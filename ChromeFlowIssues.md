# ChromeFlow Issues & Improvement Requests

Issues encountered while filling Mango task forms. Updated across sessions. Ordered by impact.

---

## 1. `get_form_fields` doesn't surface file upload inputs

**What happened:** The delivery ZIP upload area showed as a textarea in `get_form_fields`, but the actual file input had dimensions 0×0 (hidden behind a custom drag-and-drop zone). There was no way to programmatically trigger the file picker or inject a file path — I had to find the drop zone via multi-step DOM queries and then ask the user to click and select the file manually.

**Wish:** `get_form_fields` should detect file inputs and custom upload zones (by looking for `input[type="file"]` and nearby drag-drop elements), and surface them with their label so I know they need manual handling upfront.

---

## 2. `fill_input` fails silently on React-controlled textareas

**What happened:** `fill_input` returned "No input found" even with the textarea visible on screen after `scroll_to_element`. The textareas are React-controlled so the native setter must be called via `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, val)` + an `input` event. I had to fall back to `execute_script` with this pattern for every single textarea on the page — every fill required a separate tool call.

CLAUDE.md says `fill_input` "works on React-controlled inputs" — but this was not the case here.

**Wish:** `fill_input` should already use the React-aware native setter internally. If it fails, it should surface a specific error ("React-controlled element — native setter required") rather than the generic "No input found".

---

## 3. Dynamically revealed fields break any index-based approach

**What happened:** The form showed 30 fields on initial load. When I clicked the "OSS github repo" radio button, two new fields (Repository URL, Commit Hash) appeared above the Prompt textarea. My `execute_script` approach counted empty textareas by index (`emptyCount === 1`, `emptyCount === 2`, etc.). After the radio click, those counts were offset by 2 — the prompt text went into the Repository URL field, F2P tests went into the Prompt field, etc. I didn't catch this until a second `get_form_fields` call revealed the full damage. I then had to write a second corrective script to fix all 8 misaligned textareas.

This was the single most time-costly error of the session. It required ~10 extra tool calls and a full re-inventory.

**Wish:** `get_form_fields` should warn when it detects conditionally-shown fields (e.g. fields with `[hidden]`, `display:none`, or `aria-hidden` that could appear later). Better: include a stable identifier per field (the surrounding question heading text) rather than a positional index, so fills can target by label rather than count.

---

## 4. `get_form_fields` y-coordinates are viewport-relative at time of call

**What happened:** The y-positions returned by `get_form_fields` reflect where elements were on screen at call time (via `getBoundingClientRect`). After scrolling, those positions are wrong. You can't use a y-value from an earlier `get_form_fields` call to reliably target an element via `highlight_region` after the page has scrolled.

**Wish:** Return document-relative y-positions (i.e. `offsetTop` / distance from page top), not viewport-relative positions. Or include a stable DOM path / `data-` attribute alongside each field.

---

## 5. No way to verify textarea values were accepted by React

**What happened:** After filling textareas with `execute_script`, `get_page_text` doesn't include textarea contents. There's no way to confirm React accepted the value without running a second `execute_script` to read `.value` back. If the `input` event dispatch was wrong, React could silently discard the value.

**Wish:** `fill_input` (or a new `verify_input` tool) should read the element's value back after filling and return it, confirming whether React actually persisted it.

---

## 6. `scroll_to_element` doesn't confirm what it matched or where it landed

**What happened:** `scroll_to_element` returned "Scrolled to element matching X" regardless of whether it matched confidently or approximately. In one case it scrolled to the top of the page when looking for an upload area, and in another case the target field was still partially off-screen after the scroll.

**Wish:** Return the matched element's visible text and new scroll position, so it's clear whether the right element was found. If nothing matched, say so explicitly rather than silently scrolling somewhere arbitrary.

---

## 7. `get_form_fields` inventory is incomplete if sections are collapsed

**What happened:** The form had collapsible question sections. Running `get_form_fields` before clicking "Expand All" gave 30 fields; after expanding, more fields appeared and textarea indices shifted. Previously documented but re-encountered: even after "Expand All", dynamically-revealed conditional fields weren't in the initial inventory.

**Wish:** `get_form_fields` should auto-expand collapsed sections before inventorying, or at least warn that some sections are collapsed and the inventory may be incomplete.

---

## 8. No batch fill capability — every textarea requires a separate tool call

**What happened:** Each textarea fill required a separate `execute_script` call (since `fill_input` didn't work). For a form with 8 textareas, that's 8 round trips. The misalignment issue (see #3) doubled this. In practice I ended up with ~18 fill-related tool calls for a single form.

**Wish:** A `fill_form(fields: [{label, value}])` batch tool that fills multiple fields in one call, targeting by label text rather than index. This would be dramatically more efficient and less error-prone.

---

## 9. `click_element` response truncates matched text — no confidence in what was clicked

**What happened:** `click_element` returns `Clicked "My codebase is an OSS github re"` (truncated at ~40 chars). For radio buttons and checkboxes with long labels, I can't tell from the response whether the right option was selected — especially when multiple options share a common prefix.

**Wish:** Return the full matched element text and its type (radio/checkbox/button), and optionally confirm its new state (checked/unchecked) for toggleable elements.

---

## 10. `highlight_region` coordinates become stale if the user scrolls before acting

**What happened:** I called `execute_script` to get a drop zone's `getBoundingClientRect` coordinates, then immediately called `highlight_region` with those values. The values are viewport-relative: if the user had scrolled between my `execute_script` call and the `highlight_region` call, the highlight would appear in the wrong place.

**Wish:** `highlight_region` should accept a CSS selector or element reference rather than raw pixel coordinates, and scroll the element into view itself. Raw pixel coordinates are too fragile for async human-in-the-loop workflows.
