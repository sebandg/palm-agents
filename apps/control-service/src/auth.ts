// Pairing + sessions + CSRF/Origin/Host enforcement.
// - Pairing: short-lived one-use numeric code generated on the Mac.
// - Sessions: random 256-bit token, stored hashed, delivered as HttpOnly cookie.
// - Mutations: require Origin in the allowlist AND the X-OA-Request header
//   (a custom header forces a CORS preflight, which same-origin-only policy denies).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Store, SessionRow } from "./store.ts";

export const SESSION_COOKIE = "pa_session";
export const PAIRING_TTL_MS = 5 * 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly opts: { allowedOrigins: string[]; secureCookies: boolean; sessionTtlMs: number },
  ) {}

  /** Generate an 8-digit pairing code, store its hash, return the code for local display only. */
  createPairingCode(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.store.createPairingCode(hashToken(code), PAIRING_TTL_MS);
    return { code, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() };
  }

  pair(c: Context, code: string, label: string): SessionRow | null {
    if (!/^\d{8}$/.test(code)) return null;
    if (!this.store.consumePairingCode(hashToken(code))) return null;
    const token = randomBytes(32).toString("base64url");
    const session = this.store.createSession(hashToken(token), label.slice(0, 80) || "iPhone", this.opts.sessionTtlMs);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.opts.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(this.opts.sessionTtlMs / 1000),
    });
    return session;
  }

  sessionFrom(c: Context): SessionRow | null {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token || token.length < 16) return null;
    return this.store.findSession(hashToken(token));
  }

  logout(c: Context) {
    const s = this.sessionFrom(c);
    if (s) this.store.revokeSession(s.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }

  originAllowed(origin: string | undefined): boolean {
    if (!origin) return false;
    return this.opts.allowedOrigins.some((a) => safeEq(a, origin));
  }
  hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    return this.opts.allowedOrigins.some((a) => {
      try {
        return safeEq(new URL(a).host, host);
      } catch {
        return false;
      }
    });
  }

  /** Reject requests whose Host is not one we serve (defends against DNS rebinding). */
  hostGuard(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.hostAllowed(c.req.header("host"))) return c.json({ error: "host not allowed" }, 421);
      await next();
    };
  }

  /** Cookie session required. Mutations additionally need Origin + custom header. */
  requireSession(): MiddlewareHandler {
    return async (c, next) => {
      const session = this.sessionFrom(c);
      if (!session) return c.json({ error: "unauthenticated" }, 401);
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        const origin = c.req.header("origin");
        if (!this.originAllowed(origin)) return c.json({ error: "origin not allowed" }, 403);
        if (c.req.header("x-pa-request") !== "1") return c.json({ error: "missing request header" }, 403);
        const ct = c.req.header("content-type") ?? "";
        if (c.req.header("content-length") !== "0" && ct && !ct.startsWith("application/json")) return c.json({ error: "json only" }, 415);
      }
      c.set("session", session);
      await next();
    };
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
