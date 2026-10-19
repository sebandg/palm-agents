# Setup

The machine side runs natively on macOS (no Docker, no VM, no sudo). The phone side is a web app; it is tested on iPhone and should work on Android with Chrome.

## 1. Prerequisites on the Mac

| Requirement | Notes |
| --- | --- |
| macOS | Tested on macOS 26 (Apple silicon). Any recent version should do. |
| Node.js 24+ | From https://nodejs.org, Homebrew, or a tarball extracted into `~/.local/node` (no admin rights needed). |
| tmux 3.2+ | `brew install tmux`, or build it into `~/.local` (see §6b). |
| Tailscale | On the Mac and on the phone, logged into the same tailnet (§4). |
| An agent CLI | e.g. Claude Code (`claude`) or Codex (`codex`), logged in. |
| Google Chrome (optional) | Set `PALM_AGENTS_BROWSER_CHANNEL=chrome` to drive it instead of the bundled Chromium (still a separate profile). |

## 2. Install the project

```sh
git clone https://github.com/sebandg/palm-agents.git && cd palm-agents
scripts/setup.sh        # npm ci, Playwright Chromium, web build, doctor
npm run doctor          # re-check any time
```

## 3. Run it

Foreground (first time, to watch logs):

```sh
npm start
```

As a user launchd agent (restarts on crash, starts at login):

```sh
scripts/install-launchd.sh
# edit ~/.palm-agents/env, then:
launchctl kickstart -k gui/$(id -u)/com.palm-agents.control
```

The service binds to `127.0.0.1:8787` only. Data lives in `~/.palm-agents` (mode 700):

```
palm-agents.sqlite    phone sessions, browser ownership, event stream
browser-profile/      the agent's own Chromium profile (website logins!) — never your personal Chrome profile
logs/                 rotated, secret-free logs
env                   service environment (mode 600)
```

## 4. Private access from the phone (Tailscale)

Install Tailscale on the Mac (https://tailscale.com/download/mac) and on the phone, and log both into the same tailnet. Then on the Mac run `scripts/tailscale-serve.sh`, which does the following for you:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale status      # note the MagicDNS name, e.g. my-mac.tailnet-name.ts.net
```

Tailscale Serve terminates HTTPS with a tailnet certificate and forwards to loopback. **Do not use `tailscale funnel`**: it would expose the service publicly. Then tell the service which origin is allowed, otherwise every mutation is rejected as a bad Origin/Host:

```
# ~/.palm-agents/env
PALM_AGENTS_ALLOWED_ORIGINS=https://my-mac.tailnet-name.ts.net
```

Restrict access further with a Tailscale ACL so only the owner's devices can reach the Mac on port 443. Network access is **not** authentication: the app still requires pairing.

## 5. Pair the phone

```sh
npm run pair
```

prints an 8-digit one-use code valid for 5 minutes. On the phone open `https://my-mac.tailnet-name.ts.net/` and enter the code. The session cookie is HttpOnly, Secure, SameSite=Strict, 30 days, revocable from **Settings → Paired sessions**.

## 6. Home Screen app and alerts

iPhone: Safari → Share → **Add to Home Screen**; Android: Chrome menu → **Add to Home screen**. Launch from the icon. In **Settings (gear) → Background alerts → Enable** grant notification permission (on iOS this needs 16.4+ and the Home Screen app, not a Safari tab). Alerts name the session only ("claude-proj needs you in the browser", "codex-web is waiting for you") and never say what it is doing; tapping one opens that session or the Browser tab. If you decline, everything still works in the foreground.

## 6b. Terminal sessions (tmux)

The **Terminal** tab is a phone remote for real interactive CLI sessions on the Mac: `claude` with whatever tools you give it (files, shell, computer use, Chrome), or anything else. Sessions live in tmux, so they survive the phone disconnecting and can be opened on the Mac at the same time.

- Install tmux: `brew install tmux`, or without Homebrew build libevent and tmux into `~/.local` (`./configure --prefix=$HOME/.local --disable-utf8proc`). The service looks in `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, or `PALM_AGENTS_TMUX`.
- Start a session from the phone (**New session**: a folder, then Claude Code, Codex, Shell or another command from the dropdown, then **Create**; the session is named after the choice and folder. New agents go in `AGENTS` in `apps/mobile-web/src/views/Terminal.tsx`) or on the Mac with the `cs` shorthand (`scripts/cs`, symlinked into `~/.local/bin`): `cs` opens a tmux session named after the current directory, `cs name ~/dev/project` picks name and directory, and the same command re-attaches if the session exists. Then run `claude` inside. `cs -l` lists sessions. Without the shorthand: `tmux new -A -s name -c dir`.
- The phone resizes the tmux window to its own column count when it opens a session (`window-size manual`), so output wraps instead of scrolling sideways. On the Mac, `tmux resize-window -A` takes the size back.
- Typing: the text box sends the text followed by Enter; the quick-key row sends Esc, Tab, Shift+Tab, arrows, Ctrl-C, 1/2/3, y/n, Enter. Text is sent literally (tmux `send-keys -l`), never interpreted as key names.
- "Needs you": when the last lines of a session look like a prompt (y/n, numbered Yes/No choices, "Esc to cancel", password) the session is flagged on the phone and a generic push alert is sent once. It is a heuristic; the session's output is never parsed beyond that.
- Each session shows **working** (its screen changed in the last few seconds), **needs you** (it looks like a prompt) or **idle**. A session that needs you shows a banner on the other tab; **Open** jumps to it. The service checks sessions every 3 s even with no phone open, so the push alert comes when the prompt appears.

### The shared browser for terminal agents

`scripts/connect-agents.sh` registers the `palm-browser` MCP tool (`packages/mcp-bridge`) for Claude Code (user scope) and Codex (`~/.codex/config.toml`, with a 300 s tool timeout). Re-run it after moving the repo. New agent sessions then have `browser_observe`, `browser_navigate`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_tabs` and `request_human`.

- The tool authenticates with `~/.palm-agents/agent-bridge-token` (owner-only, new on every service start; read on each call, so a restart needs no config change). The endpoint refuses requests that came through Tailscale Serve.
- An agent may use the browser when nobody else holds it. While you use it on the phone, its calls are refused with "the owner is using the shared browser".
- `request_human` hands the browser to the phone ("Claude needs you", with a button back to the agent's session) and waits inside the call until you tap **Return to Claude**, up to 4 minutes per call (`PALM_AGENTS_AGENT_WAIT_SEC`); the agent calls it again to keep waiting.

### Photos and dev-server previews

- **Photos:** in a session, **⋯ → Send photo or screenshot** sends one from the phone (the ⋯ menu holds the less frequent actions, also Claude's full-detail view). It is shrunk to at most 2048 px, saved owner-only in `~/.palm-agents/uploads/` (removed after 7 days) and its path is pasted into the prompt. Claude Code turns a pasted image path into an attached image (`[Image #1]`); add your question and send.
- **Previews:** when a program started in a session listens on a port (a dev server), the session card says **serving :port** and the ⋯ button shows a dot. In the session, **⋯ → Preview :port on this phone** shares that port on your tailnet with Tailscale Serve (`https://<mac>.<tailnet>.ts.net:<port>`, tailnet only, never Funnel); **Open :port in Safari** then opens it. The share is removed when the server stops or you tap **Stop sharing**. Only ports owned by a process inside a tmux session can be shared. Some dev servers refuse unknown host names (Vite: `server.allowedHosts`); ask the agent to allow the `.ts.net` name. Set `PALM_AGENTS_TAILSCALE` to the CLI path if it is not in `/Applications/Tailscale.app`, or to `off` to disable previews.

## 7. Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `PALM_AGENTS_DATA_DIR` | `~/.palm-agents` | state directory |
| `PALM_AGENTS_PORT` / `HOST` | `8787` / `127.0.0.1` | loopback bind |
| `PALM_AGENTS_ALLOWED_ORIGINS` | localhost origins | comma list of extra allowed origins (your Tailscale HTTPS URL) |
| `PALM_AGENTS_TMUX` | found on PATH / `~/.local/bin` | tmux binary for the Terminal tab |
| `PALM_AGENTS_TAILSCALE` | auto (`/Applications/Tailscale.app/…`) | Tailscale CLI for dev-server previews; `off` disables them |
| `PALM_AGENTS_TMUX_SOCKET` | unset (default server) | tmux socket name (`tmux -L`); set only to isolate the phone's sessions from Terminal.app's |
| `PALM_AGENTS_PUSH_CONTACT` | first HTTPS allowed origin | VAPID contact for push services (`mailto:` or `https:`); Apple rejects placeholder addresses with 403 |
| `PALM_AGENTS_BROWSER_CHANNEL` | (Playwright Chromium) | `chrome` to use installed Google Chrome |
| `PALM_AGENTS_HEADLESS` | `0` | `1` for headless (tests) |
| `PALM_AGENTS_AGENT_WAIT_SEC` | `240` | how long one `request_human` call waits for Hand back |
| `PALM_AGENTS_AGENT_IDLE_SEC` | `30` | an agent that stops using the browser lets go after this |
| `PALM_AGENTS_OWNER_IDLE_SEC` | `60` | browsing on your own without input this long lets an agent take the browser back |
| `PALM_AGENTS_SESSION_TTL_DAYS` | `30` | phone session lifetime |
| `PALM_AGENTS_INSECURE_COOKIES` | unset | `1` only for plain-http local development |

## 8. Upgrades

`git pull && npm ci && npm run build && scripts/connect-agents.sh`, then `launchctl kickstart -k gui/$(id -u)/com.palm-agents.control`. Migrations run automatically at startup (`apps/control-service/src/db.ts`); they are additive. Back up first with `scripts/backup.sh`. Rollback: stop the service, restore the backup `palm-agents.sqlite`, check out the previous commit.

## 9. Uninstall

`scripts/uninstall-launchd.sh` removes the launchd agent and keeps data. `--purge-data` asks before deleting `~/.palm-agents` (which includes the browser profile with website logins).
