import { build } from "esbuild";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
mkdirSync("public/assets", { recursive: true });
// Build id: the app compares it with /version.json and reloads itself when the Mac has a newer build.
const BUILD = Date.now().toString(36);
writeFileSync("public/version.json", JSON.stringify({ build: BUILD }));
const common = { define: { __BUILD__: JSON.stringify(BUILD) }, bundle: true, minify: true, sourcemap: false, target: ["safari16", "es2022"], logLevel: "info" };
await build({ ...common, entryPoints: ["src/main.tsx"], outfile: "public/assets/app.js", jsx: "automatic", jsxImportSource: "preact", format: "esm" });
await build({ ...common, entryPoints: ["src/sw.ts"], outfile: "public/sw.js", format: "iife" });
console.log("mobile-web built");
