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

This registers the MCP server in `~/.claude.json` and writes a `CLAUDE.md` into your project so Claude knows when and how to use Chromeflow.

**2. Load the Chrome extension** (one time):

The setup wizard opens `chrome://extensions` for you. Then:
1. Enable **Developer mode** (top-right toggle)
2. Click **Load unpacked**
3. Select the path printed by the setup wizard

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

Run the setup wizard from the new project's directory:

```bash
npx chromeflow setup
```

The MCP server is already registered globally — this just adds `CLAUDE.md` to the project.

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

After rebuilding the extension, click **Update** on `chrome://extensions`.

## Requirements

- Claude Code
- Chrome (or any Chromium browser)
- Node.js 22+
