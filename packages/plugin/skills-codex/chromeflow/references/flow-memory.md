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
2. **Earned promotion → trusted.** A provisional flow is promoted to
   *trusted* once its exact step-signature is independently re-observed a
   second time, OR the moment you `save_flow()` it (an explicit vouch).
3. **Trusted flows are recalled first — for this exact URL, or a sibling.**
   If a URL has no trusted flow of its own, chromeflow also checks for a
   trusted flow on a *sibling* URL: same origin and same path shape once
   per-instance segments (a job posting id, an order id, a ticket number) are
   templated out. This is what lets a hard-won discovery on one job
   posting/listing/ticket recall on a *different* one at the same site,
   instead of being locked to the one exact URL it was learned on — see
   `known_flow (from a sibling page, ...)` below.
4. **A single unproven success still recalls, as `possible_flow`.** If a URL
   has neither its own trusted flow nor a trusted sibling, but does have a
   provisional flow from exactly one prior success on that same URL, it's
   surfaced anyway — labeled lower-confidence, never pooled across siblings.
   This is what lets a hard-won discovery recall on the very next visit to
   the same URL, rather than needing a near-impossible second identical
   revisit.
5. **Self-correcting recall.** A recalled step that fails on replay (a click
   that misses, or a `type_text` that doesn't land) OR that you silently
   rediscover with a *different* locator (a mismatch) **demotes the flow to
   provisional on the first miss** (so it immediately stops being recalled) and
   drops it on the second. Only *reliable* flows (more successes than
   failures, clean last replay) are surfaced. Provisional flows also expire
   after 30 days. This is what keeps memory net-positive on dynamic / anti-bot
   sites where a stored selector can drift between sessions — and is what
   bounds the risk of a bad sibling-URL merge to one wasted attempt.

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
Steps marked `⚠fragile` (positional `nth-*` / multi-option comma selectors /
long hex-or-GUID-suffixed ids that a framework typically regenerates per page
render, e.g. Workday's questionnaire fields) are the likeliest to have
drifted — re-verify them first, and treat a sibling-sourced hint (below) with
extra caution since it was proven on a *different* page.

## Three signals you'll see in tool responses

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
`⚠fragile-selector` (positional `nth-of-type`, or a hex/GUID-shaped id) is the
one most likely to have drifted; re-verify it first. A flow tagged
`recorded on vX, re-verify` came from older click logic.

**`known_flow (from a sibling page, ...)`** — the same thing, but earned on a
*different* URL at this site that shares the same route shape (e.g. a
different job posting, order, or ticket — only the instance-specific id
segment differs). This is what makes a hard-won discovery on one Workday job
posting useful on the next one, instead of every new posting starting from
zero. Verify more carefully than a same-URL `known_flow` — the DOM can differ
in small ways between sibling pages even when the button ceremony is
identical.

**`possible_flow`** — a single unproven success on this exact URL (no trusted
flow exists yet, for this URL or a sibling). Try it, but verify more
carefully than a `known_flow` — it's only been seen working once. If it
fails or the element isn't found on the first attempt, abandon it just like
any other recalled step, don't retry.

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
- a click whose target looks like an email address (`click_element("someone@example.com")`)
  — never captured, on any site (see below)
- anything on Gmail's numbered-account-slot URLs (`mail.google.com/mail/u/0`,
  `/u/1`, ...) or Google's account-chooser flow — never captured or recalled,
  regardless of target shape

## Excluded from the cache: shared-account surfaces and identifying targets

Two safety guards, independent of the tier/promotion system above:

1. **Gmail's `/mail/u/N` inbox URLs and Google's account-chooser** are
   excluded from flow memory entirely — `originKey()` returns nothing for
   them, so `noteUrl`/`observe`/`recallHint` are all no-ops. The same
   origin+path on these URLs resolves to *different content depending on
   which signed-in account is active*, and the URL itself carries no signal
   telling you which. A step recorded while driving one identity's Gmail or
   account picker will otherwise replay verbatim in a different identity's
   session, on the exact same URL — real cross-contamination risk (opening a
   stranger's email thread, or picking the wrong Google account mid-task).
   Other `accounts.google.com` pages that don't list multiple accounts (the
   OAuth consent "Continue" screen, for instance) are NOT excluded — that
   recall is safe and useful, since the consent screen only ever concerns
   whichever account is already authenticating.
2. **Any click target that looks like an email address is never buffered,
   on any site** — not just Google's. A recorded step naming a specific
   person's address is unsafe to replay across sessions/identities
   regardless of which page it's on, so this is a general content-shape
   guard rather than a domain check.

Both guards apply at capture time (nothing unsafe is ever written) and
recall time (defense in depth for anything that predates the guard).

## Storage

`~/.chromeflow/flows.json`, keyed by origin + path (query string stripped).
Each flow carries a `tier` (`provisional` / `trusted`), `success_count`, and
`fail_count`. Selectors and success-signals only — **never** the typed text.
Repeated observations of the same flow bump its success count (and promote it)
rather than duplicating.
