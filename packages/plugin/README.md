# chromeflow (Claude Code plugin)

The Claude Code plugin for [Chromeflow](https://chromeflow.vercel.app) — let Claude drive your real browser.

## What it bundles

- **MCP server** registration (`.mcp.json` → `npx -y chromeflow`) — the chromeflow MCP server is fetched from npm on first run.
- **Permission allowlist** (`settings.json`) — all 34 chromeflow tool names pre-approved, so Claude doesn't prompt you on every call.
- **Skill** (`skills/chromeflow/SKILL.md`) — usage guidance Claude pulls in when it detects a browser task (setting up Stripe, grabbing API keys, filling forms, etc.). Loaded on demand, not jammed into every conversation's context.
- **SessionStart hook** (`hooks/hooks.json`) — injects a short "use chromeflow tools, don't fall back to curl/AppleScript" pointer into every CC session's context. Belt-and-braces guard against Claude skipping the skill for subtle browser tasks.

## Install

```
/plugin marketplace add NeoDrew/chromeflow
/plugin install chromeflow
```

Then install the Chrome extension (one-time):
[chromewebstore.google.com/detail/chromeflow](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)

That's it — works in every project, no per-project setup.

The plugin ships a `SessionStart` hook that automatically injects a short "use chromeflow tools, don't fall back to Bash/curl" pointer into every CC session's context, so Claude never drifts to `curl` or AppleScript for browser tasks. No file editing required.

## Why a plugin (and not `npx chromeflow setup`)

`npx chromeflow setup` is the legacy path — it still works, but it has to run **in every project** to write `CLAUDE.md` and `.claude/settings.local.json`. The plugin handles all of that once, machine-wide.

The legacy CLI now prints a hint pointing at this plugin.

## Related

- npm package (MCP server binary): [chromeflow](https://www.npmjs.com/package/chromeflow)
- Chrome extension: [Chrome Web Store](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)
- Source: [github.com/NeoDrew/chromeflow](https://github.com/NeoDrew/chromeflow)
