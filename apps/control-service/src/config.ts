import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { findTailscale } from "./previews.ts";

export interface Config {
  dataDir: string;
  dbPath: string;
  profileDir: string;
  logDir: string;
  host: string;
  port: number;
  /** Origins allowed to make authenticated requests (scheme://host[:port]). */
  allowedOrigins: string[];
  /**
   * VAPID contact (`mailto:` or `https:` URL) sent to push services. Apple's push
   * service rejects placeholder addresses with 403 BadJwtToken, so this defaults
   * to the first HTTPS allowed origin (your Tailscale URL) when there is one.
   */
  pushContact: string;
  /** tmux binary for the Terminal view (resolved from PATH / ~/.local/bin when unset). */
  tmuxBin: string | undefined;
  /** Optional tmux socket name (`tmux -L`). Unset = the default server, so sessions the owner starts in Terminal.app are visible. */
  tmuxSocket: string | undefined;
  /** Tailscale CLI for dev-server previews; null = previews off (PALM_AGENTS_TAILSCALE=off). */
  tailscaleBin: string | null;
  secureCookies: boolean;
  headlessBrowser: boolean;
  browserChannel: string | undefined;
  sessionTtlMs: number;
  /** How long request_human from a terminal agent waits for the owner per call. */
  agentWaitMs: number;
  /** An agent that has not used the browser for this long lets go of it. */
  agentIdleMs: number;
  /** The owner browsing on their own gives the browser up to an agent after this long without input. */
  ownerIdleMs: number;
  version: string;
  webDistDir: string;
}

export function loadConfig(env = process.env): Config {
  const dataDir = env.PALM_AGENTS_DATA_DIR ?? path.join(os.homedir(), ".palm-agents");
  const port = Number(env.PALM_AGENTS_PORT ?? 8787);
  const host = env.PALM_AGENTS_HOST ?? "127.0.0.1";
  const extraOrigins = (env.PALM_AGENTS_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...extraOrigins];
  return {
    dataDir,
    dbPath: path.join(dataDir, "palm-agents.sqlite"),
    profileDir: path.join(dataDir, "browser-profile"),
    logDir: path.join(dataDir, "logs"),
    host,
    port,
    allowedOrigins,
    pushContact: env.PALM_AGENTS_PUSH_CONTACT || allowedOrigins.find((o) => o.startsWith("https://")) || "mailto:owner@localhost",
    tmuxBin: env.PALM_AGENTS_TMUX || undefined,
    tmuxSocket: env.PALM_AGENTS_TMUX_SOCKET || undefined,
    tailscaleBin: env.PALM_AGENTS_TAILSCALE === "off" ? null : findTailscale(env.PALM_AGENTS_TAILSCALE || undefined),
    secureCookies: env.PALM_AGENTS_INSECURE_COOKIES !== "1",
    headlessBrowser: env.PALM_AGENTS_HEADLESS === "1",
    browserChannel: env.PALM_AGENTS_BROWSER_CHANNEL || undefined,
    sessionTtlMs: Number(env.PALM_AGENTS_SESSION_TTL_DAYS ?? 30) * 86_400_000,
    agentWaitMs: Number(env.PALM_AGENTS_AGENT_WAIT_SEC ?? 240) * 1000,
    agentIdleMs: Number(env.PALM_AGENTS_AGENT_IDLE_SEC ?? 30) * 1000,
    ownerIdleMs: Number(env.PALM_AGENTS_OWNER_IDLE_SEC ?? 60) * 1000,
    version: "0.1.0",
    webDistDir: env.PALM_AGENTS_WEB_DIR ?? path.resolve(import.meta.dirname, "../../mobile-web/public"),
  };
}

export function ensureDirs(cfg: Config) {
  for (const d of [cfg.dataDir, cfg.profileDir, cfg.logDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  // The browser profile holds authenticated website sessions: keep it owner-only.
  fs.chmodSync(cfg.dataDir, 0o700);
  fs.chmodSync(cfg.profileDir, 0o700);
}
