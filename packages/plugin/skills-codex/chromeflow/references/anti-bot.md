# Anti-bot reference

This is the core differentiator. Other browser drivers ship vanilla CDP
clicks and Playwright typing; chromeflow's click and keystroke pipelines
were tuned over 400+ hours against live anti-bot platforms. When the user
hits a site that uses isTrusted checks, behavioural fingerprinting, React-
fiber-only handlers, or strict PointerEvent shape validation, this is the
playbook.

## Validated-against

Chromeflow's CDP click and isTrusted=true keystroke pipelines have been
validated against the following platforms (as of 0.10.0):

| Platform | Validated capability |
|---|---|
| Reddit `faceplate-textarea-input` (composer expand) | CDP click opens the composer; previously required real user gesture |
| Reddit `#comment-composer-submit-button` (comment submit) | Pre-fill body via `type_text(into_selector="div[name=body]", clear_first=true)`; the submit click itself still gates on a real human gesture and will report `silently_rejected` for unattended sessions |
| X / Twitter `[data-testid="tweetTextarea_0"]` | `type_text` with isTrusted=true CDP keystrokes lands; submit still gates on a real human gesture |
| React-controlled radio/checkbox forms (Radix UI, Headless UI) | `click_element` auto-handles the React fiber `__reactProps$.onClick` path when CDP click silently rejected |
| Forms whose Submit button is behind a `[role=dialog]` portal | `click_element("Submit", in_dialog=true)` scopes correctly |
| Closed-shadow-root inputs (Stencil/Lit/Radix portals) | `fill_input(selector=...)` reaches them via content-script tagging |

## What we explicitly do NOT claim

This list is shorter than the one above for a reason. Don't oversell:

- **We do NOT bypass reCAPTCHA / hCaptcha / Cloudflare Turnstile solving.**
  `get_form_fields()` reports captcha presence as a `⚠ CAPTCHA detected`
  line in the response. The submit will be silently rejected and there is
  no automated recovery — most chromeflow sessions run unattended, so
  `highlight_region` + `wait_for_click()` just blocks with no one to click.
  Report the CAPTCHA back rather than waiting on it.
- **We do NOT defeat IP-based fingerprinting / rate limits.** Those are
  network-layer signals chromeflow cannot influence. If a site refuses
  the user's IP, chromeflow cannot help.
- **We do NOT bypass server-side fraud scoring that aggregates many
  signals** (account age, payment history, device telemetry). We
  maximise the behavioural-signal portion, but the server can still
  down-rank or block.
- **We do NOT claim Reddit / X submit clicks fire without user gesture.**
  These platforms gate submit on isTrusted that survives a real human
  click ceremony only. Pre-fill everything, retry with `try_fiber: true`,
  then report the rejection — don't stall a run waiting for a human who
  typically isn't there.

## Decision tree for a click that "should have worked"

When `click_element` reports success but the page doesn't react:

```
click_element("Submit")
│
├── response.silently_rejected: true?
│   │
│   │  YES — the 1500ms activity probe saw zero DOM/focus/URL/alert
│   │  change after dispatch. The click was synthetic-rejected by
│   │  anti-bot detection.
│   │
│   ├── First retry: click_element("Submit", try_fiber: true)
│   │   Walks __reactProps$.onClick directly on React-heavy SPAs.
│   │   Response carries fiber_attempted: true.
│   │
│   ├── If fiber fails too (response.silently_rejected still true,
│   │   fiber_attempted: true):
│   │
│   ├── Pre-fill any related fields:
│   │   get_form_fields()
│   │   fill_form([{label, value}, ...])
│   │
│   ├── Still rejected after fiber + pre-fill: this is genuine anti-bot
│   │   gating (Reddit submit, X tweet submit, mcp.so, any reCAPTCHA-
│   │   protected form). Most chromeflow sessions run unattended, so
│   │   `highlight_region` + `wait_for_click()` just blocks on a human who
│   │   isn't there — don't reach for it by default. Report the rejection
│   │   (silently_rejected: true, what was tried) back to the caller and
│   │   stop. Only use highlight_region + wait_for_click if you know a
│   │   human is actually present for this session.
│   │
│   └── DO NOT retry the same click_element. Re-targeting won't help.
│
├── response.phase_timed_out set?
│   │
│   │  The CDP click attached but one of the phases (cdp_click,
│   │  activity_probe, react_fiber_click) exceeded its budget. Diagnostics:
│   │  - cdp_click 8s: hung CDP attach. Close other debugger sessions
│   │    (DevTools, other chromeflow instances on same tab).
│   │  - activity_probe 3.5s: MAIN-world JS blocked by long handler.
│   │    The click usually fired anyway; verify with get_page_text.
│   │  - react_fiber_click 3.5s: page navigated mid-walk or the fiber
│   │    tree was unusually deep. Retry once.
│   │
├── response.success: false (no silently_rejected, no phase_timed_out)?
│   │
│   │  The matched element wasn't where we thought. Re-resolve:
│   │  - Maybe nth wrong on a dense form: get_form_fields() to see
│   │    indices, then click_element(..., nth: N, within_selector: "...")
│   │  - Maybe the matched element is hidden: response.message will say
│   │    "Matched element X is 0×0 (hidden, display:none, ...)". Auto-
│   │    advance fires when no explicit nth was passed; retry without
│   │    nth or with a different one.
│   │
└── Default: click succeeded; the page just hasn't updated yet.
    wait_for(text="Submitted") or wait_for(selector=".success-toast").
```

## Tools that compose the bypass

### `click_element` flags

```
click_element("Submit", expect_submit: true)
```
Broad detector: watches up to 4s for ANY of URL change, [role=alert],
[data-sonner-toast], .toast, .notification, aria-live appearance,
[role=dialog] / [aria-modal=true] appearance. Returns
`silently_rejected: "submit silently rejected (likely anti-bot)..."` when
nothing fires. Use on form submits when you don't know the destination URL.

```
click_element("Save", until_selector: ".success-toast")
click_element("Save", until_url_contains: "/saved")
click_element("Confirm", until_text_contains: "Order placed")
click_element("Submit", until_url_changes: true)
```
Require an observable post-click condition. Returns success=false if not
met within `until_timeout_ms` (default 5000ms; 15000ms for
`until_url_changes`, since submit roundtrips run longer). If a request
the click fired is still in flight at the deadline, the poll auto-extends
(up to 30s for url-change) and returns `request_in_flight: true` rather
than a misleading "may not have registered" — do NOT retry those, you'll
double-submit. If a modal opened instead, the response carries
`dialog_opened: { kind, label, primary_action }` (see errors.md).

```
click_element("Action", try_fiber: true)
```
Fallback to walking React's `__reactProps$.onClick` directly when the
1500ms activity probe reports zero activity. Opt-in because fiber-prop
walking is undocumented React internal access — may misbehave on mangled
production builds. Reserve for repeat rejections on a React site.

```
click_element("Action", via: "fiber")
```
Skip the CDP click entirely and go straight to the fiber path. Cuts ~3s
of ceremony off React-fiber-only SPAs where you already know the action
is fiber-only.

```
click_element("Submit", in_dialog: true)
click_element("Confirm", dialog_query: "Delete account")
```
Scope candidate matches to a `[role=dialog]` / `[role=alertdialog]` /
`<dialog open>` so generic textHints (Cancel, OK) match the right button.

### Typing trusted keys

```
type_text("body content", into_selector="textarea[name=body]", clear_first=true)
type_text("body content", into_selector=".ProseMirror", clear_first=true)
type_text("body content", frame="iframe.composer")
```

Produces isTrusted=true CDP keystrokes with humanlike per-char delays. The
slow-pause tail caps at 250ms (down from 500ms in earlier versions). For
TipTap / ProseMirror editors, post-type verification auto-falls-back to
`document.execCommand("insertText")` when CDP keystrokes get silently
dropped by the editor's internal state machine.

Progress heartbeats fire every 200 chars so the WS request timer resets
on long typings. ~1800-char typings complete reliably without false
timeouts.

### Walking React state

```
fill_input(selector="input[name=email]", value="...")
```
Routes through the React-aware native value setter
(`Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, val)`)
and dispatches input + change events. Handles "Illegal invocation" inside
iframes by reading the prototype from the instance. Pierces closed shadow
roots via content-script tagging.

```
react_call_prop("input[name=justification]", "handleForceSubmitConfirmation", ["my reason"])
```
When a Submit button's onClick opens a modal that never renders because
form-level React state is stale, walk up the fiber and call the bypass
handler directly. Pierces closed shadow roots.

## The CDP click sequence, summarised

Each `click_element` (when `via: "cdp"` or `"auto"`) dispatches:

1. **Bezier approach path** — 6-9 mouseMoved waypoints along a quadratic
   bezier from a randomly-offset start point to the target. Quadratic
   control point is perpendicular to the line, random sign, magnitude
   scaled with path length. Inter-step delay 8-22ms with ease-out.
   Reason: behavioural fingerprinters (LinkedIn, Akamai) score on
   trajectory smoothness and curvature.

2. **Settle-hover micro-tremor** — 3 small jitter moves (±4px) around the
   target with 20-50ms delays. Reason: real human hands have micro-
   tremor; cursors never land perfectly still.

3. **Pre-press settle pause** — 25-65ms idle. Reason: real clicks have a
   small pause between cursor arrival and button press.

4. **Press** — `Input.dispatchMouseEvent type="mousePressed"` with
   `pointerType: "mouse"`, `force: 0.5`, `buttons: 1`. The
   `pointerType="mouse"` parameter makes Chrome fire PointerEvent
   alongside MouseEvent with isPrimary=true and pointerId=1, which is
   what stricter Web Components (Reddit faceplate-*, Twitter composer)
   check in addition to isTrusted.

5. **Press-release timing** — 40-100ms between mousePressed and
   mouseReleased. Real-mouse distribution.

6. **Release** — `type="mouseReleased"` with the same pointer params.
   Fires the `click` event chain that React / Reddit / X handlers listen
   for.

7. **Post-click micro-move** — 30-80ms later, one more mouseMoved within
   ±6px of the click point. Reason: humans don't freeze the cursor at
   the click pixel; they continue with tiny motion. Sites that sample
   post-click cursor stillness fail synthetic clicks here.

Then the **1500ms activity probe** fires (MutationObserver on document
plus focus / URL / value / checked / alert / toast / modal counters). If
zero activity is detected, the click was silently rejected. See the
decision tree above.

## When NOT to reach for the anti-bot tools

If a click works first time on `click_element("Save")` without
`silently_rejected`, don't escalate. The bypass machinery has its own
cost (debugger attach, MAIN-world script injection for the activity
probe). For simple non-protected forms, the default flow is already fast.

## Phase budgets (`phase_timed_out`)

Each phase of a click runs inside `phaseRace` with its own timeout. When a
phase exceeds the budget, the response carries `phase_timed_out:
"<phase_name>"` and the message identifies which phase hung. Phases and
budgets:

| Phase | Budget | Hangs when |
|---|---|---|
| `cdp_click` | 8s | CDP attach contention, hung MAIN-world handler blocking the debugger |
| `activity_probe` | 3.5s | MAIN-world JS blocked by long synchronous handler |
| `react_fiber_click` | 3.5s | page navigated mid-walk, or fiber tree unusually deep |
| `activity_probe_2` | 3.5s | second probe after fiber click hit same condition |

These exist because the WS bridge cap is 30s. Without phase budgets, ANY
hang inside a click dragged the whole call to the cap and the agent
learned nothing about which step actually hung. The phase tag is the
debugging hint.
