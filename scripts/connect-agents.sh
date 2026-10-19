#!/bin/zsh
# Gives Claude Code and Codex the shared browser: registers the palm-browser MCP tool
# (packages/mcp-bridge) for this user. Agents in any terminal session can then look at
# and use the shared browser, and hand it to the owner's phone for logins.
# Safe to re-run. Undo: `claude mcp remove -s user palm-browser` and delete the
# [mcp_servers.palm-browser] block from ~/.codex/config.toml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node || echo "$HOME/.local/bin/node")}"
BRIDGE="$ROOT/packages/mcp-bridge/dist/bridge.mjs"

(cd "$ROOT" && "$NODE" scripts/build-bridge.mjs >/dev/null)
[ -f "$BRIDGE" ] || { echo "bridge bundle missing: $BRIDGE" >&2; exit 1; }

if command -v claude >/dev/null; then
  claude mcp remove -s user palm-browser >/dev/null 2>&1 || true
  claude mcp add -s user palm-browser -- "$NODE" "$BRIDGE" >/dev/null
  echo "Claude Code: palm-browser added"
else
  echo "Claude Code: not installed, skipped"
fi

if command -v codex >/dev/null; then
  CONFIG="$HOME/.codex/config.toml"
  mkdir -p "$HOME/.codex"
  touch "$CONFIG"
  if grep -q '^\[mcp_servers.palm-browser\]' "$CONFIG"; then
    echo "Codex: palm-browser already in $CONFIG"
  else
    # request_human waits for the owner for up to 4 minutes, beyond Codex's 60 s default.
    cat >> "$CONFIG" <<TOML

[mcp_servers.palm-browser]
command = "$NODE"
args = ["$BRIDGE"]
tool_timeout_sec = 300
TOML
    echo "Codex: palm-browser added to $CONFIG"
  fi
else
  echo "Codex: not installed, skipped"
fi
echo "Start a new agent session to pick it up."
