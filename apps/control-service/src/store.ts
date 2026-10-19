// Durable state. Every method is synchronous (node:sqlite) and small; callers
// that need atomicity across methods use `tx`.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { OwnershipRecord } from "@palm-agents/protocol";
import { transaction } from "./db.ts";

const now = () => new Date().toISOString();

export interface SessionRow { id: string; label: string; createdAt: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null }
export interface StreamRow { cursor: number; kind: string; at: string; body: unknown }
export interface PushRow { id: string; sessionId: string; endpoint: string; keys: { p256dh: string; auth: string } }

export class Store {
  private txDepth = 0;
  constructor(readonly db: DatabaseSync) {}

  /** Reentrant: nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth += 1;
    try {
      return transaction(this.db, fn);
    } finally {
      this.txDepth -= 1;
    }
  }

  // ---- pairing ------------------------------------------------------------
  createPairingCode(codeHash: string, ttlMs: number) {
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(now());
    this.db.prepare("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(codeHash, now(), new Date(Date.now() + ttlMs).toISOString());
  }
  /** One-use: returns true exactly once per unexpired code. */
  consumePairingCode(codeHash: string): boolean {
    const r = this.db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(now(), codeHash, now());
    return r.changes === 1;
  }

  // ---- sessions -----------------------------------------------------------
  createSession(tokenHash: string, label: string, ttlMs: number): SessionRow {
    const id = randomUUID();
    const t = now();
    const exp = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare("INSERT INTO sessions (id, token_hash, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tokenHash, label, t, t, exp);
    return { id, label, createdAt: t, lastSeenAt: t, expiresAt: exp, revokedAt: null };
  }
  findSession(tokenHash: string): SessionRow | null {
    const r = this.db.prepare("SELECT id, label, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE token_hash = ?").get(tokenHash) as Record<string, string | null> | undefined;
    if (!r) return null;
    if (r.revoked_at || (r.expires_at as string) < now()) return null;
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now(), r.id as string);
    return { id: r.id as string, label: r.label as string, createdAt: r.created_at as string, lastSeenAt: now(), expiresAt: r.expires_at as string, revokedAt: null };
  }
  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT id, label, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now()) as Array<Record<string, string | null>>).map((r) => ({
      id: r.id as string, label: r.label as string, createdAt: r.created_at as string, lastSeenAt: r.last_seen_at as string, expiresAt: r.expires_at as string, revokedAt: null,
    }));
  }
  revokeSession(id: string): boolean {
    this.db.prepare("DELETE FROM push_subscriptions WHERE session_id = ?").run(id);
    return this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id).changes === 1;
  }

  // ---- stream ------------------------------------------------------------
  appendStream(kind: string, body: unknown): number {
    const r = this.db.prepare("INSERT INTO stream_log (kind, at, body) VALUES (?, ?, ?) RETURNING cursor").get(kind, now(), JSON.stringify(body)) as { cursor: number };
    // Keep the stream log bounded; clients that fall further behind do a full resync.
    this.db.prepare("DELETE FROM stream_log WHERE cursor < ?").run(r.cursor - 5000);
    return r.cursor;
  }
  streamAfter(cursor: number, limit = 1000): StreamRow[] {
    return (this.db.prepare("SELECT cursor, kind, at, body FROM stream_log WHERE cursor > ? ORDER BY cursor ASC LIMIT ?").all(cursor, limit) as Array<{ cursor: number; kind: string; at: string; body: string }>).map((r) => ({ ...r, body: JSON.parse(r.body) as unknown }));
  }
  latestCursor(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(cursor), 0) AS c FROM stream_log").get() as { c: number };
    return r.c;
  }

  // ---- ownership ----------------------------------------------------------
  getOwnership(): OwnershipRecord {
    const r = this.db.prepare("SELECT state, owning_task_id, lease, human_request, updated_at FROM ownership WHERE singleton = 1").get() as Record<string, string | number | null>;
    // The column names predate agents in terminal sessions (they held task ids); the values are agent session names now.
    const req = r.human_request ? (JSON.parse(r.human_request as string) as Record<string, unknown>) : null;
    return {
      state: r.state as OwnershipRecord["state"],
      holder: (r.owning_task_id as string | null) ?? null,
      lease: Number(r.lease),
      humanRequest: req ? ({ ...req, holder: (req.holder as string | null | undefined) ?? null } as NonNullable<OwnershipRecord["humanRequest"]>) : null,
      updatedAt: r.updated_at as string,
    };
  }
  setOwnership(o: Omit<OwnershipRecord, "updatedAt">): OwnershipRecord {
    const t = now();
    this.db.prepare("UPDATE ownership SET state = ?, owning_task_id = ?, lease = ?, human_request = ?, updated_at = ? WHERE singleton = 1").run(o.state, o.holder, o.lease, o.humanRequest ? JSON.stringify(o.humanRequest) : null, t);
    return { ...o, updatedAt: t };
  }

  // ---- push ---------------------------------------------------------------
  addPushSubscription(sessionId: string, endpoint: string, keys: { p256dh: string; auth: string }): PushRow {
    const id = randomUUID();
    this.db.prepare("INSERT INTO push_subscriptions (id, session_id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET session_id = excluded.session_id, keys_json = excluded.keys_json").run(id, sessionId, endpoint, JSON.stringify(keys), now());
    return { id, sessionId, endpoint, keys };
  }
  listPushSubscriptions(): PushRow[] {
    return (this.db.prepare("SELECT id, session_id, endpoint, keys_json FROM push_subscriptions").all() as Array<{ id: string; session_id: string; endpoint: string; keys_json: string }>).map((r) => ({ id: r.id, sessionId: r.session_id, endpoint: r.endpoint, keys: JSON.parse(r.keys_json) as { p256dh: string; auth: string } }));
  }
  removePushSubscription(idOrEndpoint: string) {
    this.db.prepare("DELETE FROM push_subscriptions WHERE id = ? OR endpoint = ?").run(idOrEndpoint, idOrEndpoint);
  }

  // ---- kv -----------------------------------------------------------------
  getKv(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
