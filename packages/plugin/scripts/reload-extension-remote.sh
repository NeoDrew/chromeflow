#!/usr/bin/env bash
# Recover chromeflow's Chrome extension connection WITHOUT clicking anything
# in chrome://extensions — for when you (or an agent) need it back and can't
# physically reach the machine.
#
# What this reliably does: reconnects a DISCONNECTED extension (Chrome
# crashed, was quit, or is stuck on a multi-profile picker screen with no one
# there to click through it — see CHROME_PROFILE_DIRECTORY below) and
# refreshes content scripts. Chrome content scripts are re-injected fresh on
# every page navigation regardless of restart method, so this alone is
# enough for content/*.ts-only changes.
#
# What this does NOT reliably do, confirmed by direct testing on 2026-08-11:
# refresh the extension's SERVICE WORKER (background.ts) or its offscreen
# document (offscreen.ts). Chrome does not appear to re-read an unpacked
# extension's background.js/offscreen.js from disk on ANY restart method
# tried — not chrome://restart, not a full quit-and-relaunch, not a
# manifest version bump, not chrome.runtime.reload() called from the (also
# stale) offscreen document. If you've changed background/handlers/*.ts,
# background/state.ts, background.ts, or offscreen.ts, this script will NOT
# get that code live. Only an explicit "Reload" click in chrome://extensions
# does, as far as has been established — there is no known remote
# workaround. Don't claim otherwise to a caller without re-verifying; this
# comment exists because an earlier version of this file wrongly asserted
# chrome://restart handled this case.
#
# Why a full quit-and-relaunch, not chrome://restart: no measurable
# difference was found between them for what this script CAN fix (dropped
# connections), and a full relaunch is the more certain of the two to fully
# reset a hung browser process.
#
# CHROME_PROFILE_DIRECTORY: if Chrome has multiple profiles and doesn't
# remember the last-active one, a cold launch can land on a profile PICKER
# screen instead of actually starting any profile — chromeflow's extension
# never loads because no profile ever loads, and this can look exactly like
# "the extension won't reconnect" with no other symptom. Confirmed as the
# root cause of a full outage on 2026-08-11. Set this to the exact profile
# directory name chromeflow's Chrome profile uses (check
# chrome://version's "Profile Path" while looking at the right window, or
# grep `"path"` for chromeflow's extension id in
# ~/Library/Application Support/Google/Chrome/*/Secure Preferences) to make
# Chrome launch straight into it, bypassing the picker entirely. Defaults to
# "Default" (Chrome's out-of-the-box single-profile name) — override via
# environment variable if that's not the right one on this machine:
#   CHROME_PROFILE_DIRECTORY="Profile 1" bash packages/plugin/scripts/reload-extension-remote.sh
#
# NEVER add --remote-debugging-port to this. It's tempting (CDP's
# Extensions.loadUnpacked domain would be a genuine fix for the background.js
# staleness problem above), but Chrome refuses remote debugging on a normal
# profile for security reasons, so it just fails — and relaunching with that
# flag, then relaunching AGAIN without it, was directly responsible for an
# extended outage on 2026-08-11. If you want to try the CDP route, do it
# against a throwaway --user-data-dir profile, never the one with the user's
# real logged-in sessions.
#
# Usage: bash packages/plugin/scripts/reload-extension-remote.sh
set -euo pipefail

PROFILE_DIRECTORY="${CHROME_PROFILE_DIRECTORY:-Default}"

echo "Quitting Google Chrome (if running)..."
osascript -e 'quit app "Google Chrome"' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -x "Google Chrome" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "warning: Google Chrome did not fully quit within 10s; relaunching anyway." >&2
fi

echo "Relaunching into profile directory \"$PROFILE_DIRECTORY\" (override with CHROME_PROFILE_DIRECTORY=... if this isn't chromeflow's profile)."
open -a "Google Chrome" --args --profile-directory="$PROFILE_DIRECTORY"

echo "Triggered. Verify chromeflow reconnected with the list_tabs MCP tool in a few seconds."
echo "If this doesn't fix it, check whether Chrome landed on a profile picker screen instead of the profile above."
