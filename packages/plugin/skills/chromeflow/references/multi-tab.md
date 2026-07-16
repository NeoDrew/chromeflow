# Multi-tab reference

Patterns for working across multiple tabs, opening side-tasks without
disturbing the foreground, and recovering from background drift.

## Listing and switching

```
list_tabs()                         # full inventory
switch_to_tab(tab=1)                # by 1-based index
switch_to_tab(query="github")       # by URL or title substring
switch_to_tab(tab="github")         # alias for query (string form)
```

`switch_to_tab` now echoes the landed URL and title in the response:
`Switched to tab matching "X" → "Page Title" (https://...)`. No
follow-up `list_tabs` round trip needed to verify.

## Opening side tabs

```
open_page(url, new_tab=true)        # opens, switches focus to new tab
open_page(url, new_tab=true, background=true)  # opens, keeps current tab focused
```

Use `background=true` whenever the current tab has unsaved work whose
auto-save fires on focus loss (eBay seller listings, some dashboards).

## Settle check

`open_page` runs a 6s settle check after `tabs.onUpdated` fires
complete: `document.readyState === "complete"`, no visible spinner, and
250ms of mutation quiet. If a spinner is still visible at the end of
the window, the response carries `stuck_spinner: true` with the
matching selector — the canonical case is an SPA route that left a
permanent `.spinner-wrapper` because the underlying API request died.
Don't reload, navigate elsewhere.

Pass `expect_selector="..."` to require a known-good element before
the page is considered settled. The response carries
`expect_selector_appeared: false` if it never showed up.

## Closing tabs

```
close_tab()                         # closes active tab
close_tab(query="github")           # by URL/title
close_other_tabs()                  # closes all except active
close_other_tabs(keep_query="github") # keeps tabs matching the query
```

Don't use mid-flow if you might still need a tab. Reserve for end-of-
session cleanup.

## Background heartbeats and parallel sessions — `tab_query`

`execute_script` supports `tab_query` to target a tab without
switching focus to it:

```
execute_script("return document.title", tab_query="github")
execute_script("localStorage.setItem('keepalive', Date.now())", tab_query=3)
```

Use for:
- Background heartbeats from a self-rescheduling loop on a different
  tab from the user's foreground
- Parallel-session scripts that read state from N tabs without
  visiting each

Same query syntax as `switch_to_tab`: numeric index, URL substring, or
title substring.

## Long-lived loops — verify active tab on each iteration

chromeflow pins the tab each connection is working on, so another tab
grabbing OS/window focus (a subagent's `open_page`, the user clicking
around) no longer silently redirects your next call — `list_tabs`,
`click_element`, `get_page_text`, etc. keep following the pinned tab
until you explicitly `switch_to_tab` or `open_page(new_tab=true)`.
Pinning doesn't cover the pinned tab itself changing out from under
you (the user manually navigating it while AFK, a page-side redirect).
At the start of every long-lived loop iteration, still verify:

```
const tabs = list_tabs()
const active = tabs.find(t => t.active)
if (!active.url.includes("expected-domain")) {
  switch_to_tab(query="expected-domain")
}
```

Without this guard, scripts run on the wrong page and fail with
confusing "undefined" errors that look like page bugs.

## Save state before navigating away

Before navigating away from a partially-filled form, capture the
field values via `get_form_fields()` and store them locally. If the
target tab reloads or loses state on return, restore by replaying
`fill_form` with the captured values.

## Avoiding duplicate tabs

Before opening a new tab, call `list_tabs()` to check if the target URL
is already open. Use `switch_to_tab` to return to it instead of opening
a duplicate.

## Cross-origin iframes are NOT tabs

`list_frames()` is for iframes. `list_tabs()` is for top-level browser
tabs. Iframes get pixel coordinates in `list_frames`; tabs get URLs
and titles in `list_tabs`. Pick the right tool for the boundary.
