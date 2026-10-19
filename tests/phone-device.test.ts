// Phone mode: while the owner has control the browser emulates their phone (size,
// mobile identity, touch); when control goes back to the agent it is a desktop again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import type { FrameMeta } from "@palm-agents/protocol";

let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
}, 90_000);
afterAll(async () => { await env.cleanup(); });

async function frame(): Promise<FrameMeta> {
  return ((await (await client(env).get("/api/browser/frame")).json()) as { meta: FrameMeta }).meta;
}
async function input(inp: Record<string, unknown>) {
  const meta = await frame();
  return client(env).post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: inp });
}
const pageProbe = () => env.app.browser.client.call("observe", {}).then((o) => o.meta);

describe("phone-sized browser during human control", () => {
  it("is refused unless the owner has control", async () => {
    expect((await client(env).post("/api/browser/device", { width: 390, height: 600 })).status).toBe(409);
  });

  it("emulates the phone while the owner drives and restores the desktop on return", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/login` })).status).toBe(200);

    const r = await c.post("/api/browser/device", { width: 390, height: 600 });
    expect(r.status).toBe(200);
    const m = await frame();
    expect(m.mobile).toBe(true);
    expect(m.viewport).toEqual({ width: 390, height: 600 });
    // The login form's inputs are reported so a tap on one can open the phone keyboard.
    expect(m.fields?.length).toBeGreaterThanOrEqual(2);
    const page = (await env.app.browser.client.call("observe", {})).observation;
    expect(page.url).toContain("/login");

    // A click in phone coordinates lands on the page (the username field takes focus).
    const f = m.fields![0]!;
    expect((await input({ type: "click", x: f.x + 5, y: f.y + 5, viewport: m.viewport })).status).toBe(200);
    expect((await input({ type: "scroll", dy: 300 })).status).toBe(200);

    // "Desktop site" while the owner drives: back to the desktop size and identity, then phone again.
    expect((await c.post("/api/browser/device", { desktop: true })).status).toBe(200);
    const dm = await frame();
    expect(dm.mobile).toBeFalsy();
    expect(dm.viewport).toEqual({ width: 1024, height: 768 });
    expect((await c.post("/api/browser/device", { width: 390, height: 600 })).status).toBe(200);
    expect((await frame()).mobile).toBe(true);

    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
    await waitFor(async () => !(await frame()).mobile, { label: "desktop restored" });
    const d = await pageProbe();
    expect(d.mobile).toBe(false);
    expect(d.viewport).toEqual({ width: 1024, height: 768 });
  }, 60_000);
});
