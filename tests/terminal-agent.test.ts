// Agents in terminal sessions (Claude Code, Codex) use the shared browser through the MCP
// bridge with the service's agent token: one agent holds it at a time and lets go when idle,
// agents are blocked while the owner uses it, and request_human waits inside the call until
// the owner hands the browser back.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnershipRecord } from "@palm-agents/protocol";
import { callBridge } from "../packages/mcp-bridge/src/index.ts";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let tokenFile = "";
beforeAll(async () => {
  env = await bootTestEnv({ browser: true, env: { PALM_AGENTS_AGENT_WAIT_SEC: "2", PALM_AGENTS_AGENT_IDLE_SEC: "1", PALM_AGENTS_OWNER_IDLE_SEC: "1" } });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
  tokenFile = path.join(env.dataDir, "agent-bridge-token");
}, 90_000);
afterAll(async () => { await env.cleanup(); });

const as = (session: string) => (tool: Parameters<typeof callBridge>[1], args: unknown = {}) =>
  callBridge({ baseUrl: env.base, token: () => fs.readFileSync(tokenFile, "utf8").trim(), session }, tool, args);
const agent = as("claude-proj");
const ownership = async () => ((await (await client(env).get("/api/health")).json()) as { ownership: OwnershipRecord }).ownership;

describe("terminal agents and the shared browser", () => {
  it("writes an owner-only token file", () => {
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("lets the agent browse while nobody holds the browser", async () => {
    const nav = await agent("browser_navigate", { url: `${env.fixtureBase}/login` });
    expect(nav.ok).toBe(true);
    const obs = await agent("browser_observe");
    expect(obs.ok).toBe(true);
    expect(obs.text).toContain(`${env.fixtureBase}/login`);
    // The phone sees who is using the browser.
    expect(await ownership()).toMatchObject({ state: "agent_control", holder: "claude-proj" });
  });

  it("one agent at a time: another is blocked until the first goes idle", async () => {
    expect((await agent("browser_observe")).ok).toBe(true);
    const other = await as("codex-proj")("browser_observe");
    expect(other).toMatchObject({ ok: false, blocked: true });
    expect(other.text).toContain("another agent (claude-proj)");
    await waitFor(async () => (await ownership()).holder === null, { label: "idle release", timeout: 10_000 });
    expect((await as("codex-proj")("browser_observe")).ok).toBe(true);
    expect((await ownership()).holder).toBe("codex-proj");
    await waitFor(async () => (await ownership()).holder === null, { label: "idle release", timeout: 10_000 });
  });

  it("refuses bridge calls that came in through the Tailscale proxy", async () => {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const r = await fetch(`${env.base}/bridge/call`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": "100.64.0.2" }, body: JSON.stringify({ tool: "browser_observe", args: {} }) });
    expect(r.status).toBe(404);
  });

  it("request_human hands the browser to the owner and returns when they hand it back", async () => {
    const waiting = agent("request_human", { reason: "log in to the fixture", kind: "login" });
    const o = await waitFor(async () => { const x = await ownership(); return x.state === "human_control" ? x : null; }, { label: "human control" });
    expect(o.humanRequest).toMatchObject({ holder: "claude-proj", requestedBy: "agent", reason: "log in to the fixture" });
    // While the owner has it, the agent's browser calls are blocked.
    const blocked = await agent("browser_observe");
    expect(blocked).toMatchObject({ ok: false, blocked: true });
    expect(blocked.text).toContain("owner is using");
    expect((await client(env).post("/api/browser/return-control", {})).status).toBe(200);
    const r = await waiting;
    expect(r.ok).toBe(true);
    expect(r.text).toContain("handed the browser back");
    expect((await agent("browser_observe")).ok).toBe(true);
  });

  it("tells the agent to keep waiting when the owner takes long, and the next call resumes the wait", async () => {
    const first = await agent("request_human", { reason: "enter the code", kind: "otp" });
    expect(first.ok).toBe(false);
    expect(first.text).toContain("Still waiting");
    const again = agent("request_human", { reason: "enter the code", kind: "otp" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await client(env).post("/api/browser/return-control", {})).status).toBe(200);
    expect((await again).ok).toBe(true);
  });

  it("while the owner browses: agents are blocked, a request for help is adopted, and an idle owner gives way", async () => {
    await waitFor(async () => (await ownership()).holder === null, { label: "idle release", timeout: 10_000 });
    expect((await client(env).post("/api/browser/take-control", { reason: "owner is browsing" })).status).toBe(200);
    expect((await ownership()).humanRequest).toMatchObject({ holder: null, requestedBy: "owner" });
    // Fresh owner input: the agent is blocked.
    const f = (await (await client(env).get("/api/browser/frame")).json()) as { meta: { generation: number; tabId: string; seq: number } };
    await client(env).post("/api/browser/input", { requestId: crypto.randomUUID(), generation: f.meta.generation, tabId: f.meta.tabId, frameSeq: f.meta.seq, input: { type: "scroll", dy: 10 } });
    const r = await agent("browser_navigate", { url: `${env.fixtureBase}/login` });
    expect(r).toMatchObject({ ok: false, blocked: true });
    expect(r.text).toContain("owner is using");
    // Asking for help while the owner already has the browser turns their browsing into the hand-over.
    const waiting = agent("request_human", { reason: "need a login", kind: "login" });
    await waitFor(async () => (await ownership()).humanRequest?.holder === "claude-proj", { label: "request adopted" });
    expect((await ownership()).humanRequest).toMatchObject({ holder: "claude-proj", requestedBy: "agent", reason: "need a login" });
    expect((await client(env).post("/api/browser/return-control", {})).status).toBe(200);
    expect((await waiting).ok).toBe(true);
    // The owner browses again but leaves it alone: after the idle time an agent gets it back.
    await waitFor(async () => (await ownership()).holder === null, { label: "idle release", timeout: 10_000 });
    expect((await client(env).post("/api/browser/take-control", { reason: "owner is browsing" })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1200));
    await agent("browser_observe"); // notices the idle owner and frees the browser
    await waitFor(async () => (await ownership()).state === "agent_control", { label: "idle owner gives way" });
    expect((await agent("browser_observe")).ok).toBe(true);
  });

  it("rotates the token on restart: an old token no longer works", async () => {
    const old = fs.readFileSync(tokenFile, "utf8").trim();
    env.app.agents.issueToken(tokenFile);
    const r = await callBridge({ baseUrl: env.base, token: old }, "browser_observe", {});
    expect(r.ok).toBe(false);
    expect((await agent("browser_observe")).ok).toBe(true);
  });
});
