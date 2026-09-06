# Issue: CDP Input layer dies mid-session — real keyboard + mouse dispatch stop working, synthetic-only survives

- **Date observed:** 2026-07-15
- **Severity:** High (silently breaks all keystroke- and coordinate-driven automation; agents keep "succeeding" while nothing lands)
- **Extension build in use:** whatever was live in the attached Chrome on 2026-07-15 (see `packages/extension/dist/background.js`). Version not captured at failure time — see "Data to capture next time".
- **Reproducibility:** Appeared partway through a long session and then persisted for the rest of it. Not yet reproduced from a cold start. Page reloads and cross-origin navigations did **not** clear it.

---

## 1. Summary

Midway through a long-running session, every chromeflow capability that depends on the **Chrome DevTools Protocol Input domain** (i.e. anything routed through `chrome.debugger` / `withDebugger` → `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, `Input.synthesizeTapGesture`) stopped having any effect on the page:

- `type_text` returns a **success** string ("Typed N characters via individual keystrokes") but **zero characters actually land** — verified against a plain `<input>`, not just exotic widgets.
- `click_at_coordinates` **times out** ("phase=cdp_click_at exceeded 8000ms").
- `click_element` logs that its **CDP click phase timed out** and it fell back to a **synthetic click** ("CDP phase 'cdp_click' timed out; used synthetic click fallback").

Meanwhile everything that runs through `chrome.scripting.executeScript` or normal DOM APIs kept working perfectly:

- `execute_script` — fully working the entire time.
- `open_page` — working.
- `set_file_input` — working (files attached fine).
- Synthetic DOM interaction inside `execute_script` (native value setters, `el.click()`, `dispatchEvent`, React-fiber `onChange` invocation) — working.

**Interpretation:** the `chrome.debugger` attachment for the target tab was effectively dead/detached — CDP `Input.*` commands either silently no-op (keyboard) or hang until timeout (mouse) — while the non-debugger code paths (`chrome.scripting`) were unaffected. Crucially, the keyboard handler still reports success, so the failure is **silent**: an agent will happily "type" into 20 fields and submit a form that is actually empty.

---

## 2. Impact / why it matters

The failure mode is **silent success**, which is the worst kind:

- `type_text` telling the caller it typed N characters when the field is still empty means an agent cannot trust its own form-fill. It only finds out at submit time (validation errors), or never (submits an empty/garbage form).
- Any field that requires **real keystrokes** becomes impossible: autocomplete/typeahead widgets that fetch options on input (Greenhouse "Location (City)" async react-select, Google-Places city lookups, most Workday/iCIMS comboboxes, react-select filtering in general). You cannot filter a 244-option country list or trigger an async city fetch without keystrokes landing.
- Any flow relying on `click_at_coordinates` (cross-origin iframes, reCAPTCHA anchor checkbox, canvas targets) is dead, because that tool has no non-CDP fallback — it just times out.

Real-world consequence in this session: a job-application form was ~90% filled via `execute_script` + React-fiber surgery, but could not be completed because its async location field genuinely needs keystrokes, and no CDP keystroke would land.

---

## 3. Exact symptoms (verbatim tool output)

### 3.1 `type_text` — reports success, lands nothing

Tested against a **plain** `<input id="first_name">` (not a fancy widget), after clearing it via `execute_script`:

```
type_text(into_selector="#first_name", text="Molly", clear_first=false)
→ "Typed 5 characters via individual keystrokes"

execute_script("return {firstName: document.getElementById('first_name').value}")
→ { firstName: "" }
```

Same behaviour on multiple other inputs earlier in the session (a Cezanne Google-Places `#city_id`, a Greenhouse react-select `#country`): the tool reports "Typed N characters" every time; the field value stays `""` every time.

### 3.2 `click_at_coordinates` — hard timeout

```
click_at_coordinates(x=827, y=262)      // coords from getBoundingClientRect, element in viewport (innerH=929)
→ "click_at_coordinates failed at (827, 262): phase=cdp_click_at exceeded 8000ms"
```

### 3.3 `click_element` — CDP phase times out, synthetic fallback used

```
click_element("Apply")
→ 'Could not click "Apply": undefined (CDP phase "cdp_click" timed out; used synthetic click fallback)'
```

(The synthetic fallback is why `click_element` was still partially usable — it degrades to a DOM `.click()`. `click_at_coordinates` has no such fallback and therefore just fails.)

### 3.4 What kept working

- `execute_script` — 100% reliable throughout (this is `chrome.scripting.executeScript`, not the debugger).
- `open_page` — navigation fine.
- `set_file_input` — file attached, page-level file count went `0 → 1` as expected.
- Synthetic selection of react-select values by calling the React fiber's `onChange` directly worked (updated the widget's displayed value), confirming the renderer + content-script paths were healthy; only CDP Input was dead.

---

## 4. Scope matrix

| Capability | Underlying mechanism | Status this session |
|---|---|---|
| `type_text` | `chrome.debugger` → `Input.dispatchKeyEvent` (rawKeyDown/char/keyUp) | **DEAD (silent — reports success)** |
| `click_at_coordinates` | `chrome.debugger` → `Input.dispatchMouseEvent` bezier (`dispatchHumanMouseClick`) | **DEAD (8s timeout)** |
| `click_element` CDP phase | `chrome.debugger` → mouse dispatch + activity probe | **DEAD (timeout) → falls back to synthetic click** |
| `execute_script` | `chrome.scripting.executeScript` | Working |
| `open_page` | tabs/navigation | Working |
| `set_file_input` | scripting / DOM file APIs | Working |
| Synthetic DOM (`el.click()`, native setters, `dispatchEvent`, fiber `onChange`) | in-page JS via `execute_script` | Working |

The split is clean and diagnostic: **`chrome.debugger`-routed = dead; `chrome.scripting`-routed = alive.**

---

## 5. Relevant code paths

All the dead capabilities funnel through the CDP debugger cluster:

- `packages/extension/src/background/cdp/dispatch.ts`
  - `dispatchHumanMouseClick` (bezier `Input.dispatchMouseEvent`) — used by `click_element` and `click_at_coordinates`.
  - `dispatchTapGesture` (`Input.synthesizeTapGesture`) — fallback.
  - `dispatchKeyboardActivation` (`Input.dispatchKeyEvent` rawKeyDown/char/keyUp) — Enter-activation fallback.
- `packages/extension/src/background/handlers/type.ts` → `handleTypeText` (per-character CDP key events).
- `packages/extension/src/background/handlers/click.ts` → `handleClickElement` (CDP phase, then synthetic/fiber fallback).
- `packages/extension/src/background/cdp/debugger.ts` → `withDebugger` (wraps every CDP command; this is the shared attach/detach chokepoint).

The healthy paths (`execute_script`, `set_file_input`, `open_page`) use `chrome.scripting` / tabs APIs and never touch `withDebugger` — consistent with them surviving.

---

## 6. Root-cause hypotheses (ranked)

1. **The `chrome.debugger` session got detached and `withDebugger` didn't notice / didn't re-attach.**
   The most likely cause. `chrome.debugger` auto-detaches when: DevTools is opened on the tab, another debugging client attaches, the "…is being debugged by chrome-flow" info-bar is dismissed by the user, the tab process crashes/reloads under load, or the extension SW is killed and restarted. If `withDebugger` reuses a stale attachment (or swallows the detach error), subsequent `Input.*` sends go nowhere.
   - Fits keyboard "silent success": the send is fire-and-forget-ish and the handler returns success without confirming the debuggee is still attached.
   - Fits mouse "timeout": `dispatchHumanMouseClick` awaits an activity probe / command round-trip that never resolves against a detached target.

2. **Service-worker lifecycle churn on a long session.** MV3 SWs get killed after ~30s idle. If a detach happened during an SW recycle and the re-attach path is missing/racy, the debugger stays detached while `chrome.scripting` (which re-establishes cheaply) keeps working.

3. **Under-load target instability.** Earlier in the session a Gmail tab was described as "overloaded" (CDP clicks failing there while `execute_script` still worked). Possible the debuggee target became unresponsive to the Input domain specifically, or an exception left the debugger in a half-attached state that then affected subsequently-activated tabs.

4. **(Less likely) OS-level foreground requirement.** CDP `Input.dispatch*` normally injects at the renderer regardless of OS focus, so this shouldn't matter — but worth ruling out (was Chrome backgrounded/minimized the whole time?).

---

## 7. Suggested fixes / hardening

- **Make `type_text` verify landing, not just issue keystrokes.** After dispatch, read back the focused element's `value`/`textContent` via `chrome.scripting` and fail loudly (or auto-fallback to a synthetic native-setter fill) if it didn't change. Silent "Typed N characters" on an empty field is the core trap.
- **Detect a dead debugger and self-heal.** In `withDebugger`, before/after a send, confirm the attachment (`chrome.debugger.getTargets` / attach state); on `"Detached while handling command"` / `"Debugger is not attached"` / timeout, **re-attach once and retry** before surfacing failure. Emit a distinct error (`CDP_INPUT_UNAVAILABLE`) so the MCP layer can tell the agent "real input is down, use synthetic".
- **Give `click_at_coordinates` the same synthetic/tap fallback ladder `click_element` already has** (it currently just times out with no fallback).
- **Surface debugger detach events.** Listen to `chrome.debugger.onDetach` and mark the session degraded so tools can short-circuit to synthetic paths (and tell the user to re-attach) instead of each one independently timing out for 8s.
- **Health-check tool / MCP capability flag.** A cheap `input_alive?` probe (dispatch a key to a scratch element and read it back) so an agent can detect this state in one call instead of inferring it from three separate failures.

---

## 8. Workarounds that DID work (for agents stuck in this state)

Everything via `execute_script` / synthetic DOM:

- **Text inputs:** native value setter + input/change events, resetting React's `_valueTracker` first:
  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.focus(); if (el._valueTracker) el._valueTracker.setValue('');
  set.call(el, value);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ```
- **react-select dropdowns (fixed options):** climb `el.__reactFiber$...` from the input to the fiber whose `onChange` source references the form field name, and call it with the option object `{label, value}`. (Caveat: React batches re-renders — set one field per commit, or several silently fail to stick.)
- **AngularJS Google-Places location field (Cezanne):** set the directive's isolate scope + parent `vm.cv` city fields (`city_id` = a real Google `place_id`, plus `city_name`/lat/lng) directly via `angular.element(el).isolateScope()`; the "choose from dropdown" validator then becomes cosmetic.
- **Submitting:** synthetic `el.click()` on the real submit button worked where CDP click did not.

What **cannot** be worked around synthetically: any widget that only populates on **real keystrokes** — async typeaheads that fetch options on `input` (Greenhouse candidate-location, Google Places autocomplete predictions). Those genuinely need the CDP Input layer alive.

---

## 9. Data to capture next time this happens

- Extension version + build hash at failure time.
- `chrome://extensions` → chromeflow → "service worker" console: any `chrome.debugger` detach errors / `onDetach` reason.
- Whether the "…is being debugged" info-bar was still present on the tab.
- `chrome.debugger.getTargets()` output for the failing tab (attached? which client?).
- Whether DevTools was ever opened on that tab during the session.
- Whether Chrome was foregrounded or minimized/backgrounded.
- Did opening a brand-new tab (fresh `attach`) restore CDP Input? (Not tried this session — a fast triage step.)

---

## 10. One-line repro test for "is CDP input alive?"

```
1. execute_script: create/clear a scratch input, focus it.
2. type_text into it.
3. execute_script: read the value back.
   value === "" AND type_text returned success  →  CDP Input is DEAD (this bug).
```
