import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { clearSensitive, health, authed, vapidPublicKey } from "../state.ts";

function Dot({ s }: { s: "ok" | "warn" | "bad" }) {
  return <span class={`dot ${s}`} />;
}

export function SystemView() {
  const h = health.value;
  const [sessions, setSessions] = useState<Array<{ id: string; label: string; lastSeenAt: string }>>([]);
  const [current, setCurrent] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string>("checking");
  const load = () => api.get<{ sessions: typeof sessions; current: string }>("/api/sessions").then((r) => { setSessions(r.sessions); setCurrent(r.current); }).catch(() => {});
  useEffect(() => { void load(); void checkPush(); }, []);

  async function checkPush() {
    if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) return setPushState("unsupported on this browser (iOS needs the Home Screen app)");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    setPushState(sub ? "enabled" : Notification.permission === "denied" ? "denied in settings" : "off (foreground alerts only)");
  }
  async function enablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setPushState("denied");
      const key = vapidPublicKey.value;
      if (!key) return setPushState("server has no push keys");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
      const j = sub.toJSON();
      await api.post("/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys });
      setPushState("enabled");
    } catch (e) {
      setPushState(`failed: ${(e as Error).message}`);
    }
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api.post("/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    setPushState("off (foreground alerts only)");
  }
  const act = async (p: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setMsg(null);
    try { const r = await api.post<Record<string, unknown>>(p); setMsg(JSON.stringify(r).slice(0, 200)); await load(); } catch (e) { setMsg((e as Error).message); }
  };
  const logout = async () => {
    await api.post("/api/logout").catch(() => {});
    clearSensitive();
    authed.value = false;
  };
  const ago = (iso: string | null) => (iso ? `${Math.round((Date.now() - new Date(iso).getTime()) / 1000)}s ago` : "never");

  return (
    <div class="health">
      <div class="card">
        <div><Dot s="ok" /> <b>Mac</b> v{h?.service.version} · up since {h ? new Date(h.service.startedAt).toLocaleString() : "?"}</div>
        <div class="muted">If this page does not load at all, the service is down: use launchd/SSH on the Mac (see docs/recovery.md).</div>
      </div>
      <div class="card">
        <div><Dot s={h?.browser.state === "ready" ? "ok" : h?.browser.state === "starting" ? "warn" : "bad"} /> <b>Browser</b> {h?.browser.state} · generation {h?.browser.generation} · contact {ago(h?.browser.lastContactAt ?? null)}</div>
        {h?.browser.error && <div class="small" style="color:#fca5a5">{h.browser.error}</div>}
        <div class="toolbar"><button class="secondary" onClick={() => act("/api/browser/restart", "Restart the browser worker? Open tabs reload; an agent using it gets an error and can retry. Saved logins in the profile are kept.")}>Restart browser</button></div>
      </div>
      <div class="card">
        <div><b>Agents</b> <span class="muted">· last used the browser {ago(h?.agent.lastContactAt ?? null)}</span></div>
        <div class="muted">Claude Code and Codex in terminal sessions drive the shared browser through the palm-browser tool (scripts/connect-agents.sh sets it up).</div>
      </div>
      <div class="card">
        <div><b>Background alerts</b> {pushState}</div>
        <div class="muted">"Needs you" alerts. They name the session only, never what it is doing. Requires the Home Screen app on iOS 16.4+.</div>
        <div class="toolbar"><button class="secondary" onClick={enablePush}>Enable</button><button class="secondary" onClick={disablePush}>Disable</button><button class="secondary" onClick={() => act("/api/push/test")}>Send test</button></div>
      </div>
      <div class="card">
        <div><b>Paired sessions</b></div>
        {sessions.map((s) => (
          <div key={s.id} class="row small"><span>{s.label}{s.id === current ? " (this device)" : ""} · seen {new Date(s.lastSeenAt).toLocaleString()}</span><button class="secondary" style="flex:0 0 auto" onClick={() => act(`/api/sessions/${s.id}/revoke`)}>Revoke</button></div>
        ))}
        <div class="toolbar"><button class="secondary" onClick={logout}>Log out this device</button></div>
      </div>
      {msg && <p class="muted small">{msg}</p>}
      <p class="muted small">Recovery: bookmark <code>{location.origin}/system</code> to open these settings directly. It needs the control service; if the service itself is down, use launchd or SSH.</p>
    </div>
  );
}

function urlB64ToU8(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
