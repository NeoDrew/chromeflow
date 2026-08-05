#!/usr/bin/env bash
# Force chromeflow's Chrome extension to reload from disk WITHOUT clicking
# anything in chrome://extensions — for when you (or an agent) need the fix
# live but can't physically reach the machine.
#
# Why this is needed: chrome://extensions is non-scriptable (Chrome refuses
# content-script injection there), so chromeflow cannot click its own Reload
# button — not click_element, not execute_script, nothing routed through the
# extension can reach it. There is no MCP-tool path around this.
#
# Why `chrome://restart` specifically: it's a first-party Chrome mechanism
# (the same one Chrome uses to relaunch itself after an auto-update), not a
# third-party automation driver poking at page content. That distinction is
# what makes it the one place worth setting CLAUDE.md's "only chromeflow
# drives, never osascript/other browser drivers" rule aside — that rule
# exists to stop a different automation tool from silently mishandling a
# real logged-in session on some webpage. A full-browser relaunch isn't that;
# it doesn't touch page content or session state, and Chrome's own session
# restore brings every window/tab back afterward. Coordinate-based clicking
# (guessing where the Reload button is with no way to see the screen) was
# considered and rejected for the same incident: unlike this, its failure
# mode is unpredictable (could hit "Remove" on the wrong extension) with no
# way to verify before or after.
#
# What it actually does: asks Chrome to relaunch. Unpacked (dev-mode)
# extensions are re-read from disk on that relaunch — this is what gets a
# freshly-built packages/extension/dist/ live. Session restore brings back
# whatever windows/tabs were open.
#
# Caveats (real, not hypothetical — hit these on 2026-08-05):
#   - Affects EVERY window in this Chrome profile, not just chromeflow's. If
#     other concurrent chromeflow sessions (other Claude Code instances) have
#     work mid-flight in their own windows, this interrupts them too. Their
#     windows come back via session restore; anything genuinely mid-flight
#     (a form submit, a login step) needs to be redone by that session.
#   - Does NOT touch the MCP-server side. If packages/mcp-server/src changes
#     also need to go live, each affected `claude` session's MCP subprocess
#     needs to actually restart — there's no remote trigger for that. It
#     happens on its own next time a dead subprocess is needed, or on a full
#     quit/relaunch of that Claude Code session.
#   - Only fixes the CURRENT contents of packages/extension/dist/. Run
#     `cd packages/extension && node build.mjs` first if you have unbuilt
#     source changes.
#
# Usage: bash packages/plugin/scripts/reload-extension-remote.sh
set -euo pipefail

echo "Restarting Google Chrome (chrome://restart) to reload all unpacked extensions from disk."
echo "This affects every open Chrome window in this profile, not just chromeflow's."
open -a "Google Chrome" "chrome://restart"
echo "Triggered. Chrome will relaunch and restore its previous windows/tabs within a few seconds."
echo "Verify chromeflow reconnected with the list_tabs MCP tool once Chrome is back."
