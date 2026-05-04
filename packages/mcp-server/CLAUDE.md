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
   `scroll_page` then retry, or use `highlight_region` to show the user. Never use
   `osascript`, `applescript`, or any shell command to control the browser.

2. **Never use `take_screenshot` to read page content.** After `scroll_page`, after
   `click_element`, after navigation — always call `get_page_text`, not `take_screenshot`.
   `get_page_text` returns up to 10,000 characters; if truncated it tells you the next
   `startIndex` to paginate. Screenshots are only for locating an element's pixel position
   when DOM queries have already failed. Never take more than 1–2 screenshots in a row.

3. **Use `wait_for_selector` to wait for async page changes** (build completion, modals,
   toasts). Never poll with repeated `take_screenshot` calls.

## Guided flow pattern

```
1. open_page(url)                            — navigate to the right page (add new_tab=true to keep current tab open; add background=true to keep the current tab focused if its form auto-saves on blur)
2. For each step:
   a. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        click_element("Save", until_selector=".success-toast")  — when synthetic clicks may silently no-op on a React-heavy site, require an observable post-click condition (or until_url_contains / until_text_contains)
        get_page_text() or wait_for_selector(".success") — confirm after click without an until-clause; click_element returns after 600ms regardless of outcome unless until_* was used
        fill_form([{label, value}, ...], exact=true)  — fill multiple fields in one call; pass exact=true on dense forms to refuse fuzzy text-walk matches
        fill_input("Product name", "Pro")   — fill a single field (works on React, CodeMirror, and contenteditable). Always check the response — it names the matched element so you can spot wrong-field matches
        fill_input("Rate", "5", exact=true) — exact-match mode for short generic labels that may collide with neighbouring fields
        react_set_input("input[name=email]", "x@y") — for inputs where fill_input fails (or for iframe-hosted inputs via frame=...) — handles the prototype-from-instance gotcha automatically
        type_text("hello world")            — type via trusted keyboard events (use when fill_input fails isTrusted checks)
        type_text("description", frame="iframe.se-rte")  — type into a same-origin iframe's contenteditable (eBay description editor pattern)
        set_file_input("Upload", "/abs/path/to/file.zip") — upload a file; returns success only after the upload is observably committed (no manual sleep needed between rapid uploads)
        clear_overlays()                    — call this immediately after fill_input/fill_form succeeds
        scroll_to_element("label text")     — jump directly to a known field; prefer this over scroll_page when the target is known
        scroll_page("down")                 — reveal off-screen content when target location is unknown
   b. Check results with text, not vision:
        get_page_text()                     — read errors/status after actions
        wait_for_selector(".success")       — wait for a new element to appear
        wait_for_change(".toast")          — wait for an existing element's content to mutate, then read it (uses MutationObserver, cheaper than polling)
        execute_script("return await fetch('/api/x').then(r => r.json())")  — top-level await is supported, no window.__variable + sleep dance needed
   c. When an element can't be found or clicked:
        scroll_page("down") and retry      — always try this first
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

To capture and share a screenshot (e.g. for uploading to a form or pasting into a chat),
use `take_and_copy_screenshot()` — it saves a PNG to ~/Downloads and copies it to the clipboard.

## Working with complex forms
- Before filling a large or unfamiliar form, call `get_form_fields()` to get a full inventory
  of every field (type, label, current value, vertical position, and section heading). Use
  `get_elements()` when you need pixel coordinates of visible elements; use `get_form_fields()`
  when you need to understand the full structure of a form including fields below the fold.
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
- After any radio/checkbox click that reveals new fields, call `get_form_fields()` again —
  the inventory will include the new fields and warn if more hidden ones still exist.
- If a form has collapsible sections, expand them all before calling `get_form_fields()` so
  the field list is complete. Use the `[under: "section name"]` context in each field's entry
  to identify fields by section rather than by index — indices shift when sections expand.
- Prefer `scroll_to_element("label text or #selector")` over `scroll_page` whenever you know
  which field or section you need — it scrolls precisely and confirms the matched element.
- For multi-session tasks (long forms that may exceed context), call `save_page_state()` as a
  checkpoint. A future session can call `restore_page_state()` to reload all field values.

## Working with multiple tabs
- Before opening a new tab, call `list_tabs()` to check if the target URL is already open —
  use `switch_to_tab` to return to it instead of opening a duplicate.
- `open_page(url, new_tab=true)` opens a URL without losing the current tab. Use sparingly —
  prefer switching to an existing tab over opening a new one.
- `switch_to_tab("1")` switches by tab number; `switch_to_tab("form")` matches by URL or title substring.
- Before navigating away from a partially-filled form, call `save_page_state()` so the form
  can be restored if the tab reloads or the page loses its state on return.

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
// use take_and_copy_screenshot() to read it
// restore afterward:
document.body.style.zoom = '1';
```

**Downloads via `execute_script`**: Creating a Blob URL and clicking an anchor via
`execute_script` sometimes fails due to CSP or timing. If a download doesn't trigger:
1. Retry the exact same `execute_script` call
2. If still failing, use `find_and_highlight` to show the user a download button to click manually

**Shadow DOM `[role=radio]` / custom radios silently no-op**: On sites like Outlier,
`element.click()` on a shadow-DOM radio often doesn't flip `aria-checked`. Two things
must be true: (a) the element must be scrolled into view FIRST (`scrollIntoView({block:'center'})`),
and (b) the full pointer-event chain must fire — not just `click()`:
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
