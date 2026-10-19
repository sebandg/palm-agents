// Composition root (testable): builds every component and the Hono app.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HumanInputRequest, DeviceRequest, TakeControlRequest, BridgeCall, TermCreateRequest, TermImageRequest, TermKeysRequest, TermResizeRequest, type FrameMeta, type HealthReport } from "@palm-agents/protocol";
import { createPushSender, generateVapidKeys, type PushSender } from "@palm-agents/notifications";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { Store } from "./store.ts";
import { AuthService } from "./auth.ts";
import { StreamHub } from "./stream.ts";
import { BrowserSupervisor } from "./browser.ts";
import { OwnershipManager } from "./ownership.ts";
import { AgentBridge } from "./agents.ts";
import { TerminalError, TerminalManager } from "./terminal.ts";
import { PreviewError, PreviewManager } from "./previews.ts";
import { pruneUploads, saveImage } from "./uploads.ts";
import type { Logger } from "./log.ts";
import type { SessionRow } from "./store.ts";

export interface App {
  hono: Hono<{ Variables: { session: SessionRow } }>;
  store: Store;
  auth: AuthService;
  stream: StreamHub;
  browser: BrowserSupervisor;
  ownership: OwnershipManager;
  agents: AgentBridge;
  terminal: TerminalManager;
  previews: PreviewManager;
  health(): HealthReport;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export function createApp(cfg: Config, log: Logger): App {
  const startedAt = new Date().toISOString();
  const db = openDatabase(cfg.dbPath);
  const store = new Store(db);
  const auth = new AuthService(store, { allowedOrigins: cfg.allowedOrigins, secureCookies: cfg.secureCookies, sessionTtlMs: cfg.sessionTtlMs });
  const stream = new StreamHub(store);
  const browser = new BrowserSupervisor({ profileDir: cfg.profileDir, headless: cfg.headlessBrowser, channel: cfg.browserChannel }, log);
  const ownership = new OwnershipManager(store, stream, browser, log);
  const agents = new AgentBridge(cfg, ownership, browser, log);

  // ---- push (optional) -----------------------------------------------------
  let push: PushSender | null = null;
  let vapidPublic: string | null = null;
  try {
    let keys = store.getKv("vapid");
    if (!keys) {
      keys = JSON.stringify(generateVapidKeys());
      store.setKv("vapid", keys);
    }
    const parsed = JSON.parse(keys) as { publicKey: string; privateKey: string };
    vapidPublic = parsed.publicKey;
    push = createPushSender(parsed, cfg.pushContact);
  } catch (err) {
    log("warn", `push disabled: ${(err as Error).message}`);
  }
  const sendAlert = (alert: Parameters<PushSender["send"]>[1]) => {
    if (!push) return;
    for (const sub of store.listPushSubscriptions()) {
      void push.send(sub, alert).then((r) => {
        if (!r.ok) {
          log("warn", `push to subscription ${sub.id.slice(0, 8)} failed: ${r.error}`);
          if (r.gone) store.removePushSubscription(sub.id);
        }
      });
    }
  };
  agents.onAlert = sendAlert;
  const terminal = new TerminalManager({
    tmuxBin: cfg.tmuxBin,
    socketName: cfg.tmuxSocket,
    log,
    onAttention: (name) => {
      log("info", `terminal session ${name} looks like it is waiting for the owner`);
      sendAlert({ kind: "terminal", session: name });
    },
  });

  const previews = new PreviewManager({
    panePids: () => terminal.panePids(),
    tailscaleBin: cfg.tailscaleBin,
    reservedPorts: [cfg.port],
    stateFile: path.join(cfg.dataDir, "previews.json"),
    log,
  });
  const uploadsDir = path.join(cfg.dataDir, "uploads");

  // Live view: the worker screencasts only while at least one phone has the Browser tab open.
  type LiveMsg = { event: "frame"; meta: FrameMeta; jpegBase64: string } | { event: "castTick"; generation: number; tabId: string };
  const liveSubs = new Set<(m: LiveMsg) => void>();
  const setCast = (on: boolean) => { if (browser.health.state === "ready") void browser.client.call("screencast", { on }).catch(() => {}); };
  let lastLiveFrame: LiveMsg | null = null; // a still page sends no new frames, so a new viewer gets this one
  browser.client.on("frame", (m: LiveMsg) => { lastLiveFrame = m; for (const f of liveSubs) f(m); });
  browser.client.on("castTick", (m: LiveMsg) => { for (const f of liveSubs) f(m); });

  browser.onHealth = (h) => {
    stream.publish({ kind: "health", health: { browser: h } });
    if (h.state === "ready" && liveSubs.size) setCast(true); // a restarted worker starts with the screencast off
    if (h.state === "unavailable") ownership.onBrowserUnavailable();
  };
  browser.onCrash = () => ownership.onBrowserUnavailable();
  browser.onRecovered = () => ownership.onBrowserReady();

  const health = (): HealthReport => ({
    service: { ok: true, startedAt, now: new Date().toISOString(), version: cfg.version },
    browser: browser.health,
    agent: { lastContactAt: agents.lastContactAt },
    ownership: ownership.get(),
    push: { configured: push !== null, subscriptions: store.listPushSubscriptions().length },
  });

  // ---- HTTP ----------------------------------------------------------------
  const app = new Hono<{ Variables: { session: SessionRow } }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("content-security-policy", CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/bridge/")) c.header("cache-control", "no-store");
    // The app files keep fixed names, so the phone must re-check them on every load or it keeps running an old version.
    else c.header("cache-control", "no-cache");
  });
  app.use("/api/*", auth.hostGuard());
  app.onError((err, c) => {
    log("error", `request failed: ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  // Unauthenticated: liveness only, no state.
  app.get("/api/ping", (c) => c.json({ ok: true, version: cfg.version }));

  app.post("/api/pair", async (c) => {
    if (!auth.originAllowed(c.req.header("origin"))) return c.json({ error: "origin not allowed" }, 403);
    const body = z.object({ code: z.string(), label: z.string().max(80).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    const s = auth.pair(c, body.data.code, body.data.label ?? "iPhone");
    if (!s) {
      log("warn", "pairing attempt rejected");
      return c.json({ error: "invalid or expired code" }, 401);
    }
    log("info", `paired new session ${s.id.slice(0, 8)} (${s.label})`);
    return c.json({ session: s });
  });

  const api = new Hono<{ Variables: { session: SessionRow } }>();
  api.use("*", auth.requireSession());

  api.get("/me", (c) => c.json({ session: c.get("session"), vapidPublicKey: vapidPublic }));
  api.post("/logout", (c) => {
    auth.logout(c);
    return c.json({ ok: true });
  });
  api.get("/sessions", (c) => c.json({ sessions: store.listSessions(), current: c.get("session").id }));
  api.post("/sessions/:id/revoke", (c) => {
    const ok = store.revokeSession(c.req.param("id"));
    if (ok) stream.publish({ kind: "session_revoked" });
    return c.json({ ok });
  });

  api.get("/health", (c) => c.json(health()));
  api.get("/diagnostics", (c) => c.json({ health: health(), recentLog: log.recent().slice(-100) }));

  api.get("/stream", (c) => {
    const start = Number(c.req.header("last-event-id") ?? c.req.query("cursor") ?? store.latestCursor());
    return streamSSE(c, async (s) => {
      let closed = false;
      const send = (env: unknown, id?: number) => s.writeSSE({ data: JSON.stringify(env), id: id !== undefined ? String(id) : undefined, event: "env" }).catch(() => { closed = true; });
      for (const env of stream.replay(start)) await send(env, env.cursor);
      await s.writeSSE({ event: "ready", data: JSON.stringify({ cursor: store.latestCursor(), health: health() }) });
      const unsub = stream.subscribe((env) => {
        if (closed) return;
        // Revocation of *this* session must drop the stream promptly.
        if (env.kind === "session_revoked" && !store.findSession(sessionHash(c))) {
          void send(env);
          closed = true;
          return;
        }
        void send(env, env.cursor || undefined);
      });
      const ping = setInterval(() => { void s.writeSSE({ event: "ping", data: new Date().toISOString() }).catch(() => { closed = true; }); }, 15_000);
      s.onAbort(() => { closed = true; });
      while (!closed) await new Promise((r) => setTimeout(r, 500));
      clearInterval(ping);
      unsub();
    });
  });

  // ---- browser --------------------------------------------------------------
  api.get("/browser/frame", async (c) => {
    if (browser.health.state !== "ready") return c.json({ error: "browser unavailable", health: browser.health }, 503);
    try {
      const f = await browser.client.call("frame", { quality: Number(c.req.query("q") ?? 55) }, 15_000);
      return c.json({ meta: f.meta, jpegBase64: f.jpegBase64, ownership: ownership.get() });
    } catch (err) {
      return c.json({ error: (err as Error).message, health: browser.health }, 503);
    }
  });
  api.get("/browser/tabs", async (c) => {
    if (browser.health.state !== "ready") return c.json({ tabs: [], health: browser.health });
    const owners = agents.tabSessions();
    return c.json({ tabs: (await browser.client.call("tabs", {})).map((t) => ({ ...t, session: owners.get(t.id) })) });
  });
  api.post("/browser/take-control", async (c) => {
    const body = TakeControlRequest.safeParse(await c.req.json().catch(() => ({})));
    try {
      await agents.takeControl(body.success ? body.data.reason : undefined);
      return c.json({ ownership: ownership.get() });
    } catch (err) {
      return c.json({ error: (err as Error).message, ownership: ownership.get() }, 409);
    }
  });
  api.post("/browser/return-control", async (c) => {
    try {
      await agents.returnControl();
      return c.json({ ownership: ownership.get() });
    } catch (err) {
      return c.json({ error: (err as Error).message, ownership: ownership.get() }, 409);
    }
  });
  api.post("/browser/input", async (c) => {
    const body = HumanInputRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    const gate = ownership.checkHuman();
    if (!gate.ok) return c.json({ error: gate.reason }, 409);
    if (browser.health.state !== "ready") return c.json({ error: "browser unavailable" }, 503);
    const { generation, tabId, input } = body.data;
    agents.noteHumanInput();
    if (generation !== browser.health.generation) return c.json({ error: "stale frame: browser restarted; refresh" }, 409);
    try {
      const needsTab = input.type !== "select_tab";
      const r = await browser.client.call("input", { input, expect: needsTab ? { generation, tabId } : undefined }, 40_000);
      // Human-typed text and credentials are never logged or stored. Only the fact that input happened is noted.
      log("info", `human input ${input.type}${r.filled ? ` (${r.filled.join(",")})` : ""}`);
      return c.json({ meta: r.meta, filled: r.filled });
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return c.json({ error: e.message ?? "input failed", code: e.code }, e.code?.startsWith("stale") ? 409 : e.code === "no_field" ? 422 : 500);
    }
  });
  api.post("/browser/device", async (c) => {
    const body = DeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    const gate = ownership.checkHuman();
    if (!gate.ok) return c.json({ error: gate.reason }, 409);
    if (browser.health.state !== "ready") return c.json({ error: "browser unavailable" }, 503);
    try {
      const m = "desktop" in body.data ? null : body.data;
      const r = await browser.client.call("device", { mobile: m, reload: true }, 40_000);
      log("info", m ? `phone viewport ${m.width}x${m.height}` : "desktop site");
      return c.json({ meta: r.meta });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
  api.get("/browser/live", (c) => streamSSE(c, async (s) => {
    let closed = false;
    // Only the newest frame matters: a slow phone skips frames instead of queueing them.
    let pending: LiveMsg | null = null;
    let writing = false;
    const pump = async () => {
      if (writing) return;
      writing = true;
      while (pending && !closed) {
        const m = pending;
        pending = null;
        await s.writeSSE({ event: m.event, data: JSON.stringify(m.event === "frame" ? { meta: m.meta, jpegBase64: m.jpegBase64 } : { generation: m.generation, tabId: m.tabId }) }).catch(() => { closed = true; });
      }
      writing = false;
    };
    const sub = (m: LiveMsg) => {
      if (m.event === "castTick" && pending?.event === "frame") return;
      pending = m;
      void pump();
    };
    liveSubs.add(sub);
    if (liveSubs.size === 1) { lastLiveFrame = null; setCast(true); } else if (lastLiveFrame) sub(lastLiveFrame);
    s.onAbort(() => { closed = true; });
    while (!closed) await new Promise((r) => setTimeout(r, 500));
    liveSubs.delete(sub);
    if (liveSubs.size === 0) setCast(false);
  }));
  api.post("/browser/restart", async (c) => {
    log("warn", "owner requested browser restart");
    await browser.restart();
    return c.json({ health: browser.health });
  });

  // ---- push ----------------------------------------------------------------
  // ---- terminal sessions (tmux) ---------------------------------------------
  const termError = (err: unknown, c: { json: (b: unknown, s: 400 | 404 | 409 | 500 | 503) => Response }) => {
    const e = err as TerminalError;
    const status = e.code === "unavailable" ? 503 : e.code === "not_found" ? 404 : e.code === "exists" ? 409 : e.code === "bad_name" ? 400 : 500;
    return c.json({ error: e.message ?? "terminal error", code: e.code }, status);
  };
  api.get("/term", async (c) => {
    if (!terminal.available) return c.json({ available: false, version: null, sessions: [], error: "tmux is not installed" });
    try {
      const [sessions, ports] = await Promise.all([terminal.list(), previews.bySession().catch(() => new Map())]);
      return c.json({ available: true, version: await terminal.version(), previewsAvailable: previews.available, sessions: sessions.map((s) => ({ ...s, previews: ports.get(s.name) ?? [] })) });
    } catch (err) { return termError(err, c); }
  });
  api.post("/term", async (c) => {
    const body = TermCreateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request: name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,39}" }, 400);
    try {
      return c.json({ session: await terminal.create(body.data) }, 201);
    } catch (err) { return termError(err, c); }
  });
  api.get("/term/:name/screen", async (c) => {
    try {
      return c.json(await terminal.screen(c.req.param("name"), Number(c.req.query("lines") ?? 200)));
    } catch (err) { return termError(err, c); }
  });
  api.post("/term/:name/keys", async (c) => {
    const body = TermKeysRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success || (!body.data.text && !body.data.keys?.length)) return c.json({ error: "bad request" }, 400);
    try {
      await terminal.send(c.req.param("name"), body.data);
      return c.json(await terminal.screen(c.req.param("name"), Number(c.req.query("lines") ?? 200)));
    } catch (err) { return termError(err, c); }
  });
  api.post("/term/:name/resize", async (c) => {
    const body = TermResizeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    try {
      await terminal.resize(c.req.param("name"), body.data);
      return c.json(await terminal.screen(c.req.param("name"), Number(c.req.query("lines") ?? 200)));
    } catch (err) { return termError(err, c); }
  });
  // A photo or screenshot from the phone: saved owner-only, its path pasted into the prompt.
  api.post("/term/:name/image", async (c) => {
    const body = TermImageRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    let file: string;
    try {
      file = saveImage(uploadsDir, Buffer.from(body.data.dataBase64, "base64"));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    try {
      await terminal.paste(c.req.param("name"), `${file} `);
      log("info", `photo pasted into ${c.req.param("name")} (${path.basename(file)})`);
      return c.json({ path: file, screen: await terminal.screen(c.req.param("name"), Number(c.req.query("lines") ?? 200)) });
    } catch (err) {
      fs.rmSync(file, { force: true });
      return termError(err, c);
    }
  });
  // Dev-server previews over the tailnet.
  const previewError = (err: unknown, c: { json: (b: unknown, s: 400 | 404 | 409 | 502 | 503) => Response }) => {
    const e = err as PreviewError;
    return c.json({ error: e.message ?? "preview error" }, e.code === "unavailable" ? 503 : e.code === "not_found" ? 404 : e.code === "busy" ? 409 : 502);
  };
  const portParam = (v: string) => (/^\d{4,5}$/.test(v) && Number(v) <= 65535 ? Number(v) : null);
  api.post("/previews/:port", async (c) => {
    const port = portParam(c.req.param("port"));
    if (!port) return c.json({ error: "bad port" }, 400);
    try { return c.json({ url: await previews.share(port) }); } catch (err) { return previewError(err, c); }
  });
  api.delete("/previews/:port", async (c) => {
    const port = portParam(c.req.param("port"));
    if (!port) return c.json({ error: "bad port" }, 400);
    try { await previews.unshare(port); return c.json({ ok: true }); } catch (err) { return previewError(err, c); }
  });

  api.delete("/term/:name", async (c) => {
    try {
      await terminal.kill(c.req.param("name"));
      return c.json({ ok: true });
    } catch (err) { return termError(err, c); }
  });

  api.post("/push/subscribe", async (c) => {
    if (!push) return c.json({ error: "push not configured" }, 503);
    const body = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad request" }, 400);
    const sub = store.addPushSubscription(c.get("session").id, body.data.endpoint, body.data.keys);
    return c.json({ id: sub.id });
  });
  api.post("/push/unsubscribe", async (c) => {
    const body = z.object({ endpoint: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (body.success) store.removePushSubscription(body.data.endpoint);
    return c.json({ ok: true });
  });
  api.post("/push/test", async (c) => {
    if (!push) return c.json({ error: "push not configured" }, 503);
    const results = await Promise.all(store.listPushSubscriptions().map((s) => push!.send(s, { kind: "service" })));
    return c.json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });

  app.route("/api", api);

  // ---- agent bridge (agents on this machine, with the agent token) ----------
  app.post("/bridge/call", async (c) => {
    // Tailscale Serve proxies the phone's requests to this port; the bridge is for agents on this machine.
    if (c.req.header("x-forwarded-for") || c.req.header("tailscale-user-login")) return c.json({ ok: false, text: "not found" }, 404);
    const authz = c.req.header("authorization") ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (!token) return c.json({ ok: false, text: "missing bridge token" }, 401);
    const body = BridgeCall.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, text: "bad bridge call" }, 400);
    const r = await agents.call(token, body.data, c.req.header("x-palm-agents-session")?.replace(/[^\w.-]/g, "").slice(0, 64) || undefined);
    return c.json(r.body, r.status as 200);
  });

  // ---- static web app -------------------------------------------------------
  if (fs.existsSync(cfg.webDistDir)) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), cfg.webDistDir) || "." }));
    const indexHtml = path.join(cfg.webDistDir, "index.html");
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/bridge/")) return c.json({ error: "not found" }, 404);
      return c.html(fs.readFileSync(indexHtml, "utf8"));
    });
  }

  const sessionHash = (c: { req: { header: (n: string) => string | undefined } }) => {
    const m = /(?:^|;\s*)pa_session=([^;]+)/.exec(c.req.header("cookie") ?? "");
    return m?.[1] ? hashCookie(m[1]) : "";
  };

  return {
    hono: app,
    store,
    auth,
    stream,
    browser,
    ownership,
    agents,
    terminal,
    previews,
    health,
    async start() {
      agents.issueToken(path.join(cfg.dataDir, "agent-bridge-token"));
      agents.start();
      terminal.startWatching(); // alerts and activity even while no phone is looking
      previews.start(); // drops shares whose dev server stopped
      pruneUploads(uploadsDir);
      await browser.start();
    },
    async stop() {
      agents.stop();
      terminal.stopWatching();
      previews.stop();
      await browser.stop();
      db.close();
    },
  };
}

import { hashToken } from "./auth.ts";
function hashCookie(v: string) {
  return hashToken(v);
}
