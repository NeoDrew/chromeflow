# Reddit composer expand

**Validated:** Yes
**Last verified:** 2026-05-24 on chromeflow 0.9.12
**Auth required:** No
**Stability:** Stable

## What this validates

Chromeflow's CDP click sequence (bezier + settle-hover + PointerEvent
isPrimary=true + post-click jitter) passes Reddit's faceplate-* Web
Component check on the comment composer expand. Vanilla CDP clicks
silently no-op here.

## Preconditions

- Logged out is fine; comment composer is visible on any post.
- A current Reddit post URL.

## Procedure

1. `open_page("https://www.reddit.com/r/<sub>/comments/<id>/<slug>/")`
2. `find_text("Add a comment")` — confirm the placeholder is present.
3. `click_element("Add a comment")` OR
   `click_element(selector="faceplate-textarea-input")`.

## Expected response fields

- `success: true`
- No `silently_rejected: true`
- The composer expands (verified visually OR via
  `wait_for(selector='[contenteditable=true][role="textbox"]')`)

## Manual verification

After the click, the page should show the expanded composer with a
contenteditable text area, "Comment" and "Cancel" buttons visible
below the textarea.

If the click reports success but `wait_for(selector=
'[contenteditable=true][role="textbox"]', timeout_ms=2000)` times
out, the bypass has regressed — re-check `background.ts:445-580`
(`dispatchHumanMouseClick`).

## Known regressions

None at 0.9.12. The pre-0.9.12 version dispatched MouseEvent only;
Reddit added the `event instanceof PointerEvent && event.isPrimary`
check in their faceplate-textarea-input handler and synthetic clicks
stopped opening the composer. The fix was `pointerType: "mouse"` on
all `Input.dispatchMouseEvent` calls so Chrome fires PointerEvent
alongside.
