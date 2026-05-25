# TipTap silent-drop recovery

**Validated:** Yes
**Last verified:** 2026-05-25 on chromeflow 0.9.14
**Auth required:** Depends on host site
**Stability:** Stable

## What this validates

`type_text` post-type verification auto-recovers from TipTap /
ProseMirror's silent-drop failure mode. CDP keystrokes visibly land in
the editor, then TipTap's internal state machine reverts the content
to the placeholder a few seconds later. The fix detects the drop and
re-fills via `document.execCommand("insertText", false, text)` which
TipTap accepts.

## Preconditions

- A page with a TipTap or ProseMirror editor (any site using TipTap
  v2 — many annotation dashboards, modern CMSes, knowledge-base apps).
- The editor's CSS selector (typically `.ProseMirror` or `.tiptap`).

## Procedure

1. `open_page(<site with TipTap editor>)`
2. `find_text("Prompt")` to locate the editor's label, confirms
    it's a contenteditable inside `.ProseMirror`.
3. `type_text("Test body content with at least 400 characters to
    trigger the silent-drop. Padding: ...",
    into_selector=".ProseMirror", clear_first=true)`
4. Wait 2-3s for TipTap's internal state to settle.
5. `execute_script("return document.querySelector('.ProseMirror').textContent.length")`

## Expected response fields

- `type_text` response includes the recovery note when fallback fires:
  `"Typed N characters via individual keystrokes — TipTap/ProseMirror
  silently dropped the typed text (X/Y chars survived), recovered via
  execCommand insertText (Z chars now in editor)"`.
- If the editor accepts CDP keystrokes natively (some TipTap configs do),
  the message is the plain `"Typed N characters..."` with no recovery
  note. Both outcomes are PASS.

## Manual verification

The editor should display the full typed text 2-3 seconds after the
type completes. If the placeholder reappears and no recovery note
fires in the response, the detection threshold (50% of expected
content) is too low for this editor — increase the threshold or
detect via a TipTap-specific class.

## Known regressions

Pre-0.9.14: `type_text` reported success even when TipTap discarded
the text, leaving the editor empty. The user had to manually verify
and retry via `execute_script`. The 0.9.14 fix adds post-type
verification + execCommand fallback.

## Recommended primary path

For TipTap, prefer `fill_input(textHint="Editor label", value="...")`
which auto-detects `.ProseMirror` / `.tiptap` / `[data-tiptap-editor]`
and uses execCommand from the start. `type_text` is the fallback for
when fill_input doesn't find the right editor.
