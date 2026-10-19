import { useEffect, useRef, useState } from "preact/hooks";
import type { BrowserTab, FrameMeta, OwnershipRecord } from "@palm-agents/protocol";
import { api, rid } from "../api.ts";
import { ownership, health, termOpen, view } from "../state.ts";

const STALE_MS = 6000;
const CRED_FIELDS = ["username", "password", "otp"] as const;
type CredField = (typeof CRED_FIELDS)[number];
/** Finger travel (screen px) below which a touch counts as a tap, not a swipe. */
const TAP_SLOP = 10;
/** Holding still this long turns the gesture into a press-and-drag (sliders) instead of a scroll. */
const HOLD_MS = 400;

export function BrowserView() {
  const [frame, setFrame] = useState<{ meta: FrameMeta; src: string } | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  /** The address just submitted, shown until the page reports a new URL (or the request fails). */
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  // Credential form: filled by the phone's password manager (iOS AutoFill / Bitwarden),
  // sent straight to the page's own fields. Cleared as soon as a value is used. The inputs are
  // uncontrolled and read when Fill is tapped: autofill writes several fields at once, and some
  // password managers fire no input event for the second one.
  const credForm = useRef<HTMLFormElement>(null);
  const [credMsg, setCredMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [signinOpen, setSigninOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const img = useRef<HTMLImageElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const typeBox = useRef<HTMLInputElement>(null);
  const addrBox = useRef<HTMLInputElement>(null);
  const deviceAsked = useRef(false);
  // "Desktop site" (like Safari's Request Desktop Website): remembered on this phone.
  const [desktopSite, setDesktopSiteState] = useState(() => { try { return localStorage.getItem("pa.desktopSite") === "1"; } catch { return false; } });
  const setDesktopSite = (v: boolean) => {
    try { localStorage.setItem("pa.desktopSite", v ? "1" : "0"); } catch { /* private mode */ }
    deviceAsked.current = false;
    setDesktopSiteState(v);
  };
  /** Live gesture on the screenshot: "pending" until it moves (swipe = scroll) or is held still (drag = press, move, release). */
  const drag = useRef<{ x: number; y: number; id: number; mode: "pending" | "swipe" | "drag"; timer: number; points: Array<{ x: number; y: number }> } | null>(null);
  const [holding, setHolding] = useState(false);
  const lastWasSwipe = useRef(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  // Zoom: the screenshot is shown at 1x (fit to width), 2x or 3x inside a scrollable box, so
  // small things like captchas can be seen and tapped precisely. Taps map through the image's
  // on-screen size, so they stay exact at any zoom. Swiping scrolls the page only at 1x.
  const [zoom, setZoomState] = useState(1);
  const setZoom = (z: number) => {
    const el = scroller.current;
    const cx = el ? (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth) : 0.5;
    const cy = el ? (el.scrollTop + el.clientHeight / 2) / Math.max(1, el.scrollHeight) : 0;
    setZoomState(z);
    requestAnimationFrame(() => {
      const s = scroller.current;
      if (!s) return;
      s.scrollLeft = cx * s.scrollWidth - s.clientWidth / 2;
      s.scrollTop = cy * s.scrollHeight - s.clientHeight / 2;
    });
  };
  const o = ownership.value;
  const humanControl = o?.state === "human_control";
  const unavailable = health.value?.browser.state !== "ready";

  const refresh = async () => {
    try {
      const r = await api.get<{ meta: FrameMeta; jpegBase64: string }>(`/api/browser/frame?q=${zoom > 1 ? 70 : 55}`);
      setFrame({ meta: r.meta, src: `data:image/jpeg;base64,${r.jpegBase64}` });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // Live view: the Mac pushes a frame whenever the page repaints (a still page sends a
  // heartbeat instead). Polling below only fills in when the live stream is quiet or down.
  const liveAt = useRef(0);
  const live = () => Date.now() - liveAt.current < 2500;
  useEffect(() => {
    let es: EventSource | null = null;
    const open = () => {
      if (es || document.visibilityState !== "visible") return;
      es = new EventSource("/api/browser/live");
      es.addEventListener("frame", (e) => {
        liveAt.current = Date.now();
        if (drag.current) return; // keep the image still under a moving finger
        const r = JSON.parse((e as MessageEvent).data) as { meta: FrameMeta; jpegBase64: string };
        setFrame({ meta: r.meta, src: `data:image/jpeg;base64,${r.jpegBase64}` });
      });
      es.addEventListener("castTick", () => { liveAt.current = Date.now(); });
    };
    const close = () => { es?.close(); es = null; };
    const onVis = () => (document.visibilityState === "visible" ? open() : close());
    open();
    document.addEventListener("visibilitychange", onVis);
    return () => { close(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  const loadTabs = () => api.get<{ tabs: BrowserTab[] }>("/api/browser/tabs").then((r) => setTabs(r.tabs)).catch(() => {});
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible" && !busy && !drag.current && !live()) await refresh();
      setNow(Date.now());
      if (alive) setTimeout(tick, humanControl ? 1000 : 2000);
    };
    void tick();
    void loadTabs();
    const ti = setInterval(loadTabs, 5000);
    return () => { alive = false; clearInterval(ti); };
  }, [humanControl, zoom]);

  // While the owner has control, the Mac's browser becomes a phone of this screen's size, so
  // sites serve their mobile layout and everything shows at 1:1. The server switches it back
  // to desktop for the agent as soon as control leaves the owner.
  useEffect(() => {
    if (!humanControl) { deviceAsked.current = false; return; }
    if (!frame || !!frame.meta.mobile === !desktopSite || deviceAsked.current || unavailable) return;
    const box = scroller.current;
    if (!box) return;
    deviceAsked.current = true;
    const width = Math.round(box.clientWidth);
    const height = Math.round(Math.min(width * 2.2, Math.max(420, window.innerHeight - 290)));
    setBusy(true);
    api.post("/api/browser/device", desktopSite ? { desktop: true } : { width, height })
      .then(refresh)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }, [humanControl, frame?.meta.mobile, unavailable, desktopSite]);

  const stale = !frame || now - Math.max(new Date(frame.meta.capturedAt).getTime(), liveAt.current) > STALE_MS || frame.meta.generation !== (health.value?.browser.generation ?? frame.meta.generation);
  const inputEnabled = humanControl && !stale && !unavailable && !busy;
  // Using the browser takes it: no separate "Take control" step, except that an agent in the
  // middle of using the browser is not interrupted without asking.
  const agentBusy = o?.state === "agent_control" && !!o.holder;
  const canTake = !unavailable && o?.state === "agent_control";
  const controlsEnabled = !stale && !unavailable && !busy && (humanControl || canTake);
  // The agent the owner has the browser from (it handed over, or was taken over from).
  const agentSession = humanControl ? o?.humanRequest?.holder ?? null : null;
  // An agent asking for a login or code: open the sign-in panel straight away.
  const askedAt = o?.humanRequest?.requestedBy === "agent" && humanControl && (o.humanRequest.kind === "login" || o.humanRequest.kind === "otp") ? o.humanRequest.requestedAt : null;
  useEffect(() => { if (askedAt) { setSigninOpen(true); setCredMsg(null); } }, [askedAt]);
  const openSession = (n: string) => { termOpen.value = n; view.value = "terminal"; };
  const blank = !!frame && !/^https?:/.test(frame.meta.url);
  const ensureControl = async (): Promise<boolean> => {
    if (humanControl) return true;
    if (!canTake) return false;
    if (agentBusy && !window.confirm(`${o!.holder} is using the browser. Take over?`)) return false;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ ownership: OwnershipRecord }>("/api/browser/take-control", { reason: agentBusy ? "owner took over" : "owner is browsing" });
      ownership.value = r.ownership;
      return r.ownership.state === "human_control";
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendInput = async (input: Record<string, unknown>) => {
    if (!frame) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/browser/input", { requestId: rid(), generation: frame.meta.generation, tabId: frame.meta.tabId, frameSeq: frame.meta.seq, input });
      if (!live()) await refresh(); // the live view shows the result by itself
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Screen point → page viewport pixels, through the image's on-screen bounds (exact at any zoom). */
  const toPage = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round((clientX - r.left) * (frame!.meta.viewport.width / r.width)), y: Math.round((clientY - r.top) * (frame!.meta.viewport.height / r.height)) };
  };
  const onTap = (e: MouseEvent) => {
    if (lastWasSwipe.current) { lastWasSwipe.current = false; return; }
    // First tap while watching: start browsing (the page switches to phone size), no click yet.
    if (!humanControl) { if (controlsEnabled) void ensureControl(); return; }
    if (!inputEnabled || !img.current || !frame) return;
    const { x, y } = toPage(e.clientX, e.clientY);
    // A tap on a text field focuses the type box inside this tap, the only moment iOS lets a
    // page open the keyboard. The click still goes to the page so its field gets focus too.
    const onField = frame.meta.fields?.some((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
    if (onField) typeBox.current?.focus();
    void sendInput({ type: "click", x, y, viewport: frame.meta.viewport });
  };
  // Swipe = scroll the real page, at 1x only (zoomed views pan the screenshot natively).
  const swipeable = inputEnabled && zoom === 1;
  const onPointerDown = (e: PointerEvent) => {
    if (!swipeable) return;
    const start = { x: e.clientX, y: e.clientY };
    const timer = window.setTimeout(() => {
      const d = drag.current;
      if (d && d.mode === "pending") { d.mode = "drag"; d.points = [toPage(start.x, start.y)]; setHolding(true); }
    }, HOLD_MS);
    drag.current = { ...start, id: e.pointerId, mode: "pending", timer, points: [] };
    // The image follows the finger, so the finger can leave it; capture keeps the release here.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.mode === "drag") {
      const p = toPage(e.clientX, e.clientY), last = d.points[d.points.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 4) d.points.push(p);
      return;
    }
    if (d.mode === "pending" && Math.hypot(dx, dy) > TAP_SLOP) { d.mode = "swipe"; clearTimeout(d.timer); }
    if (d.mode === "swipe") setDragOffset({ x: dx, y: dy });
  };
  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragOffset(null);
    setHolding(false);
    if (d) clearTimeout(d.timer);
    if (!d || d.id !== e.pointerId || d.mode === "pending" || !frame || !img.current) return;
    lastWasSwipe.current = true;
    setTimeout(() => { lastWasSwipe.current = false; }, 400);
    if (d.mode === "drag") {
      d.points.push(toPage(e.clientX, e.clientY));
      // Keep at most 60 points, evenly spread over the path, always including the end.
      const step = Math.ceil(d.points.length / 59);
      const pts = d.points.filter((_, i) => i % step === 0 || i === d.points.length - 1);
      if (pts.length >= 2) void sendInput({ type: "drag", points: pts, viewport: frame.meta.viewport });
      return;
    }
    const scale = frame.meta.viewport.width / img.current.getBoundingClientRect().width;
    const dy = Math.round(-(e.clientY - d.y) * scale), dx = Math.round(-(e.clientX - d.x) * scale);
    // Mostly-vertical swipes scroll vertically only, so a slightly diagonal thumb does not shift the page sideways.
    if (Math.abs(dy) >= Math.abs(dx) * 2) void sendInput({ type: "scroll", dy });
    else void sendInput({ type: "scroll", dy, dx });
  };

  const credInput = (k: CredField) => credForm.current?.elements.namedItem(k) as HTMLInputElement | null;
  const readCred = () => Object.fromEntries(CRED_FIELDS.map((k) => [k, credInput(k)?.value ?? ""])) as Record<CredField, string>;
  const clearCred = (keys: readonly CredField[]) => { for (const k of keys) { const el = credInput(k); if (el) el.value = ""; } };
  const fillCredentials = async (submit: boolean) => {
    if (!frame) return;
    const cred = readCred();
    const payload: Record<string, unknown> = { type: "fill", submit };
    for (const k of CRED_FIELDS) if (cred[k]) payload[k] = cred[k];
    if (Object.keys(payload).length === 2) { setCredMsg("Nothing to fill yet: pick a login from your password manager first."); return; }
    setBusy(true);
    setErr(null);
    setCredMsg(null);
    try {
      const r = await api.post<{ filled: Array<"username" | "password" | "otp"> }>("/api/browser/input", { requestId: rid(), generation: frame.meta.generation, tabId: frame.meta.tabId, frameSeq: frame.meta.seq, input: payload });
      // Drop what was used; keep the rest for the next page (username-first or OTP flows).
      clearCred(r.filled);
      const kept = CRED_FIELDS.filter((k) => cred[k] && !r.filled.includes(k));
      setCredMsg(`Filled ${r.filled.join(" + ")}${submit ? " and submitted" : ""}.${kept.length ? ` No ${kept.join("/")} field on this page; kept for the next step.` : ""}`);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** Type the buffer into the focused page field; `enter` also presses Enter (search boxes, chat inputs). */
  const typeText = async (enter: boolean) => {
    const t = text;
    setText(""); // clear the buffer before the request so it never lingers
    if (t) await sendInput({ type: "type", text: t, sensitive });
    if (enter) await sendInput({ type: "key", key: "Enter" });
  };
  const ret = async () => {
    setBusy(true);
    setText("");
    clearCred(CRED_FIELDS);
    setCredMsg(null);
    setSigninOpen(false);
    try { await api.post("/api/browser/return-control", {}); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const go = async (e: Event) => {
    e.preventDefault();
    // What is on screen is what goes: the field itself, not a copy that could lag behind it.
    const url = toUrl(addrBox.current?.value ?? address);
    if (!url) return;
    setEditingAddress(false);
    (document.activeElement as HTMLElement | null)?.blur();
    if (!(await ensureControl())) return;
    await open(url);
  };
  /** Navigate with the address shown at once and a spinner until the page has loaded. */
  const open = async (url: string) => {
    setPendingUrl(url);
    await sendInput({ type: "navigate", url });
    setTimeout(() => setPendingUrl(null), 400); // loaded; give the live view a moment to show it
  };

  const shownUrl = frame?.meta.url ?? "";
  /** A new address is typed in the bar: the right-hand button is Go instead of Reload. */
  const typed = editingAddress && !!address.trim() && address.trim() !== shownUrl;
  // The page moved on (a tapped link) while a typed address sat in the closed bar: show the page's.
  useEffect(() => { if (document.activeElement !== addrBox.current) setEditingAddress(false); }, [shownUrl]);
  // The page's own URL takes over once it changes (redirects included).
  const urlAtSubmit = useRef("");
  useEffect(() => {
    if (!pendingUrl) return;
    urlAtSubmit.current = shownUrl;
    const t = setTimeout(() => setPendingUrl(null), 20_000); // e.g. the same URL again: never "changes"
    return () => clearTimeout(t);
  }, [pendingUrl]);
  useEffect(() => { if (pendingUrl && shownUrl !== urlAtSubmit.current) setPendingUrl(null); }, [shownUrl]);
  useEffect(() => { if (err) setPendingUrl(null); }, [err]);
  return (
    <div>
      <form class="addr" noValidate onSubmit={go}>
        <button type="button" class="secondary" title="Back" disabled={!controlsEnabled || blank} onClick={async () => { if (await ensureControl()) await sendInput({ type: "back" }); }}><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></button>
        <input ref={addrBox} type="text" inputMode="url" enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellcheck={false} placeholder="Search or type a web address"
          // While editing, the field is left alone: the live view re-renders several times a
          // second, and rewriting the value then could put the old address back on iOS.
          value={editingAddress ? undefined : prettyUrl(pendingUrl ?? (blank ? "" : shownUrl))}
          onFocus={(e) => {
            // Select the whole address inside the tap itself: iOS ignores a later select(), which
            // left the caret at the end so a typed address was glued onto the old one.
            const el = e.target as HTMLInputElement;
            // A typed address kept from before (the keyboard was closed) stays; else the page's URL.
            const full = editingAddress ? el.value : blank ? "" : shownUrl;
            el.value = full;
            el.setSelectionRange(0, full.length);
            setAddress(full);
            setEditingAddress(true);
          }}
          // Closing the keyboard keeps a typed address (it goes with the Go button); otherwise
          // the field shows the page's address again.
          onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); setTimeout(() => { if (!v || v === shownUrl) setEditingAddress(false); }, 150); }}
          onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
        {editingAddress && address && <button type="button" class="clear" aria-label="Clear address" onMouseDown={(e) => e.preventDefault()} onClick={() => { const el = addrBox.current; if (!el) return; if (document.activeElement !== el) el.focus(); el.value = ""; setAddress(""); }}>×</button>}
        {typed
          ? <button type="submit" title="Go" aria-label="Go" onMouseDown={(e) => e.preventDefault()}><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg></button>
          : <button type="button" class="secondary" title="Reload" disabled={!controlsEnabled || blank} onClick={async () => { if (await ensureControl()) await open(shownUrl); }}>
          {pendingUrl
            ? <svg class="ico spin" viewBox="0 0 24 24" aria-label="loading"><path d="M12 4a8 8 0 1 1-8 8" /></svg>
            : <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>}
        </button>}
      </form>

      {/* Only when an agent is involved: one is using the browser, or the owner has it from one. */}
      {agentBusy && (
        <div class="card control">
          <div class="small clamp2"><b>{o!.holder} is using the browser</b> <span class="muted">Watching live.</span></div>
          <div class="row" style="margin-top:8px">
            <button class="secondary" onClick={() => openSession(o!.holder!)}>Open session</button>
            <button onClick={() => void ensureControl()} disabled={busy}>Take over</button>
          </div>
        </div>
      )}
      {agentSession && (
        <div class="card control">
          <div class="small clamp2"><b>{o!.humanRequest!.requestedBy === "agent" ? `${agentSession} needs you` : `You took over from ${agentSession}`}</b> <span class="muted">{o!.humanRequest!.requestedBy === "agent" ? o!.humanRequest!.reason : ""}</span></div>
          <div class="row" style="margin-top:8px">
            <button class="secondary" onClick={() => openSession(agentSession)}>Open session</button>
            <button onClick={ret} disabled={busy}>Hand back</button>
          </div>
        </div>
      )}

      {humanControl && !agentSession && (
        <div class="card control">
          <div class="row" style="align-items:center">
            <span class="small muted" style="flex:1">You are browsing. Agents wait until you are done.</span>
            <button style="flex:0 0 auto" onClick={ret} disabled={busy}>Done</button>
          </div>
        </div>
      )}

      {tabs.length > 1 && (
        <select value={frame?.meta.tabId} onChange={(e) => sendInput({ type: "select_tab", tabId: (e.target as HTMLSelectElement).value })} disabled={!humanControl} style="margin-bottom:8px">
          {tabs.map((t) => <option key={t.id} value={t.id}>{t.session ? `${t.session}: ` : ""}{t.title || t.url}</option>)}
        </select>
      )}

      <div class={`frame-wrap ${stale ? "stale" : ""} ${holding ? "holding" : ""}`}>
        <div ref={scroller} class="frame-scroll">
          {frame
            ? <img ref={img} src={frame.src} onClick={onTap} alt="shared browser" draggable={false}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
                class={swipeable ? "swipe" : ""}
                style={`width:${zoom * 100}%${dragOffset ? `;transform:translate(${Math.abs(dragOffset.y) >= Math.abs(dragOffset.x) * 2 ? 0 : dragOffset.x}px,${dragOffset.y}px)` : ""}`} />
            : <div style="height:240px" />}
        </div>
        {unavailable && <div class="overlay">Browser unavailable: {health.value?.browser.error ?? "starting"}. The last frame is not live.</div>}
        {!unavailable && stale && frame && <div class="overlay">Frame may be stale — input disabled until a fresh frame arrives</div>}
        {!unavailable && !stale && blank && <div class="overlay hint" style="background:transparent">Type a site or search in the bar above</div>}
        {!humanControl && !unavailable && !stale && !blank && <div class="overlay hint" style="background:transparent;align-items:flex-end;font-size:12px">{agentBusy ? `${o!.holder} is browsing` : "tap to browse"}</div>}
        {humanControl && !unavailable && frame && !frame.meta.mobile === !desktopSite && <div class="overlay hint" style="background:transparent;align-items:flex-start;font-size:12px">{desktopSite ? "switching to desktop site…" : "switching to phone size…"}</div>}
      </div>
      {/* One slim row of tools; the keyboard and sign-in panels open only when wanted. */}
      <div class="frame-tools">
        {humanControl && <button type="button" class={kbOpen ? "" : "secondary"} onClick={() => setKbOpen(!kbOpen)}>Keyboard</button>}
        {humanControl && <button type="button" class={signinOpen ? "" : "secondary"} onClick={() => setSigninOpen(!signinOpen)}>Sign in</button>}
        <button type="button" class={zoom > 1 ? "" : "secondary"} aria-label={`Zoom ${zoom}×`} onClick={() => setZoom(zoom === 3 ? 1 : zoom + 1)}>{zoom}×</button>
        {humanControl && <button type="button" class="secondary" disabled={busy || unavailable} onClick={() => setDesktopSite(!desktopSite)}>{desktopSite ? "Phone site" : "Desktop site"}</button>}
      </div>
      {err && <div class="small err">{err}</div>}

      {humanControl && (
        <div>
          {/* Rendered even when closed so a tap on a page field can focus it (iOS only opens the keyboard inside a tap). */}
          <form class={`row typebar ${kbOpen ? "" : "closed"}`} onSubmit={(e) => { e.preventDefault(); void typeText(true); }}>
            <input ref={typeBox} onFocus={() => setKbOpen(true)} type={sensitive ? "password" : "text"} autoComplete="off" autoCorrect="off" autoCapitalize="off" enterKeyHint="go"
              placeholder={sensitive ? "masked, not stored" : "Type into the page"} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
            <button type="button" class="secondary" disabled={!inputEnabled || !text} onClick={() => typeText(false)} style="flex:0 0 auto">Type</button>
          </form>
          {kbOpen && <div class="toolbar">
            {([["Tab", "Tab"], ["⌫", "Backspace"], ["Esc", "Escape"], ["⏎", "Enter"]] as const).map(([label, k]) => <button key={k} class="secondary" disabled={!inputEnabled} onClick={() => sendInput({ type: "key", key: k })}><span class={label.length === 1 ? "icon" : ""}>{label}</span></button>)}
            <label class="small mask"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive((e.target as HTMLInputElement).checked)} /> mask</label>
          </div>}
          {signinOpen && <div class="card">
            <form ref={credForm} autoComplete="on" onSubmit={(e) => { e.preventDefault(); void fillCredentials(true); }}>
              <p class="muted" style="margin:0 0 8px">Pick a login from your password manager. It goes straight into the page, not stored.</p>
              <input name="username" autoComplete="username" autoCapitalize="off" autoCorrect="off" placeholder="username or email" style="margin-bottom:6px" />
              <input name="password" type="password" autoComplete="current-password" placeholder="password" style="margin-bottom:6px" />
              <input name="otp" inputMode="text" autoCapitalize="off" autoCorrect="off" spellcheck={false} autoComplete="one-time-code" placeholder="one-time code (if asked)" style="margin-bottom:8px" />
              <div class="row">
                <button type="button" class="secondary" disabled={!inputEnabled || busy} onClick={() => fillCredentials(false)}>Fill</button>
                <button type="submit" disabled={!inputEnabled || busy}>Fill &amp; submit</button>
              </div>
              {credMsg && <div class="muted" style="margin-top:6px">{credMsg}</div>}
              {credMsg && agentSession && <div class="row" style="margin-top:8px"><span class="muted small" style="flex:1">Signed in? {agentSession} carries on once you hand back.</span><button type="button" onClick={ret} disabled={busy} style="flex:0 0 auto">Hand back</button></div>}
            </form>
          </div>}
        </div>
      )}
    </div>
  );
}

/** Address bar text → URL: full URLs pass, bare domains get https://, anything else is a search. */
function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  if (/^localhost(:\d+)?(\/.*)?$/.test(t)) return `http://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function prettyUrl(u: string): string {
  return u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}
