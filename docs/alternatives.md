# Related tools (as of October 2026)

What else exists for running agents from a phone or handing a browser to a human, and how Palm Agents differs. Claims marked *unverified* could not be confirmed from a primary source.

## First-party Anthropic

- **Claude Code Remote Control** (`claude remote-control` / `--remote-control`): mirrors a *local* session to the Claude iOS/Android app or claude.ai/code; permission prompts and questions are forwarded to the phone; push notifications on "action required"; `--chrome` works in server mode. No evidence that the phone shows Mac browser screenshots or lets you act in the Mac's browser; login/CAPTCHA pauses assume a person at the machine, and `--chrome` drives the owner's *real* Chrome profile. https://code.claude.com/docs/en/remote-control , https://code.claude.com/docs/en/mobile , https://code.claude.com/docs/en/chrome
- **Claude Code on the web / cloud sessions**: Anthropic VM + GitHub repo; no local browser link. https://code.claude.com/docs/en/claude-code-on-the-web
- **Computer use (CLI, macOS)**: native app control, browsers view-only, interactive sessions only. https://code.claude.com/docs/en/computer-use
- **Managed Agents**: hosted sandbox; browser only via Browserbase. https://platform.claude.com/docs/en/managed-agents/overview

## Third-party Claude Code phone consoles

Happy Coder, Omnara, VibeTunnel, Conductor, Claudia: chat/approvals/terminal on the phone, none with a browser live view or same-session login handoff per their docs.

## Browser infrastructure with live view + human takeover

| Tool | Handoff of the same session | Local macOS | MCP |
| --- | --- | --- | --- |
| Browserbase | live view, no formal pause/resume API | cloud | archived server |
| Anchor, Hyperbrowser, Kernel | interactive live view | cloud | varies |
| Steel | `steel_session_handoff` tool: pause, human takes control, resume | self-host via Docker or bare Node | yes |
| Browser Use Cloud | take over, continue same `session_id` | cloud | – |
| Cloudflare Browser Run | `handoff` / `handoffComplete` CDP events (cleanest contract) | cloud | – |
| Skyvern | TOTP/email 2FA, no manual takeover | pip/Docker | yes |
| playwright-mcp | persistent headed profile; log in at the Mac | yes | yes |
| BetterWright (npm) | JPEG-over-WebSocket viewer, "Take control", `browser_handoff` tool, Tailscale preset | Node (macOS not confirmed) | yes |

## Where Palm Agents fits

- **What it is:** real agent CLIs in tmux sessions on your own machine, a phone web app to drive them, and a dedicated browser on the machine that agents use through an MCP tool and that you can take over from the phone. Everything stays on the machine and your tailnet; no chat platform, no remote desktop.
- **Closest first-party path:** Claude Code Remote Control plus `--chrome`. Free and official, but for one Claude session at a time; logins need a person at the machine or a remote-desktop app, `--chrome` uses your real Chrome profile, and the phone cannot act in the browser.
- **Hosted browsers with live view** (Cloudflare, Steel, Browser Use) solve the hand-over, but cookies and sessions live in the cloud.
- **Other open-source consoles:** BetterWright covers the browser half (viewer, hand-over tool, Tailscale preset); Happy and Omnara cover the chat half. The `palm-browser` bridge is a plain stdio MCP server with a thin tool surface, so the browser side could be swapped for one of these later.
