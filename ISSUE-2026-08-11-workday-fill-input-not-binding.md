# Issue: `fill_input` sets the DOM value on Workday text fields but the value never binds to Workday's model — form validates as EMPTY on Next/Submit

- **Date observed:** 2026-08-11 (also seen 2026-08-06)
- **Severity:** High (silent — the field visibly shows the value, so the agent believes it's filled; Workday only reveals the truth at step-transition with a generic "required" error, and a naive agent will loop on it or dead-end)
- **Extension build in use:** whatever was live in the attached Chrome on 2026-08-11 (`packages/extension/dist/background.js`). Version not captured at failure time.
- **Reproducibility:** Reproduced cleanly across two independent Workday tenants (State Street `statestreet.wd1`, Lombard Odier `lombardodier.wd3`) on the "My Information" application step. Deterministic, not session-dependent.

---

## 1. Summary

On Workday `*.myworkdayjobs.com` application forms, `fill_input` (selector mode — the "React-aware native value-setter" path) **sets `input.value` and the field renders the value on screen**, but Workday's controlled-input state machine **does not register the change**. The value is present in the DOM and visible to the user, yet when the applicant clicks **Next**, Workday throws:

```
Errors Found
  Error - Given Name(s):  The field Given Name(s) is required and must have a value.
  Error - Family Name:     The field Family Name is required and must have a value.
  Error - Email:           The field Email is required and must have a value.
```

…for fields that are **plainly populated on screen** ("Molly", "Sullivan", "molly.sulli1904@gmail.com").

The fix is to enter those fields with **trusted keystrokes** (`type_text` with `clear_first: true`), which Workday's `onChange` does capture. After re-typing the exact same values via `type_text`, the identical Next click advances with zero errors.

This is the text-input analogue of the known Workday multiselect problem (`ISSUE-…-cdp-input-dead.md` touches the multiselect/keystroke angle) — but here it's **plain `<input type=text>` fields**, and the input layer is otherwise healthy (keystrokes DO land; it's specifically `fill_input`'s synthetic set that Workday ignores).

---

## 2. Impact / why it matters

The failure mode is **silent success**, the worst kind:

- `fill_input` returns success (`Filled "Given Name(s)*" → <input name="legalName--firstName">`), the value is visible on the page, and `execute_script` reads `input.value === "Molly"`. Everything says "filled."
- Workday's own required-field check disagrees, but only surfaces on step transition, and its error copy ("is required and must have a value") **implies the field is empty**, which contradicts what's on screen. An agent that trusts the visible value will re-click Next, re-verify the value is "there", and loop — or conclude the widget is broken and abandon a genuine application.
- Real-world consequence (2026-08-11): a real job application (Lombard Odier — Sustainability Research Analyst) was fully filled and looked complete, but Next silently refused to advance twice with no obvious cause until a screenshot revealed the "Errors Found" panel citing three visibly-populated fields. Re-typing them via `type_text` fixed it immediately. That's ~6 wasted tool calls + a screenshot to diagnose something the tool could self-detect.

Notably, chromeflow **already half-detects this**: after the first `type_text` on one of these fields, the tool emitted the hint:

```
ℹ flow_capturable: … (click recovered via react-fiber; field needs real keystrokes (type_text, not fill_input))
```

So the "needs real keystrokes" signal exists internally — it just isn't fed back into `fill_input` to prevent the bad fill in the first place.

---

## 3. Exact symptoms (verbatim tool output)

### 3.1 `fill_input` reports success and the DOM shows the value

```
fill_input(textHint="Given Name(s)*", value="Molly")
→ Filled "Given Name(s)*" → <input type="text" name="legalName--firstName" id="name--legalName--firstName">

fill_input(textHint="Family Name*", value="Sullivan")
→ Filled "Family Name*" → <input type="text" name="legalName--lastName" ...>

fill_input(textHint="Email*", value="molly.sulli1904@gmail.com")
→ Filled "Email*" → <input type="text" name="emailAddress" ...>
```

`execute_script` confirms the values are in the DOM:

```
execute_script(return {fn: $deep('input[name="legalName--firstName"]').value,
                       ln: $deep('input[name="legalName--lastName"]').value,
                       email: $deep('input[name="emailAddress"]').value})
→ { fn: "Molly", ln: "Sullivan", email: "molly.sulli1904@gmail.com" }
```

### 3.2 Next silently no-ops; Workday reports those same fields as empty

```
(click Next) → still on "My Information", no navigation

execute_script(... [aria-required] empty check ...)
→ reqEmpty: [""]        // an aria-required input Workday considers empty

(screenshot) → red "Errors Found" panel:
   "The field Given Name(s) is required and must have a value."
   "The field Family Name is required and must have a value."
   "The field Email is required and must have a value."
   (all three inputs visibly contain their values, red-bordered)
```

### 3.3 Re-entering the SAME values via `type_text` fixes it

```
type_text(into_selector='input[name="legalName--firstName"]', text="Molly", clear_first=true)
type_text(into_selector='input[name="legalName--lastName"]', text="Sullivan", clear_first=true)
type_text(into_selector='input[name="emailAddress"]', text="molly.sulli1904@gmail.com", clear_first=true)

(click Next) → advances to "My Experience", errBox=false
```

---

## 4. Root-cause hypothesis

Workday's text inputs are React-controlled with a change handler that binds off the **native input event produced by real user typing** (isTrusted keystrokes via CDP `Input.dispatchKeyEvent`), not off a programmatic `HTMLInputElement.prototype.value` setter + dispatched `Event('input')`.

`fill_input`'s selector path uses the standard React hack (native value setter → `new Event('input', {bubbles:true})`). That is enough for most React-controlled inputs (it works everywhere else), but Workday's field-level validation/model reads its "has a value" state from an internal store that this synthetic path does not populate. So:

- The visible `<input>` shows the value (DOM `.value` is set).
- Workday's model still has the field as empty → required-field validation fails at step transition.

Trusted CDP keystrokes (`type_text`) produce the exact event sequence Workday's handler subscribes to, so the model updates.

This matches the multiselect behaviour (search-multiselects only commit on real keystroke + Enter) — same underlying "Workday only trusts real keystrokes" root cause, now confirmed for plain text inputs too.

---

## 5. Affected surface (confirmed)

- **Tenants:** `statestreet.wd1.myworkdayjobs.com` (2026-08-06), `lombardodier.wd3.myworkdayjobs.com` (2026-08-11).
- **Fields:** "My Information" step text inputs — `legalName--firstName`, `legalName--lastName`, `emailAddress`, `addressLine1`, `city`, `postalCode`. Also the State Street salary `<textarea>` (same fix: type_text).
- **Interesting non-repro:** the phone number field (`phoneNumber`) sometimes binds via `fill_input` and is NOT flagged — so it's not 100% of inputs, which is why a screenshot is currently required to see WHICH fields Workday rejected.
- Note: some Workday tenants render "How Did You Hear / Country / Phone Device Type" as plain `<ul>` list dropdowns (bind fine via `click_element`), others as the search-multiselect (needs type-filter + Enter). Both variants seen.

---

## 6. Suggested fix (in priority order)

1. **Post-fill verification + auto-fallback in `fill_input`.** After a selector-mode fill on a React-controlled input, do a cheap check (e.g. blur the field, or read back after a microtask, or detect the host is a `*.myworkdayjobs.com` / `data-automation-id`-annotated Workday DOM) and, if the framework state didn't take, **transparently re-enter via the trusted-keystroke path**. The internal "field needs real keystrokes" detection already fires (see §2) — wire that into `fill_input` so it self-heals instead of only warning after the fact.
2. **Workday host heuristic.** When the page is Workday (`myworkdayjobs.com`, or `[data-automation-id]` inputs), have `fill_input` default to trusted keystrokes for text inputs rather than the synthetic setter.
3. **At minimum, louder feedback.** If chromeflow can detect the value didn't bind, `fill_input` should return a `bound:false` / "value set in DOM but framework didn't register — retry with type_text" warning in its result, not just an incidental `flow_capturable` note. Today the caller gets an unqualified "Filled" success.

---

## 7. Workaround (current)

On Workday text fields, skip `fill_input` and use:

```
type_text(into_selector="input[name='…']", text="…", clear_first=true)
```

for every required text input, then verify with the "Errors Found" panel (or `get_form_fields(only_empty:true)`) before clicking Next. Submit buttons on Workday also frequently need `execute_script` direct `.click()` rather than a synthetic click.

---

## 8. Data to capture next time

- Extension build/version string at failure time.
- The exact `data-automation-id` of an affected input and whether it carries a React fiber prop key.
- Whether a plain `input.dispatchEvent(new Event('change',{bubbles:true}))` (change, not input) after the setter would bind Workday's model (cheap potential fix to test).
