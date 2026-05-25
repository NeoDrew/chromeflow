# X / Twitter tweet input

**Validated:** Yes (text input; submit still requires real gesture)
**Last verified:** 2026-05-25 on chromeflow 0.9.12
**Auth required:** Yes (logged-in X account)
**Stability:** Stable

## What this validates

`type_text` with isTrusted=true CDP keystrokes lands text in X's
tweet composer textarea. X's `[data-testid="tweetTextarea_0"]` is a
contenteditable Lexical editor; vanilla `value` assignment doesn't
update its internal state.

## Preconditions

- Logged in.
- Tweet composer open (home, compose modal, or reply context).

## Procedure

1. `find_text("What is happening?!")` or
   `click_element(selector="[data-testid='tweetTextarea_0']")` to
    focus the composer.
2. `type_text(" Tweet body text",
    into_selector="[data-testid='tweetTextarea_0']", clear_first=true)`.
3. Verify via
   `execute_script("return $deep('[data-testid=\\\"tweetTextarea_0\\\"]').textContent")`.

## Leading-space workaround

`type_text` with `clear_first=true` can drop the first character.
Prepend the body with a leading space so "Worth checking" becomes
" Worth checking" — the leading space is the throwaway.

## Expected response fields

- `type_text` reports `Typed N characters` with no `silently_rejected`.
- `execute_script` returns the full body text including the leading
  space.

## Manual verification

The composer should show the typed body. Character count under the
composer should match (account for the leading space byte).

## Submit handoff

Synthetic `click_element` on the Tweet/Post submit button silently
rejects (X's submit handler checks a real-user-initiated flag).
Recovery: `highlight_region` on the Post button + `wait_for_click`.

## Shadow ban caveat

Small X accounts (under ~50 followers) shadow-ban after ~10-15
promotional replies. Confirmed on @NeoDrewX at ~38 followers. Cap
outreach at 5 promo replies/day.

## Domain spacing trick

Write "chromeflow .run" with a space when mentioning chromeflow's
domain — X's autolinker won't auto-detect it as a URL, avoiding the
"contains external link" reach penalty.

## Known regressions

None at 0.9.13. The pre-0.9.13 progress-heartbeat absence caused
long tweet bodies (>1500 chars) to false-positive a WS timeout; the
type completed on the page but the response read as failed. Fixed
via heartbeats every 200 chars.
