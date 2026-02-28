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

2. **`take_screenshot` is only for pixel-position lookups before `highlight_region`.** Every
   other state check — after navigation, after a click, after `wait_for_click`, to confirm an
   action succeeded — must use `get_page_text` or `wait_for_selector`. Never take a screenshot
   as a "let me see what's on screen" step. Correct order: try `click_element` → if it fails,
   THEN `take_screenshot` → `highlight_region`. Never screenshot preemptively.

3. **`open_page` already waits for navigation.** Never call `wait_for_navigation`
   immediately after `open_page` — it will time out.

4. **When `click_element` fails:** first try `scroll_page(down)` then retry
   `click_element`. If it still fails, `take_screenshot` and use `highlight_region`
   with pixel coordinates from the image.

5. **Use `wait_for_selector` to wait for async page changes** (build completion, modals,
   toasts). Never poll with repeated `take_screenshot` calls.

## Guided flow pattern

```
1. show_guide_panel(title, steps[])          — show the full plan upfront
2. open_page(url)                            — navigate to the right page
   mark_step_done(0)                         — ALWAYS mark step 0 done right after open_page succeeds
3. For each step:
   a. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        fill_input("Product name", "Pro")   — fill fields Claude knows the answer to
        clear_overlays()                    — call this immediately after fill_input succeeds
        scroll_page("down")                 — reveal off-screen content then retry
   b. Check results with text, not vision:
        get_page_text()                     — read errors/status after actions
        wait_for_selector(".success")       — wait for async changes (builds, modals)
        execute_script("document.title")    — query DOM state programmatically
   c. Only take a screenshot when click_element failed and you need pixel coords:
        click_element("Save")               — try this first, ALWAYS
        [if fails] take_screenshot()        — now get coords, not before
        highlight_region(x,y,w,h,msg)       — point user to exact location
        [after wait_for_click] get_page_text() — confirm result, NOT take_screenshot
   d. Pause for the user when needed:
        find_and_highlight(text, msg)        — show the user what to do
        wait_for_click()                    — wait for user interaction
        [after wait_for_click + fill_input] clear_overlays() — always clear after filling
   e. mark_step_done(i)                      — check off the step
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

## Error handling
- After any action → `get_page_text()` to check for errors (not `take_screenshot`)
- After `click_element("Save")` / form submission → use `get_page_text()` or `wait_for_selector` to confirm. Never use `wait_for_navigation` — most form saves don't navigate.
- `click_element` not found → `scroll_page("down")` then retry
- Still not found → `take_screenshot()` then `highlight_region(x,y,w,h,msg)`
- `fill_input` not found → `click_element(hint)` to focus the field, then retry `fill_input`. If still failing, use `find_and_highlight(hint, "Click here — I'll fill it in")` (NO `valueToType`) then `wait_for_click()` then retry `fill_input` — after the user focuses the field by clicking, the active-element fallback fills it automatically. `find_and_highlight` uses DOM positioning (pixel-perfect) — only fall back to `take_screenshot` + `highlight_region` if `find_and_highlight` returns false. After `fill_input` succeeds, immediately call `clear_overlays()` to remove the highlight. Only use `valueToType` when the user genuinely must type the value themselves (e.g. password, personal data).
- Waiting for async result (build, save, deploy) → `wait_for_selector(selector, timeout)`
- Never use Bash to work around a stuck browser interaction
