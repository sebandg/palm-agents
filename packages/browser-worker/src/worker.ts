// Browser worker child process. Owns one persistent Playwright context.
// Runs outside the control service's event loop so a browser hang or crash
// never takes the management interface down.
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { BrowserHealth, BrowserInput, BrowserTab, FrameMeta, Observation } from "@palm-agents/protocol";
import { WorkerError, type FillField, type IpcFromWorker, type IpcRequest, type WorkerMethodName } from "./ipc.ts";

const PROFILE_DIR = process.env.PALM_AGENTS_PROFILE_DIR;
const HEADLESS = process.env.PALM_AGENTS_HEADLESS === "1";
const CHANNEL = process.env.PALM_AGENTS_BROWSER_CHANNEL; // e.g. "chrome" to use installed Google Chrome
const VIEWPORT = { width: Number(process.env.PALM_AGENTS_VIEWPORT_W ?? 1024), height: Number(process.env.PALM_AGENTS_VIEWPORT_H ?? 768) };
const OP_TIMEOUT_MS = 30_000;

if (!PROFILE_DIR) throw new Error("PALM_AGENTS_PROFILE_DIR is required");
/** The selected tab's last web address, reopened after a restart (like "continue where you left off"). */
const LAST_URL_FILE = path.join(path.dirname(PROFILE_DIR), "browser-last-url.txt");
if (!process.send) throw new Error("browser worker must be started with an IPC channel");

let context: BrowserContext | null = null;
let generation = Number(process.env.PALM_AGENTS_BROWSER_GENERATION ?? 0);
let frameSeq = 0;
let state: BrowserHealth["state"] = "stopped";
let lastError: string | null = null;
let lastContactAt: string | null = null;
let selectedPage: Page | null = null;
const pageIds = new WeakMap<Page, string>();
let nextPageId = 1;
/** Refs from the most recent observation; invalidated on navigation. */
let refPage: Page | null = null;
let refsValid = false;
/** Phone emulation while the owner has control (null = desktop viewport for the agent). */
let mobile: { width: number; height: number } | null = null;
const MOBILE_DPR = 3;
/** Per-page DevTools sessions holding the phone overrides; detaching one drops them. */
const emuSessions = new WeakMap<Page, CDPSession>();

function send(msg: IpcFromWorker) {
  process.send!(msg);
}
function health(): BrowserHealth {
  return { state, generation, lastContactAt, error: lastError, profileDir: PROFILE_DIR ?? null };
}
function publishHealth() {
  send({ event: "health", health: health() });
}
function touch() {
  lastContactAt = new Date().toISOString();
}
function idFor(page: Page): string {
  let id = pageIds.get(page);
  if (!id) {
    id = `t${nextPageId++}`;
    pageIds.set(page, id);
  }
  return id;
}
function livePages(): Page[] {
  return context ? context.pages().filter((p) => !p.isClosed()) : [];
}
function current(): Page {
  if (!context || state !== "ready") throw new WorkerError("browser unavailable", "unavailable");
  if (!selectedPage || selectedPage.isClosed()) {
    const pages = livePages();
    selectedPage = pages[pages.length - 1] ?? null;
    if (!selectedPage) throw new WorkerError("no open tab", "no_tab");
  }
  return selectedPage;
}
function tabs(): BrowserTab[] {
  const cur = selectedPage && !selectedPage.isClosed() ? selectedPage : null;
  return livePages().map((p) => ({ id: idFor(p), url: p.url(), title: safeTitle(p), selected: p === cur }));
}
function safeTitle(p: Page): string {
  // title() is async; we keep a cached title via a cheap evaluate on frame capture. Fallback to URL.
  return titleCache.get(p) ?? p.url();
}
const titleCache = new WeakMap<Page, string>();

function wirePage(page: Page) {
  idFor(page);
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      if (refPage === page) refsValid = false;
      if (page === selectedPage && /^https?:/.test(page.url())) {
        try { fs.writeFileSync(LAST_URL_FILE, page.url(), { mode: 0o600 }); } catch { /* best effort */ }
      }
    }
  });
  page.on("close", () => {
    if (selectedPage === page) selectedPage = null;
  });
  page.on("dialog", async (d) => {
    // Native JS dialogs would otherwise block the page. Dismiss and report via title cache.
    titleCache.set(page, `[dialog dismissed: ${d.type()}] ${titleCache.get(page) ?? ""}`);
    await d.dismiss().catch(() => {});
  });
}

async function launch(): Promise<{ generation: number }> {
  if (context) return { generation };
  state = "starting";
  lastError = null;
  publishHealth();
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR!, {
      headless: HEADLESS,
      channel: CHANNEL || undefined,
      viewport: VIEWPORT,
      ignoreDefaultArgs: ["--enable-automation"],
      // Keep painting when the window is covered or in the background, so the phone's live view never freezes.
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
    });
  } catch (err) {
    context = null;
    state = "unavailable";
    const msg = err instanceof Error ? err.message : String(err);
    lastError = /SingletonLock|profile.*in use|already running|Opening in existing browser/i.test(msg)
      ? `browser profile appears to be locked by another process; not replacing it. ${msg.split("\n")[0]}`
      : msg.split("\n").slice(0, 3).join(" ");
    publishHealth();
    throw new WorkerError(lastError, "launch_failed");
  }
  generation += 1;
  frameSeq = 0;
  refsValid = false;
  for (const p of context.pages()) wirePage(p);
  context.on("page", (p) => {
    wirePage(p);
    // New tabs / popups become selectable. Do not steal selection automatically, but
    // if nothing is selected (first launch) select it.
    if (!selectedPage || selectedPage.isClosed()) selectedPage = p;
    if (mobile) void enqueue(() => emulate(p)).catch(() => {});
    publishHealth();
  });
  context.on("close", () => {
    context = null;
    selectedPage = null;
    state = "unavailable";
    lastError = lastError ?? "browser context closed unexpectedly";
    publishHealth();
  });
  if (context.pages().length === 0) {
    const p = await context.newPage();
    wirePage(p);
    selectedPage = p;
  } else {
    selectedPage = context.pages()[0] ?? null;
  }
  state = "ready";
  touch();
  publishHealth();
  // Reopen the last page instead of leaving a blank tab. Queued, so the first operation waits for it.
  let last = "";
  try { last = fs.readFileSync(LAST_URL_FILE, "utf8").trim(); } catch { /* none yet */ }
  const first = selectedPage;
  if (/^https?:\/\/\S+$/.test(last) && first && first.url() === "about:blank") {
    void enqueue(() => withTimeout(first.goto(last, { waitUntil: "domcontentloaded", timeout: 15_000 }), 20_000)).catch(() => {});
  }
  return { generation };
}

async function meta(page: Page): Promise<FrameMeta> {
  let title = "";
  try {
    title = await withTimeout(page.title(), 2_000);
  } catch {
    title = titleCache.get(page) ?? "";
  }
  titleCache.set(page, title);
  const vp = page.viewportSize() ?? VIEWPORT;
  frameSeq += 1;
  touch();
  return { generation, tabId: idFor(page), url: page.url(), title, viewport: { width: vp.width, height: vp.height }, seq: frameSeq, capturedAt: new Date().toISOString(), mobile: mobile !== null };
}

// --- live screencast ------------------------------------------------------------
// While the phone has the Browser tab open, Chromium pushes a frame whenever the page
// repaints (Page.startScreencast). At most one frame per CAST_FRAME_MS is passed on, always
// the newest, so motion stays fluid without flooding a phone on mobile data.
// It runs beside the operation queue: frames never wait for, or delay, agent work.
const CAST_FRAME_MS = 120;
const CAST_QUALITY = 55;
let castWanted = false;
let cast: { page: Page; s: CDPSession; key: string } | null = null;
let castFields: FrameMeta["fields"] = [];
let castFieldsAt = 0;
let castSyncing = false;

function castKey(page: Page) {
  return `${generation}|${idFor(page)}|${mobile ? `${mobile.width}x${mobile.height}` : "desktop"}`;
}
async function stopCast() {
  const c = cast;
  cast = null;
  if (!c) return;
  await c.s.send("Page.stopScreencast").catch(() => {});
  await c.s.detach().catch(() => {});
}
/** Keep the screencast on the selected tab at the current device size (or off). */
async function syncCast() {
  if (castSyncing) return;
  castSyncing = true;
  try {
    let page: Page | null = null;
    try { page = castWanted && context && state === "ready" ? current() : null; } catch { page = null; }
    if (!page) return void (await stopCast());
    const key = castKey(page);
    if (cast && cast.key === key && !cast.page.isClosed()) {
      send({ event: "castTick", generation, tabId: idFor(page) });
      return;
    }
    await stopCast();
    const s = await context!.newCDPSession(page);
    const c = { page, s, key };
    cast = c;
    let latest: string | null = null, lastEmit = 0, timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (cast !== c || !latest) return;
      emitCastFrame(c.page, latest);
      latest = null;
      lastEmit = Date.now();
    };
    s.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
      void s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      if (cast !== c) return;
      latest = f.data;
      if (!timer) timer = setTimeout(flush, Math.max(0, CAST_FRAME_MS - (Date.now() - lastEmit)));
    });
    const vp = mobile ?? VIEWPORT, scale = mobile ? MOBILE_DPR : 1;
    await s.send("Page.startScreencast", { format: "jpeg", quality: CAST_QUALITY, maxWidth: vp.width * scale, maxHeight: vp.height * scale, everyNthFrame: 1 });
  } catch {
    await stopCast();
  } finally {
    castSyncing = false;
  }
}
function emitCastFrame(page: Page, jpegBase64: string) {
  const now = Date.now();
  // Field rects (for opening the phone keyboard) refresh at most twice a second, off the frame path.
  if (now - castFieldsAt > 500) {
    castFieldsAt = now;
    void withTimeout(page.evaluate(FIELDS_SCRIPT), 2_000).then((f) => { castFields = f as FrameMeta["fields"]; }).catch(() => {});
  }
  const vp = page.viewportSize() ?? VIEWPORT;
  frameSeq += 1;
  touch();
  const meta: FrameMeta = { generation, tabId: idFor(page), url: page.url(), title: titleCache.get(page) ?? "", viewport: { width: vp.width, height: vp.height }, seq: frameSeq, capturedAt: new Date().toISOString(), mobile: mobile !== null, fields: castFields };
  send({ event: "frame", meta, jpegBase64 });
}
setInterval(() => void syncCast(), 1000).unref();

// Visible editable fields (viewport pixels). Runs in the page.
const FIELDS_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=range]):not([type=color]):not([type=file]), textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]')) {
    if (el.disabled || el.readOnly) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    if (out.length >= 40) break;
  }
  return out;
})()`;

async function frame(quality = 55): Promise<{ meta: FrameMeta; jpegBase64: string }> {
  const page = current();
  const emu = mobile ? emuSessions.get(page) : undefined;
  // In phone mode capture at the device pixel ratio so text stays sharp on the phone's retina screen.
  const jpegBase64 = emu
    ? ((await withTimeout(emu.send("Page.captureScreenshot", { format: "jpeg", quality }), OP_TIMEOUT_MS)) as { data: string }).data
    : (await withTimeout(page.screenshot({ type: "jpeg", quality, scale: "css", animations: "disabled", caret: "initial" }), OP_TIMEOUT_MS)).toString("base64");
  const fields = (await withTimeout(page.evaluate(FIELDS_SCRIPT), 2_000).catch(() => [])) as FrameMeta["fields"];
  return { meta: { ...(await meta(page)), fields }, jpegBase64 };
}

/** Phone identity derived from the real browser's, so the version and engine stay truthful. */
async function mobileIdentity(page: Page) {
  const real = (await page.evaluate(`({ ua: navigator.userAgent, brands: (navigator.userAgentData && navigator.userAgentData.brands) || [] })`)) as { ua: string; brands: Array<{ brand: string; version: string }> };
  const userAgent = real.ua
    .replace(/\([^)]*\)/, "(Linux; Android 14; Pixel 8)")
    .replace("HeadlessChrome", "Chrome")
    .replace(/ Safari\//, " Mobile Safari/");
  // navigator.platform must agree with the phone identity; a Mac platform under an Android UA looks like a bot.
  return { userAgent, platform: "Linux armv8l", userAgentMetadata: { platform: "Android", platformVersion: "14.0.0", architecture: "", model: "Pixel 8", mobile: true, brands: real.brands } };
}

/** Apply the current mode (phone or desktop) to one page. */
async function emulate(page: Page) {
  if (page.isClosed() || !context) return;
  const old = emuSessions.get(page);
  if (!mobile) {
    if (!old) return;
    emuSessions.delete(page);
    await old.detach().catch(() => {}); // drops our metrics, UA and touch overrides
    await page.setViewportSize(VIEWPORT); // Playwright re-applies its desktop metrics
    return;
  }
  const s = old ?? (await context.newCDPSession(page));
  emuSessions.set(page, s);
  await page.setViewportSize(mobile); // keeps Playwright's own viewport (clicks, screenshots) in step
  await s.send("Emulation.setDeviceMetricsOverride", { width: mobile.width, height: mobile.height, deviceScaleFactor: MOBILE_DPR, mobile: true });
  await s.send("Emulation.setUserAgentOverride", await mobileIdentity(page));
  await s.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

/** `reload` (default: only when becoming a phone) makes the site serve the version for the new device. */
async function setDevice(next: { width: number; height: number } | null, reload = next !== null): Promise<{ meta: FrameMeta }> {
  const page = current();
  const changed = JSON.stringify(next) !== JSON.stringify(mobile);
  mobile = next;
  if (changed) {
    for (const p of livePages()) await withTimeout(emulate(p), OP_TIMEOUT_MS).catch(() => {});
    refsValid = false;
    // Reload so the site serves the version for this device. The automatic restore when control goes
    // back to the agent skips it, so the page the owner left is not reloaded under the agent.
    if (reload && /^https?:/.test(page.url())) await withTimeout(page.reload({ timeout: 15_000, waitUntil: "domcontentloaded" }), 20_000).catch(() => {});
    await settle(page, 300);
  }
  return { meta: await meta(page) };
}

const OBSERVE_SCRIPT = `(() => {
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [contenteditable="true"], summary, [onclick]';
  const out = [];
  let i = 1;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const ref = 'e' + (i++);
    el.setAttribute('data-pa-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? ('input:' + (el.getAttribute('type') || 'text')) : tag);
    let name = el.getAttribute('aria-label') || '';
    if (!name) {
      const id = el.getAttribute('id');
      if (id) { const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (lab) name = lab.textContent || ''; }
      if (!name) { const wrap = el.closest('label'); if (wrap) name = wrap.textContent || ''; }
    }
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!name) name = (el.innerText || el.textContent || el.getAttribute('value') || '').trim();
    if (!name) name = el.getAttribute('name') || '';
    name = name.replace(/\\s+/g, ' ').slice(0, 80);
    const type = (el.getAttribute('type') || '').toLowerCase();
    let value;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = type === 'password' ? (el.value ? '[filled]' : '') : String(el.value || '').slice(0, 80);
    }
    out.push({ ref, role, name, value, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
    if (out.length >= 150) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 1500);
  return { elements: out, textSnippet: text };
})()`;

async function observe(): Promise<{ observation: Observation; jpegBase64: string; meta: FrameMeta }> {
  const page = current();
  let collected: { elements: Observation["elements"]; textSnippet: string } = { elements: [], textSnippet: "" };
  try {
    collected = (await withTimeout(page.evaluate(OBSERVE_SCRIPT), OP_TIMEOUT_MS)) as typeof collected;
    refPage = page;
    refsValid = true;
  } catch (err) {
    collected = { elements: [], textSnippet: `[observation script failed: ${(err as Error).message.split("\n")[0]}]` };
    refsValid = false;
  }
  const shot = await frame(50);
  return {
    observation: { generation, tabId: shot.meta.tabId, url: shot.meta.url, title: shot.meta.title, elements: collected.elements, textSnippet: collected.textSnippet },
    jpegBase64: shot.jpegBase64,
    meta: shot.meta,
  };
}

function requireRef(ref: string): Page {
  const page = current();
  if (!refsValid || refPage !== page) throw new WorkerError("element references are stale (page navigated or tab changed); call browser_observe again", "stale_ref");
  if (!/^e\d{1,4}$/.test(ref)) throw new WorkerError("invalid ref", "bad_ref");
  return page;
}

async function clickRef(ref: string): Promise<{ meta: FrameMeta }> {
  const page = requireRef(ref);
  const loc = page.locator(`[data-pa-ref="${ref}"]`).first();
  await withTimeout(loc.click({ timeout: 10_000 }), OP_TIMEOUT_MS);
  await settle(page);
  return { meta: await meta(page) };
}

async function typeRef(ref: string | undefined, text: string, submit?: boolean): Promise<{ meta: FrameMeta }> {
  const page = ref ? requireRef(ref) : current();
  if (ref) {
    const loc = page.locator(`[data-pa-ref="${ref}"]`).first();
    await withTimeout(loc.click({ timeout: 10_000 }), OP_TIMEOUT_MS);
    await withTimeout(loc.fill(text, { timeout: 10_000 }).catch(() => page.keyboard.type(text)), OP_TIMEOUT_MS);
  } else {
    await withTimeout(page.keyboard.type(text), OP_TIMEOUT_MS);
  }
  if (submit) {
    await page.keyboard.press("Enter");
    await settle(page);
  }
  return { meta: await meta(page) };
}

async function input(inp: BrowserInput, expect?: { generation: number; tabId: string }): Promise<{ meta: FrameMeta }> {
  const page = current();
  if (expect) {
    if (expect.generation !== generation) throw new WorkerError("input rejected: browser generation changed", "stale_generation");
    if (expect.tabId !== idFor(page)) throw new WorkerError("input rejected: selected tab changed", "stale_tab");
  }
  switch (inp.type) {
    case "click": {
      const vp = page.viewportSize() ?? VIEWPORT;
      if (inp.viewport.width !== vp.width || inp.viewport.height !== vp.height) throw new WorkerError("input rejected: viewport mismatch", "stale_viewport");
      if (inp.x < 0 || inp.y < 0 || inp.x > vp.width || inp.y > vp.height) throw new WorkerError("click outside viewport", "bad_input");
      await withTimeout(page.mouse.click(inp.x, inp.y), OP_TIMEOUT_MS);
      await settle(page, 400);
      break;
    }
    case "drag": {
      const vp = page.viewportSize() ?? VIEWPORT;
      if (inp.viewport.width !== vp.width || inp.viewport.height !== vp.height) throw new WorkerError("input rejected: viewport mismatch", "stale_viewport");
      const [first, ...rest] = inp.points;
      await page.mouse.move(first!.x, first!.y);
      await page.mouse.down();
      // Replay the finger's path with small steps in between, so the motion looks continuous to the page.
      for (const pt of rest) await page.mouse.move(pt.x, pt.y, { steps: 4 });
      await page.waitForTimeout(80);
      await page.mouse.up();
      await settle(page, 400);
      break;
    }
    case "type":
      // Sensitive or not, the worker never logs typed text.
      await withTimeout(page.keyboard.type(inp.text), OP_TIMEOUT_MS);
      break;
    case "fill":
      return fillCredentials(page, inp);
    case "key":
      await withTimeout(page.keyboard.press(inp.key), OP_TIMEOUT_MS);
      await settle(page, 400);
      break;
    case "scroll":
      await withTimeout(page.mouse.wheel(inp.dx ?? 0, inp.dy), OP_TIMEOUT_MS);
      await settle(page, 150);
      break;
    case "back":
      await withTimeout(page.goBack({ timeout: 10_000, waitUntil: "domcontentloaded" }).catch(() => null), OP_TIMEOUT_MS);
      break;
    case "navigate":
      await withTimeout(page.goto(inp.url, { timeout: 25_000, waitUntil: "domcontentloaded" }), OP_TIMEOUT_MS);
      await settle(page);
      break;
    case "select_tab": {
      const target = livePages().find((p) => idFor(p) === inp.tabId);
      if (!target) throw new WorkerError("tab not found", "no_tab");
      selectedPage = target;
      refsValid = false;
      await target.bringToFront().catch(() => {});
      return { meta: await meta(target) };
    }
  }
  return { meta: await meta(page) };
}

// Marks the page's own username / password / one-time-code inputs with data-pa-fill.
// Runs in the page; must not reference anything from this module.
const FIND_FIELDS_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  for (const el of document.querySelectorAll('[data-pa-fill]')) el.removeAttribute('data-pa-fill');
  const inputs = [...document.querySelectorAll('input')].filter((el) => !el.disabled && !el.readOnly && vis(el));
  const ac = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();
  const nm = (el) => ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  const textLike = (el) => ['text', 'email', 'tel', ''].includes(el.type) || el.getAttribute('type') === null;
  const password = inputs.find((el) => el.type === 'password');
  let otp = inputs.find((el) => ac(el) === 'one-time-code')
    || inputs.find((el) => (textLike(el) || el.type === 'number') && /otp|one.?time|passcode|code|token|2fa|mfa|verif|totp/.test(nm(el)));
  // Sites often split a code into one box per character (maxlength=1). Treat such a run of
  // boxes as one field: the first box is typed into and the page advances focus itself.
  const oneChar = (el) => el.maxLength === 1 && (textLike(el) || el.type === 'number');
  let split = [];
  if (otp && oneChar(otp)) { const i = inputs.indexOf(otp); let j = i; while (j + 1 < inputs.length && oneChar(inputs[j + 1])) j++; let k = i; while (k - 1 >= 0 && oneChar(inputs[k - 1])) k--; split = inputs.slice(k, j + 1); otp = split[0]; }
  if (!otp) { for (let i = 0; i < inputs.length; i++) { let j = i; while (j < inputs.length && oneChar(inputs[j])) j++; if (j - i >= 4) { split = inputs.slice(i, j); otp = split[0]; break; } } }
  const cands = inputs.filter((el) => el !== otp && el !== password && !split.includes(el));
  let username = cands.find((el) => ['username', 'email'].includes(ac(el)))
    || cands.find((el) => el.type === 'email')
    || cands.find((el) => textLike(el) && /user|email|login|account|mail|identifier/.test(nm(el)));
  if (!username && password) { const before = inputs.slice(0, inputs.indexOf(password)).filter((el) => textLike(el) && el !== otp); username = before[before.length - 1]; }
  if (!username && !password) { const t = cands.filter(textLike); if (t.length === 1) username = t[0]; }
  const mark = (el, key) => { if (!el) return false; el.setAttribute('data-pa-fill', key); return true; };
  return { username: mark(username, 'username'), password: mark(password, 'password'), otp: mark(otp, 'otp'), otpSplit: split.length > 1 };
})()`;

async function fillCredentials(page: Page, inp: Extract<BrowserInput, { type: "fill" }>): Promise<{ meta: FrameMeta; filled: FillField[] }> {
  const found = (await withTimeout(page.evaluate(FIND_FIELDS_SCRIPT), OP_TIMEOUT_MS)) as Record<FillField, boolean> & { otpSplit: boolean };
  const filled: FillField[] = [];
  for (const key of ["username", "password", "otp"] as const) {
    const value = inp[key];
    if (!value || !found[key]) continue;
    const loc = page.locator(`[data-pa-fill="${key}"]`).first();
    // Click like a person would, but don't depend on it: some layouts lay a transparent
    // container over the fields, which swallows the click. Focusing directly still works.
    await loc.click({ timeout: 2_000 }).catch(() => loc.focus({ timeout: 5_000 }));
    if (key === "otp" && found.otpSplit) {
      // One box per character: type the code as keystrokes so the page's own focus-advance runs.
      await withTimeout(page.keyboard.type(value.replace(/\s+/g, ""), { delay: 40 }), OP_TIMEOUT_MS);
      filled.push(key);
      continue;
    }
    // fill() replaces any stray content; fall back to key events for inputs that reject it.
    await withTimeout(loc.fill(value, { timeout: 10_000, force: true }).catch(async () => { await loc.focus(); await page.keyboard.type(value); }), OP_TIMEOUT_MS);
    // Only report a field as filled if the value really is in it (compared in the page, never logged).
    const landed = await loc.evaluate((el, v) => (el as unknown as { value: string }).value.replace(/\s+/g, "") === v.replace(/\s+/g, ""), value).catch(() => false);
    if (landed) filled.push(key);
  }
  await page.evaluate(`for (const el of document.querySelectorAll('[data-pa-fill]')) el.removeAttribute('data-pa-fill')`).catch(() => {});
  if (filled.length === 0) throw new WorkerError("no matching username, password or one-time-code field is visible on this page", "no_field");
  // Don't submit a half-filled login: the site would only answer "wrong password".
  const missed = (["username", "password", "otp"] as const).filter((k) => inp[k] && found[k] && !filled.includes(k));
  if (missed.length) throw new WorkerError(`could not fill the ${missed.join(" and ")} field on this page; tap it and use the keyboard instead`, "no_field");
  if (inp.submit) {
    await withTimeout(page.keyboard.press("Enter"), OP_TIMEOUT_MS);
    await settle(page);
  }
  return { meta: await meta(page), filled };
}

async function settle(page: Page, ms = 600) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new WorkerError(`operation timed out after ${ms}ms`, "timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// --- serial operation queue -------------------------------------------------
// All browser operations are serialized. `barrier` resolves when the queue is
// empty, which is how the control service drains in-flight agent work before
// granting human control.
let chain: Promise<unknown> = Promise.resolve();
let inflight = 0;
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  inflight += 1;
  const run = chain.then(fn, fn).finally(() => { inflight -= 1; });
  chain = run.catch(() => {});
  return run;
}

const handlers: { [K in WorkerMethodName]: (params: any) => Promise<unknown> } = {
  launch: () => enqueue(launch),
  health: async () => health(),
  tabs: async () => tabs(),
  selectTab: ({ tabId }) => enqueue(async () => { await input({ type: "select_tab", tabId }); return tabs(); }).finally(() => void syncCast()),
  newTab: () => enqueue(async () => {
    if (!context || state !== "ready") throw new WorkerError("browser unavailable", "unavailable");
    const p = await context.newPage();
    selectedPage = p;
    refsValid = false;
    return { id: idFor(p) };
  }).finally(() => void syncCast()),
  closeTab: ({ tabId }) => enqueue(async () => {
    if (!context || state !== "ready") throw new WorkerError("browser unavailable", "unavailable");
    const target = livePages().find((p) => idFor(p) === tabId);
    if (!target) return tabs();
    if (livePages().length === 1) selectedPage = await context.newPage();
    else if (selectedPage === target) selectedPage = livePages().filter((p) => p !== target).at(-1) ?? null;
    if (refPage === target) refsValid = false;
    await target.close().catch(() => {});
    return tabs();
  }).finally(() => void syncCast()),
  frame: ({ quality }) => enqueue(() => frame(quality)),
  observe: () => enqueue(observe),
  input: ({ input: inp, expect }) => enqueue(() => input(inp, expect)).finally(() => void syncCast()),
  clickRef: ({ ref }) => enqueue(() => clickRef(ref)),
  typeRef: ({ ref, text, submit }) => enqueue(() => typeRef(ref, text, submit)),
  device: ({ mobile: m, reload }) => enqueue(() => setDevice(m, reload)).finally(() => void syncCast()),
  screencast: async ({ on }) => {
    castWanted = !!on;
    await syncCast();
    return { on: castWanted };
  },
  barrier: () => enqueue(async () => ({ drained: true as const })),
  shutdown: async () => {
    const c = context;
    context = null;
    state = "stopped";
    if (c) await c.close().catch(() => {});
    publishHealth();
    setTimeout(() => process.exit(0), 50);
    return { ok: true as const };
  },
};

process.on("message", async (msg: IpcRequest) => {
  if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
  const h = handlers[msg.method];
  if (!h) return send({ id: msg.id, ok: false, error: `unknown method ${String(msg.method)}`, code: "bad_method" });
  try {
    const result = await h(msg.params ?? {});
    send({ id: msg.id, ok: true, result });
  } catch (err) {
    const e = err as Partial<WorkerError>;
    send({ id: msg.id, ok: false, error: (e.message ?? String(err)).split("\n")[0] ?? "error", code: e.code ?? "worker_error" });
  }
});
process.on("disconnect", () => {
  // Parent died. Close the browser cleanly so the profile lock is released.
  void handlers.shutdown({});
});
publishHealth();
