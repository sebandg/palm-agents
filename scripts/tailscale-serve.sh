#!/bin/zsh
# Publishes the loopback control service on the tailnet over HTTPS (never Funnel),
# then records the resulting origin in ~/.palm-agents/env and restarts the service.
# Works with the App Store / standalone app CLI or a userspace tailscale binary.
set -euo pipefail
TS="${TAILSCALE_BIN:-}"
for c in "$TS" "$(command -v tailscale 2>/dev/null || true)" "/Applications/Tailscale.app/Contents/MacOS/Tailscale" "$HOME/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
  [ -n "$c" ] && [ -x "$c" ] && TS="$c" && break
done
[ -x "${TS:-}" ] || { echo "tailscale CLI not found; set TAILSCALE_BIN"; exit 1; }
PORT="${PALM_AGENTS_PORT:-8787}"
DATA_DIR="${PALM_AGENTS_DATA_DIR:-$HOME/.palm-agents}"
echo "using $TS"
"$TS" status >/dev/null 2>&1 || { echo "tailscale is not connected yet; log in first ($TS login)"; exit 1; }
"$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
DNS="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
ORIGIN="https://$DNS"
echo "serving $ORIGIN -> http://127.0.0.1:$PORT"
"$TS" funnel status 2>/dev/null | grep -qi "funnel on" && { echo "WARNING: Funnel is enabled; disable it: $TS funnel off"; }
touch "$DATA_DIR/env"; chmod 600 "$DATA_DIR/env"
grep -v '^PALM_AGENTS_ALLOWED_ORIGINS=' "$DATA_DIR/env" > "$DATA_DIR/env.tmp" || true
echo "PALM_AGENTS_ALLOWED_ORIGINS=$ORIGIN" >> "$DATA_DIR/env.tmp"; mv "$DATA_DIR/env.tmp" "$DATA_DIR/env"; chmod 600 "$DATA_DIR/env"
launchctl kickstart -k "gui/$(id -u)/com.palm-agents.control" 2>/dev/null && echo "control service restarted with allowed origin $ORIGIN" || echo "restart the service manually (not under launchd)"
echo; echo "On the iPhone (Tailscale app logged into the same tailnet): open $ORIGIN  then run: npm run pair"
