# Chromeflow Setup

## Install

```bash
git clone https://github.com/you/chromeflow
cd chromeflow
npm install && npm run build
```

## Run the setup wizard

From your project directory:

```bash
node /path/to/chromeflow/packages/mcp-server/dist/index.js setup
```

This will:
- Register the MCP server in `~/.claude.json`
- Create or update `CLAUDE.md` in your current project
- Open `chrome://extensions` so you can load the extension

## Load the Chrome extension (one time)

The setup wizard opens the page for you. Then:

1. Enable **Developer mode** (top-right toggle)
2. Click **Load unpacked**
3. Select the path printed by the setup wizard (`packages/extension/dist`)

You only do this once. The extension persists across Chrome restarts.

## Start using it

Open a new Claude Code session in your project. The MCP server starts automatically.
The extension connects within a few seconds — you'll see the status in the popup.

Ask Claude something like:

> "Set up Stripe for this project — create a product with monthly and annual pricing and
> capture the price IDs into .env"

## Adding chromeflow to another project

Just run the setup wizard from that project's directory:

```bash
node /path/to/chromeflow/packages/mcp-server/dist/index.js setup
```

The MCP server is already registered globally — this just adds `CLAUDE.md` to the new project.
