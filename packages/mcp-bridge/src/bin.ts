import { runStdioBridge } from "./index.ts";
runStdioBridge().catch((err) => {
  process.stderr.write(`mcp bridge failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
