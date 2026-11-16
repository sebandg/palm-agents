// Where the owner is right now: at the Mac, on the phone, or at neither screen. Agents read
// this through the bridge's owner_context tool, so they can print a link when the owner is
// sitting in front of it and hand the shared browser over when they are not.
//
// Three signals, strongest first:
//  1. Mac input idle (HIDIdleTime from ioreg): seconds since the keyboard or trackpad was
//     physically touched. An agent typing into a tmux pane raises no HID event, which is
//     what makes this one trustworthy.
//  2. A phone holding the event stream open. The app keeps /api/stream connected only while
//     it is in the foreground, so a live phone subscriber means the app is open in a hand.
//     A paired session's last_seen_at is the same signal minutes stale - the phone keeps a
//     valid session long after it is pocketed, so it is never presence on its own.
//  3. The agent's own tmux session, when it has one: how long ago an attached Mac client was
//     active, and whether the window still has the phone's width (window-size manual, which
//     the global hooks clear as soon as a Mac client attaches, takes focus or is resized).
import { execFile } from "node:child_process";
import type { OwnerPresence } from "@palm-agents/protocol";
import type { Logger } from "./log.ts";

/** Device labels that mean a phone. Set at pairing from the user agent (Pair.tsx). */
export const PHONE_LABEL_RE = /iphone|ipad|android|phone|mobile/i;

/** The Mac counts as in use while its keyboard or trackpad was touched this recently. */
const MAC_LIVE_SEC = 90;
/** Longer than that and they are reading, not typing; longer than this and they have left. */
const MAC_RECENT_SEC = 900;
/** A phone that called the service this recently is probably still in the hand. */
const PHONE_RECENT_SEC = 120;

export interface SessionSignals {
  /** Seconds since an attached Mac terminal client was last active; null = none attached. */
  deskClientIdleSec: number | null;
  /** The window still has the phone's width, so the phone used this session last. */
  phoneSizedLast: boolean;
}

export interface PresenceSignals {
  /** Seconds since the Mac's keyboard or trackpad was touched; null = not readable. */
  macIdleSec: number | null;
  /** A phone is holding the event stream open right now. */
  phoneStreaming: boolean;
  /** Seconds since a phone last called the service; null = no phone ever has. */
  phoneLastSeenSec: number | null;
  /** The agent's own terminal session, when the call named one. */
  session: SessionSignals | null;
}

const ADVICE: Record<OwnerPresence["where"], string> = {
  desk:
    "They can read the terminal and click in it, and finish a sign-in in their own browser. Printing a URL is fine; handing the shared browser over is optional.",
  phone:
    "They read this terminal on the phone and cannot easily tap, select or copy long text in it, and cannot use the Mac's screen. Open the page in the shared browser (browser_navigate) and hand it over with request_human instead of printing a link.",
  away:
    "Nobody is watching either screen, so a question in the terminal may sit for a while. request_human alerts their phone; a plain prompt does not.",
  unknown:
    "Assume the phone: open the page in the shared browser and hand it over with request_human rather than printing a link for them to copy.",
};

function ago(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}min`;
  return `${Math.round(sec / 3600)}h`;
}

/** Read the signals as a verdict. Pure, so the thresholds are testable. */
export function decide(s: PresenceSignals): OwnerPresence {
  const why: string[] = [];
  if (s.macIdleSec !== null) why.push(`the Mac's keyboard or trackpad was last touched ${ago(s.macIdleSec)} ago`);
  else why.push("the Mac's input idle time is not readable here");
  if (s.phoneStreaming) why.push("a phone has the app open (it is holding the event stream)");
  else if (s.phoneLastSeenSec !== null) why.push(`no phone is streaming; one last called the service ${ago(s.phoneLastSeenSec)} ago`);
  else why.push("no phone has ever called the service");
  if (s.session?.deskClientIdleSec != null) why.push(`a Mac terminal is attached to this session, last active ${ago(s.session.deskClientIdleSec)} ago`);
  if (s.session?.phoneSizedLast) why.push("this session's window still has the phone's width");

  const mac = s.macIdleSec ?? Infinity;
  const phone = s.phoneStreaming ? 0 : s.phoneLastSeenSec ?? Infinity;
  const lastKnown: OwnerPresence["lastKnown"] =
    mac === Infinity && phone === Infinity
      ? s.session?.phoneSizedLast
        ? "phone"
        : s.session?.deskClientIdleSec != null
          ? "desk"
          : null
      : phone < mac
        ? "phone"
        : "desk";
  const at = (where: OwnerPresence["where"], confidence: OwnerPresence["confidence"]): OwnerPresence =>
    ({ where, confidence, lastKnown, why, advice: ADVICE[where] });

  if (mac <= MAC_LIVE_SEC) return at("desk", "live");
  if (s.phoneStreaming) return at("phone", "live");
  if (phone <= PHONE_RECENT_SEC) return at("phone", "recent");
  if (mac <= MAC_RECENT_SEC) return at("desk", "recent");
  return at(lastKnown === null ? "unknown" : "away", "guess");
}

/** The verdict as the agent reads it. */
export function presenceText(p: OwnerPresence): string {
  const head: Record<OwnerPresence["where"], string> = {
    desk: p.confidence === "live" ? "The owner is at the Mac right now." : "The owner looks to be at the Mac, a few minutes off the keyboard.",
    phone: p.confidence === "live" ? "The owner has Palm Agents open on their phone right now." : "The owner was on their phone moments ago and probably still is.",
    away: `Nobody is at either screen right now${p.lastKnown ? ` (the ${p.lastKnown === "phone" ? "phone" : "Mac"} was the last one used)` : ""}.`,
    unknown: "Where the owner is cannot be told right now.",
  };
  return `${head[p.where]}\n\nWhy: ${p.why.join("; ")}.\n\n${p.advice}`;
}

/** One sentence for an agent already waiting on the owner. */
export function presenceNote(p: OwnerPresence): string {
  switch (p.where) {
    case "phone":
      return "Their phone has the app open, so the hand-over is in front of them.";
    case "desk":
      return "They are at the Mac rather than the phone, so they may not have seen the phone's alert yet.";
    case "away":
      return "Neither screen is being watched right now, so this may wait a while.";
    default:
      return "";
  }
}

export class PresenceService {
  private clients = new Set<{ label: string }>();
  private macCache: { at: number; value: number | null } | null = null;

  private warnedNoHid = false;

  constructor(
    private readonly opts: {
      listSessions: () => Array<{ label: string; lastSeenAt: string }>;
      sessionSignals?: (name: string) => Promise<SessionSignals | null>;
      /** Overridable for tests; defaults to ioreg on macOS. */
      macIdle?: () => Promise<number | null>;
      log?: Logger;
    },
  ) {}

  /** A client opened the event stream; call the returned function when it closes. */
  noteStreamClient(label: string): () => void {
    const c = { label };
    this.clients.add(c);
    return () => {
      this.clients.delete(c);
    };
  }

  private get phoneStreaming(): boolean {
    for (const c of this.clients) if (PHONE_LABEL_RE.test(c.label)) return true;
    return false;
  }

  private phoneLastSeenSec(): number | null {
    const now = Date.now();
    let best: number | null = null;
    for (const s of this.opts.listSessions()) {
      if (!PHONE_LABEL_RE.test(s.label)) continue;
      const sec = (now - Date.parse(s.lastSeenAt)) / 1000;
      if (!Number.isFinite(sec)) continue;
      if (best === null || sec < best) best = Math.max(0, sec);
    }
    return best;
  }

  /** Seconds since the Mac's keyboard or trackpad was touched. Cached: ioreg is a process. */
  async macIdleSec(): Promise<number | null> {
    if (this.macCache && Date.now() - this.macCache.at < 2000) return this.macCache.value;
    const value = this.opts.macIdle ? await this.opts.macIdle().catch(() => null) : await readHidIdleSec();
    if (value === null && !this.warnedNoHid && process.platform === "darwin") {
      this.warnedNoHid = true;
      // Without it, a phone left open on the desk reads as presence while the owner is at
      // the Mac, so this is worth a line in the log rather than a silent downgrade.
      this.opts.log?.("warn", "cannot read the Mac's input idle time (ioreg): presence falls back to the phone's own signals");
    }
    this.macCache = { at: Date.now(), value };
    return value;
  }

  async signals(session?: string): Promise<PresenceSignals> {
    const [macIdleSec, s] = await Promise.all([
      this.macIdleSec(),
      session && this.opts.sessionSignals ? this.opts.sessionSignals(session).catch(() => null) : Promise.resolve(null),
    ]);
    return { macIdleSec, phoneStreaming: this.phoneStreaming, phoneLastSeenSec: this.phoneLastSeenSec(), session: s };
  }

  async read(session?: string): Promise<OwnerPresence> {
    return decide(await this.signals(session));
  }
}

/**
 * HIDIdleTime is nanoseconds since the last HID event, on the IOHIDSystem service. The
 * absolute path comes first because the launchd job runs without /usr/sbin on its PATH.
 */
export async function readHidIdleSec(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  for (const bin of ["/usr/sbin/ioreg", "ioreg"]) {
    const out = await new Promise<string | null>((resolve) => {
      execFile(bin, ["-c", "IOHIDSystem", "-r", "-d", "1"], { timeout: 4000, maxBuffer: 1_000_000 }, (err, stdout) => resolve(err ? null : stdout));
    });
    if (out === null) continue;
    let best: number | null = null;
    for (const m of out.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)) {
      const sec = Number(m[1]) / 1e9;
      if (Number.isFinite(sec) && (best === null || sec < best)) best = sec;
    }
    if (best !== null) return best;
  }
  return null;
}
