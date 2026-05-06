## Chromeflow issues from Raccoon session (May 5, 2026)

### click_element on React radio buttons silently no-ops
On the DataAnnotation Raccoon submission form, every "Yes, I'm ready", radio
sub-category, and behavioural dimension checkbox is a React-controlled input.
click_element returns success but the input's `checked` stays false:

  click_element("Yes, I'm ready to move onto the next step")
  // -> "Clicked ..." but radio.checked === false
  click_element("Yes, ...", until_selector="input[name='...']:checked")
  // -> still false after timeout

The pattern that worked reliably:
  - For radios: lbl.click() ONLY when input.checked === false (calling
    lbl.click() on an already-checked input toggled it OFF). So:
      if (!radio.checked) lbl.click();
  - For checkboxes: lbl.click() sometimes failed silently. The reliable
    fallback was the full pointer-event chain dispatched via execute_script:
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
        cb.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true}))
      );
  - For React Select dropdowns (workflow category "Type and search"):
    fill_input typed the value but the dropdown options didn't auto-select.
    Had to find a child element with exact textContent matching the option
    and dispatch mousedown + click on it.

Suggestion: have click_element auto-fall-back to the full pointer-event chain
when the underlying input doesn't update its `checked` state within the
default 600ms wait, OR auto-detect React-controlled radios/checkboxes and use
the prototype-based setter pattern by default.

### Hidden file inputs at y:0 / behind drag-and-drop zones
DA's tarball upload area on Raccoon has a hidden file input (offsetParent is
null, y=0) labelled with a UUID hint. get_form_fields correctly reported it
once revealed, set_file_input(hint="", file_path=...) worked to upload to it.

To replace an already-uploaded file: had to find a span with text "Remove"
near the upload area's y-coordinate and click it (span.click()), then a fresh
file input appeared and the second set_file_input("", path) worked.

Worth documenting in the chromeflow guidance that "to replace an existing
upload, look for a Remove button near the original upload's y, click it, then
re-upload — the same hidden file input is recycled."

### Multi-step forms that progressively reveal fields
DA Raccoon submission has a 6-step wizard. Each step's "Yes I'm ready" radio
reveals the next step's fields. get_form_fields needs to be called AFTER
every radio click — fields below the fold won't appear until the previous
step is checkpointed. The "⚠ N hidden field(s) not shown" hint at the bottom
of get_form_fields output is critical for this — heeded it once and the
upload widget appeared on the next call.

### click_element timeout on a labelled checkbox
click_element("I pressed the button!") timed out after 30 seconds. The same
checkbox responded fine to:
  cb.dispatchEvent(new MouseEvent('pointerdown', ...))
  + the rest of the chain
via execute_script. Unclear why click_element couldn't find/click it — the
label was present and visible. Possibly a custom Headless UI checkbox with
non-standard event handlers.

### Active tab drift mid-session
While running a long-lived self-rescheduling loop on a DA tab, the active
tab silently drifted to drew.cash mid-session (probably the user navigated
on their machine while AFK). execute_script ran on the wrong tab and
returned "Cannot read properties of undefined (reading 'value')" because
the target textarea didn't exist on the new page.

Fix: every loop iteration, list_tabs first and switch_to_tab back to the
target tab if active is something else. A short URL-substring check on the
expected pathname is enough.

Suggestion: chromeflow could expose a "switch_or_fail" primitive that
returns immediately if the active tab matches a query, or switches if not.
Saves a list_tabs round-trip on every loop iteration.

### DA "Last draft saved at" debounces no-op edits
On DataAnnotation, dispatching an input event with the same textarea value
does NOT advance "Last draft saved at". The auto-save logic appears to
diff against the last-saved state and skip the save when the value is
unchanged. To force a save on each tick (e.g. for a keep-alive loop),
genuinely change the value — toggling a trailing space (add when absent,
remove when present) works without altering visible content.

### Self-rescheduling page-keep-alive pattern
For tasks where you need to keep a DA form session alive while AFK, the
pattern that worked over several hours:

  1. ScheduleWakeup with delaySeconds=270 (just under the 5-min prompt-cache
     TTL — 300 is the worst-of-both bucket, 270 stays cached, 1200+ pays the
     miss but is right for genuinely long waits).
  2. Pass a self-contained prompt that re-enters the same task verbatim each
     tick.
  3. The prompt must include a hard stop condition checked from execute_script
     output (e.g. "if UTC date string starts with 2026-05-06, STOP").
     Otherwise the chain runs forever.
  4. Each tick: list_tabs, switch back if needed, execute_script (toggle a
     real value change), reschedule unless stop condition met.

The model self-paces well when the next-tick action is described concretely
in the prompt. Avoid free-form prompts like "keep the page alive" — they
drift.

### "Remove" button + hidden file input recycling
After uploading a file via set_file_input, the input becomes invisible to
get_form_fields and a "Remove" span appears near the upload area. To
replace the upload, find the Remove span by text content and click it
(span.click() works; the parent click handler picks it up). After the
remove, a fresh file input reappears at the same DOM location and a second
set_file_input(hint="", path=...) succeeds.

The full flow: list elements between the upload area's y-coordinates,
look for span.textContent === 'Remove' near the original upload's y, click
it, wait one tick, set_file_input again.
