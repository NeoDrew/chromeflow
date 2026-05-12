#!/usr/bin/env node
// SessionStart hook for chromeflow plugin.
//
// Two jobs:
// 1. Emit the pointer block as additionalContext so the agent always has the
//    "use chromeflow tools, don't fall back to Bash/curl" rules in context.
// 2. One-time migration cleanup (Claude Code only): strip stale entries left
//    behind by the legacy `npx chromeflow setup` flow (which is gone in 0.9.0).
//    User-scope files only — never touches per-project CLAUDE.md or
//    settings.local.json because those may contain user content we shouldn't
//    risk losing.
//
// Hook output: a single JSON object with hookSpecificOutput.additionalContext.
// Both Claude Code and Codex CLI consume this same shape from a SessionStart
// hook, so the same script serves both hosts.
// Failures never crash the session — we fall back to empty output silently.

const fs = require('fs');
const path = require('path');
const os = require('os');

const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT ||
  process.env.CODEX_PLUGIN_ROOT ||
  path.resolve(__dirname, '..');
const isClaudeCode = !!process.env.CLAUDE_PLUGIN_ROOT;
const pointerPath = path.join(pluginRoot, 'hooks', 'pointer.md');

function readPointer() {
  try {
    return fs.readFileSync(pointerPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Remove the legacy chromeflow MCP server entry from ~/.claude.json.
 * It looked like: { command: "npx", args: ["-y", "chromeflow"] }
 * or:           { command: "node", args: [".../mcp-server/dist/index.js"] }
 * Either way it's now dead — the plugin's .mcp.json registers chromeflow.
 * Returns a short status string for the cleanup log, or '' if nothing changed.
 */
function migrateClaudeJson() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) return '';
  let config;
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch {
    return '';
  }
  if (!config || typeof config !== 'object') return '';
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object') return '';
  if (!Object.prototype.hasOwnProperty.call(servers, 'chromeflow')) return '';
  const entry = servers.chromeflow;
  const argsStr = JSON.stringify(entry && entry.args ? entry.args : []);
  const isLegacy =
    (entry && entry.command === 'npx' && argsStr.includes('chromeflow')) ||
    (entry && entry.command === 'node' && argsStr.includes('mcp-server'));
  if (!isLegacy) return '';
  delete servers.chromeflow;
  try {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
    return 'Removed legacy `chromeflow` MCP entry from `~/.claude.json` (the plugin now registers it).';
  } catch {
    return '';
  }
}

/**
 * Strip any old "## Chromeflow" section from ~/.claude/CLAUDE.md.
 * Two flavours might be there:
 *   - the legacy "Run `npx chromeflow setup` in this project directory" hint
 *   - the 0.8.2 manual pointer block (mcp__plugin_chromeflow_chromeflow__ marker)
 * Both are now redundant because the plugin's hook injects the pointer.
 */
function migrateUserClaudeMd() {
  const userMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (!fs.existsSync(userMdPath)) return '';
  let existing;
  try {
    existing = fs.readFileSync(userMdPath, 'utf8');
  } catch {
    return '';
  }
  const hasLegacy = existing.includes('Run `npx chromeflow setup` in this project directory');
  const hasManualPointer = existing.includes('mcp__plugin_chromeflow_chromeflow__');
  if (!hasLegacy && !hasManualPointer) return '';
  const start = existing.indexOf('## Chromeflow');
  if (start < 0) return '';
  const after = existing.slice(start);
  const nextHeading = after.slice(2).search(/\n## /);
  const end = nextHeading < 0 ? existing.length : start + 2 + nextHeading + 1;
  const cleaned = (existing.slice(0, start) + existing.slice(end)).trimEnd();
  try {
    fs.writeFileSync(userMdPath, cleaned ? cleaned + '\n' : '');
    return 'Removed stale `## Chromeflow` section from `~/.claude/CLAUDE.md` (the plugin\'s SessionStart hook handles it now).';
  } catch {
    return '';
  }
}

const pointer = readPointer();
const cleanupNotes = isClaudeCode
  ? [migrateClaudeJson(), migrateUserClaudeMd()].filter(Boolean)
  : [];

let additionalContext = pointer;
if (cleanupNotes.length > 0) {
  additionalContext = pointer + '\n\n---\n\n**chromeflow plugin migration**\n\n' +
    cleanupNotes.map((n) => '- ' + n).join('\n') +
    '\n\nIf this project still has a `## Chromeflow` section in its `CLAUDE.md` (from the old `npx chromeflow setup`), it is safe to delete — the plugin\'s skill handles it now. The hook does not auto-delete per-project files.';
}

const payload = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext,
  },
};

process.stdout.write(JSON.stringify(payload));
