import { render } from "preact";
import { useEffect } from "preact/hooks";
import { authed, conn, connect, disconnect, health, loadAll, needsYou, pollTermAttention, settingsOpen, view, lastContact, termAttention, termOpen } from "./state.ts";
import { TerminalView } from "./views/Terminal.tsx";
import { PairView } from "./views/Pair.tsx";
import { BrowserView } from "./views/Browser.tsx";
import { SystemView } from "./views/System.tsx";

declare const __BUILD__: string;
/** The phone keeps app files cached; when the Mac has a newer build, drop the caches and reload once. */
async function checkForUpdate() {
  try {
    const { build } = (await (await fetch("/version.json", { cache: "no-store" })).json()) as { build: string };
    if (!build || build === __BUILD__ || sessionStorage.getItem("pa.reloadedFor") === build) return;
    sessionStorage.setItem("pa.reloadedFor", build);
    await navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
    if ("caches" in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    location.reload();
  } catch { /* offline or storage blocked: keep running this build */ }
}

// App height. Home Screen apps on iOS report the layout viewport (innerHeight, dvh, fixed
// bottom:0) one status bar short of the screen, which leaves an empty strip at the bottom;
// the large viewport (lvh) is the real screen. With the keyboard up, the visible part wins.
function fitApp() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const visible = vv ? vv.height : window.innerHeight;
  const kb = window.innerHeight - visible > 120;
  let h = visible;
  if ((navigator as unknown as { standalone?: boolean }).standalone && !kb) {
    const m = document.createElement("div");
    m.style.cssText = "position:absolute;top:0;width:1px;height:100lvh;visibility:hidden";
    document.body.appendChild(m);
    h = Math.max(visible, m.getBoundingClientRect().height);
    m.remove();
  }
  root.style.setProperty("--app-h", `${Math.round(h)}px`);
  root.classList.toggle("kb", kb);
}
fitApp();

/** A notification tap says where to go: ?open=browser or ?open=term:<session>. */
function openTarget(target: string | null) {
  if (target === "browser") view.value = "browser";
  else if (target?.startsWith("term:") && target.length > 5) { termOpen.value = target.slice(5); view.value = "terminal"; }
}
{
  const q = new URLSearchParams(location.search);
  if (q.has("open")) { openTarget(q.get("open")); history.replaceState(null, "", location.pathname); }
  navigator.serviceWorker?.addEventListener("message", (e) => openTarget((e.data as { open?: string | null } | null)?.open ?? null));
}
window.visualViewport?.addEventListener("resize", fitApp);
window.addEventListener("resize", fitApp);

function App() {
  useEffect(() => {
    void loadAll().then((ok) => { if (ok) connect(); });
    void checkForUpdate();
    const onVis = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
      if (document.visibilityState === "visible" && authed.value) void loadAll().then((ok) => { if (ok) connect(); });
      if (document.visibilityState === "hidden") disconnect();
    };
    document.addEventListener("visibilitychange", onVis);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // The Terminal tab polls its sessions itself; elsewhere keep "a session needs you" current.
  useEffect(() => {
    if (view.value === "terminal" || !authed.value) return;
    void pollTermAttention();
    const t = setInterval(() => { if (document.visibilityState === "visible") void pollTermAttention(); }, 5000);
    return () => clearInterval(t);
  }, [view.value, authed.value]);
  if (authed.value === null) return <p class="boot">Connecting…</p>;
  if (authed.value === false) return <PairView onPaired={() => void loadAll().then((ok) => { if (ok) connect(); })} />;
  const ny = needsYou.value;
  const waitingSession = termAttention.value.find((n) => view.value !== "terminal" || (termOpen.value !== null && n !== termOpen.value)) ?? null;
  const h = health.value;
  // One dot for "is everything OK": connection first, then the Mac's browser.
  const sys = conn.value !== "online" ? conn.value : h && h.browser.state !== "ready" ? "reconnecting" : "online";
  const toBrowser = () => { view.value = "browser"; };
  const toSession = (n: string) => { termOpen.value = n; view.value = "terminal"; };
  return (
    <>
      <header class="top">
        <h1>Palm Agents</h1>
        <span class={`sysdot ${sys}`} title={`${conn.value}${lastContact.value ? ` · ${new Date(lastContact.value).toLocaleTimeString()}` : ""}`} />
        <button class="gear secondary" aria-label="Settings" onClick={() => (settingsOpen.value = true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
        </button>
      </header>
      <main>
        {view.value !== "browser" && ny && <div class="banner"><span>{ny.holder ?? "An agent"} needs you in the browser: {ny.reason}</span><button onClick={toBrowser}>Open</button></div>}
        {!(view.value !== "browser" && ny) && waitingSession && <div class="banner"><span>{waitingSession} is waiting for you</span><button onClick={() => toSession(waitingSession)}>Open</button></div>}
        {view.value === "terminal" && <TerminalView />}
        {view.value === "browser" && <BrowserView />}
      </main>
      <nav class="tabs">
        {(["terminal", "browser"] as const).map((v) => (
          <button key={v} class={view.value === v ? "active" : ""} onClick={() => (view.value = v)}>{v[0]!.toUpperCase() + v.slice(1)}{(v === "browser" && ny) || (v === "terminal" && termAttention.value.length) ? " ●" : ""}</button>
        ))}
      </nav>
      {settingsOpen.value && (
        <div class="sheet" role="dialog" aria-label="Settings">
          <div class="sheet-head"><b>Settings</b><button class="secondary" onClick={() => { settingsOpen.value = false; if (location.pathname === "/system") history.replaceState(null, "", "/"); }}>Done</button></div>
          <div class="sheet-body"><SystemView /></div>
        </div>
      )}
    </>
  );
}
render(<App />, document.getElementById("app")!);
