// Browser supervisor: wraps the worker client with restart/backoff and health
// publication. Never deletes or replaces the profile on failure.
import { BrowserWorkerClient, WorkerError } from "@palm-agents/browser-worker";
import type { BrowserHealth } from "@palm-agents/protocol";
import type { Logger } from "./log.ts";

export class BrowserSupervisor {
  readonly client: BrowserWorkerClient;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  onHealth: (h: BrowserHealth) => void = () => {};
  onCrash: (reason: string) => void = () => {};
  onRecovered: () => void = () => {};

  constructor(opts: { profileDir: string; headless: boolean; channel?: string }, private readonly log: Logger) {
    this.client = new BrowserWorkerClient({ profileDir: opts.profileDir, headless: opts.headless, channel: opts.channel, log: (l, m) => log(l, m) });
    this.client.on("health", (h: BrowserHealth) => this.onHealth(h));
    this.client.on("crashed", (reason: string) => {
      this.log("error", `browser crashed: ${reason}`);
      this.onCrash(reason);
      this.scheduleRestart();
    });
  }

  get health(): BrowserHealth {
    return this.client.health;
  }

  async start(): Promise<boolean> {
    this.stopped = false;
    try {
      await this.client.start();
      this.restartAttempts = 0;
      this.log("info", `browser ready (generation ${this.client.health.generation})`);
      this.onRecovered();
      return true;
    } catch (err) {
      const e = err as WorkerError;
      this.log("error", `browser launch failed: ${e.message}`);
      // A locked profile or missing browser is not fixed by retrying quickly.
      if (e.code !== "launch_failed") this.scheduleRestart();
      return false;
    }
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delays = [3_000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(this.restartAttempts, delays.length - 1)]!;
    this.restartAttempts += 1;
    this.log("warn", `scheduling browser restart in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      await this.start();
    }, delay);
  }

  /** Owner-triggered restart. Explicit, with consequences stated in the UI. */
  async restart(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.restartAttempts = 0;
    await this.client.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.client.stop();
  }
}
