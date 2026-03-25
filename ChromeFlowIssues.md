# ChromeFlow Issues & Improvement Requests

Issues encountered while filling Mango task forms. Updated across sessions. Ordered by impact.

---

## 1. `fill_input` fails silently on React-controlled textareas

**What happened:** `fill_input` returned "No input found" even with the textarea visible on screen after `scroll_to_element`. The textareas are React-controlled so the native setter must be called via `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, val)` + an `input` event. I had to fall back to `execute_script` with this pattern for every single textarea on the page — every fill required a separate tool call.

CLAUDE.md says `fill_input` "works on React-controlled inputs" — but this was not the case here.

**What's been done:** Tree walk now checks `previousElementSibling` and goes 8 levels deep (was 6). `fill_form` surfaces per-field failures immediately. But the root cause — label not matching the DOM structure in certain React apps — is not definitively solved. If the label and textarea are siblings more than 8 levels apart, or in a non-standard structure, "No input found" will still occur.

**Remaining wish:** More robust label resolution, or a fallback to fill the nth visible textarea by position when no label match is found.
