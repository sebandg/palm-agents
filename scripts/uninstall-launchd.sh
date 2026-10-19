#!/bin/zsh
# Stops and removes the launchd agent. Keeps data (tasks + browser profile)
# unless you pass --purge-data.
set -euo pipefail
LABEL="com.palm-agents.control"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="${PALM_AGENTS_DATA_DIR:-$HOME/.palm-agents}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL"
if [ "${1:-}" = "--purge-data" ]; then
  read "ans?Delete $DATA_DIR including the browser profile with its website logins? [y/N] "
  [ "$ans" = "y" ] && rm -rf "$DATA_DIR" && echo "deleted $DATA_DIR"
else
  echo "data kept at $DATA_DIR (use --purge-data to remove)"
fi
