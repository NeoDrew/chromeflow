# chromeflow — issues + improvement requests

Notes from a long live session driving eBay UK seller flows on 2026-04-28. ~30 listings published, ~6 stuck or had to be hand-finished. The pattern of failure is consistent, so this is a useful corpus to draw from.

## Top-level: why eBay specifically is so hard

eBay's seller hub (Sell one like this / Revise listing) is built with their internal React-rich-text framework "Helix" / "se-rte". It does three things that interact badly with browser-automation tools:

1. **Inputs are React-controlled with custom value setters.** Plain `el.value = 'x'` doesn't update React state; you have to walk to the prototype's value setter and dispatch synthetic `input`+`change` events.
2. **The description editor is an iframe with a contenteditable inside it.** `document` queries don't reach into the iframe; CDP keystrokes from `type_text` work intermittently because React clears the editor on submit.
3. **Drafts auto-save on focus loss/navigation.** Every time you visit the form (even to read state), eBay POSTs an auto-save. Saved drafts can develop a "sticky" state where the description rejects no matter what you type into it.

So most of the issues below are real chromeflow gaps that would help any React-heavy site, not just eBay — they just got exposed worst here.

## Confirmed bugs / wrong behaviour in chromeflow today

### 1. `fill_input` matches the wrong field by fuzzy text and gives no warning
**Severity: high — caused 2 listings to publish with title=`5`.**

`fill_input("Ad rate", "5")` matched `<input name="title">` instead of the promoted-listings rate input, because eBay renders the rate input later than the title and the "Ad rate" label sits visually closer to the title at the time fill_input scans. Two listings (Logitech mouse 206238234970, Wheel Cleaner 206238231561) went live with `title="5"` before I noticed.

**What I want:** either an exact-match mode (`fill_input(label, value, exact: true)`) or a return value that names the input fill_input chose, so I can sanity-check it didn't hit the wrong field. Right now there's no way to know what got filled until you reload the page and read it back.

### 2. `set_file_input` silently duplicates files when called rapidly
**Severity: medium — once you know about it, sleep 3s between calls. But I lost time figuring it out and one batch had 5× the same image live for half an hour.**

Calling `set_file_input(...)` with file A, then immediately with file B, ends up with two copies of A in the upload queue (or two of B, depends on race). React's `onChange` handler is debounced/batched, and the second CDP attach overwrites the first before eBay reads it.

**What I want:** `set_file_input` to internally wait for the React change event to fire before returning, or expose a `wait_for_upload: true` flag that polls until the on-page file count increments by 1.

### 3. `set_file_input` doesn't report whether the upload was accepted by the page
**Severity: medium.**

Returns `File "X.jpg" set on input` even when React never picks it up. I have to follow with an `execute_script` that reads `[...document.querySelectorAll('p,span,div')].find(...)?.textContent` looking for the "X out of 25 photos" text. Brittle.

**What I want:** return a structured result: `{attached: true, fileCountAfter: 5, errorIfAny: null}`.

### 4. `click_element` returns success but the click didn't register
**Severity: high — present on every React-heavy site I've used chromeflow on.**

Today's instance: clicking "List with displayed fees" — `click_element` returns success, but eBay's React state hasn't actually run the click handler. Often I have to repeat the click via `execute_script` and `.click()` directly on the DOM node. No way for the tool to tell you it actually fired.

**What I want:** `click_element(label, until_url_contains: '/success')` or `click_element(label, until_dom_change: true, timeout: 5000)` that doesn't return until something observable happens.

### 5. Chromeflow extension disconnects mid-batch with no auto-reconnect
**Severity: low but breaks long flows.**

Got `Chromeflow extension is not connected. Open Chrome and ensure the extension is installed.` once during a 5-photo upload. The next call worked. No mechanism in the tool to retry — I had to insert a sleep and re-call manually.

### 6. `click_element` timeouts at 30s on elements that exist but are slow to render
**Severity: medium.**

Hit this multiple times today on "Save for later" and "Revise with displayed fees" buttons. The element exists but is briefly not clickable during a render pass. Tool waits the full 30s then errors.

**What I want:** a configurable timeout, or a fallback that switches to `execute_script` on the matched element.

### 7. `execute_script` doesn't support top-level `await`
**Severity: medium — every async fetch becomes a window.__variable + polling pattern.**

I needed to fetch an image via fetch(), build a File from the blob, attach it via DataTransfer. Wanted: `return await fetch(...).then(...)`. Got: `await is only valid in async functions and the top level bodies of modules`.

Workaround: stash result in `window.__upload`, sleep, read `window.__upload` in a follow-up call. 3 round-trips for what should be 1.

**What I want:** wrap the script in `async function` if it contains `await`, return the resolved value (or a `__pending` sentinel + auto-resolve callback).

### 8. `execute_script` "Illegal invocation" when calling React value setters bound to wrong context
**Severity: low but annoying.**

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(adInput, '5');  // sometimes throws "Illegal invocation"
```

Had to use `Object.getPrototypeOf(adInput)` instead of `window.HTMLInputElement.prototype`. Same prototype in 99% of cases, but iframes have their own `window` and the input is from the iframe's HTMLInputElement, not the outer one.

**What I want:** a built-in helper `chromeflow_react_set_input(selector, value)` that handles the proto-from-element gotcha and dispatches `input`+`change`. This pattern shows up on every React form.

### 9. `type_text` into iframe contenteditable is intermittent
**Severity: high — directly caused 2 stuck drafts today (Sonax, Meguiar's Tyre Gel).**

`type_text` fires CDP keyboard events at the focused element. For top-level inputs this works. For iframe-nested contenteditables (eBay's description editor), it works ~70% of the time and silently fails the rest. The editor reads `len > 0` immediately after type_text, but eBay's React state clears the editor when you click publish — treating it as empty, rejecting with `A description is required`.

I think the issue is that CDP `Input.dispatchKeyEvent` targets the page's main frame, not the iframe's frameId. eBay's React listens via the outer document, so when the focus is in the iframe, neither side gets the right event.

**What I want:** `type_text(text, frame: 'iframe#se-rte-frame__summary')` that targets the iframe's frameId at the CDP level. Or a `chromeflow_inject_rich_text(iframe_selector, html)` helper that handles the React-iframe contenteditable pattern end-to-end.

### 10. No first-class image-download helper
**Severity: low but every listing needs ~5 image downloads.**

For each listing today I had to:
1. `execute_script` to extract `https://m.media-amazon.com/...` URLs from Amazon page.
2. Bash `curl` to download each to `/tmp/listing_imgs/<asin>/N.jpg`.
3. `set_file_input` each.

This works but Bash + curl feels heavy. A `chromeflow_download_image(url) → temp_path` would save 5 lines per listing × 20 listings = 100 lines of session noise.

### 11. Tab management has no "open in background, don't switch"
**Severity: low.**

`open_page(url, new_tab: true)` opens the new tab AND switches to it. I want "open in new tab in the background" so my main form keeps focus (eBay auto-saves on focus loss — switching away corrupts in-progress drafts).

**What I want:** `open_page(url, new_tab: true, background: true)`.

## Site-level issues (eBay) that chromeflow could help paper over

These aren't chromeflow bugs but the tool could ship eBay-specific helpers that automate around them.

### A. eBay's "Sell one like this" flow has 12 distinct fields each with its own quirks
See `chromeflowNavTips.md` § eBay listing creation flow. A `chromeflow_ebay_create_listing(spec)` macro that wraps photos / condition / price / qty / promoted-rate / postage / dispatch / description in one structured call would replace 25+ tool calls with 1.

### B. eBay's `Allow offers` field re-asserts itself on form re-load
Documented in chromeflowNavTips.md § 9. Even after toggling off and verifying `cb.checked === false`, eBay sometimes saves the listing with offers ON. Workaround is React-checked-setter + click + change events all together. A tool helper for "set checkbox and confirm it persisted on the next page" would catch this.

### C. eBay's description iframe is uniquely hostile
Documented in chromeflowNavTips.md § 5. type_text works ~70% of the time on fresh drafts, ~0% on drafts that have been saved/reloaded multiple times. The fallback is "give up and ask the user to paste manually". A first-class `chromeflow_inject_rich_text` that targets the iframe's frameId via CDP `Input.dispatchKeyEvent` would probably push this from 70% to 100%.

### D. eBay's dispatch-time picker is a custom React component with no underlying `<select>`
The options render at `0×0` until "properly opened" by some trigger that I couldn't reverse-engineer. `click_element` and direct React `onClick` both fail. As of 2026-04-28 the only way to change dispatch from 3 days to 1 is for the user to do it manually after the listing publishes.

## What would help most (ranked)

1. **Frame-targeted `type_text`.** Would fix the description-iframe bug that cost the most time today (probably 40+ wasted tool calls across stuck drafts).
2. **`click_element` with a "until" clause.** Would eliminate ~80% of the `sleep N; execute_script(verify)` follow-up calls.
3. **`fill_input` with exact-match mode + return value naming the input it picked.** Would have prevented the 2 listings going live with title=`5`.
4. **`set_file_input` that waits for the upload to commit before returning.** Would eliminate the `sleep 3` between every photo.
5. **`react_set_input` helper.** Common enough pattern that it deserves a first-class tool, instead of every script repeating the prototype-setter ceremony.
6. **Top-level `await` in `execute_script`.** Async fetch/DataTransfer becomes 1 call instead of 3.

## Estimated time impact across today's session

- Photo-upload sleeps + verifies: ~40 tool calls that could have been ~10.
- `fill_input` title-clobber recovery: 5 listings revised, ~25 extra tool calls.
- Description retry loop on stuck drafts: ~50 tool calls across Sonax, Tyre Gel, UHD Wax, SRP 1L, Leather Cleaner, all of which the user fixed by hand in <2 minutes.
- `click_element` 30s timeouts: 4 occurrences, ~120s wall-clock blocked.

A 2-3× efficiency improvement on this session is plausible if the top-3 fixes shipped.
