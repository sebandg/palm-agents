// After a browser restart the selected tab reopens the last web page instead of a blank tab.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import type { FrameMeta } from "@palm-agents/protocol";

let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
}, 90_000);
afterAll(async () => { await env.cleanup(); });

const url = async () => ((await (await client(env).get("/api/browser/frame")).json()) as { meta: FrameMeta }).meta.url;

describe("browser restart", () => {
  it("reopens the last page", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    const meta = ((await (await c.get("/api/browser/frame")).json()) as { meta: FrameMeta }).meta;
    await c.post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: { type: "navigate", url: `${env.fixtureBase}/login?restore=1` } });
    expect(await url()).toContain("restore=1");
    await c.post("/api/browser/return-control", {});

    await env.app.browser.restart();
    await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready again", timeout: 60_000 });
    await waitFor(async () => (await url().catch(() => "")).includes("restore=1"), { label: "last page reopened", timeout: 20_000 });
  }, 120_000);
});
