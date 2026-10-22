// Terminal sessions: a thin, stateless wrapper over the tmux CLI. The owner runs
// real interactive CLIs (claude, anything else) inside tmux on the Mac, from
// Terminal.app or from the phone; the phone reads the pane text and sends keys.
// Nothing here interprets the session's output or the model inside it beyond two
// heuristics on the last few lines: "looks like a prompt" and "is still changing".
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TERM_NAME_RE, type TermKey, type TermScreen, type TermSession } from "@palm-agents/protocol";
import type { Logger } from "./log.ts";

export class TerminalError extends Error {
  constructor(message: string, public readonly code: "unavailable" | "not_found" | "bad_name" | "exists" | "tmux") {
    super(message);
  }
}

export interface TerminalOptions {
  tmuxBin?: string;
  socketName?: string;
  /** Called when a session newly looks like it is waiting for the owner. */
  onAttention?: (name: string) => void;
  log?: Logger;
}

/** Lines that usually mean an interactive CLI is waiting for a human decision. */
// Checked against the last few non-empty lines only, so an answered prompt scrolling up clears it.
const ATTENTION_RE = /(\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|yes\/no|Do you want to|Would you like to|Allow .*\?|Permission|Press Enter|press enter|password:|Passcode|Esc to cancel|\(esc\)|❯ *1\. Yes|\b[123]\. (Yes|No)\b|Y\) Yes|to confirm)/i;
const ATTENTION_LINES = 3;
/** A session whose last lines changed this recently counts as working (spinners and timers tick every second). */
const WORKING_MS = 6_000;
// tmux replaces control characters in format output, so the field separator must be printable.
const SEP = "\u00a7|\u00a7";

export function findTmux(explicit?: string): string | null {
  const candidates = [explicit, ...(process.env.PATH ?? "").split(":").map((d) => path.join(d, "tmux")), path.join(os.homedir(), ".local/bin/tmux"), "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export class TerminalManager {
  private readonly bin: string | null;
  private attention = new Map<string, boolean>();
  /** Per session: the last lines seen and when they last changed. */
  private tails = new Map<string, { text: string; changedAt: number }>();
  private watcher: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TerminalOptions = {}) {
    this.bin = findTmux(opts.tmuxBin);
  }

  get available(): boolean {
    return this.bin !== null;
  }

  async version(): Promise<string | null> {
    if (!this.bin) return null;
    try {
      return (await this.tmux(["-V"])).trim();
    } catch {
      return null;
    }
  }

  /** Polls sessions so a prompt that appears while the phone is closed still raises a push alert. */
  startWatching(intervalMs = 3000) {
    if (!this.bin || this.watcher) return;
    this.watcher = setInterval(() => {
      void this.list().catch(() => []);
    }, intervalMs);
    this.watcher.unref();
  }
  stopWatching() {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  async list(): Promise<TermSession[]> {
    this.require();
    let raw: string;
    try {
      raw = await this.tmux(["list-panes", "-a", "-F", ["#{session_name}", "#{session_created}", "#{session_attached}", "#{session_windows}", "#{window_active}", "#{pane_active}", "#{pane_id}", "#{pane_current_command}", "#{pane_current_path}", "#{pane_title}", "#{pane_width}", "#{pane_height}", "#{pane_tty}"].join(SEP)]);
    } catch (err) {
      // No server running yet = no sessions, not an error.
      if (/no server running|No such file|error connecting/i.test((err as Error).message)) return [];
      throw err;
    }
    const sessions: TermSession[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [name, created, attached, windows, winActive, paneActive, id, tmuxCommand, cwd, title, cols, rows, tty] = line.split(SEP);
      if (winActive !== "1" || paneActive !== "1" || !name) continue;
      const { attention, changedAt } = await this.checkTail(name);
      const command = await foreground(tmuxCommand ?? "", tty ?? "");
      sessions.push({
        name,
        createdAt: new Date(Number(created) * 1000).toISOString(),
        attached: attached !== "0",
        windows: Number(windows),
        // tmux's default pane title is the hostname; that is noise on the phone.
        pane: { id: id ?? "", command: command ?? "", path: cwd ?? "", title: title && title !== os.hostname() ? title : "", cols: Number(cols), rows: Number(rows) },
        attention,
        activity: attention ? "waiting" : Date.now() - changedAt < WORKING_MS ? "working" : "idle",
      });
    }
    for (const known of [...this.attention.keys()]) if (!sessions.some((s) => s.name === known)) this.attention.delete(known);
    for (const known of [...this.tails.keys()]) if (!sessions.some((s) => s.name === known)) this.tails.delete(known);
    return sessions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async screen(name: string, lines = 200): Promise<TermScreen> {
    this.require();
    checkName(name);
    const n = Math.max(1, Math.min(2000, Math.floor(lines)));
    const [text, info] = await Promise.all([
      // -e keeps SGR colour sequences for the phone's renderer; heuristics run on the stripped text.
      this.tmux(["capture-pane", "-p", "-e", "-t", `=${name}:`, "-S", `-${n}`]).catch((e) => { throw notFound(e, name); }),
      this.tmux(["display-message", "-p", "-t", `=${name}:`, ["#{cursor_x}", "#{cursor_y}", "#{pane_width}", "#{pane_height}", "#{pane_current_command}", "#{pane_tty}"].join(SEP)]).catch((e) => { throw notFound(e, name); }),
    ]);
    const parts = info.trim().split(SEP);
    const [x, y, cols, rows] = parts.slice(0, 4).map(Number);
    const command = await foreground(parts[4] ?? "", parts[5] ?? "");
    const trimmed = text.replace(/\s+$/s, "");
    const attention = ATTENTION_RE.test(lastLines(stripAnsi(trimmed), ATTENTION_LINES));
    this.noteAttention(name, attention);
    return { name, command, text: trimmed, cursor: { x: x ?? 0, y: y ?? 0 }, size: { cols: cols ?? 0, rows: rows ?? 0 }, attention, capturedAt: new Date().toISOString() };
  }

  async send(name: string, input: { text?: string; keys?: TermKey[] }): Promise<void> {
    this.require();
    checkName(name);
    try {
      // `-l` = literal: the text is typed as-is, never parsed as key names. Logged only by length.
      if (input.text) await this.tmux(["send-keys", "-t", `=${name}:`, "-l", "--", input.text]);
      if (input.keys?.length) await this.tmux(["send-keys", "-t", `=${name}:`, ...input.keys]);
    } catch (e) {
      throw notFound(e, name);
    }
    this.opts.log?.("info", `terminal input ${name}: ${input.text ? `${input.text.length} chars` : ""}${input.keys?.length ? ` keys ${input.keys.join(",")}` : ""}`.trim());
    this.attention.set(name, false);
  }

  /**
   * Pastes text the way a terminal does (bracketed paste when the program asked for it), so an
   * agent treats it as pasted: Claude Code turns a pasted image path into an attached image.
   */
  async paste(name: string, text: string): Promise<void> {
    this.require();
    checkName(name);
    try {
      await this.tmux(["set-buffer", "-b", "pa-paste", "--", text]);
      await this.tmux(["paste-buffer", "-p", "-d", "-b", "pa-paste", "-t", `=${name}:`]);
    } catch (e) {
      throw notFound(e, name);
    }
    this.opts.log?.("info", `terminal paste ${name}: ${text.length} chars`);
  }

  /** Every pane's first process, for telling which session a process belongs to. */
  async panePids(): Promise<Array<{ session: string; pid: number }>> {
    if (!this.bin) return [];
    const raw = await this.tmux(["list-panes", "-a", "-F", `#{session_name}${SEP}#{pane_pid}`]).catch(() => "");
    return raw.split("\n").filter(Boolean).map((l) => { const [session, pid] = l.split(SEP); return { session: session ?? "", pid: Number(pid) }; }).filter((p) => p.session && p.pid > 0);
  }

  async create(req: { name: string; cwd?: string; command?: string; openOnMac?: boolean }): Promise<TermSession> {
    this.require();
    checkName(req.name);
    const cwd = req.cwd ? path.resolve(req.cwd.replace(/^~(?=$|\/)/, os.homedir())) : os.homedir();
    if (!fs.existsSync(cwd)) throw new TerminalError(`directory does not exist: ${cwd}`, "tmux");
    // 100x40 suits a phone in landscape; an attached desktop client may resize it later.
    const args = ["new-session", "-d", "-s", req.name, "-c", cwd, "-x", "100", "-y", "40"];
    if (req.command?.trim()) args.push(req.command.trim());
    try {
      await this.tmux(args);
    } catch (e) {
      if (/duplicate session/i.test((e as Error).message)) throw new TerminalError(`session ${req.name} already exists`, "exists");
      throw e;
    }
    this.opts.log?.("info", `terminal session created: ${req.name} (${cwd})${req.command ? ` running ${req.command.split(" ")[0]}` : ""}`);
    await this.ensureWidthHooks();
    if (req.openOnMac) await this.openOnMac(req.name).catch((e) => this.opts.log?.("warn", `could not open a Mac window for ${req.name}: ${(e as Error).message}`));
    const s = (await this.list()).find((x) => x.name === req.name);
    if (!s) throw new TerminalError("session vanished after creation", "tmux");
    return s;
  }

  /**
   * Open a Terminal window on the Mac attached to the session, in the background so it
   * does not take focus from whatever the Mac is showing. Waits until it has attached, so
   * the phone's own resize that follows wins the width.
   */
  private async openOnMac(name: string) {
    if (process.platform !== "darwin") return;
    const file = path.join(os.tmpdir(), `palm-agents-${name}-${Date.now()}.command`);
    const sock = this.opts.socketName ? ` -L ${this.opts.socketName}` : "";
    // The script deletes itself once Terminal has started it. The name is checked against TERM_NAME_RE.
    fs.writeFileSync(file, `#!/bin/zsh
rm -f "$0"
exec ${this.bin}${sock} attach -t '=${name}'
`, { mode: 0o700 });
    await new Promise<void>((resolve, reject) => execFile("open", ["-g", "-a", "Terminal", file], (err) => (err ? reject(err) : resolve())));
    for (let i = 0; i < 20; i++) {
      const clients = await this.tmux(["list-clients", "-t", `=${name}`, "-F", "#{client_name}"]).catch(() => "");
      if (clients.trim()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Whoever used the session last gets their width. The phone sets its size (below); when a
   * Mac client attaches, gets focus or is resized, these hooks hand the window back to the
   * Mac's size. Global, so they also cover sessions started at the desk.
   */
  private async ensureWidthHooks() {
    const restore = "set-option -w -u window-size";
    await this.tmux([
      "set-option", "-s", "focus-events", "on", ";",
      "set-hook", "-g", "client-attached", restore, ";",
      "set-hook", "-g", "client-focus-in", restore, ";",
      "set-hook", "-g", "client-resized", restore,
    ]).catch((e) => this.opts.log?.("warn", `could not set the tmux width hooks: ${(e as Error).message}`));
  }

  /**
   * Resize the session's window to the phone's grid. `window-size manual` keeps an attached
   * desktop client from overriding it until the Mac is used again (see ensureWidthHooks).
   */
  async resize(name: string, size: { cols: number; rows: number }): Promise<void> {
    this.require();
    checkName(name);
    try {
      await this.ensureWidthHooks();
      await this.tmux(["set-option", "-t", `=${name}:`, "window-size", "manual"]);
      await this.tmux(["resize-window", "-t", `=${name}:`, "-x", String(size.cols), "-y", String(size.rows)]);
    } catch (e) {
      throw notFound(e, name);
    }
  }

  async kill(name: string): Promise<void> {
    this.require();
    checkName(name);
    try {
      await this.tmux(["kill-session", "-t", `=${name}`]);
    } catch (e) {
      throw notFound(e, name);
    }
    this.attention.delete(name);
    this.tails.delete(name);
    this.opts.log?.("info", `terminal session killed: ${name}`);
  }

  /** Reads the last lines: do they look like a prompt, and when did they last change? */
  private async checkTail(name: string): Promise<{ attention: boolean; changedAt: number }> {
    try {
      const tail = stripAnsi((await this.tmux(["capture-pane", "-p", "-t", `=${name}:`, "-S", "-8"])).replace(/\s+$/s, ""));
      const attention = ATTENTION_RE.test(lastLines(tail, ATTENTION_LINES));
      this.noteAttention(name, attention);
      const prev = this.tails.get(name);
      // The first look has nothing to compare with: not working.
      const changedAt = !prev ? 0 : prev.text !== tail ? Date.now() : prev.changedAt;
      this.tails.set(name, { text: tail, changedAt });
      return { attention, changedAt };
    } catch {
      return { attention: false, changedAt: 0 };
    }
  }
  private noteAttention(name: string, attention: boolean) {
    const before = this.attention.get(name) ?? false;
    this.attention.set(name, attention);
    if (attention && !before) this.opts.onAttention?.(name);
  }

  private require() {
    if (!this.bin) throw new TerminalError("tmux is not installed (see docs/setup.md, Terminal sessions)", "unavailable");
  }
  // Targets: kill-session takes `=name` (exact session). Pane-level commands take `=name:`
  // (exact session, its active window and pane); a bare `=name` would match window names.
  private tmux(args: string[]): Promise<string> {
    const full = this.opts.socketName ? ["-L", this.opts.socketName, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(this.bin!, full, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TMUX: "" } }, (err, stdout, stderr) => {
        if (err) reject(new TerminalError(`tmux ${args[0]}: ${(stderr || err.message).trim()}`, "tmux"));
        else resolve(stdout);
      });
    });
  }
}

function checkName(name: string) {
  if (!TERM_NAME_RE.test(name)) throw new TerminalError("invalid session name", "bad_name");
}
function notFound(e: unknown, name: string): TerminalError {
  const m = (e as Error).message ?? "";
  return /can't find|no server running|not found|no such/i.test(m) ? new TerminalError(`no session named ${name}`, "not_found") : (e as TerminalError);
}
function stripAnsi(s: string) {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "");
}
function lastLines(s: string, n: number) {
  const lines = s.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu", "-zsh", "-bash", "login"]);
/**
 * The program in the foreground of a pane. tmux names the pane's first process, so a session
 * started as `claude; exec zsh -l` reports the wrapping shell while Claude runs; in that case
 * the terminal's foreground processes (`+` in ps's stat) say what is really running.
 */
async function foreground(tmuxCommand: string, tty: string): Promise<string> {
  if (!SHELLS.has(tmuxCommand) || !/^\/dev\/tty\w+$/.test(tty)) return tmuxCommand;
  const out = await new Promise<string>((resolve) => execFile("ps", ["-o", "pid=,ppid=,stat=,comm=", "-t", tty.slice(5)], { timeout: 3_000 }, (err, stdout) => resolve(err ? "" : stdout)));
  const procs = out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: m[1]!, ppid: m[2]!, fg: m[3]!.includes("+"), comm: path.basename(m[4]!.trim()) }));
  const fg = procs.filter((p) => p.fg && !SHELLS.has(p.comm));
  // The outermost foreground program (its parent is not itself a foreground program), e.g. claude rather than its helpers.
  const top = fg.find((p) => !fg.some((q) => q.pid === p.ppid));
  return top?.comm ?? tmuxCommand;
}
