# Closed shadow-root input

**Validated:** Yes
**Last verified:** 2026-05-25 on chromeflow 0.9.13
**Auth required:** Depends on host site
**Stability:** Stable

## What this validates

`fill_input(selector="input[name=email]", value="...")` reaches inputs
nested inside closed shadow roots (Stencil / Lit / Radix portal
wrappers). The fix uses content-script tagging
(`data-chromeflow-react-target`) so the MAIN-world script can find the
element by attribute after the content script has located it via
`chrome.dom.openOrClosedShadowRoot`.

## Preconditions

- A page with a form field rendered inside a closed shadow root. Any
  shadcn/ui form on a Stencil-based design system qualifies.
- A field with a stable selector (name, id, or unique attribute).

## Procedure

1. `list_frames()` — verify the `Shadow hosts:` section shows
    `closed` count > 0.
2. `execute_script("return document.querySelector('input[name=email]')")` —
    should return `null` (MAIN world can't reach closed roots).
3. `find_text("Email", scope_selector="form")` — should find the
    field (chromeflow's piercing primitive).
4. `fill_input(selector="input[name=email]", value="test@example.com")` —
    response should include `(resolved inside shadow DOM)` note.

## Expected response fields

- `fill_input` response: `Set <input type="email" name="email" ...> to
  "test@example.com" (resolved inside shadow DOM)`.
- `execute_script` afterward: re-reading the same selector still
  returns null in MAIN world, but the field value is visible in the UI.
- `get_form_fields()` shows the field with the new value.

## Manual verification

The input should display the typed value. If the page's React state
has it as empty, the React-aware native setter didn't fire its
input/change events — re-check `background.ts:react_set_input`.

## Known regressions

The pre-0.9.13 version used plain `doc.querySelector` in the MAIN-
world handler for `react_set_input`. Closed-shadow inputs were
unreachable. Fixed by adding `tag_for_react` content-script handler
that tags the matched element via `queryAllDeep`, then the MAIN-world
script looks up by attribute.
