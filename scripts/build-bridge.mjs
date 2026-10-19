// Bundles the stdio MCP bridge into one self-contained file so the agent runtime
// can spawn it from any cwd with a minimal environment (no tsx, no node_modules lookup).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
mkdirSync("packages/mcp-bridge/dist", { recursive: true });
await build({
  entryPoints: ["packages/mcp-bridge/src/bin.ts"],
  outfile: "packages/mcp-bridge/dist/bridge.mjs",
  bundle: true,
  platform: "node",
  target: ["node24"],
  format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
