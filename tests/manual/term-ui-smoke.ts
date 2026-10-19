// Drives the Terminal view in a phone-sized browser against a live control
// service and a private tmux socket: pair → sessions list → new session →
// coloured output and a y/n prompt → quick keys. Screenshots for a visual check.
// Run: node --import tsx tests/manual/term-ui-smoke.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { chromium, devices } from "playwright";
import { serve } from "@hono/node-server";
import { loadConfig, ensureDirs } from "../../apps/control-service/src/config.ts";
import { createLogger } from "../../apps/control-service/src/log.ts";
import { createApp } from "../../apps/control-service/src/app.ts";
import { findTmux } from "../../apps/control-service/src/terminal.ts";
import { waitFor } from "../helpers.ts";

const outDir = process.env.UI_SMOKE_OUT ?? path.resolve("tests/manual/out");
fs.mkdirSync(outDir, { recursive: true });
const log = (m: string) => console.log(`[term-ui ${new Date().toISOString().slice(11, 19)}] ${m}`);
const SOCKET = `pa-ui-${process.pid}`;
const tmux = findTmux();
if (!tmux) { console.error("tmux not found"); process.exit(1); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-ui-"));
const port = 18787 + Math.floor(Math.random() * 1000);
// A stand-in Tailscale CLI so previews can be shared without touching the real tailnet.
const fakeTs = path.join(dataDir, "tailscale");
fs.writeFileSync(fakeTs, `#!/bin/sh\ncase "$*" in\n  "status --json") echo '{"Self":{"DNSName":"mac.example.ts.net."}}' ;;\n  "serve status --json") echo '{}' ;;\nesac\n`, { mode: 0o755 });
const devPort = port + 1000;
const cfg = loadConfig({ PALM_AGENTS_DATA_DIR: dataDir, PALM_AGENTS_PORT: String(port), PALM_AGENTS_HEADLESS: "1", PALM_AGENTS_INSECURE_COOKIES: "1", PALM_AGENTS_TAILSCALE: fakeTs, PALM_AGENTS_TMUX_SOCKET: SOCKET, HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" });
ensureDirs(cfg);
const app = createApp(cfg, createLogger(cfg.logDir, { stdout: false }));
const server = serve({ fetch: app.hono.fetch, hostname: "127.0.0.1", port });
const base = `http://localhost:${port}`;
const { code } = app.auth.createPairingCode();
const errors: string[] = [];
const demo = path.join(dataDir, "demo.sh");
fs.writeFileSync(demo, `#!/bin/sh
printf '\\033[1;36m❯ claude\\033[0m  \\033[2m(demo session)\\033[0m\\n\\n'
printf '\\033[32m✔\\033[0m Read \\033[1mapps/control-service/src/app.ts\\033[0m\\n'
printf '\\033[32m✔\\033[0m Grep \\033[1m"terminal"\\033[0m  \\033[2m12 matches\\033[0m\\n\\n'
printf '%s\\n' "$(printf 'wide-line-%.0s' $(seq 1 30))"
printf 'I will add the Terminal route next to the push routes and\\nreuse the alert helper for attention events.\\n\\n'
printf '\\033[33m⚠ Edit\\033[0m apps/control-service/src/app.ts\\n'
printf '  \\033[31m- tasks.onAlert = (alert) => {\\033[0m\\n  \\033[32m+ const sendAlert = (alert) => {\\033[0m\\n\\n'
printf 'Do you want to make this edit?\\n\\033[36m❯ 1. Yes\\033[0m\\n  2. Yes, and do not ask again this session\\n  3. No, and tell Claude what to do differently (esc)\\n'
read ans
printf '\\n\\033[32m✔ Edit applied\\033[0m (answer: %s)\\n' "$ans"
exec sh
`, { mode: 0o755 });

const phone = await chromium.launch({ headless: true });
const ctx = await phone.newContext({ ...devices["iPhone 15 Pro"], baseURL: base });
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
  await page.getByText("No sessions yet").waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(outDir, "t1-sessions-empty.png") });
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByPlaceholder("folder, e.g. ~/dev/project").fill(dataDir);
  await page.getByLabel("Run").selectOption("other");
  await page.getByPlaceholder("command to run").fill(demo);
  await page.screenshot({ path: path.join(outDir, "t2-new-session.png") });
  await page.getByRole("button", { name: "Create" }).click();
  await page.locator(".term-screen").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "t3-session-prompt.png") });
  log(`terminal box height: ${await page.locator(".term-screen").evaluate((el) => el.clientHeight)}px of ${await page.evaluate("innerHeight")}px`);
  const sideways = await page.locator(".term-screen").evaluate((el) => el.scrollWidth - el.clientWidth);
  log(`sideways overflow: ${sideways}px`);
  if (sideways > 0) errors.push("terminal scrolls sideways");
  log(`attention flagged: ${await page.locator(".term-screen.attention").count()}`);
  await page.getByRole("button", { name: "1", exact: true }).click();
  await page.getByRole("button", { name: "⏎" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, "t4-after-answer.png") });
  // Text size: A+ makes the text bigger, so the tmux window is refit to fewer columns.
  const cols = async () => Number((await page.locator(".term-title .muted").textContent())?.match(/(\d+)×/)?.[1]);
  const before = await cols();
  await page.getByRole("button", { name: "A+" }).click();
  await page.getByRole("button", { name: "A+" }).click();
  await page.waitForTimeout(1200);
  const bigger = await cols();
  await page.screenshot({ path: path.join(outDir, "t4b-bigger-text.png") });
  await page.getByRole("button", { name: "A−" }).click();
  await page.getByRole("button", { name: "A−" }).click();
  await page.waitForTimeout(1200);
  log(`text size: ${before} cols -> A+A+ ${bigger} cols -> back ${await cols()} cols`);
  if (!(bigger < before)) errors.push("A+ did not reduce the column count");
  await page.getByRole("textbox").fill("ls -la");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, "t5-after-command.png") });
  // A photo from the phone lands in the prompt as a file path (a tiny PNG stands in for the camera).
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /Send photo/ }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(outDir, "t5a-menu.png") });
  await page.getByRole("menuitem", { name: /Send photo/ }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  const pasted = await waitFor(async () => ((await page.locator(".term-screen").textContent()) ?? "").replace(/\n/g, "").includes("/uploads/photo-") || null, { label: "photo path", timeout: 10_000 }).catch(() => false);
  if (pasted) log("photo pasted into the session as a path");
  else errors.push(`photo path did not appear in the session (${((await page.locator(".term-screen").textContent()) ?? "").slice(-200)})`);
  await page.screenshot({ path: path.join(outDir, "t5b-photo.png") });
  await page.getByRole("button", { name: "^C" }).click();
  // A dev server started in the session: offered in the ⋯ menu, shared, then opened in Safari.
  await page.getByRole("textbox").fill(`python3 -m http.server ${devPort} --bind 127.0.0.1`);
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".menu-flag").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: `🌐 Preview :${devPort} on this phone` }).click();
  const open = page.getByRole("menuitem", { name: `🌐 Open :${devPort} in Safari` });
  await open.waitFor({ timeout: 10_000 });
  if ((await open.getAttribute("href")) !== `https://mac.example.ts.net:${devPort}`) errors.push(`preview link is ${await open.getAttribute("href")}`);
  await page.screenshot({ path: path.join(outDir, "t5c-preview-menu.png") });
  await page.getByRole("menuitem", { name: "Stop sharing" }).click();
  await page.getByRole("menuitem", { name: `🌐 Preview :${devPort} on this phone` }).waitFor({ timeout: 10_000 });
  log("dev server offered in the menu, shared and unshared");
  await page.locator(".term-menu-backdrop").click();
  await page.getByRole("button", { name: "‹ Sessions" }).click();
  await page.getByText(`serving :${devPort}`).waitFor({ timeout: 10_000 }).catch(() => errors.push("session card does not mention the dev server"));
  await page.locator(".card.session").waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(outDir, "t6-sessions-list.png") });
  // Real Claude (opt-in, uses a tiny bit of quota): the Detail switch toggles Ctrl+O's full transcript.
  if (process.env.PA_REAL_CLAUDE === "1") {
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByPlaceholder("folder, e.g. ~/dev/project").fill(path.join(os.homedir(), "phone-test"));
    await page.getByLabel("Run").selectOption("claude");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("button", { name: "More" }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.getByRole("textbox").fill("Run the shell command: ls -la ; then reply with just: done");
    await page.getByRole("button", { name: "Send" }).click();
    await page.locator(".term-screen", { hasText: "ctrl+o to expand" }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "t7-detail-short.png") });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: /Full detail/ }).click();
    await page.locator(".menu-flag").waitFor({ timeout: 5_000 });
    const full = await page.locator(".term-screen").textContent();
    await page.screenshot({ path: path.join(outDir, "t8-detail-full.png") });
    log(`detail full: shows ls output = ${/notes\.txt/.test(full ?? "")}`);
    if (!/notes\.txt/.test(full ?? "")) errors.push("full detail did not show the tool output");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: /Short view/ }).click();
    await page.locator(".menu-flag").waitFor({ state: "detached", timeout: 5_000 });
    log("detail switched back to short");
  }
  log("flow ok");
} catch (err) {
  errors.push(`script: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  await page.screenshot({ path: path.join(outDir, "tx-failure.png") }).catch(() => {});
} finally {
  log(errors.length ? `FRONTEND ERRORS:\n${errors.join("\n")}` : "no frontend errors");
  await phone.close();
  await app.stop();
  server.close();
  await new Promise<void>((r) => execFile(tmux, ["-L", SOCKET, "kill-server"], () => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
  log(`screenshots in ${outDir}`);
  process.exit(errors.length ? 1 : 0);
}
