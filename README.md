# Chromeflow

Browser guidance for Claude Code. When Claude needs you to set up Stripe, grab API keys, configure a third-party service, or do anything in a browser — Chromeflow takes over. It highlights what to click, fills in fields it knows, clicks buttons automatically, uploads files, and writes captured values straight to your `.env`.

## Why Chromeflow?

Existing browser automation tools (Playwright, Browser Use, Puppeteer) launch a **fresh, empty browser** — no cookies, no sessions, no extensions. Every time they start, you're logged out of everything and can't handle 2FA.

Chromeflow works in **your actual Chrome browser**, where you're already logged into Stripe, AWS, Supabase, and everything else. Claude automates what it can (clicking buttons, filling forms, uploading files) and pauses for anything that needs you (passwords, 2FA, payment details).

| | Chromeflow | Playwright / Browser Use |
|---|---|---|
| **Browser** | Your real Chrome (sessions intact) | Fresh instance, logged out of everything |
| **Auth / 2FA** | Already handled — pauses when needed | Can't handle — blocks completely |
| **Page understanding** | DOM queries (fast, cheap, reliable) | Screenshots + vision model (slow, expensive) |
| **Human-in-the-loop** | Built-in guide panel, highlights, pauses | Fully autonomous, no interaction |
| **Integration** | MCP server for Claude Code | Standalone, not Claude Code aware |
| **Credential capture** | Reads API keys → writes to `.env` | Not designed for this |

## How it works

Chromeflow is two things that work together:

- **MCP server** — gives Claude Code a set of browser tools (`open_page`, `click_element`, `fill_form`, `set_file_input`, `read_element`, `write_to_env`, etc.)
- **Chrome extension** — receives those commands and acts on the active tab (highlights, clicks, fills, uploads files, captures screenshots)

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

## What Claude can do

| Capability | Tools |
|------------|-------|
| Navigate pages, open new tabs | `open_page`, `list_tabs`, `switch_to_tab` |
| Click buttons and links | `click_element` (with `nth` for duplicates) |
| Fill single fields | `fill_input` (with `nth` for duplicates) |
| Fill multiple fields in one call | `fill_form` |
| Upload files (even hidden inputs) | `set_file_input` |
| Read page content as text | `get_page_text` (with `selector` scoping) |
| Inspect all form fields | `get_form_fields` |
| Scroll to a known element | `scroll_to_element` |
| Highlight elements for the user | `highlight_region`, `find_and_highlight` |
| Wait for the user to click | `wait_for_click` |
| Wait for async changes | `wait_for_selector` |
| Run arbitrary JS | `execute_script` |
| Read browser console output | `get_console_logs` |
| Capture credentials to `.env` | `read_element`, `write_to_env` |
| Screenshot (element location only) | `take_screenshot` |
| Screenshot + save + copy to clipboard | `take_and_copy_screenshot` |
| Screenshot the terminal window | `capture_terminal` |
| Save/restore form state across tabs | `save_page_state`, `restore_page_state` |
| Show a step-by-step guide panel | `show_guide_panel`, `mark_step_done` |

### File uploads

`set_file_input` uses Chrome DevTools Protocol to bypass the browser's file-input script restriction — the same mechanism used by Playwright and Puppeteer. It works even when the `<input type=file>` is hidden behind a custom drag-and-drop zone.

```
set_file_input("Upload", "/Users/you/Downloads/task.zip")
```

### Terminal screenshots

`capture_terminal` screenshots the terminal window (Terminal, iTerm2, Warp, VS Code, Ghostty, etc.) and saves it as a PNG. Use this with `set_file_input` to upload terminal output to a web form.

### Dedicated Claude window

Click the Chromeflow extension icon and use **"Use this window for Claude"** to lock Claude's browser operations to a specific Chrome window. This lets you freely use other Chrome windows without Claude interfering.

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
