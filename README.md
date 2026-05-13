<p align="center">
  <img src="assets/icon.png" width="120" alt="Chromeflow" />
</p>

<h1 align="center">Chromeflow</h1>

<p align="center"><strong>Let your AI coding agent (Claude Code or Codex CLI) drive your real Chrome — clicks, fills forms, grabs API keys, writes them to <code>.env</code>.</strong></p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime"><img src="https://img.shields.io/chrome-web-store/v/lkdchdgkbkodliefobkkhiegjdiidime?label=Chrome%20Web%20Store&color=4285F4" alt="Chrome Web Store" /></a>
  <a href="https://github.com/NeoDrew/chromeflow/releases"><img src="https://img.shields.io/github/v/release/NeoDrew/chromeflow?label=release&color=e85d2c" alt="Latest release" /></a>
  <a href="https://github.com/NeoDrew/chromeflow/blob/main/LICENSE"><img src="https://img.shields.io/github/license/NeoDrew/chromeflow?color=d97706" alt="MIT License" /></a>
  <a href="https://github.com/NeoDrew/chromeflow/stargazers"><img src="https://img.shields.io/github/stars/NeoDrew/chromeflow?style=social" alt="GitHub stars" /></a>
  <a href="https://chromeflow.vercel.app"><img src="https://img.shields.io/badge/website-chromeflow.vercel.app-1c1a16" alt="Website" /></a>
</p>

<p align="center">
  <a href="#setup">Install</a> · <a href="#what-claude-can-do">Tools</a> · <a href="https://chromeflow.vercel.app">Website</a> · <a href="https://github.com/NeoDrew/chromeflow/blob/main/SECURITY.md">Security</a>
</p>

---

**The problem**: Playwright, Browser Use, and Puppeteer launch a fresh empty browser every time — no cookies, no sessions, no 2FA. Your AI agent gets stuck at the first login screen.

**Chromeflow**: drives your **actual Chrome**, where you're already logged into Stripe, AWS, Supabase, Canvas, GitHub. The agent automates what it can (clicks, fills, uploads, captures keys) and pauses for anything that needs you (passwords, 2FA, payment). One MCP server, 26 browser tools, works with both Claude Code and Codex CLI.

## Why Chromeflow?

Existing browser automation tools (Playwright, Browser Use, Puppeteer) launch a **fresh, empty browser** — no cookies, no sessions, no extensions. Every time they start, you're logged out of everything and can't handle 2FA.

Chromeflow works in **your actual Chrome browser**, where you're already logged into Stripe, AWS, Supabase, and everything else. Claude automates what it can (clicking buttons, filling forms, uploading files) and pauses for anything that needs you (passwords, 2FA, payment details).

| | Chromeflow | Playwright / Browser Use |
|---|---|---|
| **Browser** | Your real Chrome (sessions intact) | Fresh instance, logged out of everything |
| **Auth / 2FA** | Already handled — pauses when needed | Can't handle — blocks completely |
| **Page understanding** | DOM queries (fast, cheap, reliable) | Screenshots + vision model (slow, expensive) |
| **Human-in-the-loop** | Highlights, pauses on sensitive input | Fully autonomous, no interaction |
| **Integration** | MCP server for Claude Code & Codex CLI | Standalone, not agent-aware |
| **Credential capture** | Reads API keys → writes to `.env` | Not designed for this |

## How it works

Chromeflow is two things that work together:

- **MCP server** — gives your coding agent (Claude Code or Codex) a set of browser tools (`open_page`, `click_element`, `fill_form`, `set_file_input`, `read_element`, `write_to_env`, etc.)
- **Chrome extension** — receives those commands and acts on the active tab (highlights, clicks, fills, uploads files, captures screenshots)

Claude drives the flow. You only touch the browser for things that genuinely need you — login, passwords, payment details, personal choices.

## Setup

### Claude Code

**1. Install the plugin** (one-time, machine-wide):

```
/plugin marketplace add NeoDrew/chromeflow
/plugin install chromeflow
```

Run these inside Claude Code. The plugin registers the MCP server, pre-approves Chromeflow tools, and ships the usage skill — no per-project setup needed.

**2. Install the Chrome extension** (one time):

[chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime) — click **Add to Chrome**.

The extension persists across Chrome restarts. You only do this once.

**3. Restart Claude Code.**

That's it. Claude will automatically reach for Chromeflow whenever a task needs browser interaction, in any project. The plugin's SessionStart hook also cleans up any stale config left over from older `npx chromeflow setup`-based installs on first run.

### Codex CLI

**1. Install the plugin** (one-time, machine-wide):

```
codex plugin marketplace add NeoDrew/chromeflow
```

Then inside Codex:

```
/plugins install chromeflow
```

The plugin registers the MCP server and ships the same usage skill that Claude Code uses, host-adjusted for Codex.

**2. Install the Chrome extension** (one time) — same Web Store link as above. The extension is host-agnostic and serves both Claude Code and Codex from the same install.

**3. Restart Codex.**

Codex will reach for Chromeflow on browser tasks the same way Claude Code does.

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

### Running multiple agent sessions in parallel

Chromeflow supports up to 11 agent sessions (Claude Code, Codex, or a mix) running in parallel, each automating a different Chrome window without touching the others.

**How it works:**
- Each agent session spawns its own Chromeflow MCP server, which auto-discovers a free port in the range `7878-7888` (first session gets 7878, second gets 7879, etc.).
- The Chrome extension maintains one WebSocket connection per port and tracks per-port window assignments.
- Every browser tool call is routed to the Chrome window assigned to the port the request came in on.

**Setup:**
1. Start your first agent session as normal — its Chromeflow will claim port 7878.
2. Start a second agent session in another terminal — its Chromeflow auto-falls-back to 7879.
3. Click the Chromeflow extension icon. The popup now shows **one row per instance** (Port 7878, Port 7879, ...) each with a green dot when live.
4. In Chrome **window A**, open the popup and click **"Use this window"** next to Port 7878.
5. Switch to **window B**, open the popup, and click **"Use this window"** next to Port 7879.

That's it. Each session now drives its own Chrome window — you can run a DataAnnotation task in one window while the other session fills out a Stripe dashboard in another, with zero collision.

Single-instance usage is unchanged and fully backwards compatible — the old per-window assignment is auto-migrated on first load.

## Adding to another project

Nothing to do — the plugin install above is machine-wide. Open any project and Chromeflow is ready.

## Upgrading

In Claude Code:

```
/plugin update chromeflow
/reload-plugins
```

In Codex:

```
/plugins update chromeflow
```

Restart the host afterward to pick up the new MCP server binary the plugin ships.

## Migrating from the old `npx chromeflow setup` flow

If you previously installed Chromeflow via `npx chromeflow setup`, do nothing — install the plugin (Setup step 1 above) and the plugin's first SessionStart cleans up:

- The stale `mcpServers.chromeflow` entry in `~/.claude.json`
- Any leftover `## Chromeflow` section in `~/.claude/CLAUDE.md`

Per-project `CLAUDE.md` files and `.claude/settings.local.json` allowlists are left alone — they may have content you want to keep, so the plugin won't touch them. You can delete the `# Chromeflow — Claude Instructions` section from each project's `CLAUDE.md` by hand whenever it's convenient (the plugin's skill carries the same content now), or just leave it.

## Development

```bash
git clone https://github.com/NeoDrew/chromeflow
cd chromeflow
npm install
packages/plugin/scripts/build-server.sh   # bundle the MCP server into the plugin
```

The MCP server source lives at `packages/mcp-server/src/` and is bundled with esbuild into `packages/plugin/server/chromeflow.mjs` — a single-file ESM binary the plugin ships directly.

Iterate locally by pointing the plugin at this checkout. In Claude Code:

```
/plugin marketplace add /absolute/path/to/this/repo
/plugin install chromeflow
```

In Codex:

```
codex plugin marketplace add /absolute/path/to/this/repo
/plugins install chromeflow
```

Rebuild the bundle after editing MCP server source, then `/reload-plugins` (Claude Code) or restart the host (Codex) to pick it up.

The Chrome extension lives at `packages/extension/`:

```bash
npm run dev:ext   # watches extension
```

After rebuilding the extension, reload it from `chrome://extensions`.

## Requirements

- Claude Code or Codex CLI
- Chrome (or any Chromium browser)
- Node.js 22+
