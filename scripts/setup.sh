#!/bin/zsh
# One-time native setup on the Mac. No sudo, no Docker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "Node.js >= 24 is required. Install from https://nodejs.org (or extract the arm64 tarball into ~/.local/node and symlink into ~/.local/bin)."; exit 1
fi
npm ci --no-audit --no-fund
node node_modules/esbuild/install.js >/dev/null 2>&1 || true
npx playwright install chromium
npm run build
npm run doctor || true
echo
echo "Next: start the service (npm start or scripts/install-launchd.sh), run 'npm run pair', and set up Tailscale Serve (docs/setup.md)."
