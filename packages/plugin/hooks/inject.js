#!/usr/bin/env node
// SessionStart hook for chromeflow plugin.
// Emits the pointer.md content as additionalContext so Claude always has
// the "use chromeflow tools, don't fall back to Bash/curl" rules in context.
// Fires once per session start; doesn't touch any user files.

const fs = require('fs');
const path = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const pointerPath = path.join(pluginRoot, 'hooks', 'pointer.md');

let additionalContext;
try {
  additionalContext = fs.readFileSync(pointerPath, 'utf8').trim();
} catch (err) {
  // Hook must never crash the session; bail silently with empty output.
  process.exit(0);
}

const payload = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext,
  },
};

process.stdout.write(JSON.stringify(payload));
