## Chromeflow issues from Whitebeard session (May 3-4, 2026)

### Shadow root rehydrate latency after "Continue tasking"
After clicking the "Continue tasking" button on Outlier, the iframe + shadow
root takes 10-15 seconds to attach. wait_for_selector("iframe") resolves while
the shadow root is still null. findShadowRoot() returns nothing. The page text
returns "Timesheet for Aether" or empty body during this window, which can be
confusingly similar to the "queue empty" indicator.

Symptoms observed multiple times this session:
- wait_for_selector("iframe") returns "found" immediately after Continue tasking
- subsequent execute_script with findShadowRoot() returns null
- a second wait_for_selector("iframe") + findShadowRoot retry succeeds

Workaround: After clicking Continue tasking, do at least one additional
wait_for_selector("iframe") (or a tight retry loop) before assuming the queue
is empty. If the body shows "Timesheet for Aether" with a session log, the
project assignment has changed and the queue is genuinely dry.

Suggestion: Have wait_for_selector("iframe") also wait for at least one
shadowRoot attachment before resolving, or expose a wait_for_shadow_root
primitive.

### Multiple textareas: sr.querySelector("textarea") picks the wrong one for CS tasks
On Whitebeard CS tasks, the response-selection step renders a Monaco code
editor PREVIEW alongside the actual ranking-justification textarea. There are
3 textareas in the shadow DOM at this point:
  - tas[0]: Monaco-internal hidden textarea (parent class contains "overflow-guard")
  - tas[1]: small "10-char Monaco" textarea
  - tas[2]: the real justification textarea (parent class === "relative")

A naive sr.querySelector("textarea") returns tas[0], which is Monaco's hidden
input. Writing to it via execute_script + native setter does NOT update the
form state — Monaco does not route events from this textarea back into its
view model, AND the form continues to report "This field is required" because
the actual justification (tas[2]) stays empty.

This caused a real failed submit on the LuoTianyi Codeforces task: I wrote
the justification to tas[0], saw "Next" was enabled, clicked through, then
on the next step the page came back with "This field is required" pointing
at the real justification.

Workaround: Always identify the justification textarea by parent class:
```js
var taJ = null;
for (var i = 0; i < tas.length; i++) {
  if (tas[i].parentElement?.className === "relative") { taJ = tas[i]; break; }
}
```

Suggestion: fill_input that targets a textarea by surrounding label text
("Ranking Justification") would be safer than positional textarea indexing.
Currently fill_input cannot reach into shadow DOM at all, so this is also
a "fill_input shadow DOM piercing" feature request.

### ScheduleWakeup fires 30-90s late, real cost on tight 25-minute window
Outlier's Whitebeard task has a hard 25-minute "active" window after which
pay drops from $37.60/hr to $18.70/hr. Submissions need to land before 25:00
to keep the full rate. ScheduleWakeup with delaySeconds=1200 from a 4-minute
timer should fire at 24:00, but in practice fires at 24:30-25:35 depending on
load. Lost ~35s on one task at exceeded rate.

Pattern observed:
  - delaySeconds=1200 from 4m  →  fired at 25m 35s (35s late, exceeded)
  - delaySeconds=1080 from 4m  →  fired at 24m 51s (within window)
  - delaySeconds=980 from 6m   →  fired at 22m 35s (early but safe)

Workaround: target wake at 22:00 not 23:00 to absorb the 30-90s wakeup
latency. delaySeconds = (22 - current_minutes) * 60, never (23 - x) * 60.

Suggestion: ScheduleWakeup could accept an `at` parameter (absolute time)
or a `before_deadline` hint that triggers the wake-up the moment the host
loop is free instead of queueing for the next tick.

### "Continue tasking" button on success page is plain DOM, not shadow
After a Whitebeard task is submitted, the success page ("You earned $X.XX")
is rendered in the main document, NOT inside the shadow root. The shadow root
disappears entirely. Accessing it via findShadowRoot() returns null. The
"Continue tasking" button is reachable via document.querySelectorAll("button")
in the regular way, no shadow DOM piercing needed.

This is consistent across the session but worth noting because the rest of
the Outlier flow lives in shadow DOM, so it is easy to default to "use the
shadow root" everywhere.

### CS task responses can be 4-8KB markdown — markdown extractor needed early
Whitebeard CS tasks regularly serve responses in the 4000-8000 char range
(competitive programming with full cpp implementations). The React fiber
markdown extraction trick (already documented for math LaTeX) is also the
only reliable way to get the full text — innerText drops indentation and
sometimes truncates inside code fences. Always use the markdown extraction
loop, not get_page_text, for CS responses.

This is more a workflow note than a chromeflow bug, but worth documenting.
