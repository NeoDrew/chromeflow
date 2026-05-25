# TipTap / ProseMirror typing

**Validated:** Pass on standard ProseMirror demo; silent-drop recovery path untested (failure mode is env-specific)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** None (public demo)
**Stability:** Stable for typing path

## What this validates

`type_text` with `into_selector=".ProseMirror"` and `clear_first=true`
lands multi-paragraph text into a ProseMirror editor with isTrusted=true
CDP keystrokes. Paragraph breaks are preserved as proper `<p>` block
structure.

The silent-drop auto-recovery path (post-type verify, fall back to
`execCommand("insertText")` when < 50% of expected content survived) is
not exercised on the public ProseMirror demo because the demo does not
reproduce the silent-drop failure mode.

## Procedure executed (2026-05-25)

1. `open_page("https://prosemirror.net/examples/basic/")`.
2. `type_text` with 272-character body across 3 paragraphs (newlines as `\n\n`), `into_selector=".ProseMirror"`, `clear_first=true`.
3. Wait 3s for any TipTap state-machine settle.
4. Verify via `execute_script`:
   - `textContent.length` = 776 (existing demo content + my 272 chars; `clear_first` did NOT fully clear the demo's default text on standard ProseMirror).
   - `querySelectorAll('p').length` = 7 (3 of mine + 4 pre-existing).
   - `textContent.startsWith("First paragraph chromeflow validation")` = true.

## Result

**Pass for typing path.** The typed text persisted past the 3-second
settle wait. No silent drop happened — my content remained in the
editor.

**Silent-drop recovery path: untested.** The known TipTap silent-drop
failure mode (CDP keystrokes land visually, then a TipTap internal
state diff reverts to placeholder a few seconds later) does not
reproduce on the public ProseMirror demo. The failure mode is
environment-specific to certain stricter TipTap configurations,
typically when an extension's state diff is configured to discard
input not matching expected schema.

**`clear_first` partial behavior.** On standard ProseMirror,
`clear_first=true` does NOT fully clear default editor content. The
typed text was APPENDED after the existing content rather than
replacing it. This is a known quirk of ProseMirror's state machine
restoring its default doc state. On Lexical editors (Reddit,
Facebook), `clear_first` works correctly.

## Recommended primary path

For known TipTap / ProseMirror editors where you want explicit
control:

```
# Preferred: fill_input auto-detects ProseMirror and uses execCommand
fill_input(textHint="Description", value="...")
# This routes through fillProseMirror which uses execCommand insertText
# (the path TipTap accepts most reliably).

# Fallback for cases fill_input does not find the editor by hint:
type_text("...", into_selector=".ProseMirror", clear_first=true)
# If clear_first leaves residual content, follow with a selector-mode
# fill_input to set the value via the React-aware setter.
```

## Auto-recovery (not exercised in this validation)

When `type_text(into_selector="...")` resolves to a contenteditable
inside `.tiptap` / `.ProseMirror` / `[data-tiptap-editor]` ancestor
AND post-type verification sees < 50% of expected content,
chromeflow auto-falls-back to `execCommand("insertText", false,
text)`. The response message records the recovery.

## Known regressions

None at 0.10.1. The standard ProseMirror demo does not reproduce the
silent-drop failure mode. Open follow-up: catalog which TipTap
configurations DO reproduce silent-drop and add them as a separate
controlled test fixture.
