# Security and privacy

This is a single-owner system. It is **not** a sandbox against a malicious agent, phone, or Mac. The guarantees below are the ones the code enforces; verify them with `npm test` (`tests/auth.test.ts`, `tests/handoff.test.ts`).

## Access

- Service binds to loopback. Remote reach is only through Tailscale Serve (private HTTPS). No Funnel.
- Host header must match an allowed origin (421 otherwise) — defends DNS rebinding.
- Pairing: 8-digit one-use code, 5-minute expiry, generated on the Mac (`npm run pair`), stored hashed.
- Sessions: 256-bit random token, stored as SHA-256; cookie `pa_session` is HttpOnly, Secure, SameSite=Strict. Revocation (Settings → Paired sessions) drops streams and API access immediately and deletes the device's push subscription.
- CSRF: every cookie-authenticated mutation must send `Origin` ∈ allowlist **and** `X-PA-Request: 1`, body must be JSON. GET never mutates.
- Event streams, frames, tabs and input endpoints all require the session.
- The only unauthenticated endpoint is `GET /api/ping` (`{ok, version}`).

## Agent bridge

- Agents (Claude Code / Codex in terminal sessions) reach `/bridge/call` through the `palm-browser` MCP bridge with a bearer token from `~/.palm-agents/agent-bridge-token` (256-bit random, file mode 600, stored hashed in memory, new on every service start). Requests that came through Tailscale Serve (`X-Forwarded-For` / `Tailscale-User-Login`) are refused, so the bridge is reachable only from this Mac.
- Every browser tool call is checked **server-side immediately before execution** against the ownership record (state, holder). One agent holds the browser at a time; another is refused until it has been idle for 30 s.
- Takeover: state goes `agent_control → pausing` (lease bumped) → drain barrier on the serialized browser worker queue → `human_control`. Agent calls during human control return HTTP 409 and tell the agent to wait.
- Permissions are the agents' own: Claude Code and Codex ask in their terminal before using tools (including the browser tools), and you answer from the Terminal tab. This service adds no approval layer of its own.
- Limitation: the gate protects only the browser tools. An agent with shell or computer-use access can do anything the Mac user can; while you type credentials into the shared browser, only the browser tools are paused.

## Credentials typed by the owner

- The browser worker types text with `page.keyboard.type` and never logs it. The control service logs only `human input <type>` (for a credential fill, also which of `username,password,otp` landed, never the values).
- Password-manager fill: the Browser view has a username / password / one-time-code form with the standard `autocomplete` hints, so iOS AutoFill (Bitwarden, iCloud Keychain, 1Password) can fill it. The phone sends the values once as a `fill` input; the worker locates the page's own fields (autocomplete hints, input types, field names), replaces their content with `locator.fill`, and optionally presses Enter. Values that had no matching field stay in the form for the next page; used values are cleared immediately. Note: AutoFill suggests logins for the console's own domain first, so use the key icon's search to pick the target site's login.
- Typed text is not persisted (no event, no DB row). The phone clears its input buffer before sending and on Return to agent.
- The model never receives human input events. After return it gets a fresh observation of the page (which may show that you are logged in — that is expected).
- The destination website and browser autofill may retain what you type, per their own settings.
- Diagnostics (`/api/diagnostics`) include health and the recent log ring only: no cookies, tokens, screenshots or page text. `tests/handoff.test.ts` asserts that the fixture password and OTP never appear in the log or diagnostics.

## Model output

- CSP: `script-src 'self'`, `style-src 'self'`, no inline scripts, `frame-ancestors 'none'`. Model text is rendered as text nodes (Preact), never as HTML.
- Page content reaches the agent as text + JPEG through the browser tool. A web page can contain instructions aimed at the agent (prompt injection); nothing here filters them, so rely on your agent's own permission prompts.

## Data sent to the model provider

The agent's provider (Anthropic for Claude Code, OpenAI for Codex) receives what you type into the agent and its tool results, including for every `browser_observe` the URL, title, element list, visible text snippet and a JPEG of the page. Screenshots taken **while you hold control** are shown only to you; the agent gets a new observation only after you hand back. Web Push payloads are generic strings sent through Apple's push service.

## Storage

- `~/.palm-agents` mode 700; DB and env mode 600. Browser profile excluded from git and diagnostics; it contains authenticated website sessions — treat backups as secrets.
- Screenshots are transient (streamed, never written to disk). The service keeps no agent transcripts; those live in each agent's own history.
- Service worker caches only static assets (`/`, `styles.css`, `assets/app.js`, manifest, icon); `/api/*` is never cached. Logout/revocation clears in-memory views.

## Terminal sessions = shell access

The Terminal tab gives any paired phone an interactive shell on the Mac as the service user: whatever `claude` (or you) can do in that tmux session, the phone can do. There is no sandbox, approval gate or tool allowlist in this path by design; the protection is the private network (Tailscale, never Funnel), the paired-session cookie, CSRF/Origin checks, and session revocation. Revoke a lost phone immediately (Settings → Paired sessions). Typed text is logged by length only; screen text is never stored by the service. The "needs you" detection reads the last three lines of the pane and matches prompt patterns; it never sends screen content in a push.

## Photos and previews

Photos sent from the phone are saved owner-only (`~/.palm-agents/uploads/`, mode 600, deleted after 7 days); only JPEG, PNG, GIF, WebP and HEIC are accepted, checked by their first bytes. A dev-server preview is shared with Tailscale Serve on the tailnet only (never Funnel), only for ports owned by a process inside a tmux session, never on a port Tailscale already serves, and it is removed as soon as the server stops (also after a service restart). A shared dev server is reachable by every device on your tailnet, without the phone's pairing cookie.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
