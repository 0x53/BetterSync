import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

/** Bundles the plugin into dist/ (main.js + manifest.json), ready to copy into a vault's .obsidian/plugins/bettersync/. */
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  // iOS 16's WebKit, the oldest Obsidian mobile supports.
  target: "es2021",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--minify") ? false : "inline",
  logLevel: "warning",
});
copyFileSync("manifest.json", "dist/manifest.json");
