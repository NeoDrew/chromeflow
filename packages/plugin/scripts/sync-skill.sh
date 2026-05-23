#!/usr/bin/env bash
# Rebuild the per-host skill files from the canonical root CLAUDE.md.
# Run this whenever the root CLAUDE.md changes.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
SOURCE_PATH="$REPO_ROOT/CLAUDE.md"
CLAUDE_SKILL_PATH="$PLUGIN_DIR/skills/chromeflow/SKILL.md"
CODEX_SKILL_PATH="$PLUGIN_DIR/skills-codex/chromeflow/SKILL.md"

if [[ ! -f "$SOURCE_PATH" ]]; then
  echo "error: $SOURCE_PATH not found" >&2
  exit 1
fi

# --- Claude Code flavor ---------------------------------------------------
mkdir -p "$(dirname "$CLAUDE_SKILL_PATH")"

cat > "$CLAUDE_SKILL_PATH" <<'FRONTMATTER'
---
name: chromeflow
description: Use when working on a task that needs a real browser — setting up third-party services (Stripe, Supabase, SendGrid, Vercel, OAuth), retrieving API keys or secrets to put in .env, configuring webhooks, filling forms in a web UI, navigating dashboards, or any browser-based step blocking code work. Also use when the user asks how to use chromeflow, what chromeflow tools exist, or how to drive a specific site (eBay, Notion, Stripe, etc.). Covers chromeflow MCP tool usage patterns, form filling on React / contenteditable / CodeMirror / Monaco / Stripe inputs, error handling, multi-tab flows, credential capture, and visual handoff to the user for 2FA / passwords / payments.
---

FRONTMATTER

cat "$SOURCE_PATH" >> "$CLAUDE_SKILL_PATH"

echo "✓ Synced $CLAUDE_SKILL_PATH from $SOURCE_PATH"

# --- Codex flavor ---------------------------------------------------------
# Same content as the Claude flavor; substitute the host name so the
# guidance reads naturally when loaded by Codex. The tool names
# (open_page, click_element, etc.) are identical across hosts and need
# no rewriting.
mkdir -p "$(dirname "$CODEX_SKILL_PATH")"

cat > "$CODEX_SKILL_PATH" <<'FRONTMATTER'
---
name: chromeflow
description: Use when working on a task that needs a real browser — setting up third-party services (Stripe, Supabase, SendGrid, Vercel, OAuth), retrieving API keys or secrets to put in .env, configuring webhooks, filling forms in a web UI, navigating dashboards, or any browser-based step blocking code work. Also use when the user asks how to use chromeflow, what chromeflow tools exist, or how to drive a specific site (eBay, Notion, Stripe, etc.). Covers chromeflow MCP tool usage patterns, form filling on React / contenteditable / CodeMirror / Monaco / Stripe inputs, error handling, multi-tab flows, credential capture, and visual handoff to the user for 2FA / passwords / payments.
---

FRONTMATTER

# "Claude Code" -> "Codex"; bare "Claude" -> "Codex". Order matters so the
# compound rewrite runs before the bare one.
sed \
  -e 's/Claude Code/Codex/g' \
  -e 's/Chromeflow — Claude Instructions/Chromeflow — Codex Instructions/g' \
  -e 's/Claude/Codex/g' \
  "$SOURCE_PATH" >> "$CODEX_SKILL_PATH"

echo "✓ Synced $CODEX_SKILL_PATH from $SOURCE_PATH"
