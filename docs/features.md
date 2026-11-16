# Features

What Palm Agents does and how each part behaves. Setup steps are in [setup.md](setup.md), the security model in [security.md](security.md).

## Terminal sessions

- Agents run in ordinary tmux sessions on the Mac. They keep running when the phone disconnects, and the same session can be opened at the desk.
- The phone's Terminal tab lists every session on the Mac's default tmux server and shows one at the phone's own width, with a text box and a row of keys for what CLIs ask for (1/2/3, y/n, arrows, Esc, Ctrl-C).
- Whoever used a session last gets the width: the phone sets its size when you type there, and the Mac takes it back when its window is attached, focused or resized.
- Web addresses in a session's output are tappable on the phone, including long ones a CLI wrapped over several lines. A tap opens the page in the phone's own browser.
- Only sessions on the tmux server are visible to Palm Agents. A `claude` started straight in a desk terminal has no phone remote, no alerts and no presence signal.

## Starting a session

- **From the phone:** the Terminal tab creates a session and, by default, opens a Terminal window for it on the Mac.
- **At the Mac:** `cs <name>` opens or re-attaches a session. `scripts/claude-session.command` (copy it to the Desktop and double-click) lists the projects in `~/dev`, newest first, and attaches a session running `claude` in the one you pick.
- All three clear `CLAUDE*`/`ANTHROPIC*` from the environment, which a nested `claude` would refuse to start with.

## Status and alerts

- Every session shows **working** (its screen changed in the last few seconds), **needs you** (it looks like a prompt) or **idle**.
- The service checks sessions every 3 seconds even with no phone open. When one starts waiting, the phone gets a push alert that names the session; tapping it opens that session.

## The shared browser

One Chrome on the Mac, with its own profile, that agents drive and the phone watches and controls. Only one of you controls it at a time.

- **It is a normal Chrome.** The service opens Google Chrome as an app (`open -na`) on the profile `~/.palm-agents/browser-profile` with a loopback DevTools port, and only attaches to it. It is not launched by the automation library, because sites behind a bot check (claude.ai) refused sign-in in a browser started that way. Set `PALM_AGENTS_BROWSER_CHANNEL=chrome` to use installed Chrome; without it the bundled Chromium is used.
- **It never claims to be a phone.** While you drive it from the phone, pages are sized to the phone's screen and nothing else changes: same desktop user agent, no touch emulation, no reload when control changes hands, so a half-filled form survives.
- **The phone shows the tab that is in front.** If you click another tab in the Chrome window, or a link opens in a new one, the phone follows within about two seconds. A dropdown lists the tabs when there is more than one; it works only while you have control.
- **Links opened inside a session land here.** Sessions get `BROWSER=scripts/open-in-shared-browser`, so a CLI that opens a web address (for example `claude /login`) opens it as a new front tab in the shared Chrome, not in the Mac's default browser. If the shared Chrome is not running, the default browser is used.
- **After a restart it reopens the last page,** unless that page was a sign-in, consent or verification page.
- **Hand-over for logins.** An agent that hits a login, code or CAPTCHA calls `request_human`; the phone alerts you, you sign in through the live view (password-manager fill works through a credential form), and hand back. Typed credentials are never logged or shown to the agent.
- **Each agent session works in its own tab,** and its tabs are closed when the session ends.

## Tools agents get (`palm-browser`)

`scripts/connect-agents.sh` registers the MCP server for Claude Code and Codex.

- `browser_observe`, `browser_navigate`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_tabs`: use the shared browser.
- `request_human`: hand the browser to the owner and wait until they hand it back.
- `owner_context`: ask which screen the owner is at right now (see below). Read-only; it does not take the browser.

## Knowing where the owner is

`owner_context` (and `/api/presence`) answers **desk**, **phone**, **away** or **unknown**, with the reasons, so an agent can print a link when you are at the Mac and use the shared browser when you are not.

- **Desk:** the Mac's keyboard or trackpad was touched in the last 90 seconds (up to 15 minutes counts as "recently").
- **Phone:** a paired phone has the app open in the foreground, or called the service in the last 2 minutes.
- **Away:** neither is fresh; the answer names the screen used last.
- Being at the Mac wins over an open phone app, because a phone left open on the desk is not you using it.

## Photos and previews

- **Photos:** send a photo or screenshot from the phone into a session; its path is pasted into the prompt. Files are kept owner-only for 7 days.
- **Dev-server previews:** a dev server an agent started can be opened in the phone's own browser. It is shared on your tailnet only.

## Access

- The service listens on `127.0.0.1` only. The phone reaches it through Tailscale Serve and is paired once with a one-time code.
- The agent bridge accepts calls only from the Mac itself, with a token that changes on every service start.

## Known limits and open questions

- **Sign-in to claude.ai** worked in the shared browser at the Mac on 16 Nov 2026 after Chrome was opened as an app and the profile's history was cleared. Which of the two made the difference is not proven. If the bot check returns, delete claude.ai's site data in that window first.
- **Not yet tried:** signing in to claude.ai through a hand-over from the phone, and `claude /login` opening its link through the `BROWSER` setting.
- **Deleting history** in the shared Chrome was blocked while the service was attached, and worked when it was not. The cause is unknown.
- **The live view may freeze** while the Chrome window is covered or minimised.
- **Machine-local settings.** The PALM AGENTS profile name and teal theme, the Chrome channel, and `PALM_AGENTS_NATIVE_VIEWPORT=1` (pages keep the real window size instead of 1024×768) live in the profile and `~/.palm-agents/env`, not in the repo. A fresh install has none of them.
- **Sessions started before 16 Nov 2026's change** keep opening links in the default browser until they are restarted.
- **The DevTools port** lets any process running as you on the Mac drive the shared browser. See [security.md](security.md).
