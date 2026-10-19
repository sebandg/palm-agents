# Testing

## Automated (`npm test`)

Vitest boots the real control service on a random loopback port with a temporary data directory, a private tmux socket, a headless Chromium and a local fixture website. Nothing touches your own sessions, browser profile or tailnet (Tailscale is replaced by a fake CLI).

| Test | What it checks |
| --- | --- |
| `auth` | Pairing codes are one-use; unpaired requests get 401; bad Origin, missing `X-PA-Request` header, non-JSON bodies and foreign Host headers are refused; revocation takes effect immediately; security headers; the agent bridge rejects bad tokens |
| `terminal` | List, create, screen, keys, resize and kill tmux sessions through the API; text is typed literally; the "needs you" heuristic; typed text is logged by length only |
| `terminal-agent` | Agents use the shared browser through the MCP bridge: one holder at a time, released when idle, refused while the owner has it |
| `handoff` | An agent calls `request_human`, the owner logs in through the phone endpoints and hands back; the password and code never appear in logs or diagnostics |
| `credential-fill` | Password-manager fill finds the page's own username, password and code fields, including fields under a transparent overlay; a page without them gives a clear error |
| `browser-live`, `browser-restore`, `phone-device` | Live frames over SSE, reopening the last page after a browser restart, phone emulation while the owner has control |
| `previews-photos` | Photos are saved owner-only and pasted as a path; non-images are refused; dev servers started in a session are shared and unshared on the tailnet |
| `alerts` | Push alerts name only the session and link to the right place |

## Manual smoke tests

`tests/manual/ui-smoke.ts` and `tests/manual/term-ui-smoke.ts` drive the built phone app in an iPhone 15 Pro viewport (headless Chromium): pairing, the browser hand-over with password-manager fill, the settings sheet, terminal sessions with a permission prompt, the ⋯ menu, photos and dev-server previews. They fail on any page error and write screenshots to `tests/manual/out/` (not committed).

```sh
node --import tsx tests/manual/ui-smoke.ts
node --import tsx tests/manual/term-ui-smoke.ts
```

## Tried on real devices

Used daily on a Mac (macOS 26, Apple silicon, Node 24, tmux 3.5, Playwright 1.64 Chromium, Tailscale 1.104) with an iPhone 15 Pro as a Home Screen app, driving Claude Code sessions. Exercised by hand: pairing over Tailscale, push alerts on a locked phone, opening a session from an alert, the browser hand-over on real sites with Bitwarden autofill, photos into a Claude Code session, dev-server previews, and the service restarting under launchd with sessions kept.

## Not yet tested

- Android phones (the app uses only standard web features, so it should work).
- Codex in day-to-day use (the bridge is set up the same way as for Claude Code).
- Long soak runs, sleep and FileVault cold-boot behaviour; CAPTCHAs, passkeys and native OS dialogs in the shared browser.
- Running the machine side on Linux (it relies on launchd and macOS tools).
