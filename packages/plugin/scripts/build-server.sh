#!/usr/bin/env bash
# Bundle the MCP server source into a single-file ESM binary the plugin ships.
# Source: packages/mcp-server/src/index.ts (and its imports + node_modules deps).
# Output: packages/plugin/server/chromeflow.mjs
#
# Reads the version from packages/plugin/.claude-plugin/plugin.json so the bundle
# reports the same version users see in `/plugin list`.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
SOURCE="$REPO_ROOT/packages/mcp-server/src/index.ts"
OUT="$PLUGIN_DIR/server/chromeflow.mjs"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "error: esbuild not found at $ESBUILD — run \`npm install\` at the repo root" >&2
  exit 1
fi

VERSION=$(node -p "require('$PLUGIN_DIR/.claude-plugin/plugin.json').version")

mkdir -p "$PLUGIN_DIR/server"

"$ESBUILD" \
  "$SOURCE" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile="$OUT" \
  --define:__CHROMEFLOW_VERSION__="\"$VERSION\"" \
  --banner:js="#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);" \
  --external:fsevents

echo "✓ Bundled chromeflow MCP server v$VERSION → $OUT"
