// Browser ownership state machine. Persisted; every agent-side browser call is
// checked here immediately before execution. Either the owner or one agent holds
// the browser at a time, never both.
import type { OwnershipRecord } from "@palm-agents/protocol";
import type { Store } from "./store.ts";
import type { StreamHub } from "./stream.ts";
import type { BrowserSupervisor } from "./browser.ts";
import type { Logger } from "./log.ts";

type HumanRequest = NonNullable<OwnershipRecord["humanRequest"]>;
export type GateResult = { ok: true; lease: number } | { ok: false; reason: string };

export class OwnershipManager {
  private current: OwnershipRecord;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store, private readonly stream: StreamHub, private readonly browser: BrowserSupervisor, private readonly log: Logger) {
    this.current = store.getOwnership();
  }

  get(): OwnershipRecord {
    return this.current;
  }

  private set(next: Omit<OwnershipRecord, "updatedAt">): OwnershipRecord {
    const prev = this.current;
    this.current = this.store.setOwnership(next);
    // The owner's phone emulation ends with their control. The worker serializes calls,
    // so this lands before any agent operation that follows the transition.
    if (prev?.state === "human_control" && next.state !== "human_control" && this.browser.health.state === "ready") {
      void this.browser.client.call("device", { mobile: null }).catch((err) => this.log("warn", `restoring desktop viewport failed: ${(err as Error).message}`));
    }
    this.log("info", `ownership -> ${next.state}`, { holder: next.holder, lease: next.lease });
    this.stream.publish({ kind: "ownership", ownership: this.current });
    return this.current;
  }

  /** Serialize transitions so pausing/draining cannot interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.transition.then(fn, fn);
    this.transition = p.catch(() => {});
    return p;
  }

  /** Called when the browser becomes ready after (re)launch. */
  onBrowserReady() {
    const o = this.current;
    if (o.state === "unavailable" || o.state === "recovering") {
      // A human request that was outstanding keeps the human in control; otherwise the browser is free.
      if (o.humanRequest) this.set({ ...o, state: "human_control", lease: o.lease + 1 });
      else this.set({ state: "agent_control", holder: null, lease: o.lease + 1, humanRequest: null });
    }
  }
  onBrowserUnavailable() {
    const o = this.current;
    if (o.state !== "unavailable") this.set({ ...o, state: "unavailable", lease: o.lease + 1 });
  }

  /** An agent takes the free browser, or keeps the one it holds. */
  claim(holder: string): GateResult {
    const o = this.current;
    if (o.state !== "agent_control") return { ok: false, reason: o.state === "human_control" || o.state === "pausing" ? "the owner is using the shared browser" : `the shared browser is ${o.state.replace("_", " ")}` };
    if (o.holder !== null && o.holder !== holder) return { ok: false, reason: `another agent (${o.holder}) is using the shared browser` };
    const next = o.holder === holder ? o : this.set({ ...o, holder, lease: o.lease + 1 });
    return { ok: true, lease: next.lease };
  }
  /** The holder is done (or went idle): the browser is free again. */
  release(holder: string) {
    const o = this.current;
    if (o.state === "agent_control" && o.holder === holder) this.set({ ...o, holder: null, lease: o.lease + 1 });
  }

  /** Human control allowed? */
  checkHuman(): GateResult {
    const o = this.current;
    if (o.state !== "human_control") return { ok: false, reason: `browser is ${o.state.replace("_", " ")}; take control first` };
    return { ok: true, lease: o.lease };
  }

  /**
   * An agent asked for help, or the owner took the browser:
   * agent_control -> pausing (lease bumped, so in-flight work can tell) -> drain -> human_control.
   */
  requestHuman(req: Omit<HumanRequest, "requestedAt" | "holder"> & { holder?: string | null }): Promise<OwnershipRecord> {
    return this.serial(async () => {
      const o = this.current;
      if (o.state === "human_control") return o;
      if (o.state === "unavailable") throw new Error("browser unavailable");
      const humanRequest: HumanRequest = { holder: req.holder !== undefined ? req.holder : o.holder, reason: req.reason, kind: req.kind, requestedAt: new Date().toISOString(), requestedBy: req.requestedBy };
      this.set({ state: "pausing", holder: humanRequest.holder, lease: o.lease + 1, humanRequest });
      // Barrier: wait for in-flight browser operations to finish before granting human input.
      try {
        await this.browser.client.call("barrier", {}, 60_000);
      } catch (err) {
        this.log("warn", `drain barrier failed: ${(err as Error).message}`);
      }
      return this.set({ state: "human_control", holder: humanRequest.holder, lease: this.current.lease + 1, humanRequest });
    });
  }

  /** An agent asks for help while the owner already browses on their own: the owner keeps the browser, now on the agent's behalf. */
  adoptRequest(req: Omit<HumanRequest, "requestedAt">): OwnershipRecord {
    const o = this.current;
    if (o.state !== "human_control") throw new Error(`cannot adopt a request while ${o.state}`);
    return this.set({ ...o, holder: req.holder, humanRequest: { ...req, requestedAt: new Date().toISOString() } });
  }

  /** Owner handed the browser back: to the agent it was handed over from, or free. */
  returnToAgent(): Promise<OwnershipRecord> {
    return this.serial(async () => {
      const o = this.current;
      if (o.state !== "human_control") throw new Error(`cannot return control while ${o.state}`);
      return this.set({ state: "agent_control", holder: o.humanRequest?.holder ?? null, lease: o.lease + 1, humanRequest: null });
    });
  }
}
