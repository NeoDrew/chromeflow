# Facebook feed composer

**Validated:** Pass (open + type; submit not tested)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Yes (logged-in Facebook account)
**Stability:** Stable

## What this validates

`click_element` on Facebook's "What's on your mind, <name>?" composer
trigger opens the post modal cleanly (the `until_selector` clause
verified `[role="dialog"]` appeared), and `type_text` lands content
in Facebook's Lexical-based contenteditable inside the modal.

## Procedure executed (2026-05-25)

1. `open_page("https://www.facebook.com/")`. Verified logged-in via
   `execute_script` (no `input[name="email"]` on the page).
2. `find_text("on your mind")` → 1 match on the composer trigger.
3. `click_element(textHint="on your mind", until_selector="[role='dialog']", until_timeout_ms=5000)` — **clean pass with no false-negative.** Response:
   `Clicked "What's on your mind, Andrew?" — Selector "[role="dialog"]" appeared`.
4. `type_text(text=" Validation draft, never posted", into_selector="[role='dialog'] [contenteditable='true'][role='textbox']", clear_first=true)`.
5. Verify via `execute_script`: `textContent` = `" Validation draft, never posted"` (31 chars, all preserved including leading space).

## Result

**Pass.** This is one of the cleanest results across the platform
suite — Facebook's composer trigger registers as a normal click
(no `silently_rejected`), the modal opens, and 31 typed chars land
cleanly with no character drops or whitespace collapses.

## Submit handoff (untested by design)

When the user actually wants to publish:

```
highlight_region("[role='dialog'] [aria-label='Post']", "Click to post")
wait_for_click()
```

Facebook's Post submit button does not appear to gate on isTrusted
the way Reddit/X do.

## Notes

- `execCommand` does NOT clear Facebook's contenteditable — the
  selectAll + delete sequence is ignored. To replace existing content,
  navigate away then back (the composer resets), or use
  `react_call_prop` to invoke the editor's clear method directly.
- The `until_selector="[role='dialog']"` clause is a reliable open-
  detect on Facebook's composer.
