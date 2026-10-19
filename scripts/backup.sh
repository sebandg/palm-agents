#!/bin/zsh
# Consistent backup of the SQLite database (tasks, sessions, approvals).
# The browser profile is copied as-is; stop the service first for a clean copy.
set -euo pipefail
DATA_DIR="${PALM_AGENTS_DATA_DIR:-$HOME/.palm-agents}"
OUT="${1:-$HOME/palm-agents-backup-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"; chmod 700 "$OUT"
sqlite3 "$DATA_DIR/palm-agents.sqlite" ".backup '$OUT/palm-agents.sqlite'"
[ -d "$DATA_DIR/browser-profile" ] && cp -R "$DATA_DIR/browser-profile" "$OUT/browser-profile"
echo "backup written to $OUT (contains website sessions: keep it private)"
