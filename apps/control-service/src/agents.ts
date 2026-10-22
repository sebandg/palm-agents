// The shared browser for agents in terminal sessions (Claude Code, Codex): the MCP bridge
// forwards their browser tool calls here with the agent token. One agent holds the browser
// at a time, and lets go after a short idle spell so another (or the owner) can use it.
// request_human waits inside the call until the owner hands the browser back.
// Each session works in its own tab, so one agent never navigates away from another's page.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { BridgeToolArgs, type BridgeCall, type BridgeResult } from "@palm-agents/protocol";
import type { WorkerError } from "@palm-agents/browser-worker";
import { hashToken } from "./auth.ts";
import type { OwnershipManager } from "./ownership.ts";
import type { BrowserSupervisor } from "./browser.ts";
import type { Logger } from "./log.ts";
import type { Config } from "./config.ts";
import type { Alert } from "@palm-agents/notifications";

type Reply = { status: number; body: BridgeResult };

export class AgentBridge {
  private tokenHash: string | null = null;
  private lastCall = new Map<string, number>();
  private lastHumanInput = 0;
  /** Tabs each session works in, newest last (a popup it switched to comes after its own tab). */
  private sessionTabs = new Map<string, string[]>();
  private tabsGeneration = -1;
  private sweeper: NodeJS.Timeout | null = null;
  lastContactAt: string | null = null;
  onAlert: (a: Alert) => void = () => {};
  /** Names of the terminal sessions that still exist (null = unknown right now). */
  liveSessions: () => Promise<string[] | null> = async () => null;

  constructor(
    private readonly cfg: Config,
    private readonly ownership: OwnershipManager,
    private readonly browser: BrowserSupervisor,
    private readonly log: Logger,
  ) {}

  /**
   * New token, written owner-only where the MCP bridge reads it on every call. Rotated on
   * each start, so a token copied from an old run stops working.
   */
  issueToken(file: string) {
    const token = randomBytes(32).toString("base64url");
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    this.tokenHash = hashToken(token);
  }

  start() {
    this.sweeper = setInterval(() => this.releaseIdle(), Math.min(5_000, this.cfg.agentIdleMs / 2));
    this.sweeper.unref();
  }
  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** The holder stopped using the browser a while ago: free it. */
  private closing = false;
  /** Sessions seen running in tmux; only these count as ended once they are gone. */
  private seenLive = new Set<string>();
  private async closeEndedSessionTabs() {
    if (this.closing) return;
    this.closing = true;
    try { await this.closeEnded(); } finally { this.closing = false; }
  }
  private async closeEnded() {
    if (this.browser.health.state !== "ready" || this.browser.health.generation !== this.tabsGeneration || this.sessionTabs.size === 0) return;
    const live = await this.liveSessions().catch(() => null);
    if (!live) return;
    const o = this.ownership.get();
    for (const [session, ids] of this.sessionTabs) {
      if (live.includes(session)) { this.seenLive.add(session); continue; }
      if (!this.seenLive.has(session) || ids.length === 0) continue;
      // Still in a hand-over, or the owner is looking at that tab: try again later.
      if (o.holder === session || o.humanRequest?.holder === session) continue;
      if (o.state === "human_control" && (await this.browser.client.call("tabs", {})).some((t) => t.selected && ids.includes(t.id))) continue;
      for (const id of ids) await this.browser.client.call("closeTab", { tabId: id }).catch(() => {});
      this.sessionTabs.delete(session);
      this.lastCall.delete(session);
      this.seenLive.delete(session);
      this.log("info", `session ${session} ended: closed its browser tab${ids.length > 1 ? "s" : ""}`);
    }
  }

  private releaseIdle() {
    void this.closeEndedSessionTabs().catch(() => {});
    const o = this.ownership.get();
    if (o.state === "agent_control" && o.holder && Date.now() - (this.lastCall.get(o.holder) ?? 0) > this.cfg.agentIdleMs) {
      this.log("info", `agent ${o.holder} idle: browser free`);
      this.ownership.release(o.holder);
    }
  }

  noteHumanInput() {
    this.lastHumanInput = Date.now();
  }

  /** Owner tapped Take over, or started using the browser. */
  async takeControl(reason: string | undefined) {
    this.noteHumanInput();
    await this.ownership.requestHuman({ reason: reason || "owner took control", kind: "other", requestedBy: "owner" });
  }

  /** Owner tapped Hand back. The agent it was handed over from carries on; it gets a fresh idle allowance. */
  async returnControl() {
    const o = await this.ownership.returnToAgent();
    if (o.holder) this.lastCall.set(o.holder, Date.now());
  }

  async call(token: string, call: BridgeCall, session: string | undefined): Promise<Reply> {
    if (!this.tokenHash || hashToken(token) !== this.tokenHash) return { status: 401, body: { ok: false, text: "bridge token is not valid" } };
    this.lastContactAt = new Date().toISOString();
    const parsed = BridgeToolArgs[call.tool].safeParse(call.args);
    if (!parsed.success) return { status: 400, body: { ok: false, text: `invalid arguments for ${call.tool}: ${parsed.error.issues.map((i) => i.message).join("; ")}` } };
    const args = parsed.data as Record<string, unknown>;
    const holder = session ?? "agent";
    this.lastCall.set(holder, Date.now());
    this.reclaimFromIdleOwner();
    if (call.tool === "request_human") return this.requestHuman(holder, String(args.reason), String(args.kind) as "login");

    const gate = this.ownership.claim(holder);
    if (!gate.ok) return { status: 409, body: { ok: false, blocked: true, text: `Blocked: ${gate.reason}. Wait and try again, or ask the owner in the terminal.` } };
    try {
      if (call.tool !== "browser_tabs") await this.useOwnTab(holder);
      const body = await this.exec(call.tool, args);
      if (call.tool === "browser_tabs" && typeof args.select === "string" && body.ok) this.noteTab(holder, args.select);
      if (this.ownership.get().lease !== gate.lease) body.text += "\n\nNote: control of the browser changed during this action.";
      return { status: 200, body };
    } catch (err) {
      const e = err as Partial<WorkerError>;
      return { status: 200, body: { ok: false, text: e.code === "stale_ref" ? e.message! : `browser error: ${e.message ?? String(err)}` } };
    }
  }

  /** The owner took the browser just to browse and has left it alone for a while: an agent may have it back. */
  private reclaimFromIdleOwner() {
    const o = this.ownership.get();
    if (o.state !== "human_control" || o.humanRequest?.requestedBy !== "owner" || o.humanRequest.holder) return;
    if (Date.now() - this.lastHumanInput < this.cfg.ownerIdleMs) return;
    this.log("info", "owner idle while browsing: browser free for agents");
    void this.ownership.returnToAgent().catch(() => {});
  }

  private async requestHuman(holder: string, reason: string, kind: "login" | "otp" | "captcha" | "native_dialog" | "other"): Promise<Reply> {
    const o = this.ownership.get();
    if (o.state === "agent_control") {
      if (o.holder && o.holder !== holder) return { status: 409, body: { ok: false, blocked: true, text: `Blocked: another agent (${o.holder}) is using the shared browser. Try again later.` } };
      await this.ownership.requestHuman({ holder, reason, kind, requestedBy: "agent" });
      this.onAlert({ kind: "browser", session: holder });
    } else if (o.state === "human_control" && !o.humanRequest?.holder) {
      // The owner is already browsing: they keep the browser, now with this agent's request.
      this.ownership.adoptRequest({ holder, reason, kind, requestedBy: "agent" });
      // Show the owner the page the agent needs help with.
      const tab = await this.liveTabOf(holder).catch(() => undefined);
      if (tab) await this.browser.client.call("selectTab", { tabId: tab }).catch(() => {});
      this.onAlert({ kind: "browser", session: holder });
    } else if (o.humanRequest?.holder !== holder) {
      return { status: 409, body: { ok: false, blocked: true, text: `Blocked: the shared browser is busy (${o.state.replace("_", " ")}${o.humanRequest?.holder ? ` for ${o.humanRequest.holder}` : ""}). Try again later.` } };
    }
    // Wait for the owner, below the 5-minute header timeout of the bridge's fetch.
    const deadline = Date.now() + this.cfg.agentWaitMs;
    while (Date.now() < deadline) {
      const cur = this.ownership.get();
      if (cur.state === "agent_control") {
        this.lastCall.set(holder, Date.now());
        return cur.holder === holder
          ? { status: 200, body: { ok: true, text: "The owner handed the browser back. Call browser_observe to see the current page, then continue. Do not repeat the step they did for you unless the page shows it is still needed." } }
          : { status: 200, body: { ok: false, text: "The owner handed the browser on to someone else. Try again later." } };
      }
      if (cur.humanRequest?.holder !== holder) return { status: 200, body: { ok: false, text: "The owner kept the browser for something else. Ask them in the terminal before using it again." } };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { status: 200, body: { ok: false, text: "Still waiting: the owner has not handed the browser back yet. Call request_human again with the same reason to keep waiting." } };
  }

  /** Which session works in each tab, for the phone's tab list. */
  tabSessions(): Map<string, string> {
    const m = new Map<string, string>();
    if (this.browser.health.generation !== this.tabsGeneration) return m;
    for (const [session, ids] of this.sessionTabs) for (const id of ids) m.set(id, session);
    return m;
  }

  private noteTab(holder: string, tabId: string) {
    for (const [s, ids] of this.sessionTabs) if (s !== holder && ids.includes(tabId)) this.sessionTabs.set(s, ids.filter((i) => i !== tabId));
    this.sessionTabs.set(holder, [...(this.sessionTabs.get(holder) ?? []).filter((i) => i !== tabId), tabId]);
  }

  /** The session's newest tab that is still open. Tab ids start over when the browser restarts. */
  private async liveTabOf(holder: string): Promise<string | undefined> {
    if (this.browser.health.generation !== this.tabsGeneration) {
      this.sessionTabs.clear();
      this.tabsGeneration = this.browser.health.generation;
    }
    const live = new Set((await this.browser.client.call("tabs", {})).map((t) => t.id));
    const mine = (this.sessionTabs.get(holder) ?? []).filter((id) => live.has(id));
    this.sessionTabs.set(holder, mine);
    return mine.at(-1);
  }

  /** Select the session's own tab, first opening one (or taking a blank tab nobody uses). */
  private async useOwnTab(holder: string) {
    const c = this.browser.client;
    let id = await this.liveTabOf(holder);
    const tabs = await c.call("tabs", {});
    if (!id) {
      const taken = new Set([...this.sessionTabs.values()].flat());
      id = tabs.find((t) => !taken.has(t.id) && t.url === "about:blank")?.id ?? (await c.call("newTab", {})).id;
      this.noteTab(holder, id);
      if (tabs.find((t) => t.id === id)?.selected) return;
      if (!tabs.some((t) => t.id === id)) return; // newTab already selected it
    }
    if (!tabs.find((t) => t.id === id)?.selected) await c.call("selectTab", { tabId: id });
  }

  private async exec(tool: BridgeCall["tool"], args: Record<string, unknown>): Promise<BridgeResult> {
    const c = this.browser.client;
    switch (tool) {
      case "browser_observe": {
        const r = await c.call("observe", {});
        const o = r.observation;
        const lines = o.elements.map((e) => `${e.ref} ${e.role} "${e.name}"${e.value !== undefined && e.value !== "" ? ` value="${e.value}"` : ""} @${e.box.x},${e.box.y} ${e.box.w}x${e.box.h}`);
        const text = `URL: ${o.url}\nTitle: ${o.title}\nTab: ${o.tabId} (generation ${o.generation})\n\nInteractive elements:\n${lines.join("\n") || "(none)"}\n\nVisible text:\n${o.textSnippet}`;
        return { ok: true, text, imageBase64: r.jpegBase64 };
      }
      case "browser_navigate": {
        const r = await c.call("input", { input: { type: "navigate", url: String(args.url) } });
        return { ok: true, text: `Navigated. URL: ${r.meta.url}\nTitle: ${r.meta.title}` };
      }
      case "browser_click": {
        if (typeof args.ref === "string") {
          const r = await c.call("clickRef", { ref: args.ref });
          return { ok: true, text: `Clicked ${args.ref}. URL: ${r.meta.url}\nTitle: ${r.meta.title}` };
        }
        if (typeof args.x === "number" && typeof args.y === "number") {
          const vp = (await c.call("frame", { quality: 10 })).meta.viewport;
          const r = await c.call("input", { input: { type: "click", x: args.x, y: args.y, viewport: vp } });
          return { ok: true, text: `Clicked at ${args.x},${args.y}. URL: ${r.meta.url}\nTitle: ${r.meta.title}` };
        }
        return { ok: false, text: "browser_click needs ref or x,y" };
      }
      case "browser_type": {
        const r = await c.call("typeRef", { ref: typeof args.ref === "string" ? args.ref : undefined, text: String(args.text), submit: args.submit === true });
        return { ok: true, text: `Typed ${String(args.text).length} characters${args.submit ? " and pressed Enter" : ""}. URL: ${r.meta.url}` };
      }
      case "browser_key": {
        const r = await c.call("input", { input: { type: "key", key: args.key as "Enter" } });
        return { ok: true, text: `Pressed ${String(args.key)}. URL: ${r.meta.url}` };
      }
      case "browser_scroll": {
        await c.call("input", { input: { type: "scroll", dy: Number(args.dy) } });
        return { ok: true, text: `Scrolled by ${Number(args.dy)}px.` };
      }
      case "browser_tabs": {
        const tabs = typeof args.select === "string" ? await c.call("selectTab", { tabId: args.select }) : await c.call("tabs", {});
        const owners = this.tabSessions();
        return { ok: true, text: tabs.map((t) => `${t.selected ? "*" : " "} ${t.id} ${t.title || "(untitled)"} ${t.url}${owners.get(t.id) ? ` [session ${owners.get(t.id)}]` : ""}`).join("\n") || "(no tabs)" };
      }
      default:
        return { ok: false, text: "unsupported tool" };
    }
  }
}
