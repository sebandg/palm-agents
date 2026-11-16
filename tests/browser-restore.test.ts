// After a browser restart the selected tab reopens the last web page instead of a blank tab -
// unless that page was a sign-in, which would come back as a verification wall nobody asked for.
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

async function visit(path: string) {
  const c = client(env);
  expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
  const meta = ((await (await c.get("/api/browser/frame")).json()) as { meta: FrameMeta }).meta;
  await c.post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: { type: "navigate", url: `${env.fixtureBase}${path}` } });
  await c.post("/api/browser/return-control", {});
}

describe("browser restart", () => {
  it("reopens the last page", async () => {
    await visit("/?restore=1");
    expect(await url()).toContain("restore=1");

    await env.app.browser.restart();
    await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready again", timeout: 60_000 });
    await waitFor(async () => (await url().catch(() => "")).includes("restore=1"), { label: "last page reopened", timeout: 20_000 });
  }, 120_000);

  it("does not reopen a sign-in page", async () => {
    await visit("/login?restore=2");
    expect(await url()).toContain("/login");

    await env.app.browser.restart();
    await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready again", timeout: 60_000 });
    // Give the restore its chance, then check it did not take it.
    await new Promise((r) => setTimeout(r, 3000));
    expect(await url().catch(() => "")).not.toContain("/login");
  }, 120_000);
});
