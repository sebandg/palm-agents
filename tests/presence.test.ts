// Where the owner is, read live: the thresholds behind the verdict, the service's own
// signals, and the owner_context tool an agent calls before printing a link.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, presenceText, PresenceService, type PresenceSignals } from "../apps/control-service/src/presence.ts";
import { callBridge } from "../packages/mcp-bridge/src/index.ts";
import { bootTestEnv, client, type TestEnv } from "./helpers.ts";
import type { OwnerPresence } from "@palm-agents/protocol";

const signals = (over: Partial<PresenceSignals> = {}): PresenceSignals =>
  ({ macIdleSec: null, phoneStreaming: false, phoneLastSeenSec: null, session: null, ...over });

describe("deciding which screen the owner is at", () => {
  it("puts them at the Mac while its keyboard is in use, even with the phone app open", () => {
    const p = decide(signals({ macIdleSec: 12, phoneStreaming: true }));
    expect(p).toMatchObject({ where: "desk", confidence: "live" });
    expect(p.advice).toContain("Printing a URL is fine");
  });

  it("puts them on the phone when the app is streaming and the Mac is cold", () => {
    expect(decide(signals({ macIdleSec: 3600, phoneStreaming: true }))).toMatchObject({ where: "phone", confidence: "live" });
  });

  it("trusts a recent phone request, but not a stale one", () => {
    expect(decide(signals({ macIdleSec: 3600, phoneLastSeenSec: 60 }))).toMatchObject({ where: "phone", confidence: "recent" });
    // 5 minutes of no keystrokes is reading at the desk, not leaving it; the phone's
    // hours-old session says nothing (it stays valid in a pocket).
    expect(decide(signals({ macIdleSec: 300, phoneLastSeenSec: 7200 }))).toMatchObject({ where: "desk", confidence: "recent" });
  });

  it("reports away, with the last screen used, once both are cold", () => {
    expect(decide(signals({ macIdleSec: 10_800, phoneLastSeenSec: 7200 }))).toMatchObject({ where: "away", confidence: "guess", lastKnown: "phone" });
    expect(decide(signals({ macIdleSec: 7200, phoneLastSeenSec: 10_800 }))).toMatchObject({ where: "away", lastKnown: "desk" });
  });

  it("says unknown rather than guessing when no signal is readable", () => {
    const p = decide(signals());
    expect(p).toMatchObject({ where: "unknown", lastKnown: null });
    expect(p.advice).toContain("Assume the phone");
  });

  it("falls back to the session's own window when nothing else is readable", () => {
    expect(decide(signals({ session: { deskClientIdleSec: null, phoneSizedLast: true } }))).toMatchObject({ where: "away", lastKnown: "phone" });
    expect(decide(signals({ session: { deskClientIdleSec: 30, phoneSizedLast: false } }))).toMatchObject({ where: "away", lastKnown: "desk" });
  });

  it("explains itself in words an agent can read", () => {
    const text = presenceText(decide(signals({ macIdleSec: 4, phoneLastSeenSec: 900 })));
    expect(text).toContain("The owner is at the Mac right now.");
    expect(text).toContain("4s ago");
    expect(text).toContain("15min ago");
  });
});

describe("the presence service's own signals", () => {
  const svc = (sessions: Array<{ label: string; lastSeenAt: string }>, macIdleSec: number | null) =>
    new PresenceService({ listSessions: () => sessions, macIdle: async () => macIdleSec });

  it("counts a streaming phone, and stops counting it once the stream closes", async () => {
    const s = svc([], 3600);
    const gone = s.noteStreamClient("iPhone");
    expect(await s.read()).toMatchObject({ where: "phone", confidence: "live" });
    gone();
    expect((await s.signals()).phoneStreaming).toBe(false);
  });

  it("does not take a paired desktop browser for a phone", async () => {
    const s = svc([{ label: "Browser", lastSeenAt: new Date().toISOString() }], 3600);
    s.noteStreamClient("Browser");
    const sig = await s.signals();
    expect(sig.phoneStreaming).toBe(false);
    expect(sig.phoneLastSeenSec).toBe(null);
  });

  it("takes the freshest phone session as the last phone contact", async () => {
    const s = svc(
      [
        { label: "iPhone", lastSeenAt: new Date(Date.now() - 600_000).toISOString() },
        { label: "iPhone", lastSeenAt: new Date(Date.now() - 30_000).toISOString() },
      ],
      3600,
    );
    expect((await s.signals()).phoneLastSeenSec).toBeCloseTo(30, 0);
  });
});

describe("an agent asking where the owner is", () => {
  let env: TestEnv;
  beforeAll(async () => { env = await bootTestEnv({ browser: false }); }, 60_000);
  afterAll(async () => { await env.cleanup(); });

  const agent = (session?: string) =>
    callBridge(
      { baseUrl: env.base, token: () => fs.readFileSync(path.join(env.dataDir, "agent-bridge-token"), "utf8").trim(), session },
      "owner_context",
      {},
    );

  it("answers without the browser and without taking it", async () => {
    const r = await agent("claude-proj");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/owner|Nobody|cannot be told/);
    expect(r.text).toContain("Why: ");
    // Asking must not make the agent the browser's holder.
    expect(env.app.ownership.get().holder).toBe(null);
  });

  it("serves the same verdict to the phone's own API", async () => {
    const p = (await (await client(env).get("/api/presence")).json()) as OwnerPresence;
    expect(["desk", "phone", "away", "unknown"]).toContain(p.where);
    expect(["live", "recent", "guess"]).toContain(p.confidence);
    expect(p.why.length).toBeGreaterThan(0);
  });

  it("reads this Mac's real input idle time", async () => {
    const sec = await env.app.presence.macIdleSec();
    expect(sec).not.toBe(null);
    expect(sec!).toBeGreaterThanOrEqual(0);
  });
});
