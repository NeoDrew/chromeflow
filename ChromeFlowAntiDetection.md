Chromeflow Anti-Detection Strategy
====================================

Living document tracking what chromeflow does (and could do) to reduce its
detectability by anti-automation systems (LinkedIn, Outlier, Datadome,
Cloudflare, PerimeterX, Akamai, etc.).

Updated whenever a defensive change ships or a new detection vector is found.


Detection layers — what we can/can't touch
-------------------------------------------

| Layer                              | Examples                       | chromeflow can defend? |
|------------------------------------|--------------------------------|-----------------------|
| TLS / JA3 fingerprint              | Cloudflare, Datadome           | NO — below extension layer |
| HTTP/2 frame ordering              | LinkedIn voyager-api           | NO — below extension layer |
| Canvas / WebGL / audio fingerprint | LinkedIn, PerimeterX           | EXTREMELY HARD — bad spoofing is worse than none |
| JS API fingerprinting              | Almost everyone                | YES — biggest ROI |
| Behavioral (mouse / keyboard)      | LinkedIn, Akamai               | YES — high value |
| Honeypot elements                  | LinkedIn, financial sites      | YES — easy |
| Injected-marker scanning           | Anyone who knows Selenium      | YES — we leak some |


Tier 1 — JS API stealth (HIGHEST ROI)
--------------------------------------

Patch the page's JS environment via a content script that runs at
`document_start` in the MAIN world (or via CDP `Page.addScriptToEvaluateOnNewDocument`
when debugger is attached pre-load). All patches must run BEFORE page scripts
read the values.

| Property                                                | Default for chromeflow          | Real Chrome value | Status |
|---------------------------------------------------------|----------------------------------|-------------------|--------|
| `navigator.webdriver`                                   | `false` (good) but extensions can flip it | `false` / `undefined` | SHIPPED v0.1.60 |
| `navigator.permissions.query({name:'notifications'})`   | `"denied"` when debugger attached headless | `"default"` | SHIPPED v0.1.60 |
| `navigator.plugins.length`                              | Sometimes 0 in test contexts    | >= 3 | SHIPPED v0.1.60 |
| `navigator.languages`                                   | Empty array possible            | Non-empty array | SHIPPED v0.1.60 |
| `window.chrome.runtime`                                 | Sometimes leaked from extension | Present, shaped like normal Chrome | SHIPPED v0.1.60 |
| `Function.prototype.toString` wrapping                  | Reveals our patches             | Should look native | SHIPPED v0.1.60 |
| `WebGLRenderingContext.prototype.getParameter`          | Returns swiftshader / Mesa for headless | Real GPU vendor strings | SHIPPED v0.1.61 |


Tier 2 — Behavioral humanization
---------------------------------

| Behavior                       | Detection vector                                      | Status |
|--------------------------------|-------------------------------------------------------|--------|
| Mouse movement before click    | Bots teleport; real users move                        | SHIPPED v0.1.60 (synthetic), v0.1.61 (CDP) |
| Random mousedown→mouseup delay | Constant delay = bot                                  | SHIPPED v0.1.60 (synthetic), v0.1.61 (CDP) |
| Click coordinate jitter        | Always-perfect-center clicks = bot                    | SHIPPED v0.1.60 (synthetic), v0.1.61 (CDP) |
| Type_text variable cadence     | Constant interval = bot; humans burst with pauses     | PARTIAL — has jitter, no thinking pauses |
| Scroll speed / acceleration    | Linear scroll = bot; humans have momentum/easing     | TODO |
| Focus blur events on clicks    | Real clicks blur previous focused element             | TODO |
| `isTrusted` on mouse events    | element.click() → isTrusted=false; CDP click → true | SHIPPED v0.1.61 — tries CDP `Input.dispatchMouseEvent` first, synthetic fallback |


Tier 3 — Footprint reduction
-----------------------------

| Item                                                  | Status |
|-------------------------------------------------------|--------|
| Randomize `__chromeflow_*` DOM IDs per session        | SHIPPED v0.1.61 — per-install 6-char random prefix via `chrome.storage.local` |
| Remove persistent overlays when not actively used     | SHIPPED — `clear_overlays` removes container; overlays only exist during active highlights |
| Lazy content script injection (programmatic, not manifest) | TODO — bigger refactor; low ROI now that markers are randomized |
| Don't leave `data-chromeflow-*` attributes after use  | SHIPPED v0.1.61 — all tags use random prefix and are removed in their respective untag/post-inspect phases |


Tier 4 — Observability for arms race
-------------------------------------

Tools that help us diagnose detection without changing it. These are how we
caught Outlier today.

- `inspect_request_headers(url)` — shipped in v0.1.57. Captures sec-fetch-*, cookies, UA hints.
- TODO: `inspect_response_headers(url)` — would catch Set-Cookie / CSP / RetryAfter that signal blocks
- TODO: `compare_session_signals()` — diff between chromeflow window and a reference window's headers/cookies


Things we should NOT do
------------------------

- TLS / JA3 spoofing — impossible from extension; sites keying on this we can't help
- Canvas fingerprint randomization — sounds clever, breaks real WebGL apps, sites detect the randomization itself, net negative
- Mass user-agent rotation — easy to detect (real UA stays constant per session)
- Pretending to be a totally different browser (Firefox UA + Chrome internals) — trivially detectable


Notes on specific sites
------------------------

### Outlier (Scale AI) — observed Apr 15 2026
- Server-side `sec-fetch-site` check on `/dashboard` (anti-direct-scrape)
- Chat UI in shadow DOM (incidental, not anti-bot but breaks naive scrapers)
- Per-session `corp_lite_default` permission check (suspected risk-score, not confirmed)

### LinkedIn — known patterns
- Behavioral biometrics ML model (mouse trajectory, keystroke dynamics)
- Voyager-API requires CSRF token + custom headers
- Multi-layer: TLS + behavioral + canvas + audio + ML on telemetry

### Datadome / Cloudflare-protected sites
- TLS JA3 first; if pass, JS challenge with WASM-encoded checks
- Hard to defeat from extension — they assume browser context but check for automation markers
