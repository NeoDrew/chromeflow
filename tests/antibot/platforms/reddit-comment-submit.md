# Reddit comment submit (typing path)

**Validated:** Pass (typing path; submit not exercised by design)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Yes
**Stability:** Stable

## What this validates

`type_text` with `into_selector` lands multi-paragraph text into
Reddit's Lexical contenteditable body editor with paragraph breaks
preserved as proper `<p>` block structure. The actual submit click
is NOT exercised by automation — Reddit's
`#comment-composer-submit-button` is gated on a real isTrusted gesture
and shadow-ban thresholds make repeated automated submits risky.

## Procedure executed (2026-05-25)

1. Logged-in Reddit composer already expanded (from the composer-expand test).
2. `type_text(text="Test paragraph one.\n\nSecond paragraph with break preserved.", into_selector="div[contenteditable='true'][role='textbox'][name='body']", clear_first=true)`.
3. Verify via `execute_script` (with `$deep` helper):
   - `textContent`: `"Test paragraph one.Second paragraph with break preserved."` (57 chars; newlines absorbed by block boundaries).
   - `querySelectorAll('p').length` = 2 → Lexical converted the `\n\n` into proper paragraph structure.

## Result

**Pass.** 59 typed chars → 57 textContent chars (the 2 newlines became
block boundaries, not literal characters). Paragraph structure
preserved as Lexical's expected `<p>...</p><p><br>...</p>` shape.

**`type_text(clear_first=true)`** worked here (it does NOT on stricter
ProseMirror — see `tiptap-silent-drop.md`). Lexical accepts the
execCommand selectAll + delete sequence; ProseMirror sometimes
restores default content after the delete.

## Submit handoff (untested by design)

When the user actually wants to post the comment:

```
# Pre-fill is verified above.
highlight_region("#comment-composer-submit-button", "Click to submit")
wait_for_click()
```

## Shadow-ban caveat

Per memory `feedback_x_shadowban_threshold.md` (cross-applies to
Reddit): small accounts (low karma, < ~50 followers) shadow-ban after
~10-15 promotional replies in a session. Cap at 5 promo replies/day,
space 1-2 hours apart.

## Known regressions

None at 0.10.1. Earlier `fill_input`-based paths collapsed `\n` into
spaces; the `type_text` path (real Enter keypresses) preserves
paragraph structure.
