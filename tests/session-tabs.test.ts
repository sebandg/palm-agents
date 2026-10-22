// Each terminal session's agent works in its own tab of the shared browser, so one agent
// never navigates away from another's page, the phone's tab list says whose tab is whose, and
// a session's tab closes when the session ends. Uses a private tmux socket.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callBridge } from "../packages/mcp-bridge/src/index.ts";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import { findTmux } from "../apps/control-service/src/terminal.ts";

const tmux = findTmux();
const SOCKET = `pa-tabs-${process.pid}`;
let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true, env: { PALM_AGENTS_AGENT_IDLE_SEC: "1", PALM_AGENTS_TMUX_SOCKET: SOCKET } });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
  for (const name of ["one", "two"]) expect((await client(env).post("/api/term", { name, command: "sh" })).status).toBe(201);
}, 90_000);
afterAll(async () => {
  await env.cleanup();
  if (tmux) await import("node:child_process").then((cp) => new Promise<void>((r) => cp.execFile(tmux, ["-L", SOCKET, "kill-server"], () => r())));
});

const agent = (session: string, tool: Parameters<typeof callBridge>[1], args: unknown = {}) =>
  callBridge({ baseUrl: env.base, token: () => fs.readFileSync(path.join(env.dataDir, "agent-bridge-token"), "utf8").trim(), session }, tool, args);
const tabs = async () => ((await (await client(env).get("/api/browser/tabs")).json()) as { tabs: Array<{ id: string; url: string; session?: string }> }).tabs;
const free = () => waitFor(() => (env.app.ownership.get().holder === null ? true : null), { label: "browser free", timeout: 10_000 });

describe.skipIf(!tmux)("a tab per session", () => {
  it("two sessions get their own tabs and keep their own pages", async () => {
    expect((await agent("one", "browser_navigate", { url: `${env.fixtureBase}/login` })).ok).toBe(true);
    await free();
    expect((await agent("two", "browser_navigate", { url: `${env.fixtureBase}/popup-start` })).ok).toBe(true);
    await free();
    const obs = await agent("one", "browser_observe");
    expect(obs.text).toContain("/login");
    const list = await tabs();
    expect(list.find((t) => t.session === "one")?.url).toContain("/login");
    expect(list.find((t) => t.session === "two")?.url).toContain("/popup-start");
  });

  it("the agent's tab list names the sessions", async () => {
    const r = await agent("one", "browser_tabs");
    expect(r.text).toMatch(/\[session one\]/);
    expect(r.text).toMatch(/\[session two\]/);
  });

  it("closes a session's tab when the session ends", async () => {
    await free();
    expect((await client(env).raw("/api/term/two", { method: "DELETE", headers: { cookie: env.cookie, origin: env.origin, "x-pa-request": "1" } })).status).toBe(200);
    await waitFor(async () => ((await tabs()).some((t) => t.url.includes("/popup-start")) ? null : true), { label: "tab of two closed", timeout: 15_000 });
    expect((await tabs()).find((t) => t.session === "one")?.url).toContain("/login");
  });
});
