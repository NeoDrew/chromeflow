# Chromeflow

Browser guidance for Claude Code. When Claude needs you to set up Stripe, grab API keys, configure a third-party service, or do anything in a browser — Chromeflow takes over. It highlights what to click, fills in fields it knows, clicks buttons automatically, and writes captured values straight to your `.env`.

## How it works

Chromeflow is two things that work together:

- **MCP server** — gives Claude Code a set of browser tools (`open_page`, `click_element`, `fill_input`, `read_element`, `write_to_env`, etc.)
- **Chrome extension** — receives those commands and acts on the active tab (highlights, clicks, fills, captures screenshots)

Claude drives the flow. You only touch the browser for things that genuinely need you — login, passwords, payment details, personal choices.

## Setup

**1. Run the setup wizard** from your project directory:

```bash
npx chromeflow setup
```

This:
- Registers the MCP server in `~/.claude.json`
- Writes `CLAUDE.md` into your project so Claude knows when and how to use Chromeflow
- Adds a hint to `~/.claude/CLAUDE.md` so Claude will suggest `npx chromeflow setup` in any project that isn't yet configured
- Pre-approves Chromeflow tools in `.claude/settings.local.json` (no per-action prompts)

**2. Install the Chrome extension** (one time):

The setup wizard opens the Chrome Web Store for you — click **Add to Chrome**.

Or install directly: [chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime)

The extension persists across Chrome restarts. You only do this once.

**3. Restart Claude Code.**

That's it. Claude will automatically reach for Chromeflow whenever a task needs browser interaction.

## Usage

Just ask Claude normally:

> "Set up Stripe for this project — create a product with monthly and annual pricing, capture the price IDs into .env"

> "Go to Supabase and get my project's anon key and service role key"

> "Help me configure SendGrid webhooks for this app"

Claude will navigate, highlight steps, click what it can, pause for anything sensitive, and write values to your `.env` automatically.

## Adding to another project

Run setup from the new project's directory — the MCP server is already registered globally, this just drops `CLAUDE.md` and tool permissions into the project:

```bash
npx chromeflow setup
```

## Commands

| Command | What it does |
|---------|-------------|
| `npx chromeflow setup` | Register MCP server, write project `CLAUDE.md`, pre-approve tools |
| `npx chromeflow update` | Refresh the project `CLAUDE.md` with the latest instructions |
| `npx chromeflow uninstall` | Remove all Chromeflow config (MCP entry, `CLAUDE.md` sections, tool permissions) |

## Development

```bash
git clone https://github.com/NeoDrew/chromeflow
cd chromeflow
npm install
npm run build
```

Then run setup using the local build:

```bash
node packages/mcp-server/dist/index.js setup
```

To rebuild on changes:

```bash
npm run dev:mcp   # watches mcp-server
npm run dev:ext   # watches extension
```

After rebuilding the extension, reload it from `chrome://extensions`.

## Requirements

- Claude Code
- Chrome (or any Chromium browser)
- Node.js 22+
