# Error recovery reference

Most errors carry a structured field that tells you exactly what
happened. Read the response, don't guess.

## `silently_rejected: true` (anti-bot or slow async)

The click dispatched but the activity probe (default 1500ms) saw zero
DOM / focus / URL / value / checked / alert / toast / modal change.
Two common causes:

1. **Anti-bot rejection**: the site silently rejected the synthetic
   click (Reddit submit, X submit, reCAPTCHA-protected forms).
2. **Slow async action**: the button triggers an API call that takes
   longer than the probe window to produce visible DOM changes (common
   on annotation dashboards like "Collect Traces & Continue").

**Recovery:**
1. If the button triggers a slow async action (API call, data
   collection, "Collect Traces"), use `skip_activity_probe: true`.
   This skips the probe AND all fallback clicks (tap gesture, pointer
   chain, DOM .click(), fiber), preventing double-fire. Verify state
   yourself via `find_text` after 3-5s. You can combine with
   `until_text_contains` or `until_selector` to wait for the result.
2. If `skip_activity_probe` is too aggressive, try
   `activity_timeout_ms: 3000` (or higher) first. The probe returns
   early on activity, so increasing it only costs time when there
   truly is no activity.
3. For shadow DOM buttons: the pointer chain fallback fires
   automatically between the CDP click and DOM .click() fallback. If
   you still see silently_rejected on shadow DOM sites, the button
   likely gates on isTrusted (proceed to step 5).
4. Try `try_fiber: true` once. The fiber walk is shadow-DOM-aware.
   If `fiber_attempted: true` AND `silently_rejected: true` still
   set, fiber didn't help either.
5. Pre-fill any related fields via `fill_form` / `fill_input`.
6. If it's still rejected after fiber + pre-fill, this is genuine
   anti-bot gating. Most chromeflow sessions run unattended, so
   `highlight_region` + `wait_for_click()` just blocks on a human who
   isn't there — don't reach for it by default. Report the rejection
   back to the caller and stop. Only use it if you know a human is
   actually present for this session.
7. Do NOT retry the same `click_element`. Re-targeting doesn't help.

See `references/anti-bot.md` for the full decision tree.

## `request_in_flight: true` (slow submit, do NOT retry)

Set on a `click_element` whose `until_*` clause timed out *while a
fetch/XHR triggered by the click was still in flight*. The click DID
register; the navigation or server response is simply still pending.
The until-poll already auto-extends its deadline while a request is in
flight (up to 30s for `until_url_changes`), so seeing this means the
request outran even that.

**Recovery:** do NOT retry the click — on a submit, a second click
double-submits. Re-check the page with `find_text` / `get_page_text`,
or re-issue the same `click_element` with a higher `until_timeout_ms`.
(`until_url_changes` now defaults to 15000ms, up from 5000ms, for
exactly this reason.)

## `dialog_opened: { kind, label, primary_action }`

Set on a `click_element` whose `until_*` clause timed out because a
modal opened instead of navigating. `kind` tells you which:

- `"confirmation"` — a two-step action ("Submit?" → [Confirm]). The
  first click worked; click the `primary_action` label to finish, e.g.
  `click_element(textHint: primary_action)`. NOT a validation error.
- `"required-input"` — the dialog wants a value first (flair picker,
  "answer this question"). Supply it inside the dialog, then click its
  `primary_action`, then retry the original action.
- `"dialog"` — opened but unclassified; read `label` and decide.

## `wait_for(since: "now")` only fires on genuinely new text

`since: "now"` now snapshots every match present at call time and only
resolves on a match that wasn't there before. Use it whenever the query
string might already be on the page (e.g. the prompt text echoed in a
textarea, or stacked prior-step content an SPA left in the DOM): the
wait won't false-fire on the pre-existing copy, only on the freshly
rendered one. Omit `since` to match text that's already present.

## `phase_timed_out: "<phase_name>"`

One phase of a click exceeded its own budget. Phases and budgets:

| Phase | Budget | Diagnostic |
|---|---|---|
| `cdp_click` | 8s | Hung CDP attach. Close DevTools or other chromeflow instances on this tab. |
| `activity_probe` | 3.5s | MAIN-world JS blocked. Click usually fired anyway; verify with `get_page_text`. |
| `react_fiber_click` | 3.5s | Page navigated mid-walk, or fiber tree unusually deep. Retry once. |
| `activity_probe_2` | 3.5s | Second probe after fiber hit same condition. |

The whole-call WS cap is 30s; phase budgets let you know WHICH part hung.

## `stuck_spinner: true`

`open_page` settled with a visible spinner still on screen after 6s.
The route is likely dead (SPAs sometimes leave a permanent
`.spinner-wrapper` when the underlying API request fails). Don't
reload — navigate elsewhere instead.

The response carries `spinner_selector` so you know which element
chromeflow detected.

## `expect_selector_appeared: false`

You passed `expect_selector="..."` to `open_page` and it never
appeared within 6s. The page may be partially loaded or stuck. Try
`get_page_text` to see what state the page is in.

## "Request timed out after Nms (last progress Mms ago)"

The WS bridge timer elapsed. The error message includes the time
since the last `progress` heartbeat from the extension. If
`last progress` is recent (under a few hundred ms), the operation
likely completed on the page — verify state before retrying. Long
typings emit progress every 200 chars, so a recent heartbeat is
evidence the type actually landed.

## "Another debugger is already attached to this tab after 5 retries"

Could be:
1. Chrome DevTools open on this tab (Cmd+Opt+I) — close it.
2. Another chromeflow instance attached to this tab — move it to a
   separate Chrome window.
3. A transient internal race where the previous detach hadn't
   propagated yet. The 5-retry budget (~7.5s) usually catches these,
   but if it slips through, just retry the original call once.
4. A previous `execute_script` hung and locked the debugger. As of
   0.10.4, `execute_script` auto-terminates via
   `Runtime.terminateExecution` on timeout and releases the debugger
   cleanly. If you hit this on an older version, refresh the tab.
   Pass `timeout_ms` to `execute_script` to control the timeout
   (default 30s; lower for scripts that might hang, higher for
   intentionally long-running shadow DOM traversals).

## "Frame removed — page navigated during script execution"

`execute_script` was running when the page navigated. The script's
effects may or may not have completed; the response carries
`navigated: true` and `result: "[navigated]"`. Verify post-navigation
state with `get_page_text` or `wait_for`.

## "Cannot access contents of the page"

The tab lost extension host access (Chrome quietly evicts the content
script after long idle, navigation between origin variants). The
handler auto-reloads the tab once and retries; the response carries
`reauthorized: true` so you can see what happened. The reload may
clear in-page form state, so capture field values via `get_form_fields()`
before long idles on pages with unsaved input (restore later with
`fill_form` — see references/multi-tab.md "Save state before navigating
away").

## `fill_input` matched the wrong field

The response names the matched element AND its match-strength. If you
see `<input name="title">` when you wanted "Ad rate", the
fuzzy-text-walk latched onto a neighbour.

Match-strength ranks (best to worst):
- `aria-eq` — exact aria-label match
- `placeholder-eq` — exact placeholder match
- `label-text-eq` — exact `<label>` text match
- `name-eq` — exact name attribute match
- `id-eq` — exact id match
- `*-includes` — substring match (lower confidence)
- `fuzzy-text-walk` — nearby-text walk (lowest, source of wrong-field bugs)

Recovery for wrong-field matches:
1. Pass `exact: true` to refuse fuzzy / *-includes
2. Pass an explicit `nth` to disambiguate
3. Switch to `selector="<css>"` mode

**Ambiguous fuzzy matches are now refused by default** rather than
silently picking the first candidate. The response includes a
`Candidates:` list with each candidate's identifying attributes.

## `scope_missed: true`

`within_selector`, `near_text`, `in_dialog`, or `dialog_query` didn't
match anything. Either the scope doesn't exist (yet), or you mistyped
it. Don't retry blindly — call `find_text` for the scope first to
confirm it's on the page.

## `click_element` 0×0 hidden auto-advance

When the matched element has `width: 0; height: 0` AND no explicit
`nth` was passed, chromeflow automatically advances to the next visible
candidate. The success message starts with `"Auto-advanced from hidden
first match for X → visible candidate Y"`.

If you DID pin a specific `nth`, the click is refused with the
candidate list — re-targeting after the fact is too risky on dense
forms.

## `wait_for(text=...)` matched too quickly

Response carries `initial_match_warning` when the match fired <50ms
into the wait. The page likely kept stale text in the DOM from a prior
step. Re-call with `since: "now"` to gate on a new mutation.

## `wait_for(text="Live")` matched "delivery"

Common English words ("Live", "New", "Done", "Confirm") substring-
match unrelated content. Pass `whole_word: true` to wrap the query in
word boundaries:
```
wait_for(text="Live", whole_word=true)
find_text("Done", whole_word=true)
```

## `wait_for(text=...)` timed out

Response includes `last_text` — the trailing 240 chars of the scope's
content when the wait gave up. If your target was "Live" and last_text
shows "Starting up... 47%", extend the timeout instead of debugging a
phantom failure.

## `find_text` returns no matches

Response includes `hidden_count` when `visible_only=true` (default)
filtered everything out. Sample: `"No visible matches found for X.
3 hidden match(es) skipped..."`. Pass `visible_only=false` to include
them.

## TipTap silent-drop

`type_text` reports success but the editor reverts to placeholder a
few seconds later. Auto-recovery already kicks in: post-type
verification re-fills via `execCommand("insertText")` when the editor
has < 50% of expected content. The response message records the
fallback: `"TipTap/ProseMirror silently dropped the typed text
(N/M chars survived), recovered via execCommand insertText"`.

If you want to skip the verify-and-fallback entirely on TipTap, prefer
`fill_input(textHint="Description", value="...")` from the start — it
auto-detects TipTap/ProseMirror and uses execCommand from the start.

## Recovery escalation pattern

For ANY browser interaction that fails:

1. Read the response's structured fields first (`silently_rejected`,
   `phase_timed_out`, `scope_missed`, `selector_in_shadow`, etc.).
2. Try the documented recovery for that specific field.
3. If the response is plain `success: false` with no signal, call
   `get_page_text` to see what the page actually looks like now.
4. As a last resort, `take_screenshot` to find pixel positions for
   `click_at_coordinates`. Reserve `highlight_region` + `wait_for_click`
   for sessions where a human is actually present — most chromeflow runs
   are unattended, so that pairing just blocks with no one to click.

Never retry the same failing call without first reading what changed.
