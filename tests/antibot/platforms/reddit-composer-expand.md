# Reddit composer expand

**Validated:** Pass (with caveat)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** Logged-in account
**Stability:** Stable for state transition; activity probe false-negative

## What this validates

Chromeflow's CDP click sequence on Reddit's `faceplate-textarea-input`
trigger transitions the composer state (submit button becomes visible,
focus jumps to the contenteditable). The faceplate-* Web Component
checks PointerEvent isPrimary=true in addition to isTrusted, which
vanilla Playwright clicks do not pass.

## Procedure executed (2026-05-25)

1. `open_page("https://www.reddit.com/r/programming/comments/<id>/...")`
2. Pre-click state via `execute_script` using the injected `$deep` helper:
   - `#comment-composer-submit-button` exists but `getBoundingClientRect().width === 0`.
   - Visible `faceplate-textarea-input[data-testid="trigger-button"]` is the 2nd instance (1st is the desktop/mobile duplicate).
3. `click_element(selector="faceplate-textarea-input[data-testid='trigger-button']", nth=2)`.
4. Post-click state via `execute_script`:
   - Submit button visibility transitioned `false → true`.
   - `document.activeElement` is `div[contenteditable="true"][role="textbox"][name="body"]`.

## Result

**State transition succeeded.** Reddit's faceplate-* check accepted
the CDP click sequence; the composer expanded.

**Activity-probe false negative.** `click_element` returned
`silently_rejected: true` because the 1500ms probe watches DOM
mutations / focus / URL / value / checked / alert / toast / modal —
but composer expansion toggles CSS-driven visibility on an existing
DOM node, which the probe does not catch. The response's `→ Focused:`
line did show focus moving into the textbox, but the probe didn't
score that as activity for this target shape.

**Implication for callers:** when clicking faceplate-* triggers
(composer expand, comment-action expand, etc.), do not trust
`silently_rejected` alone. Verify post-state via `execute_script`.

## Recommended primary path

```
click_element(selector="faceplate-textarea-input[data-testid='trigger-button']", nth=2)
# Ignore silently_rejected if returned
execute_script(`
  return {
    submit_visible: (function(){var b=$deep('#comment-composer-submit-button'); return b?b.getBoundingClientRect().width>0:false})(),
    focused_ce: document.activeElement?.isContentEditable
  };
`)
# Both true ⇒ composer expanded successfully.
```

## Open follow-up

The activity probe could be tuned to weight `focused_after` (any
non-body focused element after a click) as activity. Tracked as a
known false-negative source.
