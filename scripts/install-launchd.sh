#!/bin/zsh
# Installs a user-level launchd agent that keeps the control service running.
# Reversible with scripts/uninstall-launchd.sh. Does not touch FileVault, login
# items, or system settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node || echo "$HOME/.local/bin/node")}"
LABEL="com.palm-agents.control"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="${PALM_AGENTS_DATA_DIR:-$HOME/.palm-agents}"
mkdir -p "$DATA_DIR/logs" "$HOME/Library/LaunchAgents"
chmod 700 "$DATA_DIR"
ENV_FILE="$DATA_DIR/env"
[ -f "$ENV_FILE" ] || cat > "$ENV_FILE" <<ENV
# Environment for the Palm Agents control service (sourced by launchd wrapper).
# PALM_AGENTS_ALLOWED_ORIGINS=https://your-mac.your-tailnet.ts.net
# PALM_AGENTS_BROWSER_CHANNEL=chrome
ENV
chmod 600 "$ENV_FILE"
WRAPPER="$DATA_DIR/run.sh"
cat > "$WRAPPER" <<RUN
#!/bin/zsh
set -a; [ -f "$ENV_FILE" ] && source "$ENV_FILE"; set +a
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PALM_AGENTS_DATA_DIR="$DATA_DIR"
cd "$ROOT"
exec "$NODE" --no-warnings=ExperimentalWarning --import tsx apps/control-service/src/main.ts serve
RUN
chmod 700 "$WRAPPER"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$WRAPPER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DATA_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/logs/launchd.err.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $LABEL ($PLIST). Logs: $DATA_DIR/logs. Edit $ENV_FILE then: launchctl kickstart -k gui/$(id -u)/$LABEL"
