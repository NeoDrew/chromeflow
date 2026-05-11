# chromeflow (Claude Code plugin)

The Claude Code plugin for [Chromeflow](https://chromeflow.vercel.app) — let Claude drive your real browser.

## What it bundles

- **MCP server** registration (`.mcp.json` → `npx -y chromeflow`) — the chromeflow MCP server is fetched from npm on first run.
- **Permission allowlist** (`settings.json`) — all 34 chromeflow tool names pre-approved, so Claude doesn't prompt you on every call.
- **Skill** (`skills/chromeflow/SKILL.md`) — usage guidance Claude pulls in when it detects a browser task (setting up Stripe, grabbing API keys, filling forms, etc.). Loaded on demand, not jammed into every conversation's context.

## Install

```
/plugin marketplace add NeoDrew/chromeflow
/plugin install chromeflow
```

Then install the Chrome extension (one-time):
[chromewebstore.google.com/detail/chromeflow](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)

**Strongly recommended** — add this block to `~/.claude/CLAUDE.md` so Claude never reaches for `curl` / `osascript` / Playwright on browser tasks:

```markdown
## Chromeflow

The Chromeflow Claude Code plugin is installed. For ANY task that touches a real browser — opening sites, checking if a page is up, reading content, filling forms, logging in, capturing API keys, OAuth, scraping, navigating dashboards — use the `mcp__plugin_chromeflow_chromeflow__*` tools and load the `chromeflow` skill for the usage patterns.

Do NOT fall back to Bash / `curl` / `osascript` / AppleScript / Playwright / Puppeteer for browser tasks. Chromeflow drives the user's real Chrome with their sessions intact; the fallbacks won't have their logins and will fail silently.
```

The plugin's `chromeflow` skill loads on demand — but if Claude doesn't realise a request is browser-y, it might skip the skill and reach for `curl`. This 3-line pointer is always in context and prevents that drift. (If you ever run `npx chromeflow setup`, it writes this block for you automatically.)

That's it — works in every project, no per-project setup.

## Why a plugin (and not `npx chromeflow setup`)

`npx chromeflow setup` is the legacy path — it still works, but it has to run **in every project** to write `CLAUDE.md` and `.claude/settings.local.json`. The plugin handles all of that once, machine-wide.

The legacy CLI now prints a hint pointing at this plugin.

## Related

- npm package (MCP server binary): [chromeflow](https://www.npmjs.com/package/chromeflow)
- Chrome extension: [Chrome Web Store](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)
- Source: [github.com/NeoDrew/chromeflow](https://github.com/NeoDrew/chromeflow)
