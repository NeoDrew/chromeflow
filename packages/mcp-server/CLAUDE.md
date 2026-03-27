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
   `get_page_text` returns up to 20,000 characters; if truncated it tells you the next
   `startIndex` to paginate. Screenshots are only for locating an element's pixel position
   when DOM queries have already failed. Never take more than 1–2 screenshots in a row.

3. **Use `wait_for_selector` to wait for async page changes** (build completion, modals,
   toasts). Never poll with repeated `take_screenshot` calls.

## Guided flow pattern

```
1. show_guide_panel(title, steps[])          — show the full plan upfront
2. open_page(url)                            — navigate to the right page (add new_tab=true to keep current tab open)
   mark_step_done(0)                         — ALWAYS mark step 0 done right after open_page succeeds
3. For each step:
   a. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        get_page_text() or wait_for_selector(".success") — ALWAYS confirm after click; click_element returns after 600ms regardless of outcome
        fill_form([{label, value}, ...])    — fill multiple fields in one call; prefer over repeated fill_input
        fill_input("Product name", "Pro")   — fill a single field (works on React, CodeMirror, and contenteditable)
        set_file_input("Upload", "/abs/path/to/file.zip") — upload a file to a file input (even hidden inputs)
        clear_overlays()                    — call this immediately after fill_input/fill_form succeeds
        scroll_to_element("label text")     — jump directly to a known field; prefer this over scroll_page when the target is known
        scroll_page("down")                 — reveal off-screen content when target location is unknown
   b. Check results with text, not vision:
        get_page_text()                     — read errors/status after actions
        wait_for_selector(".success")       — wait for async changes (builds, modals)
        execute_script("document.title")    — query DOM state programmatically
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
   e. mark_step_done(i)                      — check off the step after it is complete
4. clear_overlays()                          — clean up when done
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

**`fill_input` not found:**
1. `click_element(hint)` to focus the field, then retry `fill_input`
2. `find_and_highlight(hint, "Click here — I'll fill it in")` (no `valueToType`) then
   `wait_for_click()` — the user's click focuses the field and `fill_input`'s active-element
   fallback fills it automatically
3. Call `clear_overlays()` after `fill_input` succeeds
4. Only use `valueToType` when the user must personally type the value (password, personal data)

**Waiting for async results** (build, save, deploy): `wait_for_selector(selector, timeout)` — never poll with screenshots.

**React Select / custom styled dropdowns** (e.g. "Select..." components on DataAnnotation):
`click_element` and `fill_input` do NOT work on these — they intercept native events. Use
`execute_script` directly:

```js
// 1. Open the menu — click the control div (filter by pageY if multiple)
var controls = document.querySelectorAll('[class*="control"]');
controls[N].click();

// 2. Pick an option by exact text
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
  if (allEls[i].textContent.trim() === 'Target Option' && allEls[i].children.length === 0) {
    allEls[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    allEls[i].click();
    break;
  }
}

// 3. Verify
controls[N].textContent.trim(); // should show selected value
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

**Never use Bash to work around a stuck browser interaction.**
