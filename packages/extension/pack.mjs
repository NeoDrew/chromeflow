#!/usr/bin/env node
/**
 * Package packages/extension/dist/ into a Chrome Web Store-ready .zip.
 *
 * Reads the version + name from dist/manifest.json so the artifact name
 * tracks whatever was actually built. Re-running overwrites the existing zip
 * at the same version.
 *
 * Usage: `npm run package` from packages/extension/ (or via the workspace).
 * Run after `npm run build` so dist/ is fresh. The combined script
 * `npm run package` in package.json chains both.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve("dist");
const manifestPath = resolve(distDir, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error(`error: ${manifestPath} not found — run \`npm run build\` first`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const slug = String(manifest.name ?? "extension")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");
const outFile = resolve(`${slug}-${manifest.version}.zip`);

if (existsSync(outFile)) unlinkSync(outFile);

// `cd dist && zip -r ../X.zip .` archives with paths relative to dist/, so the
// resulting zip unpacks straight into a folder ready for "Load unpacked" /
// Chrome Web Store upload. Exclude noise that occasionally sneaks into dist/
// (Finder metadata, source maps if a watcher run left any).
execSync(
  `cd dist && zip -r ${JSON.stringify(outFile)} . -x '*.DS_Store' '*.map'`,
  { stdio: "inherit" }
);

const sizeKb = Math.round(statSync(outFile).size / 1024);
console.log(`\n✓ Packed ${outFile} (${sizeKb} KB) — chromeflow ${manifest.version}`);
console.log(`  Upload at https://chrome.google.com/webstore/devconsole`);
