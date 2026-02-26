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

## HARD RULES — never break these

1. **Never use Bash as a fallback for browser tasks.** If `click_element` fails, use
   `scroll_page` then retry, or use `highlight_region` to show the user. Never use
   `osascript`, `applescript`, or any shell command to control the browser.

2. **Take a screenshot only when you need to decide what to do next.** Do not take
   a screenshot after every action as a reflex. Take one after navigation, or when
   `click_element`/`find_and_highlight` fails and you need to locate something visually.

3. **`open_page` already waits for navigation.** Never call `wait_for_navigation`
   immediately after `open_page` — it will time out.

4. **When `click_element` fails:** first try `scroll_page(down)` then retry
   `click_element`. If it still fails, `take_screenshot` and use `highlight_region`
   with pixel coordinates from the image.

## Guided flow pattern

```
1. show_guide_panel(title, steps[])          — show the full plan upfront
2. open_page(url)                            — navigate to the right page
3. For each step:
   a. [if needed] take_screenshot()          — only when you need to locate something
   b. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        fill_input("Product name", "Pro")   — fill fields Claude knows the answer to
        scroll_page("down")                 — reveal off-screen content then retry
      Or pause for the user:
        find_and_highlight(text, msg)        — show the user what to do
        wait_for_click()                    — wait for user interaction
   c. mark_step_done(i)                      — check off the step
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
- `click_element` not found → `scroll_page("down")` then retry
- Still not found → `take_screenshot()` then `highlight_region(x,y,w,h,msg)`
- Page still loading → `take_screenshot()` to confirm, proceed when content is visible
- Never use Bash to work around a stuck browser interaction
