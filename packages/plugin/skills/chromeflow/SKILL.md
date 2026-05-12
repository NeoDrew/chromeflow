---
name: chromeflow
description: Use when working on a task that needs a real browser — setting up third-party services (Stripe, Supabase, SendGrid, Vercel, OAuth), retrieving API keys or secrets to put in .env, configuring webhooks, filling forms in a web UI, navigating dashboards, or any browser-based step blocking code work. Also use when the user asks how to use chromeflow, what chromeflow tools exist, or how to drive a specific site (eBay, DataAnnotation, Notion, Stripe, etc.). Covers chromeflow MCP tool usage patterns, form filling on React / contenteditable / CodeMirror / Monaco / Stripe inputs, error handling, multi-tab flows, credential capture, and visual handoff to the user for 2FA / passwords / payments.
---

# Chromeflow — Claude Instructions

## What chromeflow is
Chromeflow is a browser guidance tool. When a task requires the user to interact with a
website (create accounts, set up billing, retrieve API keys, configure third-party services),
use chromeflow to guide them through it visually instead of giving text instructions.

## When to use chromeflow (be proactive)
Use chromeflow automatically whenever a task requires:
- Creating or configuring a third-party account (Stripe, SendGrid, Supabase, Vercel, etc.)
- Retrieving API keys, secrets, or credentials to place in `.env`
- Setting up pricing tiers, webhooks, or service configuration in a web UI
- Any browser-based step that is blocking code work

Do NOT ask "should I open the browser?" — just do it. The user expects seamless handoff.

**Never end a response with a "you still need to" list of browser tasks.** If code changes are done and browser steps remain (e.g. creating a Stripe product, adding an env var), continue immediately with chromeflow — don't hand them back to the user.

## HARD RULES — never break these

1. **Never use Bash as a fallback for browser tasks.** If `click_element` fails, use
   `scroll_to_element` then retry, or use `highlight_region` to show the user. Never use
   `osascript`, `applescript`, or any shell command to control the browser.

2. **Never use `take_screenshot` to read page content.** After `click_element`, after
   navigation — always call `get_page_text` (or `find_text` if you only need to check for a
   specific phrase). `get_page_text` returns up to 10,000 characters; if truncated it tells
   you the next `startIndex` to paginate. Screenshots are only for locating an element's
   pixel position when DOM queries have already failed. Never take more than 1–2 screenshots
   in a row.

3. **Use `wait_for(selector=…)` to wait for async page changes** (build completion, modals,
   toasts). Never poll with repeated `take_screenshot` calls.

## Guided flow pattern

```
1. open_page(url)                            — navigate to the right page (add new_tab=true to keep current tab open; add background=true to keep the current tab focused if its form auto-saves on blur)
2. For each step:
   a. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        click_element("Save", until_selector=".success-toast")  — when synthetic clicks may silently no-op on a React-heavy site, require an observable post-click condition (or until_url_contains / until_text_contains)
        fill_form([{label, value}, ...], exact=true)  — fill multiple fields in one call; pass exact=true on dense forms to refuse fuzzy text-walk matches
        fill_input(textHint="Product name", value="Pro")   — fill a single field by label hint (works on React, CodeMirror, and contenteditable). Always check the response — it names the matched element so you can spot wrong-field matches
        fill_input(textHint="Rate", value="5", exact=true) — exact-match mode for short generic labels that may collide with neighbouring fields
        fill_input(selector="input[name=email]", value="x@y") — selector-mode (replaces the old react_set_input). Bypasses fuzzy matching and uses the React-aware native value-setter so React's onChange picks up the change. Supports `frame` for same-origin iframe inputs.
        type_text("hello world")            — type via trusted keyboard events (use when fill_input fails isTrusted checks)
        type_text("description", frame="iframe.se-rte")  — type into a same-origin iframe's contenteditable (eBay description editor pattern)
        set_file_input("Upload", "/abs/path/to/file.zip") — upload a file; returns success only after the upload is observably committed (no manual sleep needed between rapid uploads)
        clear_overlays()                    — call this immediately after fill_input/fill_form succeeds
        scroll_to_element("label text")     — jump directly to a known field by CSS selector or visible text; use execute_script("window.scrollBy(0, 400)") only for blind incremental scrolls
   b. Check results with text, not vision:
        get_page_text()                     — read errors/status after actions
        wait_for(selector=".success")       — wait for a CSS selector to appear (replaces wait_for_selector)
        wait_for(text="Saved")              — wait for a text substring to appear (replaces wait_for_text)
        wait_for(change_in=".toast")        — wait for an existing element's subtree to mutate, then read its text (replaces wait_for_change)
        execute_script("return await fetch('/api/x').then(r => r.json())")  — top-level await is supported, no window.__variable + sleep dance needed
   c. When an element can't be found or clicked:
        scroll_to_element("label text") and retry — always try this first
        get_elements()                      — get EXACT DOM coords when needed
        highlight_region(selector,msg)      — highlight by CSS selector (preferred; scrolls element into view automatically)
        highlight_region(x,y,w,h,msg)       — highlight by coords only if no selector available (coords go stale on scroll)
        [absolute last resort] take_screenshot() — only if you genuinely can't identify the element from DOM
   d. Pause for the user when needed:
        find_and_highlight(text, msg)        — show the user what to do
        wait_for_click()                    — wait for user interaction
        [after fill_input] clear_overlays() — always clear after filling
3. clear_overlays()                          — clean up when done
```

**Default to automation.** Only pause for human input when the step genuinely requires
personal data or a human decision.

## What to do automatically vs pause for the user

**Claude acts directly** (`click_element` / `fill_input`):
- Any button: Save, Continue, Create, Add, Confirm, Next, Submit, Update
- Product names, descriptions, feature lists
- Prices and amounts specified in the task
- URLs, redirect URIs, webhook endpoints
- Selecting billing period, currency, or other known options
- Dismissing cookie banners, cookie dialogs, "not now" prompts

**Pause for the user** (`find_and_highlight` + `wait_for_click`):
- Email address / username / login
- Password or passphrase
- Payment method / billing / card details
- Phone number / 2FA / OTP codes
- Any legal consent the user must personally accept
- Choices that depend on user preference Claude wasn't told

## Capturing credentials
After a secret key or API key is revealed:
1. `read_element(hint)` — capture the value
2. `write_to_env(KEY_NAME, value, envPath)` — write to `.env`
3. Tell the user what was written

Use the absolute path for `envPath` — it's the Claude Code working directory + `/.env`.

## Privileged context — `fetch_url`, `download_file`, `read_attachment`

`execute_script` runs in **page context**: it can touch the DOM but is subject to the page's `Content-Security-Policy` (specifically `connect-src`, which routinely blocks `fetch()` against authenticated APIs on sites like Canvas, banking dashboards, internal portals).

For authenticated network access, use the **privileged-context** tools — they run in the extension's background service worker with full host_permissions, automatically include the user's Chrome cookies, and bypass page CSP entirely:

- `fetch_url(url, method?, headers?, body?, binary?)` — generic HTTP request, returns `{status, headers, body_text or body_base64, truncated, total_bytes}`. Use for AJAX endpoints, JSON APIs, anything where you need a clean response object. Pass `binary: true` for non-text bodies (PDFs, images, zips).
- `download_file(url, filename?)` — Chrome's authenticated download flow, returns the absolute path the file landed at. Use when you need the bytes saved to disk for another tool to read (or to hand the path to the user).
- `read_attachment(url, format?, max_chars?)` — privileged fetch + format-aware text extraction in one call. Supports docx (via in-extension ZIP extraction, no local CLI), txt, md, csv, json, xml, html. PDF returns a structured error pointing you at `download_file` + your local `pdftotext`/`textutil` (PDF native support is planned for v0.9.4).

**Mental model**: page context for DOM manipulation, privileged context for network access. If `execute_script("...await fetch(...)...")` returns "Failed to fetch" or a `Content-Security-Policy` error, switch to `fetch_url` (or `read_attachment` if you just want the text).

## Discoverability — `list_frames`

Before reaching into an iframe with `find_text({frame: "selector"})` or other frame-targeted tools, call `list_frames()` to see what's actually on the page. Each result includes:
- `selector` — drop this directly into another tool's `frame` parameter
- `origin` — the iframe's origin (parsed from `src`)
- `accessible` — `true` for same-origin frames (`find_text` etc. work), `false` for cross-origin (use `read_attachment(src)` or `take_screenshot` instead)

This is how you avoid "frame not accessible" errors after the fact. Top-level frames only — nested cross-origin trees aren't enumerated.

To capture and share a screenshot (e.g. for uploading to a form or pasting into a chat),
use `take_screenshot(copy_to_clipboard=true, save_to="downloads")` — saves a PNG to ~/Downloads
and copies it to the clipboard. The defaults (`copy_to_clipboard=false, save_to="none"`) return
the image to Claude only.

## Working with complex forms
- Before filling a large or unfamiliar form, call `get_form_fields()` to get a full inventory
  of every field (type, label, current value, vertical position, and section heading). Use
  `get_elements()` when you need pixel coordinates of visible elements; use `get_form_fields()`
  when you need to understand the full structure of a form including fields below the fold.
  If you only need one or two specific fields, use `find_input("hint")` instead — targeted
  lookup is much cheaper than the full inventory and returns labels you can pipe straight
  into `fill_input`.
- `get_form_fields()` includes `[type=file]` fields even when they are visually hidden behind
  custom drag-and-drop zones. Use `set_file_input(hint, filePath)` to upload a file — provide
  the label/hint text and the absolute path to the file on disk.
- For forms with multiple fields, use `fill_form([{label, value}, ...])` to fill them all
  in a single call. It returns a per-field success/failure report so you can immediately see
  which fields weren't found. Use `fill_input` only for a single field.
- `fill_input` and `fill_form` work on React-controlled inputs, contenteditable (Stripe,
  Notion), and **CodeMirror 6 editors** — auto-detected. After filling, the value is read
  back and a warning is shown if React did not accept it.
- **Monaco editors** (VS Code-style code editors on DataAnnotation, etc.) appear in
  `get_form_fields()` as type "monaco". They cannot be filled via `fill_input` — use
  `execute_script` with the Monaco API instead:
  ```js
  // Read content from the first Monaco model
  monaco.editor.getModels()[0].getValue()
  // Write content to the first Monaco model
  monaco.editor.getModels()[0].setValue('new content here')
  ```
- `set_file_input` accepts CSS selectors as the hint (e.g. `#import-problem-file`,
  `.upload-input`) in addition to label text. Use selectors when file inputs are hidden
  behind custom UIs and have no visible label.
- **Replacing an already-uploaded file**: after `set_file_input` succeeds, the input
  becomes invisible and a "Remove" span/button typically appears near the upload area.
  To replace the file: `click_element("Remove", nth=N)` (the right `nth` if there are
  multiple), then call `set_file_input(hint, newPath)` again — the same hidden input is
  recycled and accepts the new file. Verify with `get_form_fields()` between the two
  steps so you're sure the input has reappeared.
- **Forcing auto-save on idempotent text edits** (e.g. keep-alive loop on an
  auto-saving DataAnnotation form): some auto-save logic diffs against the last-saved
  value and skips no-op writes. To force a real save on each tick without changing
  visible content, toggle a trailing space — add when absent, remove when present.
  `fill_input` value comparison handles both directions transparently. **Caveat:**
  long-running heartbeats that toggle whitespace on a real form field have been
  observed to drift other fields' React state out of sync (the re-render reset a
  separate radio's checked state to the form-level store value). For heartbeat
  loops, prefer writing to `localStorage` via `execute_script` instead — the
  auto-save handler usually fires on any input event, but `localStorage` writes
  don't perturb React state at all.
- After any radio/checkbox click that reveals new fields, call `get_form_fields()` again —
  the inventory will include the new fields and warn if more hidden ones still exist.
- If a form has collapsible sections, expand them all before calling `get_form_fields()` so
  the field list is complete. Use the `[under: "section name"]` context in each field's entry
  to identify fields by section rather than by index — indices shift when sections expand.
- Prefer `scroll_to_element("label text or #selector")` over `scroll_page` whenever you know
  which field or section you need — it scrolls precisely and confirms the matched element.
- For multi-session tasks (long forms that may exceed context), call `save_page_state()` as a
  checkpoint. A future session can call `restore_page_state()` to reload all field values.

## Discovery — find without dumping the whole page

Three lightweight tools save tokens vs `get_page_text` / `get_form_fields` when you don't need the full content:

- `find_text("Saved successfully")` — grep the DOM. Returns surrounding context, a CSS selector, and a `clickable` flag for each match. Use this instead of `get_page_text` when you're checking whether a specific phrase is present, or to locate a button by its visible text. If `clickable=true`, pipe the matched text straight into `click_element`.
- `find_input("Email")` — fuzzy form-field lookup, top-N. Returns labels you can pipe straight into `fill_input(label, value)` — both tools share the same match ranks (`aria-eq` → `placeholder-eq` → `label-text-eq` → `name-eq` → `id-eq` → `*-includes` → `fuzzy-text-walk`). Cheaper than `get_form_fields` when you just need a couple of specific fields. Pass `type_filter="email"` to restrict to a specific input type.
- `wait_for_text("Saved")` — wait for text to appear without knowing the selector ahead of time. Complements `wait_for_selector` for the case where you only know the post-action message.

All three pierce open shadow roots and accept `frame="iframe.selector"` for same-origin iframes. Pass `regex=true` on `find_text` / `wait_for_text` for case-insensitive regex matching. Pass `exact=true` on `find_input` to refuse fuzzy text-walk matches.

```
find_text("Build complete", scope_selector=".log-output")     — only check the build log section
find_input("Card number", type_filter="text")                  — find Stripe's card-number field
wait_for_text("Deploy successful", timeout_ms=30000)           — wait up to 30s after clicking Deploy
```

Reach for these BEFORE `get_page_text` / `get_form_fields` when the goal is "is X here?" or "where is X?". Reserve `get_page_text` for reading actual content, and `get_form_fields` for understanding a whole form's structure.

## Working with multiple tabs
- Before opening a new tab, call `list_tabs()` to check if the target URL is already open —
  use `switch_to_tab` to return to it instead of opening a duplicate.
- `open_page(url, new_tab=true)` opens a URL without losing the current tab. Use sparingly —
  prefer switching to an existing tab over opening a new one.
- `switch_to_tab("1")` switches by tab number; `switch_to_tab("form")` matches by URL or title substring.
- Before navigating away from a partially-filled form, call `save_page_state()` so the form
  can be restored if the tab reloads or the page loses its state on return.
- **In long-lived self-rescheduling loops**, the active tab can silently drift mid-session
  (the user navigates manually while AFK, or another tab steals focus). At the start of
  every loop iteration, call `list_tabs` and verify the active tab's URL matches your
  expected target — if not, `switch_to_tab(<URL or title substring>)` before running
  `execute_script` or any other tab-scoped tool. Without this guard, scripts run on the
  wrong tab and fail with confusing "undefined" errors that look like page bugs.

## Error handling

**After any action**, confirm with `get_page_text()` or `wait_for_selector` — never take a
screenshot to check what happened.

**`click_element` not found:**
1. `scroll_page("down")` then retry `click_element`
2. `get_elements()` to get exact coords → `highlight_region(x,y,w,h,msg)`
3. `take_screenshot()` only if you still can't identify the element from DOM queries

**Multiple elements with the same label** (e.g. many "Remove" buttons):
`click_element("Remove", nth=3)` — use `nth` (1-based) to target the specific one by order top-to-bottom. Check `get_form_fields` or `get_page_text` first to determine which index corresponds to the right section.

**`fill_input` matched the wrong field** (always read the response — it names the matched element):
- If you wanted "Ad rate" and got back `<input name="title">`, the fuzzy text walker latched onto a neighbour. Retry with `exact=true` and a more specific hint, or use `react_set_input(selector, value)` with a precise CSS selector.
- The match-strength is reported as `aria-eq`, `placeholder-eq`, `name-eq`, `id-eq`, `label-text-eq`, or fuzzier kinds. Anything labeled `fuzzy-text-walk` or `*-includes` is the lowest-confidence kind — verify the matched element really was what you wanted.

**`fill_input` not found or rejected by the page:**
1. `click_element(hint)` to focus the field, then retry `fill_input`
2. `react_set_input("input[name=...]", value)` — uses the input's own prototype to set the value, dispatches input/change. Handles the "Illegal invocation" iframe gotcha and the prototype-from-instance ceremony for you.
3. If the site rejects programmatic input (isTrusted check, shadow DOM, custom editors):
   - `click_element(hint)` to focus the field
   - `execute_script("document.execCommand('selectAll')")` to clear existing content
   - `type_text("new value")` — uses CDP trusted keyboard events that pass isTrusted checks
4. For iframe-hosted contenteditable rich-text editors (eBay's description, etc.):
   - `type_text("body content", frame="iframe.selector")` — same-origin only. Focuses the iframe's contenteditable, types via CDP, dispatches input/change in the iframe's context so React reads the new value.
5. `find_and_highlight(hint, "Click here — I'll fill it in")` (no `valueToType`) then
   `wait_for_click()` — the user's click focuses the field and `fill_input`'s active-element
   fallback fills it automatically
6. Call `clear_overlays()` after `fill_input` succeeds
7. Only use `valueToType` when the user must personally type the value (password, personal data)

**`click_element` returned success but the page didn't change** (common on React-heavy sites where synthetic clicks no-op):
Pass an `until_*` clause to require an observable post-click condition. `click_element` returns success=false if the condition isn't met within `until_timeout_ms` (default 5000):
```
click_element("List with displayed fees", until_url_contains="/listing-published")
click_element("Save", until_selector=".success-toast")
click_element("Confirm", until_text_contains="Order placed")
```
If success=false: try `react_set_input` to fire the click via the page's own React handler, or use `execute_script("document.querySelector(...).click()")` directly.

**Spotting silent redirects**: every `click_element` response now includes `before_url`, `after_url`, and `navigated`. The agent-facing text appends a `→ Navigated: <url>` line whenever `before_url !== after_url`. This catches the "I clicked Assessment but the page bounced me to course home" case without needing a separate `list_tabs` round-trip. If the URL didn't change but the click is supposed to navigate, that's a sign the click never registered.

**0×0 hidden elements are refused immediately**: if the matched element has `width: 0; height: 0` (display:none, off-DOM, or a render-time race), `click_element` returns success=false with a clear "refusing to click" message instead of attempting the click and waiting for an `until_*` clause to time out. Use `wait_for_selector` with a state-specific selector that only matches the visible state, or `scroll_to_element` to bring it into view first.

**`switch_to_tab` accepts `tab` as a synonym for `query`**: `switch_to_tab({tab: 1})`, `switch_to_tab({tab: "github"})`, and `switch_to_tab({query: "github"})` all work. Use whichever reads more naturally — `tab` for indices, `query` for substring matches.

**`click_element` timed out (the WS request, not until-polling)**: the message will say "the click MAY have already fired". On a busy React reconciliation, the click does land but the response read can outrun the 30s WS timeout. Don't blindly retry — re-clicking can toggle React radios OFF or fire a duplicate submit. Verify with `get_page_text`, `wait_for_selector`, or `wait_for_text` first; only retry if the page state confirms the click never took effect.

**Modal never opens / submit handler swallowed by stale validation state**: when a Submit button's onClick opens a modal that never renders (e.g. validation thinks the form is incomplete because the form-level React state is stale, but DOM inputs look filled), use `react_call_prop` to call the bypass handler directly:
```
react_call_prop("input[name=justification]", "handleForceSubmitConfirmation", ["my justification text"])
```
Walks up the React fiber from the selector, finds the nearest component with a prop function of the given name, and calls it with the JSON-serializable args. Returns the component name and stringified return value so you can verify the right handler ran.

**`set_file_input` not committing on rapid back-to-back uploads:**
The default 3000ms commit-wait is enough for most uploaders. For batch photo uploads on slow react file handlers (eBay's 25-photo carousel, Stripe Connect document upload), increase `wait_ms` to 6000–8000 OR pass `verify_selector` pointing at the thumbnail/Remove-button that should appear:
```
set_file_input("Photos", "/path/1.jpg", verify_selector=".photo-thumbnail:nth-of-type(1)")
set_file_input("Photos", "/path/2.jpg", verify_selector=".photo-thumbnail:nth-of-type(2)")
```
The page-level file count is reported in the response — use it to spot uploaders that consume-and-reset the input vs uploaders that keep the file there.

**Waiting for async results** (build, save, deploy): `wait_for_selector(selector, timeout)` — never poll with screenshots. `wait_for_selector` pierces open shadow roots, so a selector inside a web component (Outlier task UI, Lit/Stencil widget) matches without ceremony.

**Waiting for a shadow host's tree to attach** (e.g. SPA route flips where `<my-host>` appears 10s before its shadow content hydrates, and `wait_for_selector("my-host")` resolves while `host.shadowRoot` is still null): pass `shadow_root=true`. The wait then requires the matched element's `.shadowRoot` to be non-null, not just for the host element to exist.
```
wait_for_selector("iframe", shadow_root=true)   — wait until the iframe both exists AND has an attached shadowRoot
```

**Waiting for an existing region to update** (e.g. click Save, then get the confirmation toast; send a chat message, then get the reply): `wait_for_change(selector)` uses a MutationObserver on the element's subtree and returns its new text content as soon as the mutation settles. Prefer this over `wait_for_selector` + `get_page_text` when the element already exists and you just need its next state — one call instead of two, no polling.

**Pre-filling `prompt()` and `confirm()` dialogs**: When a page action will trigger a JS
dialog (e.g. "Save As" calling `prompt()`), call `set_dialog_response` BEFORE the action:
```
set_dialog_response(type="prompt", value="my-filename")   — next prompt() returns "my-filename"
set_dialog_response(type="confirm", value="true")          — next confirm() returns true
```
Then trigger the action (e.g. `click_element("Save As")`). The response is consumed once.

**React Select / custom styled dropdowns** (e.g. "Select..." components on DataAnnotation):
`click_element` and `fill_input` do NOT work on these — they intercept native events. The cleanest path is `react_set_input` (which handles the prototype-from-instance setter for you) followed by a click on the filtered option:

```
1. react_set_input('input[id*="react-select-3-input"]', "Target Option")
   — sets the hidden combobox input via its own prototype's value-setter and dispatches the input event React's onChange listens for
2. (300ms pause for the dropdown to filter)
3. execute_script("document.querySelector('[id*=\"react-select-3-option-0\"]').click()")
4. Verify the control shows the selected value:
   execute_script("document.querySelector('[class*=\"singleValue\"]').textContent.trim()")
```

If you must hand-roll this with `execute_script` (older React-Select versions, weird custom wrappers), prefer reading the prototype FROM the instance to avoid "Illegal invocation" inside iframes:

```js
var input = document.querySelector('input[id*="react-select-3-input"]');
input.focus();
var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
setter.call(input, 'Target Option');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

Fallback if the combobox approach doesn't work (older React Select versions):
```js
var controls = document.querySelectorAll('[class*="control"]');
controls[N].click();
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
  if (allEls[i].textContent.trim() === 'Target Option' && allEls[i].children.length === 0) {
    allEls[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    allEls[i].click();
    break;
  }
}
```

**Page text with large embedded content** (e.g. uploaded log files previewed inline): full-page `get_page_text()` pagination becomes unwieldy. Scope to a specific section instead:
```
get_page_text(selector=".section-3")   — scope to a CSS selector
get_page_text(selector="#upload-form") — scope to an id
```
Use `execute_script("document.querySelectorAll('section').length")` to find structural selectors first.

**Page content rendered as images** (e.g. qualification "Examples" tabs that show PNG screenshots
instead of DOM text): `get_page_text()` returns nothing useful. Zoom out and screenshot instead:

```js
// Shrink to fit wide content, then screenshot
document.body.style.zoom = '0.4';
// use take_screenshot() to read it
// restore afterward:
document.body.style.zoom = '1';
```

**Downloads via `execute_script`**: Creating a Blob URL and clicking an anchor via
`execute_script` sometimes fails due to CSP or timing. If a download doesn't trigger:
1. Retry the exact same `execute_script` call
2. If still failing, use `find_and_highlight` to show the user a download button to click manually

**React-controlled native radios/checkboxes that don't update `checked`**: `click_element`
auto-handles this for native `<input type=radio>` and `<input type=checkbox>` inputs
(including labels that wrap or `for=` reference them). The flow:
- If a radio is already `checked=true`, `click_element` skips the click — re-clicking can
  toggle it OFF on React forms whose `onChange` interprets the click as a deselect. The
  response says `"X — radio already checked, click skipped"`.
- If the standard click fires but the input's `checked` state didn't change as expected
  (radio still unchecked, or checkbox didn't toggle), `click_element` automatically
  dispatches the full pointer-event chain (`pointerdown → mousedown → pointerup → mouseup
  → click`) on the input. The response says `"now checked (after pointer-chain fallback)"`.

You only need to drop into `execute_script` for the no-native-input case below.

**Shadow DOM `[role=radio]` / role-only custom radios silently no-op**: On sites like
Outlier where the radio is a `[role=radio]` div with no underlying `<input>`,
`click_element`'s native-input fallback can't help — the click target has no `.checked`
property to verify. Two things must be true: (a) the element must be scrolled into view
FIRST (`scrollIntoView({block:'center'})`), and (b) the full pointer-event chain must
fire — not just `click()`:
```js
['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t =>
  el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true}))
);
```
After scroll, re-query the radio list — its length may change as more content becomes
visible. Then verify `aria-checked === "true"` before moving on.

**Visibility-detection overlays** (e.g. Multimango's "Content Hidden" black overlay):
Some sites render a full-screen overlay when the tab loses focus, triggered by
`document.visibilityState` / `document.hidden`. Chromeflow tab-switching triggers it.
Workaround — remove the overlay and patch the APIs:
```js
document.querySelectorAll('[style*="z-index: 99999"]').forEach(el => el.remove());
Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
['visibilitychange','blur'].forEach(t =>
  document.addEventListener(t, e => e.stopImmediatePropagation(), true)
);
```
Re-apply after every navigation.

**Never use Bash to work around a stuck browser interaction.**

## Recipes for tools removed in 0.9.4

The following tools were demoted from the surface to keep the tool list lean. The
underlying mechanics still work — they're just inlined into `execute_script` recipes now.

**`read_element` → `find_text` + read context, or `execute_script`**
```js
// Capture an API key shown after a label
const el = [...document.querySelectorAll('*')].find(n => n.textContent?.startsWith('sk-'));
return el?.textContent.trim();
```
Or use `find_text("sk-", max: 1)` and read the matched context.

**`scroll_page` → `scroll_to_element` or `execute_script`**
```
scroll_to_element("Section heading text")     // by visible text
scroll_to_element("#submit-btn")              // by CSS selector
execute_script("window.scrollBy(0, 400)")     // blind incremental scroll (rarely needed)
```

**`get_elements` → `find_text` for targeted lookup**
```
find_text("Save", max: 3)                     // finds the button, returns selector + coords
```
`get_elements` was a 3K-char dump every call; `find_text` returns 200–500 chars for the same lookup.

**`react_call_prop` → `execute_script` walking React fibers directly**
```js
// Walk up from a known element, find a prop function, call it
function findFiberProp(el, propName) {
  let node = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  let fiber = el[node];
  while (fiber) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props && typeof props[propName] === 'function') return props[propName];
    fiber = fiber.return;
  }
  return null;
}
const fn = findFiberProp(document.querySelector('input[name=justification]'), 'handleForceSubmitConfirmation');
return await fn('my justification');
```

**`save_page_state` / `restore_page_state` → `execute_script` + a local JSON file**
```js
// Save
const fields = [...document.querySelectorAll('input,textarea,select')].map(f => ({
  selector: `[name="${f.name}"]`, type: f.type, value: f.value, checked: f.checked,
}));
return JSON.stringify(fields);   // write the returned string to a temp file via your tooling
```
Restore reverses the process: read JSON, set values, dispatch `input`/`change` events.

**`set_dialog_response` → `execute_script` override**
```js
// Before triggering the action that shows a prompt():
window.prompt = () => 'my response';
window.confirm = () => true;
// Then trigger the action.
```

