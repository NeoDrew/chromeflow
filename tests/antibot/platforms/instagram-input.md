# Instagram input

**Validated:** Pass (React-controlled native input via selector-mode fill_input)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Yes (logged-in Instagram account)
**Stability:** Stable for native-input fill; full DM/comment composer not exercised

## What this validates

`fill_input(selector="...")` lands a value into Instagram's React-
controlled native `<input>` elements via the React-aware native value
setter (the `Object.getOwnPropertyDescriptor(prototype, "value").set`
ceremony). Instagram's React tree picks up the change and the value
is accepted by the page's state.

## Procedure executed (2026-05-25)

1. `open_page("https://www.instagram.com/direct/inbox/")`. Verified
   logged-in via `execute_script` (no `input[name="username"]`).
2. Probed the page for any contenteditable / textarea — none on
   `/direct/inbox/` until a thread is opened. The Search input
   (`input[placeholder="Search"]`) is the only typing target.
3. `fill_input(selector="input[placeholder='Search']", value="chromeflow-validation-test")` —
   response: `Set <input type="text" name="searchInput"> to "chromeflow-validation-test"`.
4. Verify via `execute_script`: `input.value === "chromeflow-validation-test"` (the React-aware setter dispatched input + change events; React state accepted).

## Result

**Pass for React-controlled native input.** `fill_input(selector=...)`
correctly used the prototype's native value setter, dispatched
input/change events, and Instagram's React state accepted the value.

## Open follow-up

The full DM message composer test was not exercised because Instagram's
DM inbox does not render the message composer until a thread is opened,
and opening a thread requires picking an arbitrary contact (we did not
want to clutter the user's DMs with test threads).

For a full DM composer test:

```
open_page("https://www.instagram.com/direct/inbox/")
# Click into an existing thread (user-selected target)
# Then test the contenteditable message composer:
type_text("Test", into_selector="[role='textbox'][contenteditable='true']")
# Verify via execute_script before submitting
```

## Comment composer

The post-comment input is a separate test target. Pattern:

```
open_page("https://www.instagram.com/p/<post-id>/")
fill_input(textHint="Add a comment", value="...")
# Or for typing path:
type_text("...", into_selector="textarea[aria-label='Add a Comment…']")
```

## Submit handoff (untested by design)

Instagram does not currently gate the Send button on isTrusted as
strictly as Reddit/X.

## Known regressions

None at 0.10.1. The React-aware native value setter has been stable
across Instagram's React updates.
