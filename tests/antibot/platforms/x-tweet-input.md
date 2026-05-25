# X / Twitter tweet input

**Validated:** Pass (typing path with leading-space workaround; submit not tested)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Yes
**Stability:** Stable

## What this validates

`type_text` with isTrusted=true CDP keystrokes lands text in X's
tweet composer Lexical contenteditable. X's
`[data-testid="tweetTextarea_0"]` is a contenteditable Lexical editor;
vanilla `value` assignment does not update its internal state.

## Procedure executed (2026-05-25)

1. `open_page("https://x.com/home")` — verified logged in via `execute_script` (`!$deep('[data-testid="login"]')`).
2. `type_text(text=" Validation test text — never posted", into_selector="[data-testid='tweetTextarea_0']", clear_first=true)` — leading space is the throwaway character for the known first-char-drop issue.
3. Verify via `execute_script`:
   - `textContent`: `"Validation test text — never posted"` (35 chars).
   - First real char `V` preserved (leading space eaten as expected).

## Result

**Pass.** 36 typed chars (including leading space) → 35 char textContent
(leading space dropped, first real char `V` landed correctly). The
leading-space workaround for the first-char-drop bug works as
documented.

## First-char-drop workaround

`type_text(into_selector="[data-testid='tweetTextarea_0']",
clear_first=true)` drops the first character on X's Lexical editor.
Prepend the body with a leading space (or any throwaway char) so the
real first character of your content lands correctly.

## Submit handoff (untested by design)

Submit is gated on a real isTrusted gesture even when CDP click
passes elsewhere. Recovery: `highlight_region` on the Post button +
`wait_for_click()`.

## Shadow-ban caveat

Per memory: small X accounts (< ~50 followers) shadow-ban after
~10-15 promotional replies in a session. Confirmed on @NeoDrewX at
~38 followers. Cap at 5 promo replies/day.

## Domain spacing trick

When mentioning chromeflow's URL in a tweet, write `chromeflow .run`
with a space so X's autolinker does not auto-detect it as a URL.
Avoids the "contains external link" reach penalty.
