import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { bootTestEnv, client, type TestEnv } from "./helpers.ts";

function rawStatus(base: string, request: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => sock.write(request));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
    sock.on("error", reject);
  });
}

let env: TestEnv;
beforeAll(async () => { env = await bootTestEnv({ browser: false }); });
afterAll(async () => { await env.cleanup(); });

describe("access control", () => {
  it("unpaired client cannot read tasks, frames, events or send commands", async () => {
    for (const p of ["/api/tasks", "/api/health", "/api/browser/frame", "/api/stream"]) {
      const r = await fetch(env.base + p);
      expect(r.status, p).toBe(401);
    }
    const r = await fetch(env.base + "/api/tasks", { method: "POST", headers: { "content-type": "application/json", origin: env.origin, "x-pa-request": "1" }, body: JSON.stringify({ clientRequestId: "abcdefgh1", runtime: "mock", prompt: "x" }) });
    expect(r.status).toBe(401);
  });
  it("ping is the only unauthenticated endpoint and leaks no state", async () => {
    const r = await fetch(env.base + "/api/ping");
    expect(r.status).toBe(200);
    expect(Object.keys((await r.json()) as object)).toEqual(["ok", "version"]);
  });
  it("pairing codes are one-use and invalid codes are rejected", async () => {
    const { code } = env.app.auth.createPairingCode();
    const ok = await fetch(env.base + "/api/pair", { method: "POST", headers: { "content-type": "application/json", origin: env.origin }, body: JSON.stringify({ code }) });
    expect(ok.status).toBe(200);
    const again = await fetch(env.base + "/api/pair", { method: "POST", headers: { "content-type": "application/json", origin: env.origin }, body: JSON.stringify({ code }) });
    expect(again.status).toBe(401);
    const bad = await fetch(env.base + "/api/pair", { method: "POST", headers: { "content-type": "application/json", origin: env.origin }, body: JSON.stringify({ code: "00000000" }) });
    expect(bad.status).toBe(401);
  });
  it("rejects bad Origin, missing CSRF header, and bad Host on mutations", async () => {
    const c = client(env);
    const badOrigin = await c.post("/api/tasks", { clientRequestId: "abcdefgh2", runtime: "mock", prompt: "x" }, { origin: "https://evil.example" });
    expect(badOrigin.status).toBe(403);
    const noHeader = await fetch(env.base + "/api/tasks", { method: "POST", headers: { cookie: env.cookie, origin: env.origin, "content-type": "application/json" }, body: "{}" });
    expect(noHeader.status).toBe(403);
    // fetch() refuses to set Host, so use a raw socket for the DNS-rebinding check.
    const badHost = await rawStatus(env.base, "GET /api/health HTTP/1.1\r\nHost: evil.example\r\nCookie: " + env.cookie + "\r\nConnection: close\r\n\r\n");
    expect(badHost).toBe(421);
    // A form post (non-JSON) with a cookie cannot mutate either.
    const form = await fetch(env.base + "/api/tasks", { method: "POST", headers: { cookie: env.cookie, origin: env.origin, "x-pa-request": "1", "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(415);
  });
  it("revoked session loses access promptly", async () => {
    const { code } = env.app.auth.createPairingCode();
    const r = await fetch(env.base + "/api/pair", { method: "POST", headers: { "content-type": "application/json", origin: env.origin }, body: JSON.stringify({ code, label: "second" }) });
    const cookie2 = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const c2 = client(env, cookie2);
    expect((await c2.get("/api/health")).status).toBe(200);
    const sessions = (await (await c2.get("/api/sessions")).json()) as { current: string };
    const rev = await client(env).post(`/api/sessions/${sessions.current}/revoke`);
    expect(rev.status).toBe(200);
    expect((await c2.get("/api/health")).status).toBe(401);
  });
  it("security headers and CSP are present", async () => {
    const r = await client(env).get("/api/health");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("bridge endpoint rejects missing/invalid tokens", async () => {
    const r = await fetch(env.base + "/bridge/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: JSON.stringify({ tool: "browser_observe", args: {} }) });
    expect(r.status).toBe(401);
  });
});
