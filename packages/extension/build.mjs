import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");

const sharedConfig = {
  bundle: true,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

async function build() {
  mkdirSync("dist", { recursive: true });

  // Copy static assets
  cpSync("src/popup/index.html", "dist/popup.html");
  cpSync("src/offscreen.html", "dist/offscreen.html");
  cpSync("manifest.json", "dist/manifest.json");

  const contexts = await Promise.all([
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/background.ts"],
      outfile: "dist/background.js",
      format: "esm",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/offscreen.ts"],
      outfile: "dist/offscreen.js",
      format: "iife",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/content/index.ts"],
      outfile: "dist/content.js",
      format: "iife",
      platform: "browser",
    }),
    esbuild.context({
      ...sharedConfig,
      entryPoints: ["src/popup/index.ts"],
      outfile: "dist/popup.js",
      format: "iife",
      platform: "browser",
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    console.log("Build complete.");
  }
}

build().catch(console.error);
