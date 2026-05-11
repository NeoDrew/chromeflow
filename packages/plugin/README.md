# chromeflow (Claude Code plugin)

The Claude Code plugin for [Chromeflow](https://chromeflow.vercel.app) — let Claude drive your real browser.

## What it bundles

- **MCP server binary** (`server/chromeflow.mjs`) — a single-file ESM bundle of the chromeflow MCP server (~30 tools, WebSocket bridge to the Chrome extension). Spawned by `.mcp.json` directly via `node`. No npm dependency.
- **Permission allowlist** (`settings.json`) — all 34 chromeflow tool names pre-approved, so Claude doesn't prompt you on every call.
- **Skill** (`skills/chromeflow/SKILL.md`) — usage guidance Claude pulls in when it detects a browser task (setting up Stripe, grabbing API keys, filling forms, etc.). Loaded on demand, not jammed into every conversation's context.
- **SessionStart hook** (`hooks/hooks.json`) — injects a short "use chromeflow tools, don't fall back to curl/AppleScript" pointer into every CC session. Also performs one-time migration cleanup for users coming from the old `npx chromeflow setup` flow (strips the stale `~/.claude.json` MCP entry and `~/.claude/CLAUDE.md` section).

## Install

```
/plugin marketplace add NeoDrew/chromeflow
/plugin install chromeflow
```

Then install the Chrome extension (one-time):
[chromewebstore.google.com/detail/chromeflow](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)

That's it — works in every project, no per-project setup, no npm package needed.

## Upgrading

```
/plugin update chromeflow
/reload-plugins
```

Restart Claude Code to pick up the new MCP server bundle.

## Migrating from the old `npx chromeflow setup` flow

The old npm package (`chromeflow`) and its CLI commands (`setup`, `update`, `uninstall`, `doctor`) are retired in 0.9.0+. The plugin now ships the MCP server binary directly.

If you previously ran `npx chromeflow setup` somewhere, just install the plugin — its first SessionStart hook cleans up:

- The stale `mcpServers.chromeflow` entry in `~/.claude.json`
- Any leftover `## Chromeflow` section in `~/.claude/CLAUDE.md`

Per-project `CLAUDE.md` files and `.claude/settings.local.json` allowlists are left alone (they may have content you want to keep). The `# Chromeflow — Claude Instructions` section in each old project's `CLAUDE.md` is safe to delete by hand — the plugin's skill carries the same content.

## Build

The MCP server source lives at `packages/mcp-server/src/` and is bundled into `server/chromeflow.mjs`:

```
packages/plugin/scripts/build-server.sh
```

The skill body is synced from the canonical root `CLAUDE.md`:

```
packages/plugin/scripts/sync-skill.sh
```

## Related

- Chrome extension: [Chrome Web Store](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)
- Source: [github.com/NeoDrew/chromeflow](https://github.com/NeoDrew/chromeflow)
