# Error recovery reference

Most errors carry a structured field that tells you exactly what
happened. Read the response, don't guess.

## `silently_rejected: true` (anti-bot)

The click dispatched but the 1500ms activity probe saw zero DOM /
focus / URL / value / checked / alert / toast / modal change. The site
silently rejected the synthetic click — Reddit submit, X submit, and
reCAPTCHA-protected forms all do this.

**Recovery:**
1. Try `try_fiber: true` once. If `fiber_attempted: true` AND
   `silently_rejected: true` still set, fiber didn't help either.
2. Pre-fill any related fields via `fill_form` / `fill_input`.
3. `highlight_region(selector, "Click to submit")` + `wait_for_click()`.
4. Do NOT retry the same `click_element`. Re-targeting doesn't help.

See `references/anti-bot.md` for the full decision tree.

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
clear in-page form state, so `save_page_state` before long idles on
pages with unsaved input.

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
   `click_at_coordinates` or `highlight_region` + `wait_for_click`.

Never retry the same failing call without first reading what changed.
