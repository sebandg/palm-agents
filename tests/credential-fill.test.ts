// Phone-side credential fill: the owner's password manager fills a local form,
// the worker locates the page's own username/password/OTP fields and fills them.
// No tapping fields in the screenshot, no secrets in logs or diagnostics.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_OTP, FIXTURE_PASS, FIXTURE_USER } from "./fixtures/login-site/server.ts";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import type { FrameMeta } from "@palm-agents/protocol";

let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
}, 90_000);
afterAll(async () => { await env.cleanup(); });

type InputResult = { status: number; body: { meta?: FrameMeta; filled?: string[]; error?: string; code?: string } };
async function input(inp: Record<string, unknown>): Promise<InputResult> {
  const { meta } = (await (await client(env).get("/api/browser/frame")).json()) as { meta: FrameMeta };
  const r = await client(env).post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: inp });
  return { status: r.status, body: (await r.json()) as InputResult["body"] };
}

describe("credential fill from the phone", () => {
  it("fills the page's own fields step by step and keeps secrets out of logs", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/login` })).status).toBe(200);

    // Login page: username + password filled and submitted; the OTP value is kept for later.
    const r1 = await input({ type: "fill", username: FIXTURE_USER, password: FIXTURE_PASS, otp: FIXTURE_OTP, submit: true });
    expect(r1.status).toBe(200);
    expect(r1.body.filled).toEqual(["username", "password"]);
    expect(r1.body.meta?.url).toContain("/otp");

    // OTP page: only the one-time-code field exists.
    const r2 = await input({ type: "fill", username: FIXTURE_USER, otp: FIXTURE_OTP, submit: true });
    expect(r2.status).toBe(200);
    expect(r2.body.filled).toEqual(["otp"]);
    expect(r2.body.meta?.url).toContain("/success");

    // Success page has no credential fields: a clear error, not a blind keyboard.type.
    const r3 = await input({ type: "fill", password: "nothing-to-fill" });
    expect(r3.status).toBe(422);
    expect(r3.body.code).toBe("no_field");

    const diag = JSON.stringify(await (await c.get("/api/diagnostics")).json());
    expect(diag).not.toContain(FIXTURE_PASS);
    expect(diag).not.toContain(FIXTURE_OTP);
    expect(diag).toContain("human input fill (username,password)");
    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 60_000);

  it("types a code into one-box-per-character inputs", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    await input({ type: "navigate", url: `${env.fixtureBase}/logout` });
    await input({ type: "navigate", url: `${env.fixtureBase}/login` });
    expect((await input({ type: "fill", username: FIXTURE_USER, password: FIXTURE_PASS, submit: true })).body.meta?.url).toContain("/otp");
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/otp?split=1` })).status).toBe(200);
    const r = await input({ type: "fill", otp: FIXTURE_OTP, submit: true });
    expect(r.status).toBe(200);
    expect(r.body.filled).toEqual(["otp"]);
    expect(r.body.meta?.url).toContain("/success");
    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 60_000);

  it("replaces stray content instead of appending to it", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    await input({ type: "navigate", url: `${env.fixtureBase}/logout` });
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/login` })).status).toBe(200);
    // Simulate the clunky path: username typed, then the password accidentally appended to it.
    expect((await input({ type: "fill", username: `${FIXTURE_USER}${FIXTURE_PASS}` })).status).toBe(200);
    const r = await input({ type: "fill", username: FIXTURE_USER, password: FIXTURE_PASS, submit: true });
    expect(r.body.filled).toEqual(["username", "password"]);
    expect(r.body.meta?.url).toContain("/otp");
    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 60_000);

  it("fills fields that a transparent layer covers (clicks don't reach them)", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    await input({ type: "navigate", url: `${env.fixtureBase}/logout` });
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/login?overlay=1` })).status).toBe(200);
    const r = await input({ type: "fill", username: FIXTURE_USER, password: FIXTURE_PASS, submit: true });
    expect(r.body.filled).toEqual(["username", "password"]);
    expect(r.body.meta?.url).toContain("/otp");
    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 60_000);
});
