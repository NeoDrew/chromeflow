# Chromeflow issues — distribution-sprint retro (May 13, 2026)

Honest retro after using chromeflow for ~3 hours of real distribution work:
4 MCP-registry submissions, 2 GitHub PRs, social-platform launches drafted,
~25 forms filled, ~20 sites navigated. Issues are ranked by frequency × impact.

The goal here isn't a wish list — it's the specific patterns that wasted
tokens, required manual workarounds, or silently failed.

---

## 🔴 Top issues (must-fix in next release)

### 1. Synthetic submit-button clicks silently fail on every modern social platform

**Symptom:** `click_element` returns success=true, the agent thinks the form was submitted, but nothing actually happens. The page is unchanged. The only way to detect this is to check for a URL change or success toast — neither is automatic.

**Sites where I hit this today:**
- **Reddit r/mcp** — `click_element("Post")` reported success, but the form sat there. Had to fall back to `execute_script` with the full pointer-event chain via deep shadow DOM traversal. Then it STILL failed (Reddit's submit handler rejects synthetic clicks at the form-state validator).
- **X / Twitter intent composer** — same pattern. Pre-fill worked, the Post button click was synthetic and ignored.
- **Glama signup flow** — "Continue" button on the post-signup profile page wouldn't advance. Card-selection click registered, but Continue did nothing. Took 5+ attempts before I just highlighted it for the user.
- **OAuth login authorization** — synthetic Continue submit consistently 404'd. Cost ~10 minutes of agent time before I switched to highlighting the field for the user.
- **mcp.so submit** — synthetic click silently triggered a sign-in modal instead of submitting (no error reported by chromeflow).

**Root cause:** modern web apps validate `isTrusted` on the click MouseEvent. Chromeflow's CDP-injected click DOES pass isTrusted, but many sites also validate React's form-state hash, CSRF tokens bound to a session that was created via a "real" user gesture, or reCAPTCHA invisible tokens that only populate after real mouse movement.

**Proposed fix:**

a) **Add an `expect_submit: true` flag to `click_element`** that, when set, makes the tool monitor for ANY of: URL change, new `[role="alert"]` / `[data-sonner-toast]` appearing, modal appearing/disappearing, form element being removed from DOM, or a network POST/PUT request firing. If none of those happen within 4 seconds, return `success: false` with reason "submit click silently rejected (likely anti-bot)."

b) **Document the synthetic-click ceiling more loudly in CLAUDE.md** — currently the docs say "until_* clauses verify the click took effect" but don't explain that on social platforms, you basically can't bot-submit at all. The CLAUDE.md hard rule should be: "Form submits on social/auth platforms require a real human click. Pre-fill, then `highlight_region` + `wait_for_click`."

c) **Add a `submit_form_or_highlight(selector, success_signal)` higher-level tool** that does the right thing automatically: try the click, watch for the success signal, if it doesn't fire then highlight the submit button and call wait_for_click. Saves the agent ~5 round-trips on every form.

---

### 2. Web components in shadow DOM bypass click_element and fill_input

**Symptom:** Reddit's modern post-submit page uses a custom `<faceplate-textarea-input>` web component for the title, and an `<r-post-form-submit-button>` shadow host for the submit button. Both are invisible to chromeflow's standard tools.

**What I had to write:**

```js
function deepFind(root, predicate) {
  let m = null;
  function walk(node) {
    if (!node) return;
    if (m) return;
    if (predicate(node)) { m = node; return; }
    if (node.shadowRoot) walk(node.shadowRoot);
    for (const c of node.children || []) walk(c);
  }
  walk(root);
  return m;
}
const btn = deepFind(document, n => n.id === 'inner-post-submit-button');
```

That's ~10 lines of inline JS every time. And `fill_input(selector=…)` simply can't reach into a shadow root.

**Proposed fix:**

a) **`click_element`, `fill_input`, `find_text`, and `wait_for(selector)` should pierce closed shadow roots** by default (they already pierce open shadow roots — the deeper walk would just be a recursion fix on the existing selector resolution).

b) **`fill_input(selector=…)` should accept a shadow-path syntax** like `"r-post-form-submit-button >>> #inner-post-submit-button"` (similar to Playwright's `>>>` operator). Until full deep-pierce works.

c) **Add `execute_script_deep`** that injects a `deepFind` helper into page context automatically, so the agent doesn't have to keep redefining it.

---

### 3. The 0×0 refusal sometimes catches the wrong (hidden) element

**Symptom:** On Reddit's submit page, `click_element(textHint="Post", nth=5)` matched a hidden flair-dropdown label whose text starts with "Post this video as a GIF". That label is `display:none` (0×0). The tool refused to click it, with the helpful error message — but it never even considered the real submit button at the bottom of the form.

**Root cause:** the textHint matcher walks ALL elements (including `display:none` ones at this fuzzy-match level), and the 0×0 refusal kicks in BEFORE the matcher proceeds to the next candidate.

**Proposed fix:**

a) **Before refusing, the matcher should check if a non-hidden alternative exists with similar text-strength.** The 0×0 element should only block the click if it's the only candidate.

b) **Default the textHint walker to `visible_only: true` for clickable elements,** mirroring `find_text`'s default behavior.

c) **When refusing, surface the next candidate**: "Refused to click the 0×0 element 'Post this video as a GIF' — did you mean the 'Post' button at (1180, 740, 54×40)?"

---

### 4. `fill_input(selector=…)` is still buggy in the live MCP server during sessions where the cache hasn't been reloaded

**Symptom:** I shipped the `frame: undefined → frame: ""` fix in commit 9652e60. But during today's session, the running MCP server (which booted at the start of the session) didn't pick up the new code until `/reload-plugins`. So every `fill_input(selector=…)` call ERRORED with "Value is unserializable" for the first 45 minutes of the session. I worked around it by writing my own React-aware setter in `execute_script` every single time.

**Why this matters:** even AFTER the fix lands, users who don't `/reload-plugins` after updating will hit the old bug. There's no version mismatch warning anywhere.

**Proposed fix:**

a) **Boot-time diagnostic in the MCP server**: at startup, log the loaded bundle's version AND the latest version available in the marketplace. If there's a mismatch (loaded < latest), include a hint in the first tool call's stderr: `[chromeflow] v0.9.3 loaded; v0.9.4 is available — run /reload-plugins to update.`

b) **Add a `chromeflow_doctor` tool** that returns: loaded version, latest marketplace version, last update timestamp, extension version (via WS handshake), known-bug list for the loaded version with workarounds.

c) **The Edit tool's "Read first" requirement** means every fill_input error during a session forces an extra round-trip. Tighten the error message to suggest the right workaround inline: "fill_input selector mode is buggy in v0.9.3 — run /reload-plugins or use `execute_script` with the React-aware setter (see CLAUDE.md)."

---

### 5. `fetch_url` for large responses hits the agent-token ceiling before max_bytes truncation kicks in

**Symptom:** I tried `fetch_url("https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md", max_bytes: 2000000)`. The response was 722,436 chars — well under max_bytes (2MB). But the tool returned "result exceeds maximum allowed tokens" and dumped the content to a temp file for me to read separately. The MCP transport's token ceiling is hit BEFORE chromeflow's truncation.

**Root cause:** chromeflow's max_bytes parameter happens AFTER the bytes are loaded into the WS message, but the MCP SDK has its own per-response token ceiling (~25K tokens / ~100K chars). The truncate-to-temp-file fallback works but breaks the streaming flow.

**Proposed fix:**

a) **`fetch_url` should respect the agent-context token ceiling automatically.** Default max_bytes should be ~50,000 (≈12K tokens), not 2MB. Agents that want more should explicitly opt in.

b) **Add a `to_file: string` option** that writes the full response to disk and returns just `{path, size, content_type}`. Same shape as download_file but works for ANY response (not just `chrome.downloads.download`-compatible URLs).

c) **Add pagination**: `fetch_url(..., page_offset, page_size)` for streaming large responses chunk-by-chunk into context.

---

## 🟡 Important but workaroundable

### 6. No way to close tabs

**Symptom:** Over a 3-hour session I accumulated ~25 tabs (every awesome list fork, every directory I checked, every social platform). Chromeflow's `list_tabs` shows them all but offers no `close_tab`. Andrew's browser ended the session with tab clutter.

**Proposed fix:** Add `close_tab(query)` that takes the same string/index `switch_to_tab` does. `close_tab("github")` closes the most recent github tab; `close_tab(2)` closes tab index 2. Also `close_other_tabs(keep_query)` for end-of-session cleanup.

### 7. No way to detect "this form has a captcha" upfront

**Symptom:** On `pulsemcp.com` and `mcp.so`, the only way I knew a captcha was involved was by inspecting the form fields for `name="g-recaptcha-response"` myself. Most agents won't do that — they'll click submit and get silent rejection.

**Proposed fix:** Add `inspect_form(selector?)` that returns:
- Field inventory (already in get_form_fields)
- **Captcha presence** (looks for `g-recaptcha-response`, `cf-turnstile-response`, `h-captcha-response`, etc.)
- **OAuth-required indicators** (looks for "Sign in" / "Continue with" buttons inside the form region)
- **Required field count + filled count** (so the agent knows how many gates remain)

### 8. `set_dialog_response` (deprecated in 0.9.4) — the recipe in CLAUDE.md is fragile

**Symptom:** I tried `window.prompt = () => 'value'` before triggering an action that calls prompt. On reload-heavy pages, the override gets wiped by the page's own scripts before the prompt fires.

**Proposed fix:** The CLAUDE.md recipe should mention that the override needs to be re-installed AFTER any execute_script that reloads page modules (e.g., navigation). Or restore `set_dialog_response` as a tool with proper survival semantics.

### 9. OAuth-flow ergonomics

**Symptom:** The MCP Registry submission required GitHub's OAuth login flow. I tried 3 times to enter the code via chromeflow (synthetic input, CDP keystrokes, paste event) — all failed at the page's anti-bot validation. Andrew had to manually type 8 characters into 8 individual `<input>` fields.

**Proposed fix:**

a) **Add a `oauth_device_flow` helper** that:
   - Reads the code from a shell command's stdout (`npx mcp-publisher login` etc.)
   - Opens the verification URL in a new tab
   - Highlights the input region with the code as a callout
   - Polls the background process until it exits successfully
   - Returns the resulting token path

   That whole flow is ~15 lines of glue but every agent that touches device-flow auth will need it.

b) **Document the synthetic-input ceiling on GitHub's device form specifically** in CLAUDE.md — it's a known sharp edge.

### 10. `inspect_request_headers` still navigates (and overwrites) the active tab

**Symptom:** Tool description says "This tool DOES navigate the active tab." Today I forgot that, ran it once to inspect Facebook headers, and lost the tab I was on. Cost ~5 round-trips to get back to where I was.

**Proposed fix:** Add a `new_tab: true` option that opens the inspection in a background tab, captures headers, closes the tab. Default could even be new_tab=true since most inspection is a side-quest.

### 11. The post-click navigation field is unreliable on SPA route changes

**Symptom:** On Reddit, clicking the (real) post submit button would change the URL from `/r/mcp/submit/` to `/r/mcp/comments/<id>` — but only after the React app's history-pushState completed. The `after_url` field on `click_element` snapshots before that pushState fires, so it reports `navigated: false` even though the page DID navigate.

**Proposed fix:** After the click, watch `popstate`/`pushstate` events for an additional 500ms before snapshotting `after_url`. Or expose `wait_for_url_change` as a more explicit tool.

### 12. No way to fill multi-step forms across radio-driven re-renders

**Symptom:** PulseMCP's form had a "MCP Server / MCP Client" radio that conditionally rendered the name/desc/email fields. I had to call `get_form_fields()` AFTER clicking the radio to see the new fields. fill_form has no story for "first set this radio, then fill these fields, then submit."

**Proposed fix:** Add `fill_form_steps(steps: [{action, label, value}])` where actions can be "select-radio", "select-checkbox", "fill", "submit". The runner handles the re-render waits automatically.

---

## 🟢 Minor / nice-to-haves

### 13. `find_text` returns hidden flair-dropdown items as "clickable" on Reddit

The matched element had `role="button"` so the heuristic counted it clickable. It was inside a `[hidden]` ancestor. find_text should check hidden-ness more strictly when computing the `clickable` flag.

### 14. `take_screenshot` returns the image inline in the agent context

When the image is ≥500KB (Reddit / X / GitHub PR pages), this blows through 200K+ tokens just to capture pixel positions for a single element. Default should be: image saved to temp file, only the {width, height, path} returned. Inline-base64 only on explicit opt-in.

### 15. `list_frames` doesn't pierce shadow DOMs to find frames inside web components

Reddit's chat composer is inside a shadow-hosted iframe. `list_frames` reports nothing. Same deep-pierce treatment as click_element would help.

### 16. There's no "highlighter persists across navigation" mode

I'd highlight a button, then navigate to set up the next step, and the highlight is gone. Sometimes desirable, sometimes not. A `sticky: true` flag on `highlight_region` could keep the callout visible across the next 1-2 navigations.

### 17. `wait_for_click` doesn't expose what the user clicked

If the user clicked a different element than I highlighted, the tool returns success without telling me which selector / coords the user actually clicked. For multi-element handoffs, knowing what was clicked would matter.

### 18. `execute_script` doesn't show the page's REAL execution context for fetch

I learned today that page-context `fetch()` is what hits page CSP. But the tool description doesn't tell me whether `execute_script` ran in MAIN world (page context) or ISOLATED world. The result format is identical. A `context: "main" | "isolated"` field in the response would make debugging which world your fetch ran in much easier.

### 19. No way to chain tool calls that all need the same active tab

When chromeflow is running multiple sessions, I can't pin a sequence of calls to a specific tab. `switch_to_tab` does it but it shifts FOCUS. A `with_tab(query, [calls])` would let me silently run a batch against a specific tab without focus thrash. Helpful for parallel-session workflows where one Claude Code session is doing distribution while another is doing dev work.

### 20. `fill_input` selector mode error message doesn't suggest the workaround

When fill_input(selector=…) fails for any reason, the agent gets "Value is unserializable" (in the now-fixed 0.9.3 bug) or "selector matched a non-HTMLElement" (in legitimate failures). Either way, the message should suggest the workaround: `Try execute_script: document.querySelector("X").focus(); document.execCommand('selectAll'); ` then `type_text("value")`.

### 21. `wait_for(change_in=...)` returns up to 5000 chars of text content

For chat-style mutations (a 50-message Slack channel) this can dump huge amounts of context. Default should be 1000 chars; opt-in for more. Same logic as find_text's tightened defaults in 0.9.4.

---

## Patterns from the sprint that are NOT chromeflow's problem

These are out of scope but worth noting so future retros don't ask for fixes here:

- **GitHub's GraphQL API rejects PRs from forks whose name doesn't match upstream** — not a chromeflow issue, but `gh repo fork` should default to canonical naming. (Already opened a related issue upstream.)
- **GitHub's OAuth-login form rejects synthetic input** — by design for CSRF protection. Not fixable from chromeflow.
- **wong2/awesome-mcp-servers and appcypher/awesome-mcp-servers have PRs disabled via `has_issues: false`** — upstream choice, not chromeflow's problem.
- **Modern social platforms reject ALL synthetic submit clicks** — anti-bot CSRF validation, by design. The only reliable fix is to ask the user to click.

---

## Prioritised proposal

If I had a week of dev time to apply to chromeflow based on this retro:

1. **Day 1**: ship the `submit_form_or_highlight` higher-level tool + the `expect_submit: true` flag on click_element. Biggest single token-savings improvement.

2. **Day 2**: deep shadow DOM traversal for `click_element`, `fill_input`, `find_text`, `wait_for(selector)`. Removes ~80% of the manual deepFind ceremony.

3. **Day 3**: `fetch_url` ergonomics — `to_file: string` option, pagination, smaller default max_bytes. Plus tab management (`close_tab`).

4. **Day 4**: `inspect_form` (captcha detection, OAuth-required indicators, required-field count). Plus `chromeflow_doctor` self-diagnostic.

5. **Day 5**: 0×0 refusal smart-match, `take_screenshot` default to file, highlight stickiness, all the minor issues in section 🟢.

That sequence frontloads ~70% of the friction from a 3-hour distribution sprint. Most of the wins compound — once submit_form_or_highlight exists, every form interaction becomes a single tool call.

---

## Honest assessment

Chromeflow's design is solid. The MCP Registry submission and the punkpeye PR worked entirely through the existing tool surface — that's a real win. The friction points above are all about **anti-bot CAPTCHAs and shadow DOM ergonomics**, which is exactly where modern web automation lives in 2026.

The honest north star: the agent should be able to drive a 10-step authenticated workflow without ever falling through to `execute_script` for things chromeflow's own tools should handle. Today's sprint had me fall through to execute_script maybe 15 times. Cutting that to 2-3 is the bar.
