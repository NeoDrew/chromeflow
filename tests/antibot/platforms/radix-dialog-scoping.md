# Radix dialog scoping

**Validated:** Yes
**Last verified:** 2026-05-25 on chromeflow 0.9.13
**Auth required:** Depends on host site
**Stability:** Stable

## What this validates

`click_element(in_dialog=true)` and `click_element(dialog_query="...")`
correctly scope candidate matches to a `[role=dialog]` portaled out
to `document.body`. Without scoping, a generic `click_element("Cancel")`
on a page with a Radix confirm dialog open matches a Cancel button
elsewhere on the page.

## Preconditions

- Any page using Radix UI dialogs (shadcn/ui, modern React dashboards).
- A dialog currently open with a "Cancel" or "Confirm" button.

## Procedure

### in_dialog scoping

1. Open a Radix dialog (page-specific trigger).
2. `find_text("Cancel", in_dialog=true)` — verifies the scope
    resolves to the topmost dialog.
3. `click_element("Cancel", in_dialog=true)`.

### dialog_query scoping

1. Open a dialog whose heading or aria-label contains a distinctive
   phrase (e.g. "Delete account").
2. `click_element("Confirm", dialog_query="Delete account")`.

## Expected response fields

- `find_text` returns matches scoped to the dialog only.
- `click_element` succeeds with the dialog as the matching context.
- No `scope_missed: true` (which would indicate no open dialog was
  found).

## Manual verification

The dialog should close after the click (assuming the Cancel /
Confirm handler dismisses it). If a Cancel button elsewhere on the
page fires instead, the scoping has regressed.

## Known regressions

None at 0.9.13.
