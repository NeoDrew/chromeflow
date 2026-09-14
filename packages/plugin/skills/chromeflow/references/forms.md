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
  rejected and there's no automated way through it that we've found so far — pre-fill everything
  else, then report the CAPTCHA back rather than blocking on
  `highlight_region` + `wait_for_click`, since most sessions run
  unattended with no one to solve it.
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
detected via the `required` attribute, `aria-required="true"`, a
trailing `*` in the associated `<label>` text, OR a late-bound
validation signal: `aria-invalid="true"` on the field, or a visible
"This question is required" / "Please select…" message in the field's
question container. That last case catches SPA forms (survey builders,
annotation dashboards, headlessui/Radix disclosure panels) that only mark a
field required after a failed submit attempt — so run a submit first,
then `get_form_fields(only_empty=true)` surfaces exactly what's still
blocking. If it still returns nothing but Submit is disabled, the page
likely uses a custom validation hook — try `react_call_prop` on it.

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

**Zero values:** writing `"0"` to a controlled number input that renders
`value={n || ""}` reads back as empty — chromeflow now recognises this
(and pure numeric reformats like `"0.50"` → `"0.5"`) as accepted, with a
"normalised" note, instead of the misleading "value may not have been
accepted by React" warning. So `fill_form([{label:"Hours", value:"0"}])`
is reliable.

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

`get_form_fields()` reads this correctly on its own — no manual verification
needed. react-select's search input's own `.value` stays `""` after a real
selection (the chosen option renders in a separate sibling node, react-select's
stable `singleValue` CSS class), which used to make `get_form_fields()` report
the field as permanently empty even after a genuine selection, no matter how
many times you called it or how long you waited — not a timing gap, a
structural blind spot. It now reads the sibling `singleValue` node when the
input's own value is empty, so a plain `get_form_fields()` (or `get_page_text`
/ `find_text`) call shows the real selected value directly. If you ever still
need to check it by hand:
```
execute_script("document.querySelector('[class*=\"singleValue\"]').textContent.trim()")
```

**This generalizes to every custom dropdown/combobox/autocomplete widget, not
just react-select** (Workday-style listbox country pickers, Radix comboboxes,
Lit/Stencil selects — anything that isn't a native `<select>`). Never reach
for `take_screenshot` to confirm one of these landed the right option instead
of a stray one — a screenshot is pixels you still can't grep, and for widgets
`get_form_fields()` doesn't have dedicated handling for yet, a text read via
`get_page_text` / `find_text` / `execute_script` gets the same confirmation
for a fraction of the cost.

### File inputs (including hidden drag-zone uploaders)

```
set_file_input("Photos", "/Users/me/Downloads/img.jpg")
set_file_input("#hidden-upload", "/abs/path")               # CSS selector hint
set_file_input("Photos", "/path", verify_selector=".thumbnail")
```

Hint accepts label text OR CSS selector. Pierces closed shadow DOM.
Default 3000ms commit-wait; pass `verify_selector` or bump `wait_ms`
for slow uploaders. Reports `targeted <id>` and `page-level file count:
N → M` in the response so you can confirm which slot received the file
and spot uploaders that consume-and-reset the input vs. retain it.

**An input that clears with no visible confirmation is reported as a
failure, not a success.** Some drag-and-drop widgets (react-dropzone and
similar) read the file from the input, then clear it — a legitimate
pattern when the file genuinely landed, but indistinguishable from a
silent rejection by file-count alone. `set_file_input` now also checks
whether the filename shows up anywhere on the page (shadow-piercing)
before trusting a cleared input as success. If it never does,
`success:false` with `consumed_unconfirmed: true` and a "looks like a
silent rejection" message — don't retry blindly; verify with
`get_page_text` / `take_screenshot`, and if the tenant is genuinely
walling automated uploads, hand off to the user rather than looping.

**A "#"/"."/"["-prefixed hint is an exact selector, not a search term.**
When several sibling file inputs each have a unique id (a common
multi-upload form), `set_file_input("#screenshot-uuid", ...)` targets
exactly that input. If the selector matches no file input, the call now
FAILS LOUDLY rather than silently routing the file to a different
(e.g. first-empty) input — so you never upload to the wrong slot. Use a
text-label hint only when you want fuzzy matching.

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
