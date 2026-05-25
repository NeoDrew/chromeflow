# Forms reference

Filling forms is chromeflow's most common operation. This reference
covers field discovery, fill patterns per framework, multi-field batch
fills, and the "why is Submit disabled" diagnostic.

## Discovery — `get_form_fields`

Before filling an unfamiliar form, get an inventory:

```
get_form_fields()
```

Returns every input, textarea, select, CodeMirror editor, and Monaco
editor on the page (sorted top-to-bottom by y-position). Pierces closed
shadow roots. Each field carries `type`, `label`, current `value`,
`required` flag, `empty` flag, and a section heading.

Also reports:
- **CAPTCHA presence** (`⚠ CAPTCHA detected: recaptcha/turnstile/hcaptcha`)
  with the sitekey when available. Synthetic submits will be silently
  rejected — pre-fill, then highlight the submit and `wait_for_click`.
- **OAuth provider buttons** (`Continue with Google`, `Sign in with
  GitHub`) detected on the page. If the user wants OAuth, click the
  provider button instead of filling email/password.

Filtered modes:

```
get_form_fields(query="Email")              # filter+rank by hint
get_form_fields(query="Card", type_filter="text")
get_form_fields(query="Address", exact=true)  # refuse fuzzy text-walk
```

Match strengths reported: `aria-eq` > `placeholder-eq` > `label-text-eq`
> `name-eq` > `id-eq` > `*-includes` > `fuzzy-text-walk`. The lowest two
are the historical source of "wrong field filled" bugs; pass
`exact: true` to refuse them.

## "Why is Submit disabled?" — `only_empty`

```
get_form_fields(only_empty=true)
```

Filters the inventory to required-but-empty fields. Required-ness is
detected via the `required` attribute, `aria-required="true"`, or a
trailing `*` in the associated `<label>` text. Replaces the "walk every
field manually" diagnostic on dense forms. If `only_empty` returns
nothing but Submit is still disabled, the page likely uses a custom
validation hook — try `react_call_prop` on the validation function.

## Single fill — `fill_input`

```
fill_input(textHint="Email", value="x@y")
fill_input(textHint="Email", value="x@y", exact=true)  # refuse fuzzy
fill_input(textHint="Email", value="x@y", nth=2)        # disambiguate
fill_input(selector="input[name=email]", value="x@y")   # by CSS selector
```

The textHint path is fuzzy-rank against label / placeholder / aria-label
/ name / id (same ranking as `get_form_fields`). Response includes the
matched element's identifying attributes plus the match-strength —
verify the match before assuming success, especially when the rank is
`fuzzy-text-walk` or `*-includes`.

**Ambiguous fuzzy matches are refused, not silently picked.** When 2+
inputs would match via `fuzzy-text-walk` and no explicit `nth` was set,
the response carries `success=false` with a `Candidates:` list.
Disambiguate via `exact: true`, an explicit `nth`, or `selector="<css>"`.

The selector path bypasses fuzzy matching entirely. It also pierces
closed shadow DOM via content-script tagging, so selectors that target
inputs inside Radix/Stencil/Lit web components work.

**Frame support:**
```
fill_input(selector="input[name=desc]", value="...", frame="iframe.editor")
```
Same-origin iframes only.

## Batch fill — `fill_form`

```
fill_form([
  {label: "Email", value: "x@y"},
  {label: "Password", value: "..."},
  {label: "Name", value: "Andrew"},
])

fill_form([{label, value}, ...], exact=true)   # refuse fuzzy per-field
```

Returns a per-field success/failure report so you can spot which fields
weren't found. Use over repeated `fill_input` whenever you have ≥3
fields to fill — one round trip instead of three.

## Framework-specific patterns

### Native inputs / textareas / selects

Just `fill_input`. The textHint path resolves by label, the selector
path uses the React-aware native value setter.

### React-controlled inputs that ignore synthetic events

Use the selector path:
```
fill_input(selector="input[name=email]", value="x@y")
```
Internally routes through `react_set_input` which reads the prototype
from the instance (avoids "Illegal invocation" inside iframes), calls
the native value setter, then dispatches `input` and `change` events.
Pierces closed shadow roots.

### Contenteditable (Stripe, Notion)

`fill_input` auto-detects contenteditable and uses
`document.execCommand("insertText")` which Stripe / Notion accept.

### CodeMirror 6

`fill_input(textHint="Code label", value="...")` auto-detects
`.cm-editor` wrappers and fills via the CodeMirror API path.

### TipTap / ProseMirror

```
fill_input(textHint="Description", value="...")
```
Auto-detected via `.tiptap` / `.ProseMirror` / `[data-tiptap-editor]`
class. Fills via selectAll + insertText.

For long edits or replacements:
```
type_text("new content", into_selector=".ProseMirror", clear_first=true)
```
Uses CDP isTrusted=true keystrokes. **TipTap silent-drop auto-recovery**
fires when CDP keys land but the editor reverts (a known TipTap state-
machine quirk): post-type verification re-fills via execCommand
insertText. The response message records the recovery.

### Monaco editors

Monaco appears in `get_form_fields()` as type `monaco`. Cannot be filled
via `fill_input`. Use `execute_script`:
```
execute_script("monaco.editor.getModels()[0].setValue('new content')")
```

### React Select / custom styled dropdowns

The "Select…" pattern. `click_element` and `fill_input` don't work —
they intercept native events. The clean path:
```
fill_input(selector='input[id*="react-select-3-input"]', value="Target Option")
# (300ms pause for filter)
execute_script("document.querySelector('[id*=\"react-select-3-option-0\"]').click()")
```

Then verify the control shows the value:
```
execute_script("document.querySelector('[class*=\"singleValue\"]').textContent.trim()")
```

### File inputs (including hidden drag-zone uploaders)

```
set_file_input("Photos", "/Users/me/Downloads/img.jpg")
set_file_input("#hidden-upload", "/abs/path")               # CSS selector hint
set_file_input("Photos", "/path", verify_selector=".thumbnail")
```

Hint accepts label text OR CSS selector. Pierces closed shadow DOM.
Default 3000ms commit-wait; pass `verify_selector` or bump `wait_ms`
for slow uploaders. Reports `page-level file count: N → M` in the
response so you can spot uploaders that consume-and-reset the input vs.
those that retain the file.

**Replacing an already-uploaded file:**
```
click_element("Remove", nth=N)        # find the right Remove button
set_file_input(hint, new_path)        # input is recycled
```

Verify with `get_form_fields()` between the two steps to confirm the
input reappeared.

## Auto-save on blur — opening forms in background

Some sites auto-save on focus loss (eBay seller listings). When opening
a new tab for a side-task that you'll return to:
```
open_page(url, new_tab=true, background=true)
```
Keeps the original tab focused; the auto-save doesn't fire.

## Forcing auto-save on idempotent text edits

Some auto-save logic diffs against the last-saved value and skips no-op
writes. To force a real save on each tick (keep-alive loops, status
heartbeats), toggle a trailing space — add when absent, remove when
present. `fill_input` value comparison handles both directions.

**Caveat:** long-running heartbeats that toggle whitespace on a real
form field have been observed to drift other fields' React state out of
sync (the re-render reset a separate radio's checked state to the form-
level store value). For heartbeat loops, prefer writing to `localStorage`
via `execute_script` — the auto-save handler usually fires on any input
event, but `localStorage` writes don't perturb React state at all.

## After radio/checkbox clicks that reveal new fields

Call `get_form_fields()` again. The inventory will include the new
fields. The response warns if more hidden fields still exist.

## Expanding collapsible sections

Expand all collapsibles before calling `get_form_fields()` so the field
list is complete. Use the `[under: "section name"]` context in each
field's entry to identify fields by section rather than by index —
indices shift when sections expand.

## Frame support

`get_form_fields(query=…, frame="iframe.selector")` enumerates inside a
same-origin iframe. Cross-origin iframes return a `frame_error`; use
`take_screenshot` + `click_at_coordinates` instead (see `references/
shadow-dom.md` and the main SKILL for cross-origin patterns).
