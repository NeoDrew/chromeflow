# React recipes

Patterns that come up repeatedly on React-controlled UIs. Most are
covered by chromeflow's primitives directly; this reference is for the
cases where you need to reach into React's internal machinery.

## React-controlled native radios / checkboxes that don't update `checked`

`click_element` already handles the standard cases automatically:

- **Already-checked radio**: re-clicking would toggle it OFF on React
  forms whose onChange interprets the click as a deselect. The
  matcher returns `success=true` with `"radio already checked, click
  skipped"` — no click fires.
- **Radio still unchecked after click**: chromeflow auto-fires the full
  pointer-event chain (`pointerdown → mousedown → pointerup → mouseup →
  click`) on the input. Response says `"now checked (after pointer-
  chain fallback)"`.
- **Checkbox didn't toggle**: same pointer-chain fallback.

You only need to drop into `execute_script` for the no-native-input
case below.

## Shadow DOM `[role=radio]` / role-only custom radios

On sites where the radio is a `[role=radio]` div with no underlying
`<input>` (Radix UI without the native-input adapter, custom React
role-only widgets), `click_element`'s native-input fallback can't help.
Two things must be true:

1. The element must be scrolled into view first.
2. The full pointer-event chain must fire — not just `click()`.

```
scroll_to_element("[role=radio][data-value='approve']")
execute_script(`
  const el = $deep('[role=radio][data-value="approve"]');
  el.scrollIntoView({block: 'center'});
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
    el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true}))
  );
`)
```

After click, re-query the radio list — its length may change as more
content becomes visible. Verify `aria-checked === "true"` before moving on.

## React Select / custom styled dropdowns

`click_element` and `fill_input` do NOT work on these — they intercept
native events. The cleanest path uses the hidden combobox input:

```
1. fill_input(selector='input[id*="react-select-3-input"]', value="Target Option")
   — sets the hidden combobox input via the React-aware native value setter
2. (300ms pause for the dropdown to filter)
3. execute_script("document.querySelector('[id*=\"react-select-3-option-0\"]').click()")
4. Verify:
   execute_script("document.querySelector('[class*=\"singleValue\"]').textContent.trim()")
```

If you must hand-roll this with `execute_script` (older React-Select
versions, weird custom wrappers), read the prototype FROM the instance
to avoid "Illegal invocation" inside iframes:

```js
var input = document.querySelector('input[id*="react-select-3-input"]');
input.focus();
var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
setter.call(input, 'Target Option');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

Fallback for older React Select versions (no hidden combobox input):

```js
var controls = document.querySelectorAll('[class*="control"]');
controls[N].click();
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
  if (allEls[i].textContent.trim() === 'Target Option' && allEls[i].children.length === 0) {
    allEls[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    allEls[i].click();
    break;
  }
}
```

## React fiber `onClick` bypass — `click_element(try_fiber: true)`

When the 1500ms activity probe reports zero activity after a CDP click,
chromeflow can walk up to 12 fiber levels looking for the nearest
`__reactProps$.onClick` prop and invoke it directly with a minimal
synthetic event:

```
click_element("Submit", try_fiber: true)
```

Returns `fiber_attempted: true` in the response when the fiber path
fired. The response message records the React component name (or
"anonymous") so you can sanity-check the right handler ran.

**Opt-in** because fiber-prop walking is undocumented React internal
access and may misbehave on mangled production builds.

## React fiber `__reactProps$.onClick` via `via: "fiber"`

When you already know a site is React-fiber-only (CDP clicks reliably
silently-reject), skip the CDP ceremony entirely:

```
click_element("Submit", via: "fiber")
```

Cuts ~3 seconds of bezier + activity probe off the round trip. Three
modes:
- `via: "auto"` (default) — CDP first, fiber fallback only when
  `try_fiber: true` is also set
- `via: "cdp"` — CDP only, no fiber fallback ever
- `via: "fiber"` — fiber only, no CDP

## Calling React props directly — `react_call_prop`

When a Submit button's onClick opens a modal that never renders because
form-level React state is stale (validation thinks the form is
incomplete even though DOM inputs look filled), bypass the validation
hook by calling the prop directly:

```
react_call_prop("input[name=justification]", "handleForceSubmitConfirmation", ["my justification text"])
```

Walks up the React fiber from the selector, finds the nearest component
with a prop function of the given name, calls it with the JSON-
serializable args. Returns the component name and the stringified
return value.

Pierces closed shadow DOM via content-script tagging.

## React fiber walk in raw `execute_script`

When `react_call_prop` doesn't fit (you need to read state, not call a
function), walk the fiber manually:

```js
function findFiberProp(el, propName) {
  let nodeKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  let fiber = el[nodeKey];
  while (fiber) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props && propName in props) return props[propName];
    fiber = fiber.return;
  }
  return null;
}
const el = $deep('button.submit');
return findFiberProp(el, 'disabled');
```

`__reactFiber$<hash>` and `__reactProps$<hash>` are React's private fiber
keys. Stable across React 16/17/18, but mangled in some production
builds.

## React-controlled number inputs

`fill_input(selector="input[type=number]", value="3")` handles these
via the React-aware native value setter. If the field has no useful
label (column-header rubric grids, etc.), the selector path is the
right one. The textHint path's fuzzy-text-walk often misidentifies
which input is which on dense numeric grids — pass `exact: true` or
prefer the selector path.

## Stale element references after React re-renders

React re-renders detach the cached element nodes between operations.
Chromeflow's primitives (`click_element`, `fill_input`, etc.) re-resolve
on every call so this isn't a concern at the tool level. But in
`execute_script` blocks, cache nothing across operations:

```js
// BAD — element detached by the time second op runs
const btn = $deep('button.next');
btn.click();
// ... React re-renders ...
btn.dispatchEvent(new Event('blur'));  // fires on detached node

// GOOD — re-query each time
$deep('button.next').click();
// re-render ...
$deep('button.next').dispatchEvent(new Event('blur'));
```
