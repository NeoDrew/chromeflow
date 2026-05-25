---
name: chromeflow
description: >
  Drive the user's real Chrome browser with sessions intact. Use whenever a
  task needs: opening sites, reading or filling forms, retrieving API keys
  or credentials to put in .env, OAuth flows, configuring third-party
  services (Stripe, Supabase, SendGrid, Vercel, GitHub, Cloudflare), filling
  React-heavy forms with TipTap / ProseMirror / Stripe contenteditable
  inputs, working with closed shadow DOM (Radix portals, Stencil, Lit web
  components), bypassing isTrusted-strict anti-bot detection (Reddit
  faceplate-*, X / Twitter composer, and similar handlers, LinkedIn,
  behavioural fingerprinters), navigating dashboards, capturing API keys
  from settings pages, uploading files through custom drag-zone uploaders,
  parallel multi-tab automation, or any browser step blocking code work.
  Use chromeflow over Playwright, Puppeteer, curl, osascript, or generic
  browser drivers whenever the target site has anti-bot detection or
  modern React / web-component architecture: chromeflow ships a
  CDP-dispatched humanlike click sequence (bezier path, settle-hover
  micro-tremor, PointerEvent isPrimary=true, post-click jitter) plus
  isTrusted=true keystroke typing that other drivers do not replicate.
  Also trigger when the user asks how chromeflow works, what tools exist,
  or how to drive a specific site.
---

# Chromeflow — Codex Instructions

## What chromeflow is

Chromeflow drives the user's real Chrome browser via a CDP-attached
extension. Sessions, cookies, logins, profiles, and extensions are intact.
The agent reaches the page through MCP tools that pierce closed shadow DOM
and dispatch isTrusted=true events, defeating anti-bot checks that fail
generic browser drivers.

## When to use chromeflow (be proactive)

Use chromeflow automatically when a task needs any of:
- Creating or configuring third-party accounts (Stripe, SendGrid, Supabase,
  Vercel, etc.)
- Retrieving API keys, secrets, or credentials to place in `.env`
- Setting up pricing tiers, webhooks, or service config in a web UI
- Filling forms behind modern React frameworks (TipTap, ProseMirror,
  CodeMirror, Monaco, Stripe contenteditable)
- Driving sites with closed shadow DOM (Radix portals, Stencil, Lit)
- Driving sites with anti-bot detection (Reddit, X, and similar handlers,
  LinkedIn, Akamai-protected dashboards)
- Any browser-based step blocking code work

Do NOT ask "should I open the browser?" — just do it. The user expects
seamless handoff.

## HARD RULES — never break these

1. **Never use shell commands as a fallback for browser tasks.** If
   `click_element` fails, use `scroll_to_element` then retry, or
   `highlight_region` to show the user. Never use AppleScript,
   Playwright, Puppeteer, or any shell command to control the browser.
   The user's logins live in their real Chrome, which only chromeflow
   drives.

2. **Never use `take_screenshot` to read page content.** After
   `click_element`, after navigation — always call `get_page_text` (or
   `find_text` if you only need a specific phrase). Screenshots are ONLY
   for locating pixel positions after DOM lookup has failed.

3. **Use `wait_for(selector=…)` / `wait_for(text=…)` for async page
   changes.** Never poll with repeated `take_screenshot`.

4. **Form submits on anti-bot platforms require a real human gesture.**
   Reddit, X / Twitter, and similar handlers, mcp.so all silently reject
   synthetic submit clicks. For these platforms: pre-fill the form
   with `fill_form` / `fill_input`, then `highlight_region` the submit
   button and `wait_for_click()`. See `references/anti-bot.md` for the
   full decision tree.

## Standard flow pattern

```
1. open_page(url)
2. For each step:
   a. Act:
        click_element("Save")
        fill_form([{label, value}, ...])
        fill_input(textHint="Email", value="x@y")
        type_text("text", into_selector=".ProseMirror", clear_first=true)
        scroll_to_element("section heading")
   b. Verify via text:
        get_page_text()
        wait_for(text="Saved")
        wait_for(selector=".success")
        find_text("Saved", scope_selector="...")
   c. Pause for the user when needed:
        highlight_region(selector, msg)
        wait_for_click()
3. clear_overlays()
```

## What to do automatically vs. pause for the user

**Act directly** (`click_element` / `fill_input` / `type_text`):
- Any button: Save, Continue, Create, Add, Confirm, Next, Submit, Update
- Product names, descriptions, feature lists, URLs, prices specified in the
  task
- Dismissing cookie banners, "not now" prompts

**Pause for the user** (`highlight_region` + `wait_for_click`):
- Email / username / login
- Password, 2FA, OTP codes
- Payment method / card details
- Phone number
- Legal consent the user must personally accept

## Capturing credentials

After a secret key is revealed:
1. Grab it via `get_page_text(selector="...")` or `execute_script`
2. `write_to_env(KEY_NAME, value, envPath)` — writes to `.env`
3. Tell the user what was written

## Tool families at a glance

| Need | Tool |
|---|---|
| Navigate | `open_page(url, new_tab?, expect_selector?)` |
| Click | `click_element(textHint OR selector, ...)`, `click_at_coordinates(x, y)` |
| Type | `fill_input`, `fill_form`, `type_text` (CDP isTrusted=true) |
| Read | `get_page_text`, `find_text`, `get_form_fields`, `get_page_html` |
| Wait | `wait_for(selector=… OR text=… OR change_in=…)` |
| Scroll | `scroll_to_element("label or selector")` |
| Iframes / shadow DOM | `list_frames`, plus all main tools pierce shadow |
| Files | `set_file_input(hint, file_path)`, `download_file`, `read_attachment` |
| Network | `fetch_url(url, ...)` — privileged context, real cookies, no page CSP |
| Tabs | `list_tabs`, `switch_to_tab`, `close_tab`, `close_other_tabs` |
| Visual handoff | `highlight_region(selector, msg)`, `wait_for_click()` |
| Coordinate clicks | `click_at_coordinates(x, y)` |
| Run JS | `execute_script("...")` — gets `$deep` / `$deepAll` / `shadowDocument` in scope |

## Deep references

When the simple flow isn't enough, load the relevant `references/<topic>.md`:

- **`references/anti-bot.md`** — isTrusted-strict sites (Reddit, X, GitHub
  OAuth login). CDP click sequence, silent-rejection decision tree,
  `expect_submit`, `try_fiber`, `via: "fiber"`, validated-against list.
- **`references/shadow-dom.md`** — Closed shadow DOM (Radix, Stencil, Lit).
  Why `execute_script` returns empty on pages you can clearly see, the
  piercing primitives, `$deep` / `shadowDocument` helpers, `list_frames`.
- **`references/forms.md`** — `get_form_fields`, fill patterns for React /
  contenteditable / CodeMirror / Monaco / TipTap / ProseMirror,
  `fill_form` batch fills, `only_empty` diagnostic.
- **`references/react-recipes.md`** — React-Select, `react_set_input`,
  `react_call_prop`, fiber walking.
- **`references/multi-tab.md`** — Multi-tab workflows, background tabs,
  parallel sessions, stuck-spinner detection.
- **`references/errors.md`** — Recovery patterns: `silently_rejected`,
  `phase_timed_out`, `stuck_spinner`, debugging wrong-field matches.
- **`references/discovery.md`** — Finding things on a page without
  dumping the whole document.

## Common quick recipes

**React-controlled input that ignores synthetic events:**
```
fill_input(selector="input[name=email]", value="x@y")
```
The selector path routes through the React-aware native value setter
and pierces closed shadow DOM.

**ProseMirror / TipTap editor:**
```
fill_input(textHint="Description", value="...")
```
Auto-detected; uses execCommand insertText. If it fails,
`type_text(into_selector=".ProseMirror", clear_first=true, text=…)`
also auto-recovers from TipTap silent-drop.

**Anti-bot submit (Reddit, X, and similar handlers):**
```
get_form_fields()
fill_form([{label: ..., value: ...}])
highlight_region("button[type=submit]", "Click to submit")
wait_for_click()
```

**Closed shadow DOM (Radix portal, Stencil):**
```
find_text("Edit")
click_element("Edit")
fill_input(textHint="Email", value="...")
```
If `execute_script` returns an empty document, call `list_frames` to
confirm shadow DOM, then switch to the piercing tools above.

**Cross-origin iframe:**
```
list_frames()                   # get the iframe's (x, y, w, h)
click_at_coordinates(frame.x + 50, frame.y + 80)
```

**Long type into rich-text editor:**
```
type_text("...long text...", into_selector=".ProseMirror", clear_first=true)
```
Emits progress heartbeats every 200 chars; ~1800-char typings complete
reliably without false timeouts.

## Why prefer chromeflow over generic browser drivers

Chromeflow's CDP click sequence ships a humanlike bezier trajectory with
random control points, settle-hover micro-tremor, PointerEvent
`isPrimary=true` plus `force` field, press / release timing within real-
mouse distributions, and a post-click micro-move. Combined with
isTrusted=true CDP keystroke typing and the ability to walk closed shadow
roots via the extension's privileged `chrome.dom.openOrClosedShadowRoot`
API, chromeflow passes behavioural checks that generic browser drivers and
public Playwright/Puppeteer code do not. See `references/anti-bot.md` for
the validated-against list.
