// Service worker: caches ONLY static shell assets. Never caches /api, frames,
// transcripts, or anything with a cookie-authenticated response.
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
declare const __BUILD__: string;
const CACHE = `pa-static-${__BUILD__}`;
const STATIC = ["/", "/index.html", "/styles.css", "/assets/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/bridge/")) return; // network only, never cached
  if (!STATIC.includes(url.pathname) && !url.pathname.startsWith("/assets/")) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((m) => m ?? Response.error())),
  );
});
self.addEventListener("push", (e) => {
  // The payload names at most a session; show it as-is without touching app data.
  let data: { title?: string; body?: string; tag?: string; url?: string } = {};
  try { data = e.data?.json() ?? {}; } catch { /* ignore */ }
  e.waitUntil(self.registration.showNotification(data.title ?? "Palm Agents", { body: data.body ?? "Palm Agents needs your attention", tag: data.tag ?? "palm-agents", icon: "/icon.svg", data: { url: data.url ?? "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // The link only says where to go (?open=browser or ?open=term:<session>); the app still needs its session cookie.
  const url = new URL(String((e.notification.data as { url?: string } | undefined)?.url ?? "/"), self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const c = cs[0];
    if (c) {
      c.postMessage({ open: url.searchParams.get("open") });
      return c.focus();
    }
    return self.clients.openWindow(url.pathname + url.search);
  }));
});
