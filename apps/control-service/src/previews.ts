// Dev-server previews: a server an agent starts inside a terminal session (Vite, Next, …)
// can be opened in the phone's own Safari. Sharing goes through Tailscale Serve on the same
// port number, so it is reachable only from the owner's tailnet devices, never the internet.
// Only ports that belong to a process inside a tmux session can be shared, and a share is
// removed as soon as its server stops.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./log.ts";

export class PreviewError extends Error {
  constructor(message: string, public readonly code: "unavailable" | "not_found" | "busy" | "tailscale") {
    super(message);
  }
}

type Listener = { port: number; pid: number; target: string };
export type Preview = { port: number; url: string | null };

const SCAN_TTL_MS = 3_000;

export function findTailscale(explicit?: string): string | null {
  for (const c of [explicit, "/Applications/Tailscale.app/Contents/MacOS/Tailscale", path.join(os.homedir(), "Applications/Tailscale.app/Contents/MacOS/Tailscale"), "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

function run(bin: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

export interface PreviewOptions {
  /** tmux sessions and the pid of each pane's first process. */
  panePids: () => Promise<Array<{ session: string; pid: number }>>;
  tailscaleBin: string | null;
  /** Ports that are never offered (the control service itself). */
  reservedPorts: number[];
  stateFile: string;
  log: Logger;
}

export class PreviewManager {
  private shared = new Set<number>();
  private dnsName: string | null = null;
  private cache: { at: number; bySession: Map<string, Listener[]> } | null = null;
  private watcher: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PreviewOptions) {
    try { for (const p of JSON.parse(fs.readFileSync(opts.stateFile, "utf8")) as number[]) if (Number.isInteger(p)) this.shared.add(p); } catch { /* none yet */ }
  }

  get available(): boolean {
    return this.opts.tailscaleBin !== null;
  }

  /** Dev servers per session, with the URL when shared. */
  async bySession(): Promise<Map<string, Preview[]>> {
    const scan = await this.scan();
    const out = new Map<string, Preview[]>();
    for (const [session, ls] of scan) out.set(session, ls.map((l) => ({ port: l.port, url: this.shared.has(l.port) && this.dnsName ? `https://${this.dnsName}:${l.port}` : null })));
    return out;
  }

  async share(port: number): Promise<string> {
    const ts = this.requireTailscale();
    const l = [...(await this.scan(true)).values()].flat().find((x) => x.port === port);
    if (!l) throw new PreviewError(`nothing started from a terminal session is listening on port ${port}`, "not_found");
    const dns = await this.dns();
    if (!this.shared.has(port)) {
      // Never take over a port Tailscale already serves for something else (443 is this app).
      const status = JSON.parse(await run(ts, ["serve", "status", "--json"]).catch(() => "{}")) as { TCP?: Record<string, unknown> };
      if (status.TCP?.[String(port)]) throw new PreviewError(`port ${port} is already shared on the tailnet by something else`, "busy");
      await run(ts, ["serve", "--bg", `--https=${port}`, l.target]).catch((e) => { throw new PreviewError((e as Error).message, "tailscale"); });
      this.shared.add(port);
      this.save();
      this.opts.log("info", `preview shared: port ${port} on the tailnet`);
    }
    return `https://${dns}:${port}`;
  }

  async unshare(port: number): Promise<void> {
    if (!this.shared.has(port)) return;
    const ts = this.requireTailscale();
    await run(ts, ["serve", `--https=${port}`, "off"]).catch((e) => this.opts.log("warn", `stopping preview ${port}: ${(e as Error).message}`));
    this.shared.delete(port);
    this.save();
    this.opts.log("info", `preview stopped: port ${port}`);
  }

  /** Removes shares whose server has stopped (also those left over from an earlier run). */
  async sweep(): Promise<void> {
    if (this.shared.size === 0 || !this.available) return;
    const live = new Set([...(await this.scan(true)).values()].flat().map((l) => l.port));
    for (const port of [...this.shared]) if (!live.has(port)) await this.unshare(port);
  }

  start(intervalMs = 5_000) {
    void this.sweep().catch(() => {});
    this.watcher = setInterval(() => void this.sweep().catch(() => {}), intervalMs);
    this.watcher.unref();
  }
  stop() {
    if (this.watcher) clearInterval(this.watcher);
  }

  private warned = new Set<string>();
  private warnOnce(msg: string): string {
    if (!this.warned.has(msg)) { this.warned.add(msg); this.opts.log("warn", `previews: ${msg}`); }
    return "";
  }

  private requireTailscale(): string {
    if (!this.opts.tailscaleBin) throw new PreviewError("Tailscale is not installed on the Mac", "unavailable");
    return this.opts.tailscaleBin;
  }

  private async dns(): Promise<string> {
    if (this.dnsName) return this.dnsName;
    const st = JSON.parse(await run(this.requireTailscale(), ["status", "--json"])) as { Self?: { DNSName?: string } };
    const name = st.Self?.DNSName?.replace(/\.$/, "");
    if (!name) throw new PreviewError("Tailscale is not connected", "tailscale");
    this.dnsName = name;
    return name;
  }

  /** TCP listeners owned by processes that descend from a tmux pane. */
  private async scan(fresh = false): Promise<Map<string, Listener[]>> {
    if (!fresh && this.cache && Date.now() - this.cache.at < SCAN_TTL_MS) return this.cache.bySession;
    if (this.available && !this.dnsName) await this.dns().catch(() => {});
    const [panes, lsof, ps] = await Promise.all([
      this.opts.panePids().catch(() => []),
      // Absolute paths: the launchd service's PATH has no /usr/sbin.
      run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], 5_000).catch((e) => this.warnOnce(`listing ports failed: ${(e as Error).message}`)),
      run("/bin/ps", ["-axo", "pid=,ppid="], 5_000).catch((e) => this.warnOnce(`listing processes failed: ${(e as Error).message}`)),
    ]);
    const parent = new Map<number, number>();
    for (const line of ps.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) parent.set(Number(m[1]), Number(m[2]));
    }
    const paneOf = new Map(panes.map((p) => [p.pid, p.session]));
    const sessionOf = (pid: number): string | null => {
      for (let p = pid, hops = 0; p > 1 && hops < 64; p = parent.get(p) ?? 0, hops++) {
        const s = paneOf.get(p);
        if (s) return s;
      }
      return null;
    };
    // lsof -F: "p<pid>" starts a process, "n<addr>:<port>" lists each listening socket.
    const byPort = new Map<number, { pid: number; v4: boolean; v6: boolean }>();
    let pid = 0;
    for (const line of lsof.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) {
        const m = line.slice(1).match(/^(.*):(\d+)$/);
        if (!m) continue;
        const port = Number(m[2]);
        if (port < 1024 || this.opts.reservedPorts.includes(port)) continue;
        const host = m[1]!;
        const e = byPort.get(port) ?? { pid, v4: false, v6: false };
        if (host === "*" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) e.v4 = true;
        else e.v6 = true;
        byPort.set(port, e);
      }
    }
    const bySession = new Map<string, Listener[]>();
    for (const [port, e] of byPort) {
      const s = sessionOf(e.pid);
      if (!s) continue;
      // Servers bound to "localhost" on macOS may listen on ::1 only.
      const target = e.v4 ? `http://127.0.0.1:${port}` : `http://[::1]:${port}`;
      bySession.set(s, [...(bySession.get(s) ?? []), { port, pid: e.pid, target }].sort((a, b) => a.port - b.port));
    }
    this.cache = { at: Date.now(), bySession };
    return bySession;
  }

  private save() {
    try { fs.writeFileSync(this.opts.stateFile, JSON.stringify([...this.shared]), { mode: 0o600 }); } catch (e) { this.opts.log("warn", `saving previews: ${(e as Error).message}`); }
  }
}
