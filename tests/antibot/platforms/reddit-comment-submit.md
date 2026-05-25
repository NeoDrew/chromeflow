# Reddit comment submit

**Validated:** Yes (pre-fill + human-gesture handoff path)
**Last verified:** 2026-05-24 on chromeflow 0.9.12
**Auth required:** Yes (logged-in Reddit account)
**Stability:** Stable

## What this validates

Pre-fill of the composer body via `type_text` and the highlight +
human-gesture handoff for the submit click. Reddit's
`#comment-composer-submit-button` silently rejects synthetic clicks
even when the CDP click sequence passes — the submit handler checks
for a real user-initiated event flag we cannot fake. The validated
pipeline is the pre-fill + handoff, not synthetic submit.

## Preconditions

- Logged in.
- Comment composer expanded (run the
  `reddit-composer-expand` procedure first).

## Procedure

1. Composer already expanded.
2. `type_text("Body text with multiple paragraphs.\n\nSecond paragraph.",
    into_selector="div[name=body]", clear_first=true)` —
    Reddit's body editor is Lexical contenteditable. `fill_input`
    collapses `\n` into spaces, killing paragraph breaks. `type_text`
    fires real Enter keypresses.
3. `find_text("Comment", scope_selector="#comment-composer")` to
    locate the submit button.
4. `highlight_region("#comment-composer-submit-button", "Click to submit")`
5. `wait_for_click()`

## Expected response fields

- `type_text` response: `Typed N characters via individual keystrokes`,
  no `silently_rejected` (typing is into a textarea, not a button)
- `wait_for_click` resolves when user clicks
- After user click, `get_page_text(selector="#comments-tree")` shows
  the new comment (with a propagation delay of up to 2-3s)

## Manual verification

The submitted comment should appear in the comments tree with the
correct paragraph breaks. If paragraph breaks collapsed to spaces,
`type_text`'s `\n → Enter` handling has regressed.

## Known regressions

The pre-0.9.13 version used `fill_input` for the body which collapsed
`\n` into spaces. The fix routes body input through `type_text` so
each newline produces a real keypress.

## Shadow ban caveat

Small Reddit accounts (under ~50 followers) are shadow-banned after
~10-15 promotional replies in a session — the submit appears
successful in /with_replies but the comment is silently dropped from
target threads. Cap outreach at 5 promo replies/day, space 1-2 hours
apart. See feedback_x_shadowban_threshold (cross-applies).
