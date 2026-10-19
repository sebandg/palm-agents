// Drives the real phone web app in a phone-sized Playwright browser against a
// live control service: pair, browse, have a terminal agent hand the browser
// over (Needs you), take screenshots. Verifies the frontend bundle runs without
// JS errors. Run: node --import tsx tests/manual/ui-smoke.ts
import path from "node:path";
import fs from "node:fs";
import { chromium, devices } from "playwright";
import { bootTestEnv, waitFor } from "../helpers.ts";

const outDir = process.env.UI_SMOKE_OUT ?? path.resolve("tests/manual/out");
fs.mkdirSync(outDir, { recursive: true });
const env = await bootTestEnv({ browser: true });
// Serve the built web app from the real public dir.
(env.cfg as { webDistDir: string }).webDistDir = path.resolve("apps/mobile-web/public");
const log = (m: string) => console.log(`[ui ${new Date().toISOString().slice(11, 19)}] ${m}`);
const errors: string[] = [];
try {
  // The test env was created with a fake web dir; rebuild the app with the real one by re-creating routes is heavy,
  // so instead point a second server at the same control service via a tiny proxy-less trick: serve static from env.base is not
  // possible post-construction. Use the real service entry instead.
  await env.cleanup();
} catch {}

// Boot the real service (same code path as `npm start`) on a random port with a temp data dir.
import { loadConfig, ensureDirs } from "../../apps/control-service/src/config.ts";
import { createLogger } from "../../apps/control-service/src/log.ts";
import { createApp } from "../../apps/control-service/src/app.ts";
import { serve } from "@hono/node-server";
import os from "node:os";
import { createFixtureServer, FIXTURE_PASS, FIXTURE_USER } from "../fixtures/login-site/server.ts";
import type { AddressInfo } from "node:net";
import { callBridge } from "../../packages/mcp-bridge/src/index.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ui-"));
const fixture = createFixtureServer();
await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
const fixtureBase = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
const port = 18787 + Math.floor(Math.random() * 1000);
const cfg = loadConfig({ PALM_AGENTS_DATA_DIR: dataDir, PALM_AGENTS_PORT: String(port), PALM_AGENTS_HEADLESS: "1", PALM_AGENTS_INSECURE_COOKIES: "1", PALM_AGENTS_TAILSCALE: "off", HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" });
ensureDirs(cfg);
const app = createApp(cfg, createLogger(cfg.logDir, { stdout: false }));
const server = serve({ fetch: app.hono.fetch, hostname: "127.0.0.1", port });
await app.start();
await waitFor(() => app.browser.health.state === "ready", { label: "shared browser", timeout: 60_000 });
const base = `http://localhost:${port}`;
const { code } = app.auth.createPairingCode();

const phoneBrowser = await chromium.launch({ headless: true });
const ctx = await phoneBrowser.newContext({ ...devices["iPhone 15"], baseURL: base });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
let paired = false;
page.on("console", (m) => { if (m.type() === "error" && !(!paired && /401/.test(m.text()))) errors.push(`console: ${m.text()}`); });
try {
  await page.goto("/");
  await page.getByPlaceholder("0000 0000").fill(code);
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByRole("heading", { name: "Palm Agents" }).waitFor({ timeout: 10_000 });
  paired = true;
  // Browsing needs no separate step: typing an address on a blank browser takes control and opens it.
  await page.getByRole("button", { name: "Browser" }).click();
  await page.getByText("Type a site or search in the bar above").waitFor({ timeout: 15_000 });
  const startAddr = page.getByPlaceholder("Search or type a web address");
  await startAddr.click();
  await startAddr.fill(`${fixtureBase.replace("http://127.0.0.1", "localhost")}/login?from=start`);
  await startAddr.press("Enter");
  await waitFor(async () => (await app.browser.client.call("frame", { quality: 10 })).meta.url.includes("from=start"), { label: "browse without Take control", timeout: 20_000 });
  log(`browsed straight from the address bar; ownership: ${app.ownership.get().state}`);
  if (await page.getByRole("button", { name: /Return to Claude|Hand back/ }).count()) errors.push("owner browsing showed a hand-back card");
  await page.screenshot({ path: path.join(outDir, "0-browse-direct.png") });
  // Browsing on your own is not "needs you": no banner on the other tab.
  await page.getByRole("button", { name: "Terminal" }).click();
  await page.waitForTimeout(500);
  if (await page.locator(".banner", { hasText: "needs you" }).count()) errors.push(`owner browsing showed a banner: ${await page.locator(".banner").first().innerText()}`);
  await page.getByRole("button", { name: "Browser" }).click();
  page.on("dialog", (d) => void d.accept());
  // A terminal agent (Claude Code in session "claude-proj") hands the browser over for a login.
  // The owner was browsing: hand it back first, as the owner would when asked in the terminal.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("last used the browser").waitFor({ timeout: 5_000 }).catch(() => errors.push("settings has no Agents card"));
  await page.getByRole("button", { name: "Done" }).click();
  await app.agents.returnControl();
  await waitFor(() => app.ownership.get().state === "agent_control", { label: "browser back with the agents", timeout: 10_000 });
  const agentCall = (tool: Parameters<typeof callBridge>[1], args: unknown = {}) =>
    callBridge({ baseUrl: `http://127.0.0.1:${port}`, token: () => fs.readFileSync(path.join(dataDir, "agent-bridge-token"), "utf8").trim(), session: "claude-proj" }, tool, args);
  if (!(await agentCall("browser_navigate", { url: `${fixtureBase}/login` })).ok) errors.push("terminal agent could not navigate");
  // The Browser tab shows which agent is using the browser, with Take over.
  await page.getByText("claude-proj is using the browser").waitFor({ timeout: 10_000 }).catch(() => errors.push("no 'claude-proj is using the browser' card"));
  if (!(await page.getByRole("button", { name: "Take over" }).count())) errors.push("agent-busy card has no Take over");
  await page.screenshot({ path: path.join(outDir, "1a-agent-using-browser.png") });
  const handover = (async () => {
    for (;;) {
      const r = await agentCall("request_human", { reason: "Log in to the fixture site", kind: "login" });
      if (!r.text.startsWith("Still waiting")) return r;
    }
  })();
  await page.getByText("claude-proj needs you").first().waitFor({ timeout: 30_000 });
  log("needs-you card shown for a terminal agent");
  if (!(await page.getByRole("button", { name: "Open session" }).count())) errors.push("needs-you card has no button back to the agent's session");
  await page.screenshot({ path: path.join(outDir, "1-claude-needs-you.png"), fullPage: false });
  // On the other tab a banner leads back.
  await page.getByRole("button", { name: "Terminal" }).click();
  await page.locator(".banner", { hasText: "claude-proj needs you" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(outDir, "2-needs-you.png") });
  await page.locator(".banner", { hasText: "claude-proj needs you" }).getByRole("button", { name: "Open" }).click();
  await page.getByRole("button", { name: "Hand back" }).first().waitFor({ timeout: 10_000 });
  await page.locator(".frame-wrap img").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  // Phone mode: the browser switches to this screen's size while the owner has control.
  await waitFor(async () => (await app.browser.client.call("frame", { quality: 10 })).meta.mobile, { label: "phone mode", timeout: 20_000 });
  await page.waitForTimeout(1500);
  log("browser view with live frame and human controls (phone mode)");
  await page.screenshot({ path: path.join(outDir, "3-browser-human-control.png") });

  // Type into the page via the phone UI: tap the username field using the image coordinates.
  const obs = await app.browser.client.call("observe", {});
  const user = obs.observation.elements.find((e) => e.name.includes("Username"))!;
  const img = page.locator(".frame-wrap img");
  const box = (await img.boundingBox())!;
  const sx = box.width / obs.observation.elements[0]!.box.w; // not used; compute from viewport instead
  const vp = (await app.browser.client.call("frame", { quality: 10 })).meta.viewport;
  await img.click({ position: { x: ((user.box.x + user.box.w / 2) / vp.width) * box.width, y: ((user.box.y + user.box.h / 2) / vp.height) * box.height } });
  // A tap on a page field focuses the type box in the same tap (what opens the iOS keyboard).
  const focused = (await page.evaluate("document.activeElement && document.activeElement.placeholder")) as string | undefined;
  log(`after tapping a field, focused: ${focused}`);
  if (focused !== "Type into the page") errors.push(`tap on a field did not focus the type box (focused=${focused})`);
  await page.getByPlaceholder("Type into the page").fill("owner");
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.waitForTimeout(800);
  const after = await app.browser.client.call("observe", {});
  const typed = after.observation.elements.find((e) => e.name.includes("Username"))?.value;
  log(`typed via phone tap+type -> username field value: "${typed}"`);
  if (typed !== "owner") errors.push(`tap-to-click coordinate mapping failed (value=${typed})`);
  void sx;

  // Zoom 2x: the image doubles in width inside a scrollable box; a tap on the password field must still land.
  await page.getByRole("button", { name: "Zoom 1×" }).click();
  await page.waitForTimeout(1200);
  const box2 = (await img.boundingBox())!;
  if (Math.round(box2.width) < Math.round(box.width * 1.9)) errors.push(`zoom did not enlarge the frame (${box.width} -> ${box2.width})`);
  const pass = obs.observation.elements.find((e) => e.name.includes("Password"))!;
  const scroller = page.locator(".frame-scroll");
  const target = { x: ((pass.box.x + pass.box.w / 2) / vp.width) * box2.width, y: ((pass.box.y + pass.box.h / 2) / vp.height) * box2.height };
  await scroller.evaluate((el, t) => { el.scrollLeft = Math.max(0, t.x - el.clientWidth / 2); el.scrollTop = Math.max(0, t.y - el.clientHeight / 2); }, target);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, "3b-browser-zoom-2x.png") });
  await img.click({ position: target });
  await page.getByPlaceholder("Type into the page").fill("zoomed");
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.waitForTimeout(800);
  const after2 = await app.browser.client.call("observe", {});
  const pw = after2.observation.elements.find((e) => e.name.includes("Password"))?.value;
  log(`tap at 2x zoom -> password field: ${pw}`); // password values are reported as "[filled]", never the text
  if (pw !== "[filled]") errors.push(`tap mapping at 2x zoom failed (password field value=${pw})`);
  // The agent asked for a login, so the sign-in panel is already open. A password manager fills
  // both fields at once, firing no input events: Fill & submit must still send both.
  const signin = page.getByPlaceholder("username or email");
  if (!(await signin.isVisible())) errors.push("sign-in panel did not open for the agent's login request");
  await page.evaluate(`document.querySelector('input[name="username"]').value = ${JSON.stringify(FIXTURE_USER)}; document.querySelector('input[name="password"]').value = ${JSON.stringify(FIXTURE_PASS)};`);
  await page.getByRole("button", { name: "Fill & submit" }).click();
  await page.getByText("Filled username + password and submitted").waitFor({ timeout: 15_000 }).catch(() => {});
  const credNote = await page.locator(".card .muted").filter({ hasText: "Filled" }).first().innerText().catch(() => "(none)");
  log(`autofill sign-in -> ${credNote}`);
  if (!credNote.includes("username + password")) errors.push(`autofilled sign-in did not fill both fields (${credNote})`);
  if (!(await page.getByText("Signed in? claude-proj carries on").isVisible())) errors.push("no Hand back prompt after signing in");
  if ((await signin.inputValue()) !== "") errors.push("sign-in form kept the username after filling");
  await page.getByRole("button", { name: "Zoom 2×" }).click();
  await page.getByRole("button", { name: "Zoom 3×" }).click();
  await page.waitForTimeout(600);
  // Swipe up on the screenshot: scrolls the page, does not click. A tall page with a field at y=300 shows how far.
  const tall = "data:text/html," + encodeURIComponent('<meta name=viewport content="width=device-width"><body style="margin:0"><div style="height:300px"></div><input id=f><div style="height:3000px"></div>');
  const cur = await app.browser.client.call("frame", { quality: 10 });
  await app.browser.client.call("input", { input: { type: "navigate", url: tall }, expect: { generation: cur.meta.generation, tabId: cur.meta.tabId } });
  await page.waitForTimeout(2200);
  const y0 = (await app.browser.client.call("frame", { quality: 10 })).meta.fields?.[0]?.y;
  const b3 = (await img.boundingBox())!;
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height * 0.8);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height * (0.8 - i * 0.08));
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, "3c-after-swipe.png") });
  const y1 = (await app.browser.client.call("frame", { quality: 10 })).meta.fields?.[0]?.y;
  log(`swipe: field y ${y0} -> ${y1}`);
  if (!(y0 !== undefined && y1 !== undefined && y0 - y1 > 100)) errors.push(`swipe did not scroll the page (field y ${y0} -> ${y1})`);
  // Live view: an animating page reaches the phone as a stream of frames, without polling.
  const anim = "data:text/html," + encodeURIComponent('<meta name=viewport content="width=device-width"><body style="margin:0"><div id=b style="width:60px;height:60px;background:red;position:absolute"></div><script>let t=0;(function f(){t++;b.style.left=(t*3%300)+"px";requestAnimationFrame(f)})()</script>');
  const cur3 = await app.browser.client.call("frame", { quality: 10 });
  await app.browser.client.call("input", { input: { type: "navigate", url: anim }, expect: { generation: cur3.meta.generation, tabId: cur3.meta.tabId } });
  await page.waitForTimeout(1500);
  let polls = 0;
  const onReq = (r: { url(): string }) => { if (r.url().includes("/api/browser/frame")) polls++; };
  page.on("request", onReq);
  await page.evaluate("window.__srcChanges = 0; new MutationObserver(() => window.__srcChanges++).observe(document.querySelector('.frame-scroll img'), { attributes: true, attributeFilter: ['src'] })");
  await page.waitForTimeout(3000);
  const changes = Number(await page.evaluate("window.__srcChanges"));
  page.off("request", onReq);
  log(`live view: ${(changes / 3).toFixed(1)} frames/s on an animating page, ${polls} screenshot polls`);
  if (changes / 3 < 4) errors.push(`live view too slow: ${(changes / 3).toFixed(1)} fps`);
  const shift = await img.getAttribute("style").then((st) => /transform/.test(st ?? "") ? st : "");
  if (shift) errors.push(`image still shifted after the swipe (${shift})`);
  // Hold, then drag: a press-move-release on the page (slider captchas). The page reports what it got in its title.
  const slider = "data:text/html," + encodeURIComponent('<meta name=viewport content="width=device-width"><body style="margin:0;height:100vh" onmousedown="window.d=event.clientX" onmouseup="document.title=\'drag \'+window.d+\'->\'+event.clientX+(event.buttons?\'\':\' released\')">slider');
  const cur2 = await app.browser.client.call("frame", { quality: 10 });
  await app.browser.client.call("input", { input: { type: "navigate", url: slider }, expect: { generation: cur2.meta.generation, tabId: cur2.meta.tabId } });
  await page.waitForTimeout(2200);
  await img.scrollIntoViewIfNeeded();
  const b4 = (await img.boundingBox())!;
  await page.mouse.move(b4.x + b4.width * 0.15, b4.y + b4.height * 0.5);
  await page.mouse.down();
  await page.waitForTimeout(600); // hold still: becomes a drag
  const holdOutline = await page.locator(".frame-wrap.holding").count();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b4.x + b4.width * (0.15 + i * 0.09), b4.y + b4.height * 0.5);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const dragTitle = (await app.browser.client.call("frame", { quality: 10 })).meta.title;
  log(`hold+drag: outline=${holdOutline} page saw "${dragTitle}"`);
  const m = /drag (\d+)->(\d+) released/.exec(dragTitle);
  if (!holdOutline || !m || Number(m[2]) - Number(m[1]) < 150) errors.push(`hold-then-drag did not reach the page as a drag ("${dragTitle}")`);
  // Address bar: a full URL navigates the shared browser without a task.
  const addr = page.getByPlaceholder("Search or type a web address");
  await addr.click();
  // A bare domain, as people type it (a type=url field refuses to submit this).
  // Needs internet: the Mac's test browser opens example.com.
  await addr.fill("example.com");
  await addr.press("Enter");
  const spinning = await page.locator(".addr .ico.spin").count();
  await page.waitForTimeout(400);
  const shownNow = await addr.inputValue();
  log(`address field right after Go: "${shownNow}", spinner: ${spinning}`);
  if (!spinning) errors.push("no loading spinner while the page opens");
  if (shownNow !== "example.com") errors.push(`address field did not show the new address at once ("${shownNow}")`);
  await waitFor(async () => (await app.browser.client.call("frame", { quality: 10 })).meta.url.includes("example.com"), { label: "bare domain", timeout: 20_000 }).catch(() => errors.push("address bar did not open a bare domain (example.com)"));
  await page.locator(".addr .ico.spin").waitFor({ state: "detached", timeout: 5_000 }).catch(() => errors.push("spinner kept spinning after the page loaded"));
  log("address bar opened a bare domain");
  await addr.click();
  await addr.fill(`${fixtureBase}/login?from=address-bar`);
  await addr.press("Enter");
  await waitFor(async () => (await app.browser.client.call("frame", { quality: 10 })).meta.url.includes("from=address-bar"), { label: "address bar navigation", timeout: 15_000 });
  log("address bar navigated");
  // Type an address, close the keyboard (tap elsewhere), then tap the right-hand button: it is Go now, not Reload.
  await addr.click();
  await addr.fill(`${fixtureBase}/login?from=go-button`);
  await page.locator("header.top h1").click();
  await page.waitForTimeout(400);
  if ((await addr.inputValue()) !== `${fixtureBase}/login?from=go-button`) errors.push(`closing the keyboard dropped the typed address ("${await addr.inputValue()}")`);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await waitFor(async () => (await app.browser.client.call("frame", { quality: 10 })).meta.url.includes("from=go-button"), { label: "Go button", timeout: 15_000 }).catch(() => errors.push("the Go button did not open the typed address"));
  await page.getByRole("button", { name: "Go", exact: true }).waitFor({ state: "detached", timeout: 5_000 }).catch(() => errors.push("Go button did not turn back into Reload"));
  log("typed address + closed keyboard + Go button opened it");
  const frameMeta = async () => (await app.browser.client.call("frame", { quality: 10 })).meta;
  await page.getByRole("button", { name: "Desktop site" }).click();
  await waitFor(async () => !(await frameMeta()).mobile, { label: "desktop site", timeout: 20_000 });
  log(`desktop site toggle -> ${JSON.stringify((await frameMeta()).viewport)}`);
  await page.screenshot({ path: path.join(outDir, "3e-desktop-site.png") });
  await page.getByRole("button", { name: "Phone site" }).click();
  await waitFor(async () => (await frameMeta()).mobile, { label: "phone site again", timeout: 20_000 });
  log("phone site toggle -> mobile again");
  await page.waitForTimeout(3000);
  await page.evaluate("window.scrollTo(0, 0)");
  await page.locator("main").evaluate((m) => m.scrollTo(0, 0));
  await page.screenshot({ path: path.join(outDir, "3d-address-bar.png") });
  const raw = await app.browser.client.call("frame", { quality: 60 });
  fs.writeFileSync(path.join(outDir, "3d-raw-frame.jpg"), Buffer.from(raw.jpegBase64, "base64"));
  log(`raw frame ${JSON.stringify(raw.meta.viewport)} mobile=${raw.meta.mobile} url=${raw.meta.url}`);

  await page.getByRole("button", { name: "Hand back" }).first().click();
  await waitFor(() => app.ownership.get().state !== "human_control", { label: "handed back", timeout: 15_000 });
  await page.getByRole("button", { name: "Hand back" }).first().waitFor({ state: "detached", timeout: 10_000 });
  const back = await handover;
  log(`returned control; the agent's request_human returned: ${back.text.split(".")[0]}`);
  if (!back.ok) errors.push(`request_human did not return ok after Return to Claude (${back.text})`);
  if (!(await agentCall("browser_observe")).ok) errors.push("terminal agent could not use the browser after the hand-back");
  await page.getByRole("button", { name: "Terminal" }).click();
  await page.waitForTimeout(500);
  if (await page.locator(".banner", { hasText: "needs you in the browser" }).count()) errors.push("banner still shown after handing the browser back");
  await page.screenshot({ path: path.join(outDir, "4-after-return.png") });

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Paired sessions").waitFor();
  await page.screenshot({ path: path.join(outDir, "5-settings.png") });
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("Paired sessions").waitFor({ state: "detached" });
  log("settings sheet ok");
} catch (err) {
  errors.push(`script: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  await page.screenshot({ path: path.join(outDir, "x-failure.png") }).catch(() => {});
} finally {
  log(errors.length ? `FRONTEND ERRORS:\n${errors.join("\n")}` : "no frontend errors");
  await phoneBrowser.close();
  await app.stop();
  server.close();
  fixture.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  log(`screenshots in ${outDir}`);
  process.exit(errors.length ? 1 : 0);
}
