// "Open a session for <project>": an agent asks through the bridge and gets a tmux session
// running the configured command in that folder. Private tmux socket; no Mac windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callBridge } from "../packages/mcp-bridge/src/index.ts";
import { findTmux } from "../apps/control-service/src/terminal.ts";
import { bootTestEnv, type TestEnv } from "./helpers.ts";

const tmux = findTmux();
const SOCKET = `pa-open-${process.pid}`;
const dev = fs.mkdtempSync(path.join(os.tmpdir(), "pa-dev-"));
fs.mkdirSync(path.join(dev, "my app"));
let env: TestEnv;

beforeAll(async () => {
  env = await bootTestEnv({ browser: false, env: { PALM_AGENTS_TMUX_SOCKET: SOCKET, PALM_AGENTS_DEV_DIR: dev, PALM_AGENTS_SESSION_COMMAND: "sleep 600", PALM_AGENTS_MAC_WINDOWS: "0" } });
}, 30_000);
afterAll(async () => {
  await env.cleanup();
  if (tmux) await import("node:child_process").then((cp) => new Promise<void>((r) => cp.execFile(tmux, ["-L", SOCKET, "kill-server"], () => r())));
  fs.rmSync(dev, { recursive: true, force: true });
});

const open = (args: Record<string, unknown>) =>
  callBridge({ baseUrl: env.base, token: () => fs.readFileSync(path.join(env.dataDir, "agent-bridge-token"), "utf8").trim() }, "open_session", args);

describe.skipIf(!tmux)("an agent opening a session for a project", () => {
  it("starts a session named after the folder, running the configured command there", async () => {
    const r = await open({ project: "my app" });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toContain('Started session "my-app"');
    const s = (await env.app.terminal.list()).find((x) => x.name === "my-app");
    expect(s?.pane.command).toBe("sleep");
    expect(fs.realpathSync(s!.pane.path)).toBe(fs.realpathSync(path.join(dev, "my app")));
  });

  it("does not start a second one for the same project", async () => {
    const r = await open({ project: path.join(dev, "my app") });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("already running");
    expect((await env.app.terminal.list()).filter((x) => x.name === "my-app")).toHaveLength(1);
  });

  it("says so when the folder does not exist", async () => {
    const r = await open({ project: "nope" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("No such project folder");
  });
});
