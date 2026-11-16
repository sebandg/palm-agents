// Phone size: while the owner has control the pages are sized to their phone screen, and
// back to the desktop viewport when the agent has it again. The browser never claims to BE
// a phone - the machine is the Mac whichever screen the owner is looking at - so the site
// still sees desktop Chrome on macOS, and the switch does not reload the page.
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

/** What the fixture's /ua page reports about the browser. */
async function identity(): Promise<string> {
  const o = (await env.app.browser.client.call("observe", {})).observation;
  return o.textSnippet.replace(/\s+/g, " ");
}

describe("phone-sized browser during human control", () => {
  it("keeps the real desktop identity, and does not reload, when the size changes", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/ua` })).status).toBe(200);

    const before = await identity();
    expect(before).toContain("Macintosh");

    expect((await c.post("/api/browser/device", { width: 390, height: 600 })).status).toBe(200);
    const during = await identity();
    for (const lie of ["Android", "Pixel", "Mobile Safari", "Linux armv8l"]) expect(during, lie).not.toContain(lie);
    expect(during).toContain("Macintosh");
    expect(during).toContain("touch: false");

    // A half-filled form survives the switch: the page reflows, it is not re-served.
    expect((await input({ type: "navigate", url: `${env.fixtureBase}/login` })).status).toBe(200);
    const m = await frame();
    const f = m.fields![0]!;
    expect((await input({ type: "click", x: f.x + 5, y: f.y + 5, viewport: m.viewport })).status).toBe(200);
    expect((await input({ type: "type", text: "keepme" })).status).toBe(200);
    expect((await c.post("/api/browser/device", { desktop: true })).status).toBe(200);
    const o = (await env.app.browser.client.call("observe", {})).observation;
    expect(o.elements.some((e) => e.value === "keepme"), JSON.stringify(o.elements.map((e) => e.value))).toBe(true);

    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 90_000);

  it("is refused unless the owner has control", async () => {
    expect((await client(env).post("/api/browser/device", { width: 390, height: 600 })).status).toBe(409);
  });

  it("sizes the pages to the phone while the owner drives, and restores the desktop on return", async () => {
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

    // "Desktop site" while the owner drives: back to the full viewport, then phone size again.
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
