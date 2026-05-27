# Shadow DOM reference

Modern SPAs render visible content inside shadow roots. When the root is
`mode: "closed"`, page-context JavaScript (i.e. `execute_script`) cannot
reach it — `document.querySelectorAll('button').length` returns 0,
`document.body.innerText` returns 0 characters, even though the page
renders fine. This is the canonical "Radix portal" pattern, also used by
Stencil components, Lit web components, custom shadow-rooted widgets.

## The rule

If `execute_script` returns an empty result on a page you can clearly see
in a screenshot, **do not drop to screenshots**. Switch to chromeflow's
shadow-piercing tools. All of these pierce open AND closed shadow roots
via the extension's privileged `chrome.dom.openOrClosedShadowRoot` API:

| Tool | Pierces open | Pierces closed |
|---|---|---|
| `find_text(query)` | ✓ | ✓ |
| `get_page_text(selector?)` | ✓ | ✓ |
| `get_form_fields()` | ✓ | ✓ |
| `click_element(textHint)` | ✓ | ✓ |
| `click_element(selector=...)` | ✓ | ✓ |
| `fill_input(textHint)` | ✓ | ✓ |
| `fill_input(selector=...)` | ✓ | ✓ (via content-script tagging) |
| `scroll_to_element(query)` | ✓ | ✓ |
| `set_file_input(hint, path)` | ✓ | ✓ |
| `wait_for(selector=…)` | ✓ | ✓ |
| `wait_for(text=...)` | ✓ | ✓ |
| `react_call_prop` | ✓ | ✓ (via content-script tagging) |
| `execute_script` MAIN-world code | ✓ (via `$deep`) | ✗ |

`execute_script` runs in MAIN world (the page's own context) and is subject
to the same shadow-root opacity that any page script sees. The other tools
use the extension's content-script context where `chrome.dom` is available.

## `execute_script` helpers — `$deep` / `$deepAll` / `shadowDocument`

Every `execute_script` body has four locals pre-injected in scope:

```js
// $deep(selector, root?) — querySelector that walks OPEN shadow roots
const btn = $deep('button.submit');

// $deepAll(selector, root?) — querySelectorAll equivalent, returns array
const all = $deepAll('[role=button]');

// shadowDocument — open shadow root with the most interactive elements
// (buttons, inputs, links), or document if no shadow roots exist.
// On pages with multiple shadow roots (e.g. one for CSS theme vars,
// one for content), this picks the content root automatically.
shadowDocument.querySelector('input[name=email]');

// shadowDocuments — array of ALL open shadow roots on the page (DOM order).
// Use when you need to search across multiple roots or when the
// automatic pick is wrong.
shadowDocuments.forEach(sr => console.log(sr.host.tagName));
```

These cover the common case where an SPA mounts all its UI inside a
single root open shadow host. Replace every `document.querySelector*`
with `shadowDocument.querySelector*` and the same code reaches the SPA's
content. On multi-root pages (theme host + content host), the scoring
heuristic picks the root with the most interactive elements rather than
the first one in DOM order.

For **closed** shadow roots, MAIN world can't reach them — `execute_script`
is still blind. Switch to `find_text` / `click_element` / `fill_input` /
`get_form_fields` from the table above.

## Diagnostic — `list_frames`

When `execute_script` returns nothing useful on a page you can see:

```
list_frames()
```

The response includes a `Shadow hosts:` section with one entry per
attached shadow host, an `open` / `closed` flag, and the nesting depth.
Non-zero `closed` count is the signal to abandon `execute_script` and
switch to piercing tools.

`get_page_text` also reports `shadow_hosts_seen: N` in its response.

## When the selector returned by `find_text` doesn't work elsewhere

`find_text` walks closed shadow trees, so the CSS selector it returns
may point INTO a closed root. `document.querySelector(thatSelector)`
from MAIN world (i.e. `execute_script`) won't find it. The chromeflow
piercing tools (`click_element`, `fill_input`, `scroll_to_element`,
`wait_for(selector=…)`, `find_text(scope_selector=…)`) all use
`queryAllDeep` which traverses shadow roots — pass the selector to one
of those tools instead.

## Scoping to a specific dialog

Radix dialogs portal to `document.body`, so a generic `click_element
("Cancel")` may match a Cancel button outside the dialog. Two flags:

```
click_element("Cancel", in_dialog: true)
```
Scopes to the topmost open `[role=dialog]` / `[role=alertdialog]` /
`<dialog open>` (highest z-index wins, document order tiebreaker).

```
click_element("Confirm", dialog_query: "Delete account")
```
Scopes to the dialog whose heading or aria-label matches the substring.
Wins over `in_dialog` if both are set.

`find_text` accepts the same `in_dialog` / `dialog_query` so discovery
and action use the same scope.

## Closed-shadow file inputs (drag-zone uploaders)

`set_file_input(hint, file_path)` pierces both root kinds. Hidden file
inputs nested inside Stencil/Lit/Radix drag-zone wrappers — typical
upload uploaders that hide the real `<input type=file>` behind a styled
drop target — are reachable by label, name, or CSS selector. The CDP
attach uses `DOM.getDocument({pierce: true})` to find the tagged input
across shadow boundaries.

## Stencil/Lit `[role=radio]` no-input radios

On role-only custom radios (no underlying `<input>`), `click_element`
already auto-dispatches the full pointer-event chain
(`pointerdown → mousedown → pointerup → mouseup → click`) on the
element. If you ever drop into `execute_script` for these (rare since
`click_element` handles them), scroll the radio into view first then
fire the full chain — half a chain dispatches but doesn't toggle.

## Capturing closed-shadow text for analysis

```
get_page_text()                            # auto-pierces
get_page_text(selector="my-host")          # scoped, also pierces
get_page_html(selector="my-host")          # raw HTML, also pierces
```

Then read.
