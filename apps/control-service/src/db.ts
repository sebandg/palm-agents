// SQLite via node:sqlite (bundled with Node 24; no native build step).
// Explicit, numbered migrations. All multi-row writes go through transaction().
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL UNIQUE, runtime TEXT NOT NULL, model TEXT,
      title TEXT NOT NULL, status TEXT NOT NULL, status_detail TEXT, provider_session_id TEXT, checkpoint TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, last_event_seq INTEGER NOT NULL DEFAULT 0,
      pending_prompt TEXT, bridge_token_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);
    CREATE TABLE IF NOT EXISTS task_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(task_id, seq)
    );
    CREATE TABLE IF NOT EXISTS stream_log (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS followups (
      client_request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tool TEXT NOT NULL, description TEXT NOT NULL, args TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decision TEXT, decided_at TEXT, decided_by_session TEXT
    );
    CREATE TABLE IF NOT EXISTS ownership (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state TEXT NOT NULL, owning_task_id TEXT, lease INTEGER NOT NULL,
      human_request TEXT, updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO ownership (singleton, state, owning_task_id, lease, human_request, updated_at)
      VALUES (1, 'recovering', NULL, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, keys_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

export function openDatabase(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

export function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
