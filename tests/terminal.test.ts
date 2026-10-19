// Terminal sessions over tmux: list / create / screen / keys / resize / kill through the
// authenticated API, the "needs you" heuristic, and that typed text is logged by length only.
// Uses a private tmux socket so the owner's real sessions are never touched.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import { findTmux } from "../apps/control-service/src/terminal.ts";
import type { TermScreen, TermSession } from "@palm-agents/protocol";

const tmux = findTmux();
const SOCKET = `pa-test-${process.pid}`;
let env: TestEnv;

beforeAll(async () => {
  env = await bootTestEnv({ browser: false, env: { PALM_AGENTS_TMUX_SOCKET: SOCKET } });
}, 30_000);
afterAll(async () => {
  await env.cleanup();
  if (tmux) await import("node:child_process").then((cp) => new Promise<void>((r) => cp.execFile(tmux, ["-L", SOCKET, "kill-server"], () => r())));
});

describe.skipIf(!tmux)("terminal sessions (tmux)", () => {
  const name = "pa-test-shell";
  const screen = async () => (await (await client(env).get(`/api/term/${name}/screen`)).json()) as TermScreen;

  it("lists nothing, then creates a session running a shell in a directory", async () => {
    const c = client(env);
    const empty = (await (await c.get("/api/term")).json()) as { available: boolean; sessions: TermSession[] };
    expect(empty.available).toBe(true);
    expect(empty.sessions).toEqual([]);

    const r = await c.post("/api/term", { name, cwd: env.dataDir, command: "sh" });
    expect(r.status).toBe(201);
    const s = ((await r.json()) as { session: TermSession }).session;
    expect(s.name).toBe(name);
    expect(fs.realpathSync(s.pane.path)).toBe(fs.realpathSync(env.dataDir));
    expect(s.attached).toBe(false);
    expect((await c.post("/api/term", { name, command: "sh" })).status).toBe(409);
    expect((await c.post("/api/term", { name: "bad name!" })).status).toBe(400);
  });

  it("types text + Enter and shows the output; special keys are allowlisted", async () => {
    const c = client(env);
    const r = await c.post(`/api/term/${name}/keys`, { text: "echo hello-from-phone", keys: ["Enter"] });
    expect(r.status).toBe(200);
    await waitFor(async () => /hello-from-phone\n/.test((await screen()).text + "\n") ? true : null, { label: "echo output" });
    expect((await c.post(`/api/term/${name}/keys`, { keys: ["C-x"] })).status).toBe(400);
    expect((await c.post(`/api/term/${name}/keys`, {})).status).toBe(400);
    // Literal mode: key names inside text are typed, not interpreted.
    await c.post(`/api/term/${name}/keys`, { text: "echo Enter-is-literal", keys: ["Enter"] });
    await waitFor(async () => (await screen()).text.includes("Enter-is-literal") ? true : null, { label: "literal" });
  });

  it("flags a y/n prompt as needing the owner and clears it after input", async () => {
    const c = client(env);
    await c.post(`/api/term/${name}/keys`, { text: "printf 'Do you want to proceed? (y/n) '; read ans; echo answered:$ans; echo line2; echo line3", keys: ["Enter"] });
    await waitFor(async () => (await screen()).attention ? true : null, { label: "attention" });
    const list = (await (await c.get("/api/term")).json()) as { sessions: TermSession[] };
    expect(list.sessions.find((s) => s.name === name)?.attention).toBe(true);
    await c.post(`/api/term/${name}/keys`, { text: "y", keys: ["Enter"] });
    await waitFor(async () => (await screen()).text.includes("answered:y") ? true : null, { label: "answered" });
    expect((await screen()).attention).toBe(false);
  });

  it("resizes the window to the phone's grid", async () => {
    const c = client(env);
    const r = await c.post(`/api/term/${name}/resize`, { cols: 48, rows: 20 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as TermScreen).size).toEqual({ cols: 48, rows: 20 });
    expect(["sh", "bash", "dash"]).toContain((await screen()).command); // macOS /bin/sh is bash
    expect((await c.post(`/api/term/${name}/resize`, { cols: 5, rows: 20 })).status).toBe(400);
  });

  it("names the program running under a wrapping shell (`prog; exec zsh -l` sessions)", async () => {
    const c = client(env);
    expect((await c.post("/api/term", { name: "pa-test-wrapped", cwd: env.dataDir, command: "sleep 30; exec sh" })).status).toBe(201);
    await waitFor(async () => ((await (await c.get("/api/term/pa-test-wrapped/screen")).json()) as TermScreen).command === "sleep", { label: "foreground sleep" });
    const list = (await (await c.get("/api/term")).json()) as { sessions: TermSession[] };
    expect(list.sessions.find((x) => x.name === "pa-test-wrapped")?.pane.command).toBe("sleep");
    expect((await c.raw("/api/term/pa-test-wrapped", { method: "DELETE", headers: { cookie: env.cookie, origin: env.origin, "x-pa-request": "1" } })).status).toBe(200);
  });

  it("tells working, waiting and idle sessions apart", async () => {
    const c = client(env);
    const activity = async (n: string) => ((await (await c.get("/api/term")).json()) as { sessions: TermSession[] }).sessions.find((x) => x.name === n)?.activity;
    // A program printing every half second is working; once it stops, the session goes idle.
    expect((await c.post("/api/term", { name: "pa-test-busy", cwd: env.dataDir, command: "i=0; while [ $i -lt 12 ]; do echo tick $i; i=$((i+1)); sleep 0.5; done; exec sh" })).status).toBe(201);
    await activity("pa-test-busy"); // first look: nothing to compare with yet
    await waitFor(async () => (await activity("pa-test-busy")) === "working", { label: "working", timeout: 5_000 });
    await waitFor(async () => (await activity("pa-test-busy")) === "idle", { label: "idle after output stops", timeout: 20_000 });
    // A prompt is "waiting", whatever else the screen does.
    await c.post("/api/term/pa-test-busy/keys", { text: "printf 'Continue? (y/n) '; read a", keys: ["Enter"] });
    await waitFor(async () => (await activity("pa-test-busy")) === "waiting", { label: "waiting", timeout: 5_000 });
    expect((await c.raw("/api/term/pa-test-busy", { method: "DELETE", headers: { cookie: env.cookie, origin: env.origin, "x-pa-request": "1" } })).status).toBe(200);
  }, 40_000);

  it("never logs typed text, only its length; kills the session; unknown names are 404", async () => {
    const c = client(env);
    const diag = JSON.stringify(await (await c.get("/api/diagnostics")).json());
    expect(diag).not.toContain("hello-from-phone");
    expect(diag).toContain("terminal input pa-test-shell: 21 chars keys Enter");
    const r = await c.raw(`/api/term/${name}`, { method: "DELETE", headers: { cookie: env.cookie, origin: env.origin, "x-pa-request": "1" } });
    expect(r.status).toBe(200);
    expect((await c.get(`/api/term/${name}/screen`)).status).toBe(404);
    expect((await c.post(`/api/term/${name}/keys`, { keys: ["Enter"] })).status).toBe(404);
  });

  it("requires a paired session", async () => {
    const r = await fetch(`${env.base}/api/term`);
    expect(r.status).toBe(401);
  });
});
