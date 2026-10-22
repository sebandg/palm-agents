// App state + SSE connection with cursor resume.
import { signal, computed } from "@preact/signals";
import type { HealthReport, OwnershipRecord, StreamEnvelope } from "@palm-agents/protocol";
import { api } from "./api.ts";

export type Conn = "online" | "reconnecting" | "offline";
export const authed = signal<boolean | null>(null);
export const conn = signal<Conn>("offline");
export const lastContact = signal<string | null>(null);
export const ownership = signal<OwnershipRecord | null>(null);
export const health = signal<HealthReport | null>(null);
export const vapidPublicKey = signal<string | null>(null);
export const view = signal<"terminal" | "browser">("terminal");
/** Settings sheet (the gear). /system opens it directly (recovery bookmark). */
export const settingsOpen = signal(location.pathname === "/system");
/** Terminal sessions that currently look like they are waiting for the owner (names). */
export const termAttention = signal<string[]>([]);
/** The terminal session open in the Terminal tab (null = the session list). */
export const termOpen = signal<string | null>(null);
/** Refresh termAttention while the Terminal tab (which polls on its own) is not showing. */
export async function pollTermAttention() {
  try {
    const r = await api.get<{ sessions: Array<{ name: string; attention: boolean }> }>("/api/term");
    termAttention.value = r.sessions.filter((s) => s.attention).map((s) => s.name);
  } catch { /* offline: keep the last known */ }
}

/** An agent handed the browser over and waits for the owner. The owner browsing on their own is not "needs you". */
export const needsYou = computed(() => {
  const o = ownership.value;
  const r = o?.state === "human_control" || o?.state === "pausing" ? o.humanRequest : null;
  return r && r.requestedBy === "agent" ? r : null;
});

let cursor = 0;
let es: EventSource | null = null;
let retry = 0;

export async function loadAll(): Promise<boolean> {
  try {
    const me = await api.get<{ vapidPublicKey: string | null }>("/api/me");
    vapidPublicKey.value = me.vapidPublicKey;
    authed.value = true;
  } catch {
    authed.value = false;
    return false;
  }
  const h = await api.get<HealthReport>("/api/health");
  health.value = h;
  ownership.value = h.ownership;
  return true;
}

export function connect() {
  if (es) es.close();
  conn.value = retry === 0 ? "reconnecting" : conn.value;
  es = new EventSource(`/api/stream?cursor=${cursor}`);
  es.addEventListener("ready", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { cursor: number; health: HealthReport };
    if (cursor === 0) cursor = d.cursor;
    health.value = d.health;
    ownership.value = d.health.ownership;
    conn.value = "online";
    lastContact.value = new Date().toISOString();
    retry = 0;
  });
  es.addEventListener("ping", () => { lastContact.value = new Date().toISOString(); });
  es.addEventListener("env", (e) => {
    const m = e as MessageEvent;
    const env = JSON.parse(m.data) as StreamEnvelope;
    if (env.cursor) cursor = Math.max(cursor, env.cursor);
    lastContact.value = new Date().toISOString();
    switch (env.kind) {
      case "ownership":
        ownership.value = env.ownership;
        if (health.value) health.value = { ...health.value, ownership: env.ownership };
        break;
      case "health":
        void api.get<HealthReport>("/api/health").then((h) => { health.value = h; }).catch(() => {});
        break;
      case "session_revoked":
        void loadAll().then((ok) => { if (!ok) clearSensitive(); });
        break;
    }
  });
  es.onerror = () => {
    conn.value = retry > 3 ? "offline" : "reconnecting";
    es?.close();
    es = null;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
    retry += 1;
    setTimeout(() => {
      if (document.visibilityState === "hidden") { retry = 0; return; }
      void api.get("/api/me").then(() => connect(), (err) => {
        if (err && (err as { status?: number }).status === 401) { authed.value = false; clearSensitive(); } else connect();
      });
    }, delay);
  };
}
export function disconnect() {
  es?.close();
  es = null;
}
export function clearSensitive() {
  ownership.value = null;
  health.value = null;
}

/** Settings: open a Terminal window on the Mac for sessions started from this phone (default on). */
export function openOnMac(): boolean {
  try { return localStorage.getItem("pa.openOnMac") !== "0"; } catch { return true; }
}
export function setOpenOnMac(on: boolean) {
  try { localStorage.setItem("pa.openOnMac", on ? "1" : "0"); } catch { /* private mode */ }
}
