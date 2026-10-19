import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import net, { type AddressInfo } from "node:net";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
import { createApp, type App } from "../apps/control-service/src/app.ts";
import { loadConfig, ensureDirs, type Config } from "../apps/control-service/src/config.ts";
import { createLogger } from "../apps/control-service/src/log.ts";
import { createFixtureServer } from "./fixtures/login-site/server.ts";

export interface TestEnv {
  app: App;
  cfg: Config;
  base: string;
  server: ServerType;
  fixtureBase: string;
  cookie: string;
  origin: string;
  dataDir: string;
  cleanup(): Promise<void>;
}

/** Boots the control service on a random loopback port with a temp data dir, pairs a session, starts the fixture site. */
export async function bootTestEnv(opts: { browser?: boolean; env?: Record<string, string> } = {}): Promise<TestEnv> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-test-"));
  const fixture = createFixtureServer();
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const fixturePort = (fixture.address() as AddressInfo).port;

  // Pick a free port for the service first so allowedOrigins is right.
  const port = await freePort();

  const cfg = loadConfig({
    PALM_AGENTS_DATA_DIR: dataDir,
    PALM_AGENTS_PORT: String(port),
    PALM_AGENTS_HEADLESS: "1",
    PALM_AGENTS_INSECURE_COOKIES: "1",
    PALM_AGENTS_WEB_DIR: path.join(dataDir, "no-web"),
    PALM_AGENTS_TAILSCALE: "off", // never touch the real tailnet from tests
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    ...(opts.env ?? {}),
  });
  ensureDirs(cfg);
  const log = createLogger(cfg.logDir, { stdout: process.env.PA_TEST_VERBOSE === "1" });
  const app = createApp(cfg, log);
  const server = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.hono.fetch, hostname: "127.0.0.1", port }, () => resolve(s)); });
  const base = `http://127.0.0.1:${port}`;
  if (opts.browser !== false) await app.start();
  else app.agents.issueToken(path.join(dataDir, "agent-bridge-token"));

  const { code } = app.auth.createPairingCode();
  const res = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ code, label: "test" }) });
  if (res.status !== 200) throw new Error(`pair failed ${res.status}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;

  return {
    app, cfg, base, server, cookie, origin: base, dataDir,
    fixtureBase: `http://127.0.0.1:${fixturePort}`,
    async cleanup() {
      await app.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => fixture.close(() => r()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function client(env: TestEnv, cookieOverride?: string) {
  const headers = (extra: Record<string, string> = {}) => ({ cookie: cookieOverride ?? env.cookie, origin: env.origin, "x-pa-request": "1", "content-type": "application/json", ...extra });
  return {
    get: (p: string) => fetch(env.base + p, { headers: { cookie: cookieOverride ?? env.cookie } }),
    post: (p: string, body: unknown = {}, extra: Record<string, string> = {}) => fetch(env.base + p, { method: "POST", headers: headers(extra), body: JSON.stringify(body) }),
    raw: (p: string, init: RequestInit) => fetch(env.base + p, init),
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, { timeout = 30_000, interval = 150, label = "condition" } = {}): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
