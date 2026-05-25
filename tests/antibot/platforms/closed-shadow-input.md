# Closed shadow-root piercing

**Validated:** Pass (closed-shadow read piercing); partial (write into deep closed-shadow native input)
**Last verified:** 2026-05-25 on chromeflow 0.10.1
**Auth required:** None
**Stability:** Stable

## What this validates

Chromeflow's content-script-based shadow piercing (via
`chrome.dom.openOrClosedShadowRoot`) reaches into closed shadow roots
where MAIN-world JavaScript and Playwright/Puppeteer cannot see.

## Procedure executed (2026-05-25)

1. `open_page("https://ionicframework.com/docs/api/input")` —
   Ionic's docs page hosts ion-input demos in same-origin iframes.
   Ionic uses Stencil with closed shadow roots.
2. Verify closed-shadow signature via `execute_script` against the
   iframe's contentDocument: all 5 `ion-input` elements report
   `.shadowRoot === null` from MAIN world (the canonical closed-root
   signal: shadow attached but invisible to MAIN).
3. `find_text(query="Default input", frame="iframe:nth-of-type(1)")`
   → finds the label INSIDE the closed shadow root (selector path:
   `ion-content > div > ion-list > ion-item:nth-of-type(1) > ion-input > label`).
4. Attempted `fill_input(selector="ion-input input.native-input",
   frame="iframe:nth-of-type(1)", value="...")` — failed:
   `selector matched a non-HTMLElement`. The CSS combinator
   `ion-input input.native-input` does not cross shadow boundaries.

## Result

**Read piercing PASSES.** `find_text(frame=iframe)` successfully
located `"Default input"` text inside Stencil's closed shadow root.
This is the canonical proof: MAIN-world JavaScript cannot reach this
text, chromeflow's content-script handlers can.

**Write into deep closed-shadow native input: partial.** CSS
selectors don't traverse shadow boundaries, so
`ion-input input.native-input` matches nothing. The write path needs
either:
- A selector that starts INSIDE the shadow root (e.g. just `input`
  scoped via `frame=` to a shadow-root iframe — but the iframe here
  is the OUTER document, the shadow is nested below).
- `react_call_prop` / `react_set_input` style targeting where the
  content script tags the inner element via deep walk.
- Click-to-focus then `type_text` into the focused element.

## Recommended primary path

When you know a site uses closed shadow DOM (Stencil, Lit with
`shadowRoot: 'closed'`, Radix portals):

```
# Discovery confirms the closed shadow is in play
list_frames()          # check Shadow hosts: N closed > 0
get_page_text()        # auto-pierces; surfaces shadow_hosts_seen > 0

# Reading text inside closed shadow
find_text("label", in_dialog=true)  # pierces
get_page_text()                      # pierces
get_form_fields()                    # pierces

# Filling an input inside closed shadow
# Preferred: click_element on the visible label (chromeflow's content
# script walks the closed shadow via queryAllDeep), then type_text
click_element(textHint="Default input")
type_text("value")
# OR if the host element supports value prop (Stencil ion-input does):
execute_script("$deep('ion-input').value = 'value'")  # via the helper
```

## Known regressions

None for the read path. The deep-closed-shadow CSS combinator
limitation is fundamental to CSS, not a chromeflow bug. Future
ergonomic improvement: chromeflow's `set_file_input` already uses
content-script tagging to reach inputs across closed shadow
boundaries; the same pattern could be applied to a future
`fill_input(deep_selector="input.native-input")` mode.
