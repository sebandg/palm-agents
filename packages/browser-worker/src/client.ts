// Parent-side client: forks the worker, multiplexes requests, supervises restarts.
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BrowserHealth } from "@palm-agents/protocol";
import { WorkerError, type IpcFromWorker, type WorkerMethodName, type WorkerMethods } from "./ipc.ts";

export interface BrowserWorkerOptions {
  profileDir: string;
  headless?: boolean;
  channel?: string;
  viewport?: { width: number; height: number };
  /** Called with structured, secret-free log lines. */
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class BrowserWorkerClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private health_: BrowserHealth = { state: "stopped", generation: 0, lastContactAt: null, error: null, profileDir: null };
  private generation = 0;
  private stopping = false;

  constructor(private readonly opts: BrowserWorkerOptions) {
    super();
  }

  get health(): BrowserHealth {
    return this.health_;
  }

  /** Spawn the child and launch the browser. Safe to call again after a crash. */
  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts");
    const child = fork(entry, [], {
      execArgv: ["--import", "tsx", "--no-warnings=ExperimentalWarning"],
      env: {
        ...process.env,
        PALM_AGENTS_PROFILE_DIR: this.opts.profileDir,
        PALM_AGENTS_HEADLESS: this.opts.headless ? "1" : "0",
        PALM_AGENTS_BROWSER_CHANNEL: this.opts.channel ?? "",
        PALM_AGENTS_VIEWPORT_W: String(this.opts.viewport?.width ?? 1024),
        PALM_AGENTS_VIEWPORT_H: String(this.opts.viewport?.height ?? 768),
        PALM_AGENTS_BROWSER_GENERATION: String(this.generation),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    this.child = child;
    child.stdout?.on("data", (d) => this.opts.log?.("info", `[browser-worker] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => this.opts.log?.("warn", `[browser-worker] ${String(d).trim()}`));
    child.on("message", (m: IpcFromWorker) => this.onMessage(m));
    child.on("exit", (code, signal) => {
      this.child = null;
      const reason = `browser worker exited (code=${code} signal=${signal})`;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new WorkerError(reason, "worker_exited"));
        this.pending.delete(id);
      }
      if (!this.stopping) {
        this.health_ = { ...this.health_, state: "unavailable", error: reason };
        this.emit("health", this.health_);
        this.emit("crashed", reason);
      }
    });
    const { generation } = await this.call("launch", {});
    this.generation = generation;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.call("shutdown", {}, 10_000);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (!this.child) return resolve();
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
    this.health_ = { ...this.health_, state: "stopped" };
    this.emit("health", this.health_);
  }

  /** Hard restart: kill the child (if any) and launch again with a new generation. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  call<M extends WorkerMethodName>(method: M, params: WorkerMethods[M]["params"], timeoutMs = 45_000): Promise<WorkerMethods[M]["result"]> {
    const child = this.child;
    if (!child || !child.connected) return Promise.reject(new WorkerError("browser worker not running", "unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerError(`browser worker call ${method} timed out`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.send({ id, method, params });
    });
  }

  private onMessage(m: IpcFromWorker) {
    if ("event" in m) {
      if (m.event === "health") {
        this.health_ = m.health;
        this.emit("health", m.health);
      } else {
        this.emit(m.event, m);
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new WorkerError(m.error, m.code));
  }
}
