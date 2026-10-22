// Terminal view: a phone remote for real tmux sessions on the Mac.
// Session list → one session: the pane rendered at the phone's own width
// (we resize the tmux window to fit), a composer that types text + Enter,
// and a quick-key row for the things CLIs ask for (1/2/3, y/n, arrows, Esc, ^C).
import { useEffect, useRef, useState } from "preact/hooks";
import type { TermKey, TermScreen, TermSession } from "@palm-agents/protocol";
import { api } from "../api.ts";
import { conn, openOnMac, termAttention, termOpen } from "../state.ts";
import { renderAnsi } from "../ansi.ts";

/** Scrollback to show. Every capture (poll, keys, resize) asks for the same depth so a reply never truncates the view. */
const LINES = 1000;

/** Text sizes for the terminal (px), remembered on this phone. Bigger text means fewer columns. */
const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18];
const DEFAULT_FONT = 12;
function savedFont(): number {
  try { const n = Number(localStorage.getItem("pa.termFont")); return FONT_SIZES.includes(n) ? n : DEFAULT_FONT; } catch { return DEFAULT_FONT; }
}
/** Claude Code's Ctrl+O view shows every tool call with its full output; its footer says so. */
const DETAIL_RE = /Showing detailed transcript/;

const ACTIVITY: Record<TermSession["activity"], string> = { working: "working", waiting: "needs you", idle: "idle" };

type TermList = { available: boolean; version: string | null; previewsAvailable?: boolean; sessions: TermSession[]; error?: string };

const QUICK: Array<{ label: string; keys?: TermKey[]; text?: string; title: string }> = [
  { label: "Esc", keys: ["Escape"], title: "Escape" },
  { label: "⌫", keys: ["BSpace"], title: "Backspace" },
  // Claude Code clears its whole (multi-line) input on Esc Esc; Ctrl+U only clears one line.
  { label: "Clear", keys: ["Escape", "Escape"], title: "Clear Claude's input (Esc Esc)" },
  { label: "Tab", keys: ["Tab"], title: "Tab" },
  { label: "⇧Tab", keys: ["BTab"], title: "Shift+Tab (cycle modes)" },
  { label: "↑", keys: ["Up"], title: "Up" },
  { label: "↓", keys: ["Down"], title: "Down" },
  { label: "←", keys: ["Left"], title: "Left" },
  { label: "→", keys: ["Right"], title: "Right" },
  { label: "PgUp", keys: ["PageUp"], title: "Page Up (scroll back in fullscreen apps)" },
  { label: "PgDn", keys: ["PageDown"], title: "Page Down" },
  { label: "^C", keys: ["C-c"], title: "Ctrl+C" },
  { label: "1", text: "1", title: "type 1" },
  { label: "2", text: "2", title: "type 2" },
  { label: "3", text: "3", title: "type 3" },
  { label: "y", text: "y", title: "type y" },
  { label: "n", text: "n", title: "type n" },
  { label: "⏎", keys: ["Enter"], title: "Enter" },
];

export function TerminalView() {
  const [list, setList] = useState<TermList | null>(null);
  const open = termOpen.value;
  const setOpen = (n: string | null) => { termOpen.value = n; };
  const [err, setErr] = useState<string | null>(null);

  const refreshList = async () => {
    try {
      const r = await api.get<TermList>("/api/term");
      setList(r);
      termAttention.value = r.sessions.filter((s) => s.attention).map((s) => s.name);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void refreshList();
    const t = setInterval(() => { if (document.visibilityState === "visible" && !open) void refreshList(); }, 3000);
    return () => clearInterval(t);
  }, [open]);

  if (open) return <SessionView name={open} onBack={() => { setOpen(null); void refreshList(); }} />;
  return (
    <div class="term-list">
      {err && <div class="card" style="border-color:var(--bad)">{err}</div>}
      {list && !list.available && (
        <div class="card"><b>tmux is not installed on the Mac.</b><div class="muted">Terminal sessions need tmux. See docs/setup.md → Terminal sessions.</div></div>
      )}
      {list?.available && list.sessions.length === 0 && <p class="muted" style="text-align:center;margin:24px 0">No sessions yet. Start one below, or run <code>tmux new -s name</code> on the Mac.</p>}
      {list && list.sessions.map((s) => (
        <div key={s.name} class={`card session ${s.attention ? "attention" : ""}`} onClick={() => setOpen(s.name)}>
          <div class="row" style="align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div class="session-name">{s.name}<span class={`pill ${s.activity}`} style="margin-left:8px">{ACTIVITY[s.activity]}</span>{isShell(s.pane.command) && <span class="pill shell">shell</span>}</div>
              <div class="muted ellipsis">{programLabel(s.pane.command)}{s.previews?.length ? ` · serving ${s.previews.map((p) => `:${p.port}`).join(" ")}` : ""}{s.pane.title && s.pane.title !== s.pane.command ? ` · ${s.pane.title}` : ""}</div>
              <div class="muted ellipsis small">{shortPath(s.pane.path)} · {s.attached ? "also open on the Mac" : "detached"} · since {new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
            </div>
            <span class="chev">›</span>
          </div>
        </div>
      ))}
      {list?.available && <NewSession taken={list.sessions.map((x) => x.name)} onCreated={(name) => { void refreshList(); setOpen(name); }} />}
    </div>
  );
}

/** What a new session runs; add new agents here. The session is named after the choice and the folder. */
const AGENTS: Array<{ label: string; command: string; tag: string }> = [
  { label: "Claude Code", command: "claude", tag: "claude" },
  { label: "Codex", command: "codex", tag: "codex" },
  { label: "Shell", command: "", tag: "shell" },
];
const OTHER = "other";
const saved = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };

function NewSession({ taken, onCreated }: { taken: string[]; onCreated: (name: string) => void }) {
  const [show, setShow] = useState(false);
  const [cwd, setCwd] = useState(() => saved("pa.termCwd", "~"));
  const [choice, setChoice] = useState(() => saved("pa.termAgent", AGENTS[0]!.tag));
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!show) return <button class="wide" onClick={() => setShow(true)}>New session</button>;
  const agent = choice === OTHER
    ? { command: other.trim(), tag: other.trim().split(/\s+/)[0]!.split("/").pop() || "cmd" }
    : AGENTS.find((a) => a.tag === choice) ?? AGENTS[0]!;
  const create = async (e: Event) => {
    e.preventDefault();
    if (choice === OTHER && !agent.command) return;
    setBusy(true);
    setErr(null);
    const dir = cwd.trim() || "~";
    const base = `${agent.tag}-${(dir.replace(/\/+$/, "").split("/").pop() || "home").replace(/^~$/, "home")}`.replace(/[^\w-]+/g, "-").slice(0, 40); // tmux turns dots into underscores
    let name = base;
    for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
    try {
      const r = await api.post<{ session: TermSession }>("/api/term", { name, cwd: dir, command: agent.command || undefined, openOnMac: openOnMac() });
      try { localStorage.setItem("pa.termCwd", dir); localStorage.setItem("pa.termAgent", choice); } catch { /* private mode */ }
      setShow(false);
      setOther("");
      onCreated(r.session.name);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="card new-session" onSubmit={create}>
      <div class="row" style="margin-bottom:8px">
        <b class="small" style="flex:1">New session</b>
        <button type="button" class="link small" onClick={() => setShow(false)}>Cancel</button>
      </div>
      <input placeholder="folder, e.g. ~/dev/project" aria-label="Folder" value={cwd} autoCapitalize="off" autoCorrect="off" onInput={(e) => setCwd((e.target as HTMLInputElement).value)} style="margin-bottom:8px" />
      {choice === OTHER && <input placeholder="command to run" aria-label="Command" value={other} autoCapitalize="off" autoCorrect="off" onInput={(e) => setOther((e.target as HTMLInputElement).value)} style="margin-bottom:8px" />}
      {err && <div class="muted" style="color:var(--bad);margin-bottom:6px">{err}</div>}
      <div class="row">
        <select aria-label="Run" value={choice} onChange={(e) => setChoice((e.target as HTMLSelectElement).value)}>
          {AGENTS.map((a) => <option key={a.tag} value={a.tag}>{a.label}</option>)}
          <option value={OTHER}>Other command…</option>
        </select>
        <button type="submit" style="flex:0 0 auto" disabled={busy || (choice === OTHER && !other.trim())}>Create</button>
      </div>
    </form>
  );
}

function SessionView({ name, onBack }: { name: string; onBack: () => void }) {
  const [screen, setScreen] = useState<TermScreen | null>(null);
  /** The grid last fitted to this phone, re-applied when typing after the Mac took the width. */
  const phoneSize = useRef<{ cols: number; rows: number } | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [previews, setPreviews] = useState<{ on: boolean; list: Preview[] }>({ on: false, list: [] });
  const photo = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stickBottom = useRef(true);
  const lastText = useRef("");
  const [font, setFontState] = useState(savedFont);
  const setFont = (step: number) => {
    const i = FONT_SIZES.indexOf(font) + step;
    const next = FONT_SIZES[Math.max(0, Math.min(FONT_SIZES.length - 1, i))]!;
    try { localStorage.setItem("pa.termFont", String(next)); } catch { /* private mode */ }
    setFontState(next);
  };

  const show = (s: TermScreen) => {
    setScreen(s);
    termAttention.value = s.attention ? Array.from(new Set([...termAttention.value, name])) : termAttention.value.filter((n) => n !== name);
    if (s.text !== lastText.current) {
      lastText.current = s.text;
      if (stickBottom.current) requestAnimationFrame(() => pre.current?.scrollTo({ top: pre.current.scrollHeight }));
    }
  };
  const refresh = async () => {
    try {
      show(await api.get<TermScreen>(`/api/term/${encodeURIComponent(name)}/screen?lines=${LINES}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  /** Fit the tmux window to this phone: measured character width → columns. */
  const fit = async () => {
    const p = pre.current, m = probe.current;
    if (!p || !m) return;
    const charW = m.getBoundingClientRect().width / 10;
    const lineH = m.getBoundingClientRect().height || 16;
    if (!charW) return;
    const cols = Math.max(40, Math.floor((p.clientWidth - 16) / charW));
    // Rows from the box itself, measured with the keyboard down (the keyboard
    // only hides part of it; resizing tmux on every keyboard toggle would redraw).
    if (document.documentElement.classList.contains("kb")) return;
    const rows = Math.max(12, Math.min(60, Math.floor((p.clientHeight - 16) / lineH)));
    phoneSize.current = { cols, rows };
    try {
      show(await api.post<TermScreen>(`/api/term/${encodeURIComponent(name)}/resize?lines=${LINES}`, { cols, rows }));
    } catch { /* an attached desktop client may own the size; keep going */ }
  };
  // Pin the app to the visible viewport while a session is open, so the iOS
  // keyboard shrinks the terminal instead of scrolling the page (and its top) away.
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    root.classList.add("term-fullscreen");
    const sync = () => {
      if (window.scrollY || (vv && vv.offsetTop)) window.scrollTo(0, 0);
      if (stickBottom.current) requestAnimationFrame(() => pre.current?.scrollTo({ top: pre.current.scrollHeight }));
    };
    sync();
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    return () => {
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      root.classList.remove("term-fullscreen");
    };
  }, []);
  useEffect(() => {
    void fit().then(refresh);
    const t = setInterval(() => { if (document.visibilityState === "visible" && !busy) void refresh(); }, 1000);
    const onResize = () => void fit();
    const onVisible = () => { if (document.visibilityState === "visible") void fit(); };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); window.removeEventListener("resize", onResize); document.removeEventListener("visibilitychange", onVisible); };
  }, [name]);

  // New text size → new character width → refit the tmux window (after the browser re-lays out).
  const fontChanged = useRef(false);
  useEffect(() => {
    if (!fontChanged.current) { fontChanged.current = true; return; }
    requestAnimationFrame(() => void fit());
  }, [font]);

  const send = async (body: { text?: string; keys?: TermKey[] }) => {
    setBusy(true);
    setErr(null);
    try {
      // The Mac took the width back since: typing here makes it the phone's again.
      const ps = phoneSize.current;
      if (ps && screen && (screen.size.cols !== ps.cols || screen.size.rows !== ps.rows)) {
        await api.post(`/api/term/${encodeURIComponent(name)}/resize?lines=${LINES}`, ps).catch(() => {});
      }
      show(await api.post<TermScreen>(`/api/term/${encodeURIComponent(name)}/keys?lines=${LINES}`, body));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    const t = text;
    if (!t) { await send({ keys: ["Enter"] }); return; }
    setText("");
    await send({ text: t, keys: ["Enter"] });
    input.current?.focus();
  };
  // Dev servers this session started, for the preview bar (the list is checked less often than the screen).
  const refreshPreviews = async () => {
    try {
      const r = await api.get<TermList>("/api/term");
      setPreviews({ on: !!r.previewsAvailable, list: r.sessions.find((x) => x.name === name)?.previews ?? [] });
    } catch { /* keep the last */ }
  };
  useEffect(() => {
    void refreshPreviews();
    const t = setInterval(() => { if (document.visibilityState === "visible") void refreshPreviews(); }, 5000);
    return () => clearInterval(t);
  }, [name]);
  const sendPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ screen: TermScreen }>(`/api/term/${encodeURIComponent(name)}/image?lines=${LINES}`, { dataBase64: await imageBase64(file) });
      show(r.screen);
      input.current?.focus();
    } catch (e) {
      setErr(`Photo not sent: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (photo.current) photo.current.value = "";
    }
  };
  const kill = async () => {
    try { await api.del(`/api/term/${encodeURIComponent(name)}`); onBack(); } catch (e) { setErr((e as Error).message); }
  };
  const onScroll = () => {
    const p = pre.current;
    if (!p) return;
    stickBottom.current = p.scrollHeight - p.scrollTop - p.clientHeight < 24;
  };

  const detailed = !!screen && DETAIL_RE.test(screen.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").filter((l) => l.trim()).slice(-6).join("\n"));
  return (
    <div class="term-session">
      <div class="term-head">
        <button class="secondary" onClick={onBack}>‹ Sessions</button>
        <div class="term-title">
          <b>{name}<span class={`dot ${conn.value}`} title={`connection: ${conn.value}`} /></b>
          <span class="muted small">{screen ? `${programLabel(screen.command)} · ${screen.size.cols}×${screen.size.rows}` : ""}{screen?.attention ? " · needs you" : ""}</span>
        </div>
        <button class="secondary" title="Smaller text" disabled={font === FONT_SIZES[0]} onClick={() => setFont(-1)}>A−</button>
        <button class="secondary" title="Bigger text" disabled={font === FONT_SIZES[FONT_SIZES.length - 1]} onClick={() => setFont(1)}>A+</button>
        {confirmKill
          ? <button class="danger" onClick={kill}>Confirm kill</button>
          : <button class="secondary" onClick={() => { setConfirmKill(true); setTimeout(() => setConfirmKill(false), 4000); }}>Kill</button>}
      </div>
      <pre ref={pre} class={`term-screen ${screen?.attention ? "attention" : ""}`} style={`font-size:${font}px`} onScroll={onScroll}>
        <span ref={probe} class="term-probe" aria-hidden="true">MMMMMMMMMM</span>
        {screen ? renderAnsi(screen.text) : "…"}
      </pre>
      {err && <div class="muted" style="color:var(--bad)">{err}</div>}
      {screen && isShell(screen.command) && (
        <div class="term-hint"><b>Shell</b>, no program running. Type <code>claude</code> ⏎ to start Claude.</div>
      )}
      <div class="term-composer">
        {/* Less frequent actions live in this menu; add new ones here rather than to the input bar. */}
        <input ref={photo} type="file" accept="image/*" hidden onChange={(e) => void sendPhoto((e.target as HTMLInputElement).files?.[0])} />
        <div class="term-menu-anchor">
          {menu && <>
            <div class="term-menu-backdrop" onClick={() => setMenu(false)} />
            <div class="term-menu card" role="menu">
              {previews.on && <PreviewItems previews={previews.list} onChange={refreshPreviews} onOpen={() => setMenu(false)} />}
              <button type="button" role="menuitem" class="secondary" disabled={busy} onClick={() => { setMenu(false); photo.current?.click(); }}>📷 Send photo or screenshot</button>
              {screen && programLabel(screen.command) === "claude" && (
                <button type="button" role="menuitem" class="secondary" disabled={busy} title="Claude's Ctrl+O" onClick={() => { setMenu(false); void send({ keys: ["C-o"] }); }}>{detailed ? "Short view" : "Full detail"} <span class="muted">(Ctrl+O)</span></button>
              )}
            </div>
          </>}
        </div>
        <div class="quick">
          <button type="button" class={menu ? "" : "secondary"} aria-label="More" style="font-size:18px;line-height:1" aria-haspopup="menu" aria-expanded={menu} title={detailed ? "More (showing full detail)" : "More"} onClick={() => setMenu(!menu)}>⋯{detailed ? <span class="menu-flag">full</span> : previews.on && previews.list.length > 0 && <span class="menu-flag">●</span>}</button>
          {QUICK.map((q) => <button key={q.label} type="button" class="secondary" title={q.title} disabled={busy} onClick={() => send(q.text ? { text: q.text } : { keys: q.keys })}>{q.label}</button>)}
        </div>
        <form class="row" onSubmit={submit}>
          <input ref={input} placeholder={screen && isShell(screen.command) ? "Shell command, ⏎ runs it" : `Type to ${screen ? programLabel(screen.command) : "the session"}, ⏎ sends`} value={text} autoCapitalize="off" autoCorrect="off" autoComplete="off" enterKeyHint="send" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <button type="submit" disabled={busy} style="flex:0 0 auto">Send</button>
        </form>
      </div>
    </div>
  );
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);
/** Human name of the foreground program. Claude Code sets its process title to its version number. */
function programLabel(cmd: string): string {
  if (/^\d+\.\d+\.\d+/.test(cmd)) return "claude";
  return cmd || "shell";
}
function isShell(cmd: string): boolean {
  return !cmd || SHELLS.has(cmd);
}

function shortPath(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

type Preview = NonNullable<TermSession["previews"]>[number];
/**
 * Menu items for the dev servers a session started: share one to the tailnet, then open it in
 * Safari (two taps: iOS only opens a new window straight from a tap, not after a request).
 */
function PreviewItems({ previews, onChange, onOpen }: { previews: Preview[]; onChange: () => void; onOpen: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (port: number, share: boolean) => {
    setBusy(port);
    setErr(null);
    try {
      if (share) await api.post(`/api/previews/${port}`);
      else await api.del(`/api/previews/${port}`);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {previews.map((p) => p.url
        ? <div key={p.port} class="row">
            <a role="menuitem" class="btn" href={p.url} target="_blank" rel="noopener" onClick={onOpen} style="flex:1">🌐 Open :{p.port} in Safari</a>
            <button type="button" role="menuitem" class="secondary" disabled={busy === p.port} onClick={() => act(p.port, false)} style="flex:0 0 auto">Stop sharing</button>
          </div>
        : <button key={p.port} type="button" role="menuitem" class="secondary" disabled={busy === p.port} onClick={() => act(p.port, true)}>{busy === p.port ? `Sharing :${p.port}…` : `🌐 Preview :${p.port} on this phone`}</button>)}
      {err && <div class="small" style="color:var(--bad)">{err}</div>}
    </>
  );
}

/** Photos go up as JPEG at most 2048 px on the long side: quick on mobile data, plenty for an agent. */
async function imageBase64(file: File): Promise<string> {
  let blob: Blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("could not encode"))), "image/jpeg", 0.88));
  } catch { /* send the original */ }
  if (blob.size > 9_000_000) throw new Error("image is too large (9 MB max)");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
