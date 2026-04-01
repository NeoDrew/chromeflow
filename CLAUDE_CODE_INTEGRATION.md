# Claude Code Integration Analysis

Research from analyzing Claude Code source code to find opportunities for chromeflow to integrate better.

## Architecture Overview

Claude Code discovers MCP servers through a 3-tier config hierarchy:
1. **Global config** (`~/.claude.json`) — `mcpServers` field (where `npx chromeflow setup` writes)
2. **`.mcprc`** (project root) — per-project MCP servers, requires user approval on first use
3. **Project config** (per-directory in global config) — highest precedence

MCP tools are namespaced as `mcp__<serverName>__<toolName>` (e.g., `mcp__chromeflow__click_element`).

## Findings & Status

### 1. MCP Connection Timeout: 5 seconds (hardcoded)

Claude Code gives MCP servers exactly 5 seconds to connect. If startup exceeds this, the server fails silently.

**Status: No action needed.** Chromeflow's startup is already fast (<100ms) — the MCP server creates a stdio transport and registers tools synchronously. The WebSocket connection to Chrome is lazy (happens on first tool call, not at startup).

### 2. Concurrent Tool Calls (up to 10 read-only tools in parallel)

Claude Code runs read-only tools concurrently. If chromeflow's WebSocket bridge can't handle concurrent requests, responses could collide.

**Status: No action needed.** The ws-bridge already uses UUID-based requestId routing. Each request gets a unique ID, responses are matched back via `pending` Map. Concurrent calls are fully safe.

### 3. Screenshot Size Limit: 3.75MB after base64

Claude Code enforces a 3.75MB limit on base64-encoded images. Chromeflow's screenshots have no size cap — complex pages could exceed this and fail silently.

**Status: FIXED in v0.1.41.** Added resolution scaling: if the PNG exceeds 3.5MB (with margin), the image is re-rendered at 75% and then 50% resolution until it fits. Applied to both `take_screenshot` and `take_and_copy_screenshot`.

### 4. MCP Prompts (Slash Commands)

Claude Code supports MCP servers exposing prompts that appear as user-callable slash commands. Chromeflow doesn't use this — it only registers tools.

**Status: FIXED in v0.1.41.** Added `/chromeflow-status` prompt showing extension connection status and active tab info.

### 5. Context Window Bloat

Claude Code does not compress old tool results. Chromeflow's `get_page_text` returns up to 20,000 characters per call, which accumulates fast in the context window.

**Status: FIXED in v0.1.41.** Reduced default chunk size from 20,000 to 10,000 characters. Still paginatable via `startIndex`. Tool description updated to note the token cost of repeated calls.

### 6. `.mcprc` Support

Claude Code checks project-root `.mcprc` files as a second discovery path. Chromeflow's `npx chromeflow setup` only writes to `~/.claude.json`.

**Status: No action needed.** The global `~/.claude.json` approach is correct for a tool that should be available across all projects. `.mcprc` is for project-specific servers.

## Technical Details

### WS-Bridge Request Flow
```
MCP Tool Call → ws-bridge.request(msg) → assigns UUID requestId
  → sends JSON over WebSocket to Chrome extension
  → extension processes in content script / background
  → response sent back with same requestId
  → ws-bridge matches response via pending Map → resolves Promise
```

- Default timeout: 30 seconds per request
- Single WebSocket client at a time (latest connection wins)
- No auto-reconnect — user must reload extension manually if disconnected

### Image Handling Pipeline
```
Chrome captureVisibleTab (device DPR resolution)
  → downscale to CSS pixels via OffscreenCanvas
  → draw coordinate grid overlay
  → export as PNG blob
  → base64 encode
  → return to MCP server → return to Claude Code
  → Claude Code auto-converts to ImageBlockParam for vision
```

### Tool Permission Flow
```
npx chromeflow setup
  → writes mcp__chromeflow__* entries to .claude/settings.local.json
  → Claude Code reads on startup → tools are pre-approved
  → no per-action permission prompts
```
