// Live view: while a phone has the Browser tab open, the worker screencasts the selected tab
// and the server streams frames over SSE; a still page sends heartbeats instead of frames.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestEnv, client, waitFor, type TestEnv } from "./helpers.ts";
import type { FrameMeta } from "@palm-agents/protocol";

let env: TestEnv;
beforeAll(async () => {
  env = await bootTestEnv({ browser: true });
  await waitFor(() => env.app.browser.health.state === "ready", { label: "browser ready", timeout: 60_000 });
}, 90_000);
afterAll(async () => { await env.cleanup(); });

/** Reads SSE events from /api/browser/live into `events` until aborted. */
function openLive() {
  const events: Array<{ event: string; data: { meta?: FrameMeta; jpegBase64?: string } }> = [];
  const ac = new AbortController();
  void (async () => {
    const res = await fetch(env.base + "/api/browser/live", { headers: { cookie: env.cookie }, signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return { events, close: () => ac.abort() };
}

describe("live browser view", () => {
  it("streams frames of the selected tab, heartbeats on a still page, and stops with no viewer", async () => {
    const c = client(env);
    expect((await c.post("/api/browser/take-control", { reason: "test" })).status).toBe(200);
    await waitFor(() => env.app.ownership.get().state === "human_control", { label: "human_control" });

    const live = openLive();
    const frames = () => live.events.filter((e) => e.event === "frame");
    await waitFor(() => frames().length > 0, { label: "first live frame", timeout: 15_000 });
    expect(frames()[0]!.data.jpegBase64!.length).toBeGreaterThan(1000);

    const meta = ((await (await c.get("/api/browser/frame")).json()) as { meta: FrameMeta }).meta;
    const nav = await c.post("/api/browser/input", { requestId: crypto.randomUUID(), generation: meta.generation, tabId: meta.tabId, frameSeq: meta.seq, input: { type: "navigate", url: `${env.fixtureBase}/login` } });
    expect(nav.status).toBe(200);
    await waitFor(() => frames().some((f) => f.data.meta!.url.includes("/login")), { label: "frame of the new page", timeout: 15_000 });

    // A still page: heartbeats keep the view known-live without resending the image.
    await waitFor(() => live.events.some((e) => e.event === "castTick"), { label: "heartbeat", timeout: 5_000 });

    live.close();
    await new Promise((r) => setTimeout(r, 1500));
    const after = live.events.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(live.events.length).toBe(after);

    // A second viewer opening later gets the current frame right away, even on a still page.
    const again = openLive();
    await waitFor(() => again.events.some((e) => e.event === "frame"), { label: "frame for a new viewer", timeout: 10_000 });
    again.close();
    expect((await c.post("/api/browser/return-control", {})).status).toBe(200);
  }, 60_000);
});
