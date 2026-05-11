#!/usr/bin/env bash
# Rebuild skills/chromeflow/SKILL.md from the canonical root CLAUDE.md.
# Run this whenever the root CLAUDE.md changes.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
SKILL_PATH="$PLUGIN_DIR/skills/chromeflow/SKILL.md"
SOURCE_PATH="$REPO_ROOT/CLAUDE.md"

if [[ ! -f "$SOURCE_PATH" ]]; then
  echo "error: $SOURCE_PATH not found" >&2
  exit 1
fi

cat > "$SKILL_PATH" <<'FRONTMATTER'
---
name: chromeflow
description: Use when a task requires browser interaction — setting up third-party services (Stripe, Supabase, SendGrid, Vercel, OAuth), retrieving API keys or secrets to put in .env, configuring webhooks, filling forms in a web UI, navigating dashboards, or any browser-based step blocking code work. Covers chromeflow MCP tool usage patterns, form filling on React / contenteditable / CodeMirror / Monaco / Stripe inputs, error handling, multi-tab flows, credential capture, and visual handoff to the user for 2FA / passwords / payments.
---

FRONTMATTER

cat "$SOURCE_PATH" >> "$SKILL_PATH"

echo "✓ Synced $SKILL_PATH from $SOURCE_PATH"
