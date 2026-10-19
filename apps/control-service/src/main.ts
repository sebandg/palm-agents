// Entry point: `node --import tsx apps/control-service/src/main.ts [pair|serve]`
import { serve } from "@hono/node-server";
import { ensureDirs, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { Store } from "./store.ts";
import { AuthService } from "./auth.ts";

// Everything this process creates (db, wal/shm, logs, profile) is owner-only.
process.umask(0o077);
const cmd = process.argv[2] ?? "serve";
const cfg = loadConfig();
ensureDirs(cfg);

if (cmd === "pair") {
  // Runs as a separate process against the same database; the service validates the code.
  const store = new Store(openDatabase(cfg.dbPath));
  const auth = new AuthService(store, { allowedOrigins: cfg.allowedOrigins, secureCookies: cfg.secureCookies, sessionTtlMs: cfg.sessionTtlMs });
  const { code, expiresAt } = auth.createPairingCode();
  console.log(`\nPalm Agents pairing code: ${code.slice(0, 4)} ${code.slice(4)}\nValid until ${expiresAt} (one use).\nOn the iPhone, open the private URL and enter this code.\n`);
  process.exit(0);
}

const log = createLogger(cfg.logDir);
const app = createApp(cfg, log);
const server = serve({ fetch: app.hono.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  log("info", `control service listening on http://${info.address}:${info.port} (data: ${cfg.dataDir})`);
});
await app.start();

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log("info", `received ${sig}; shutting down`);
  await app.stop();
  server.close();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => log("error", `uncaught exception: ${err.message}`));
process.on("unhandledRejection", (err) => log("error", `unhandled rejection: ${err instanceof Error ? err.message : String(err)}`));
