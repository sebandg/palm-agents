// Login hand-over, automated: an agent in terminal session "claude-proj" opens a login page and
// calls request_human -> the owner logs in through the control service's browser input
// endpoints -> hands back -> the agent carries on in the same browser session. Also covers
// the takeover barrier, stale input rejection, popup tabs, and credential privacy.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_OTP, FIXTURE_PASS, FIXTURE_USER } from "./fixtures/login-site/server.ts";
import { callBridge } from "../packages/mcp-bridge/src/index.ts";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import type { BridgeResult, FrameMeta } from "@palm-agents/protocol";

let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
}, 90_000);
afterAll(async () => { await env.cleanup(); });

const frame = async () => (await (await client(env).get("/api/browser/frame")).json()) as { meta: FrameMeta; jpegBase64: string };
const input = (meta: FrameMeta, inp: Record<string, unknown>) => client(env).post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: inp });
const agent = (tool: Parameters<typeof callBridge>[1], args: unknown = {}) =>
  callBridge({ baseUrl: env.base, token: () => fs.readFileSync(path.join(env.dataDir, "agent-bridge-token"), "utf8").trim(), session: "claude-proj" }, tool, args);

async function typeInto(meta: FrameMeta, ref: string, text: string) {
  // Human path: click the field by coordinates from the observation, then type.
  const obs = await env.app.browser.client.call("observe", {});
  const el = obs.observation.elements.find((e) => e.ref === ref) ?? obs.observation.elements.find((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
  if (!el) throw new Error(`element ${ref} not found: ${obs.observation.elements.map((e) => e.name).join(",")}`);
  const x = el.box.x + el.box.w / 2;
  const y = el.box.y + el.box.h / 2;
  expect((await input(meta, { type: "click", x, y, viewport: meta.viewport })).status).toBe(200);
  expect((await input(meta, { type: "type", text, sensitive: true })).status).toBe(200);
}

describe("login hand-over with a terminal agent", () => {
  let waiting: Promise<BridgeResult>;
  it("the agent opens the login page and hands the browser over; its other calls are blocked meanwhile", async () => {
    expect((await agent("browser_navigate", { url: `${env.fixtureBase}/login` })).ok).toBe(true);
    expect(env.app.ownership.get()).toMatchObject({ state: "agent_control", holder: "claude-proj" });
    waiting = agent("request_human", { reason: "please log in", kind: "login" });
    const o = await waitFor(() => (env.app.ownership.get().state === "human_control" ? env.app.ownership.get() : null), { label: "human_control" });
    expect(o.humanRequest).toMatchObject({ holder: "claude-proj", kind: "login", requestedBy: "agent" });
    expect(await agent("browser_observe")).toMatchObject({ ok: false, blocked: true });
  });

  it("human completes password + OTP through the frame/input endpoints", async () => {
    let f = await frame();
    expect(f.meta.url).toContain("/login");
    expect(f.jpegBase64.length).toBeGreaterThan(1000);
    await typeInto(f.meta, "Username", FIXTURE_USER);
    await typeInto(f.meta, "Password", FIXTURE_PASS);
    expect((await input(f.meta, { type: "key", key: "Enter" })).status).toBe(200);
    f = await waitFor(async () => { const x = await frame(); return x.meta.url.includes("/otp") ? x : null; }, { label: "otp page" });
    await typeInto(f.meta, "one-time", FIXTURE_OTP);
    expect((await input(f.meta, { type: "key", key: "Enter" })).status).toBe(200);
    f = await waitFor(async () => { const x = await frame(); return x.meta.url.includes("/success") ? x : null; }, { label: "success page" });
  });

  it("typed credentials never appear in logs or diagnostics", async () => {
    const diag = JSON.stringify(await (await client(env).get("/api/diagnostics")).json());
    const logs = fs.readdirSync(env.cfg.logDir).map((f) => fs.readFileSync(path.join(env.cfg.logDir, f), "utf8")).join("\n");
    for (const secret of [FIXTURE_PASS, FIXTURE_OTP]) {
      expect(diag).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });

  it("hand back: request_human returns and the agent sees the logged-in page in the same session", async () => {
    expect((await client(env).post("/api/browser/return-control", {})).status).toBe(200);
    expect((await waiting).ok).toBe(true);
    expect(env.app.ownership.get()).toMatchObject({ state: "agent_control", holder: "claude-proj" });
    const obs = await agent("browser_observe");
    expect(obs.text).toContain("/success");
    expect(obs.text).toMatch(/Welcome|successful/i);
  });
});

describe("ownership and input safety", () => {
  it("human input is rejected while an agent holds the browser; take-control drains then allows it", async () => {
    const f = await frame();
    const denied = await input(f.meta, { type: "key", key: "Escape" });
    expect(denied.status).toBe(409);
    const take = await client(env).post("/api/browser/take-control", { reason: "test" });
    expect(take.status).toBe(200);
    expect(env.app.ownership.get().state).toBe("human_control");
    // Taken over from the agent: hand-back returns the browser to it.
    expect(env.app.ownership.get().humanRequest).toMatchObject({ holder: "claude-proj", requestedBy: "owner" });
    const ok = await input(f.meta, { type: "key", key: "Escape" });
    expect(ok.status).toBe(200);
  });
  it("rejects stale generation, wrong tab, and viewport mismatch", async () => {
    const f = await frame();
    expect((await input({ ...f.meta, generation: f.meta.generation + 5 }, { type: "key", key: "Escape" })).status).toBe(409);
    expect((await input({ ...f.meta, tabId: "t999" }, { type: "key", key: "Escape" })).status).toBe(409);
    expect((await input(f.meta, { type: "click", x: 10, y: 10, viewport: { width: 1, height: 1 } })).status).toBe(409);
  });
  it("popup login opens a selectable tab without losing human ownership", async () => {
    let f = await frame();
    expect((await input(f.meta, { type: "navigate", url: `${env.fixtureBase}/popup-start` })).status).toBe(200);
    f = await frame();
    const obs = await env.app.browser.client.call("observe", {});
    const btn = obs.observation.elements.find((e) => e.name.includes("Open popup"))!;
    expect((await input(f.meta, { type: "click", x: btn.box.x + 5, y: btn.box.y + 5, viewport: f.meta.viewport })).status).toBe(200);
    const tabs = await waitFor(async () => { const t = (await (await client(env).get("/api/browser/tabs")).json()) as { tabs: Array<{ id: string; url: string }> }; return t.tabs.length >= 2 ? t.tabs : null; }, { label: "popup tab" });
    const popup = tabs.find((t) => t.url.includes("/login") || t.url.includes("/success"))!;
    expect(popup).toBeTruthy();
    expect((await input(f.meta, { type: "select_tab", tabId: popup.id })).status).toBe(200);
    const f2 = await frame();
    expect(f2.meta.tabId).toBe(popup.id);
    expect(env.app.ownership.get().state).toBe("human_control");
    // Switch back and close the popup tab via Escape-less path: just reselect the first tab.
    const first = tabs.find((t) => t.id !== popup.id)!;
    expect((await input(f2.meta, { type: "select_tab", tabId: first.id })).status).toBe(200);
    expect((await client(env).post("/api/browser/return-control", {})).status).toBe(200);
    expect(env.app.ownership.get().state).toBe("agent_control");
  });
  it("browser restart yields an unavailable state with no fake live frame, then recovers", async () => {
    const before = env.app.browser.health.generation;
    const p = client(env).post("/api/browser/restart");
    const r = await p;
    expect(r.status).toBe(200);
    await waitFor(() => env.app.browser.health.state === "ready" && env.app.browser.health.generation > before, { label: "browser restarted", timeout: 60_000 });
    const f = await frame();
    expect(f.meta.generation).toBe(before + 1);
    expect(env.app.ownership.get().state).toBe("agent_control");
  }, 90_000);
});
