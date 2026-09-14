# LinkedIn feed composer

**Validated:** Pass (open + type; submit not tested)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Yes (logged-in LinkedIn account)
**Stability:** Stable

## What this validates

`click_element("Start a post")` opens LinkedIn's feed-post modal, and
`type_text` with isTrusted=true CDP keystrokes lands content in the
Quill-based contenteditable inside the modal. LinkedIn historically
behavioural-fingerprints synthetic input; chromeflow's CDP bezier +
PointerEvent isPrimary=true sequence passes the fingerprint.

## Procedure executed (2026-05-25)

1. `open_page("https://www.linkedin.com/feed/")`. Verified logged-in
   via `execute_script` (`!$deep('a[href*="/login"]')` returned true).
2. `find_text("Start a post")` → 1 match in the share-box widget.
3. `click_element(textHint="Start a post", until_selector=...)` —
   modal opened, focus moved to the text editor
   (aria-label="Text editor for creating content"). The
   `until_selector` clause did not match my candidates list (the
   editor's selector differs from common patterns) but the click
   itself fired cleanly.
4. `type_text(text=" Validation draft, never posted", into_selector="[aria-label='Text editor for creating content']", clear_first=true)`.
5. Verify via `execute_script`: `textContent` = `" Validation draft, never posted"` (31 chars, all preserved including leading space).

## Result

**Pass.** 31 typed chars → 31 textContent chars (no first-char-drop on
LinkedIn's Quill editor). LinkedIn accepted the CDP keystrokes
cleanly with no behavioural-fingerprint rejection.

## Submit handoff (untested by design)

When the user actually wants to publish the post:

```
highlight_region("button.share-actions__primary-action", "Click to post")
wait_for_click()
```


## Notes

- `until_selector` should pattern-match on a LinkedIn-specific
  selector. The modal's contenteditable has aria-label
  `"Text editor for creating content"` — use that as your
  post-click verification target.
- Quill collapses some whitespace patterns; if you need exact
  whitespace preservation, verify via `execute_script` after typing.
