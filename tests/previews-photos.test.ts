// From the phone into a terminal session: photos land as a pasted file path, and a dev server
// the session started can be shared to the tailnet (a fake Tailscale CLI records the calls)
// and is unshared once it stops. Uses a private tmux socket.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import { findTmux } from "../apps/control-service/src/terminal.ts";
import type { TermScreen, TermSession } from "@palm-agents/protocol";

const tmux = findTmux();
const SOCKET = `pa-prev-${process.pid}`;
const name = "pa-prev";
let env: TestEnv;
let calls = "";
let port = 0;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pa-ts-"));
  calls = path.join(dir, "calls.log");
  const fake = path.join(dir, "tailscale");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in\n  "status --json") echo '{"Self":{"DNSName":"mac.example.ts.net."}}' ;;\n  "serve status --json") echo '{}' ;;\nesac\n`, { mode: 0o755 });
  env = await bootTestEnv({ browser: false, env: { PALM_AGENTS_TMUX_SOCKET: SOCKET, PALM_AGENTS_TAILSCALE: fake } });
  port = await new Promise<number>((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
}, 30_000);
afterAll(async () => {
  await env.cleanup();
  if (tmux) await new Promise<void>((r) => execFile(tmux, ["-L", SOCKET, "kill-server"], () => r()));
});

const list = async () => (await (await client(env).get("/api/term")).json()) as { previewsAvailable: boolean; sessions: TermSession[] };
const previews = async () => (await list()).sessions.find((s) => s.name === name)?.previews ?? [];

describe.skipIf(!tmux)("photos and previews", () => {
  it("pastes a photo into the session as an owner-only file path", async () => {
    const c = client(env);
    expect((await c.post("/api/term", { name, cwd: env.dataDir, command: "sh" })).status).toBe(201);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const r = await c.post(`/api/term/${name}/image`, { dataBase64: png.toString("base64") });
    expect(r.status).toBe(200);
    const { path: file } = (await r.json()) as { path: string; screen: TermScreen };
    expect(file).toMatch(/uploads\/photo-.*\.png$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await waitFor(async () => ((await (await c.get(`/api/term/${name}/screen`)).json()) as TermScreen).text.replace(/\n/g, "").includes(path.basename(file)) ? true : null, { label: "path pasted" });
    // Not an image: refused, nothing saved.
    expect((await c.post(`/api/term/${name}/image`, { dataBase64: Buffer.from("#!/bin/sh\necho hi\n").toString("base64") })).status).toBe(400);
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
    await c.post(`/api/term/${name}/keys`, { keys: ["C-c"] });
  });

  it("offers a dev server started in the session, shares it to the tailnet, and drops it when it stops", async () => {
    const c = client(env);
    expect((await list()).previewsAvailable).toBe(true);
    await c.post(`/api/term/${name}/keys`, { text: `python3 -m http.server ${port} --bind 127.0.0.1`, keys: ["Enter"] });
    await waitFor(async () => (await previews()).some((p) => p.port === port) ? true : null, { label: "dev server found", timeout: 15_000 });
    expect((await previews()).find((p) => p.port === port)?.url).toBeNull();

    const r = await c.post(`/api/previews/${port}`, {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as { url: string }).url).toBe(`https://mac.example.ts.net:${port}`);
    expect(fs.readFileSync(calls, "utf8")).toContain(`serve --bg --https=${port} http://127.0.0.1:${port}`);
    await waitFor(async () => (await previews()).find((p) => p.port === port)?.url ? true : null, { label: "listed as shared" });

    // A port that no terminal session owns (this test's own service) cannot be shared.
    expect((await c.post(`/api/previews/${new URL(env.base).port}`, {})).status).toBe(404);

    // The server stops: the share goes with it.
    await c.post(`/api/term/${name}/keys`, { keys: ["C-c"] });
    await waitFor(async () => { await env.app.previews.sweep(); return fs.readFileSync(calls, "utf8").includes(`serve --https=${port} off`) ? true : null; }, { label: "unshared", timeout: 15_000 });
    expect(await previews()).toEqual([]);
  }, 40_000);
});
