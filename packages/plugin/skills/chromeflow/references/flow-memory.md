# Flow memory — learned site flows

chromeflow remembers the hard-won way to drive a site so you don't
rediscover it every session. It is **local and guidance-only**: nothing
replays autonomously, nothing leaves the machine, and only steps that
*cost something to discover* are stored.

Capture is **automatic, with earned trust** (a two-tier, MCTS-style
lifecycle), so memory works even if you never call a tool:

1. **Autosave → provisional.** Buffered hard-won steps are written to disk
   automatically when you leave a site (cross to a different origin) or when
   the session ends. They land as a *provisional* flow.
2. **Provisional flows are NOT recalled.** A one-off or wrong autosave can
   never misdirect a later run; it just sits unused.
3. **Earned promotion → trusted.** A provisional flow is promoted to
   *trusted* once its exact step-signature is independently re-observed a
   second time, OR the moment you `save_flow()` it (an explicit vouch).
4. **Only trusted flows are recalled.**
5. **Self-correcting recall.** A recalled step that fails on replay (a click
   that misses, or a `type_text` that doesn't land) OR that you silently
   rediscover with a *different* locator (a mismatch) **demotes the flow to
   provisional on the first miss** (so it immediately stops being recalled) and
   drops it on the second. Only *reliable* trusted flows (more successes than
   failures, clean last replay) are surfaced. Provisional flows also expire
   after 30 days. This is what keeps memory net-positive on dynamic / anti-bot
   sites where a stored selector can drift between sessions.

## Recalled steps are rendered as ready-to-run calls

Recall surfaces the *proven strategy*, not just a selector, so on hard sites you
skip the expensive cold rediscovery of the dispatch path:

- a click that only worked via the React-fiber fallback comes back as
  `click_element(selector="…", via="fiber", until_url_changes=true)` — issue it
  directly instead of re-walking the CDP → silent-reject → fallback chain;
- a field that needed real keystrokes comes back as
  `type_text(into_selector="…", clear_first=true)`;
- the verifying `until_*` that worked is included so you re-confirm cheaply.

**Abandon-on-first-miss.** A recalled call is guidance, not gospel. If it fails
or its element isn't found on the **first** attempt, do NOT retry it —
*discard the hint and rediscover from scratch*. Retrying a drifted selector is
exactly what makes memory cost more than a cold run on flaky shadow-DOM pages.
Steps marked `⚠fragile` (positional `nth-*` or multi-option comma selectors) are
the likeliest to have drifted — re-verify them first.

## Two signals you'll see in tool responses

**`known_flow`** — appears (once per origin per session) as soon as you
engage a site you've succeeded on before, whether you arrive via `open_page`,
check an already-loaded page with `list_tabs`, or act on it with
`click_element`. (Surfacing it on all three matters: when a page is already
loaded the agent skips `open_page`, so keying recall to `open_page` alone
missed roughly half of revisits.):

```
ℹ known_flow for https://www.reddit.com/submit — prefer these proven steps over rediscovery (verify each as usual):
  "submit text post" (3 steps, 4x ok):
   1. type_text textarea[name=title] (type_text)
   2. type_text div[name=body] (type_text)
   3. click_element #submit-post-button (until_url_change) [via dom-click]
```

**Follow it.** Prefer the recalled steps over rediscovering from scratch.
It's guidance, not autopilot — still pass your usual `until_*` so a stale
step fails loudly instead of acting on the wrong element. A step tagged
`⚠fragile-selector` (positional `nth-of-type`) is the one most likely to
have drifted; re-verify it first. A flow tagged `recorded on vX, re-verify`
came from older click logic.

**`flow_capturable`** — appears after chromeflow buffers a notable
resolution:

```
ℹ flow_capturable: 2 hard-won step(s) on https://www.reddit.com/submit buffered
  (click recovered via dom-click; field needs real keystrokes). They autosave on
  leaving the site; call save_flow("...") to trust them immediately.
```

These steps **will autosave** on their own. Calling `save_flow("<task label>")`
is the optional fast path: it promotes them straight to *trusted* (so they are
recalled next session instead of waiting to be re-observed) and gives them a
human label. Do it when you are confident the task genuinely succeeded. You
don't list the steps — chromeflow commits whatever it buffered for the current
origin. One call, done.

## What gets buffered (and what doesn't)

Captured (these cost retries to find):
- a click that succeeded only via a fallback (pointer-chain, DOM `.click()`,
  fiber, keyboard, React onChange sync) — surfaced as `recovered_via`
- a verified terminal action (`until_url_change` / navigating submit)
- `type_text` into an explicit selector ("this field needs real keystrokes",
  e.g. Reddit's Lexical title/body)

Skipped (rediscovery is free, persisting them is noise):
- first-try clicks on plainly-labelled buttons
- ordinary `fill_input` that landed first try
- plain text found in light DOM

## Storage

`~/.chromeflow/flows.json`, keyed by origin + path (query string stripped).
Each flow carries a `tier` (`provisional` / `trusted`), `success_count`, and
`fail_count`. Selectors and success-signals only — **never** the typed text.
Repeated observations of the same flow bump its success count (and promote it)
rather than duplicating.
