<p align="center">
  <img src="assets/icon.png" width="120" alt="Chromeflow" />
</p>

<h1 align="center">Chromeflow</h1>

When Claude needs you to set up Stripe, grab API keys, configure a third-party service, or do anything in a browser — Chromeflow takes over. It highlights what to click, fills in fields it knows, clicks buttons automatically, uploads files, and writes captured values straight to your `.env`.

## Why Chromeflow?

Existing browser automation tools (Playwright, Browser Use, Puppeteer) launch a **fresh, empty browser** — no cookies, no sessions, no extensions. Every time they start, you're logged out of everything and can't handle 2FA.

Chromeflow works in **your actual Chrome browser**, where you're already logged into Stripe, AWS, Supabase, and everything else. Claude automates what it can (clicking buttons, filling forms, uploading files) and pauses for anything that needs you (passwords, 2FA, payment details).

| | Chromeflow | Playwright / Browser Use |
|---|---|---|
| **Browser** | Your real Chrome (sessions intact) | Fresh instance, logged out of everything |
| **Auth / 2FA** | Already handled — pauses when needed | Can't handle — blocks completely |
| **Page understanding** | DOM queries (fast, cheap, reliable) | Screenshots + vision model (slow, expensive) |
| **Human-in-the-loop** | Highlights, pauses on sensitive input | Fully autonomous, no interaction |
| **Integration** | MCP server for Claude Code | Standalone, not Claude Code aware |
| **Credential capture** | Reads API keys → writes to `.env` | Not designed for this |

## How it works

Chromeflow is two things that work together:

- **MCP server** — gives Claude Code a set of browser tools (`open_page`, `click_element`, `fill_form`, `set_file_input`, `read_element`, `write_to_env`, etc.)
- **Chrome extension** — receives those commands and acts on the active tab (highlights, clicks, fills, uploads files, captures screenshots)

Claude drives the flow. You only touch the browser for things that genuinely need you — login, passwords, payment details, personal choices.

## Setup

**1. Install the Claude Code plugin** (one-time, machine-wide):

```
/plugin marketplace add NeoDrew/chromeflow
/plugin install chromeflow
```

Run these inside Claude Code. The plugin registers the MCP server, pre-approves Chromeflow tools, and ships the usage skill — no per-project setup needed.

**2. Install the Chrome extension** (one time):

[chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime) — click **Add to Chrome**.

The extension persists across Chrome restarts. You only do this once.

**3. Restart Claude Code.**

That's it. Claude will automatically reach for Chromeflow whenever a task needs browser interaction, in any project.

<details>
<summary>Legacy per-project setup (pre-plugin)</summary>

If you're on a Claude Code version without plugin support, or prefer per-project config, the older flow still works:

```bash
npx chromeflow setup
```

This registers the MCP server in `~/.claude.json`, writes `CLAUDE.md` into the current project, and pre-approves Chromeflow tools in `.claude/settings.local.json`. You have to run it in every project. The plugin route above replaces all of this in one install.
</details>

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
| Screenshot (Claude-only by default; pass `copy_to_clipboard` / `save_to` to share) | `take_screenshot` |
| Screenshot the terminal window | `capture_terminal` |
| Save/restore form state across tabs | `save_page_state`, `restore_page_state` |

### File uploads

`set_file_input` uses Chrome DevTools Protocol to bypass the browser's file-input script restriction — the same mechanism used by Playwright and Puppeteer. It works even when the `<input type=file>` is hidden behind a custom drag-and-drop zone.

```
set_file_input("Upload", "/Users/you/Downloads/task.zip")
```

### Terminal screenshots

`capture_terminal` screenshots the terminal window (Terminal, iTerm2, Warp, VS Code, Ghostty, etc.) and saves it as a PNG. Use this with `set_file_input` to upload terminal output to a web form.

### Dedicated Claude window

Click the Chromeflow extension icon and use **"Use this window for Claude"** to lock Claude's browser operations to a specific Chrome window. This lets you freely use other Chrome windows without Claude interfering.

### Running multiple Claude Code instances in parallel

Chromeflow supports up to 11 Claude Code sessions running in parallel, each automating a different Chrome window without touching the others.

**How it works:**
- Each CC session spawns its own Chromeflow MCP server, which auto-discovers a free port in the range `7878-7888` (first session gets 7878, second gets 7879, etc.).
- The Chrome extension maintains one WebSocket connection per port and tracks per-port window assignments.
- Every browser tool call is routed to the Chrome window assigned to the port the request came in on.

**Setup:**
1. Start your first Claude Code session as normal — its Chromeflow will claim port 7878.
2. Start a second CC session in another terminal — its Chromeflow auto-falls-back to 7879.
3. Click the Chromeflow extension icon. The popup now shows **one row per instance** (Port 7878, Port 7879, ...) each with a green dot when live.
4. In Chrome **window A**, open the popup and click **"Use this window"** next to Port 7878.
5. Switch to **window B**, open the popup, and click **"Use this window"** next to Port 7879.

That's it. Each CC session now drives its own Chrome window — you can run a DataAnnotation task in one window while the other session fills out a Stripe dashboard in another, with zero collision.

Single-instance usage is unchanged and fully backwards compatible — the old per-window assignment is auto-migrated on first load.

## Adding to another project

Nothing to do — the plugin install above is machine-wide. Open any project and Chromeflow is ready.

(If you used the legacy `npx chromeflow setup` flow, you'd have to run it in each project. That's why the plugin exists.)

## Commands

| Command | What it does |
|---------|-------------|
| `npx chromeflow setup` | Legacy: register MCP server, write project `CLAUDE.md`, pre-approve tools (per-project). Prefer the plugin install above. |
| `npx chromeflow update` | Refresh the project `CLAUDE.md` with the latest instructions |
| `npx chromeflow uninstall` | Remove all Chromeflow config (MCP entry, `CLAUDE.md` sections, tool permissions) |
| `npx chromeflow doctor` | Diagnose installed versions and stale caches |

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
