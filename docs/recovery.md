# Recovery

Recovery is layered. Each layer is independent of the one above it.

| Failure | What you see | What to do |
| --- | --- | --- |
| Agent crashes or hangs | Its terminal session shows it; management stays reachable | Open the session, press Esc / ^C, or start a new one. An agent that holds the browser lets go of it after 30 s without calls |
| Browser crashes / hangs | Settings → Browser `unavailable` with the reason; Browser view shows an overlay, no fake live frame; an agent using it gets a browser error and can retry | Supervisor restarts automatically with backoff (3s, 10s, 30s, 60s). Or tap **Restart browser**. Logins in the profile are kept |
| Browser profile locked (another Chromium holds it) | `unavailable: profile appears to be locked…` | The service never replaces the profile. Quit the other Chromium (or `pkill -f browser-profile`) and restart the browser |
| Control service crashes | Page does not load | launchd restarts it (KeepAlive, 10s throttle). On start it keeps human ownership if you had the browser, and issues a new agent token (the bridge picks it up on its next call). Terminal sessions live in tmux and are unaffected |
| Phone disconnects during a login | Nothing changes on the Mac | Human ownership and the pending request persist; reopen the app, the Needs-you banner is still there |
| Phone loses network | Status pill `reconnecting`/`offline`; drafts stay in the box | Nothing queued is auto-sent later. Reconnect replays events from the last cursor |
| Session revoked / expired | Pairing screen | `npm run pair` on the Mac |
| Tailscale down | Page unreachable | Fix Tailscale on either device. Agents keep running |
| Mac asleep / powered off / network down | Page unreachable; the Mac cannot report this itself | Needs a person at the Mac or external monitoring (not included). Set Energy settings to prevent sleep on power |
| Mac rebooted (FileVault) | Unreachable until someone unlocks the disk at the login screen | By design: keep FileVault on and auto-login off. The launchd **user** agent starts after login |

## Bookmarkable recovery route

`https://<mac>.<tailnet>.ts.net/system` — needs the control service. If the whole service is down, use the Mac directly or SSH.

## Optional SSH (explicit choice)

System Settings → General → Sharing → Remote Login, limited to your user, and restrict with Tailscale ACLs to your own devices. Then from the phone (e.g. Termius over Tailscale):

```sh
launchctl kickstart -k gui/$(id -u)/com.palm-agents.control   # restart service
tail -n 100 ~/.palm-agents/logs/control-service.log
cd path/to/palm-agents && npm run doctor
```

## Guarantees about side effects

- The service never replays an agent's browser action; agents retry themselves after an error.
- Leaving human control after an agent asked for help takes a **Hand back** tap; a notification or a reconnect cannot do it. (If you only browsed on your own and then leave the browser alone for a minute, an agent may take it back.)
- Exactly-once execution of website actions is **not** promised.

## Logs and diagnostics

`~/.palm-agents/logs/control-service.log` (5 MiB × 3 rotation, secrets redacted) and `launchd.{out,err}.log`. `GET /api/diagnostics` (authenticated) returns health and the last 100 log lines.

## Backups

`scripts/backup.sh [dir]` does a consistent SQLite `.backup` plus a copy of the browser profile. Stop the service first for a clean profile copy.
