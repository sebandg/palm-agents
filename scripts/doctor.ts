// `npm run doctor`: environment + state checks without touching tasks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../apps/control-service/src/config.ts";

const cfg = loadConfig();
const rows: Array<[string, "ok" | "warn" | "fail", string]> = [];
const add = (name: string, s: "ok" | "warn" | "fail", d: string) => rows.push([name, s, d]);

add("node", Number(process.versions.node.split(".")[0]) >= 24 ? "ok" : "fail", process.version);
try {
  const v = execFileSync("claude", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } }).trim();
  add("claude cli", "ok", v);
} catch {
  add("claude cli", "warn", "not on PATH (the Agent SDK bundles its own runtime; login state still comes from ~/.claude)");
}
try {
  const st = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } })) as { loggedIn?: boolean; authMethod?: string };
  add("claude auth", st.loggedIn ? "ok" : "fail", st.loggedIn ? `logged in (${st.authMethod})` : "not logged in: run `claude` once on the Mac");
} catch {
  add("claude auth", "warn", "could not query auth status");
}
const pw = path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
add("playwright chromium", fs.existsSync(pw) && fs.readdirSync(pw).some((d) => d.startsWith("chromium")) ? "ok" : "fail", fs.existsSync(pw) ? fs.readdirSync(pw).join(", ") : "run `npm run install-browser`");
add("google chrome", fs.existsSync("/Applications/Google Chrome.app") ? "ok" : "warn", "optional: set PALM_AGENTS_BROWSER_CHANNEL=chrome to use it");
import { findTmux } from "../apps/control-service/src/terminal.ts";
const tmux = findTmux(process.env.PALM_AGENTS_TMUX);
add("tmux", tmux ? "ok" : "warn", tmux ? `${tmux} (${execFileSync(tmux, ["-V"], { encoding: "utf8" }).trim()})` : "not installed: the Terminal tab needs tmux (docs/setup.md, Terminal sessions)");
const ts = ["/Applications/Tailscale.app", "/usr/local/bin/tailscale", `${process.env.HOME}/go/bin/tailscale`].find((p) => fs.existsSync(p));
add("tailscale", ts ? "ok" : "warn", ts ?? "not installed: private HTTPS access from the iPhone needs Tailscale (docs/setup.md)");
add("data dir", fs.existsSync(cfg.dataDir) ? "ok" : "warn", cfg.dataDir);
add("db", fs.existsSync(cfg.dbPath) ? "ok" : "warn", fs.existsSync(cfg.dbPath) ? `${(fs.statSync(cfg.dbPath).size / 1024).toFixed(0)} KiB` : "created on first start");
add("browser profile", fs.existsSync(cfg.profileDir) ? "ok" : "warn", fs.existsSync(cfg.profileDir) ? `${cfg.profileDir} (mode ${(fs.statSync(cfg.profileDir).mode & 0o777).toString(8)})` : "created on first start");
add("web build", fs.existsSync(path.join(cfg.webDistDir, "assets/app.js")) ? "ok" : "fail", fs.existsSync(path.join(cfg.webDistDir, "assets/app.js")) ? cfg.webDistDir : "run `npm run build`");
const plist = path.join(process.env.HOME ?? "", "Library/LaunchAgents/com.palm-agents.control.plist");
add("launchd", fs.existsSync(plist) ? "ok" : "warn", fs.existsSync(plist) ? plist : "not installed: scripts/install-launchd.sh");
try {
  const r = await fetch(`http://127.0.0.1:${cfg.port}/api/ping`);
  add("service", r.ok ? "ok" : "fail", `http://127.0.0.1:${cfg.port} -> ${r.status}`);
} catch {
  add("service", "warn", `not reachable on 127.0.0.1:${cfg.port}`);
}
add("fileVault", "warn", "after a cold boot a person must unlock the disk before the launchd user agent can start (docs/recovery.md)");

for (const [n, s, d] of rows) console.log(`${s === "ok" ? "✔" : s === "warn" ? "!" : "✘"} ${n.padEnd(18)} ${d}`);
process.exit(rows.some((r) => r[1] === "fail") ? 1 : 0);
