# Issue: Google Careers résumé upload widget has no `<input type=file>` anywhere in the DOM — set_file_input, synthetic drop events, and cross-origin fetch-then-inject all fail

- **Date observed:** 2026-08-16
- **Severity:** High for this tenant (total dead-end for résumé upload — the "Get started" step of Google's own Careers application flow cannot be completed by the agent at all; every other field on the same step fills fine).
- **Extension build:** whatever was live in the attached Chrome on 2026-08-16.
- **Reproducibility:** Deterministic on `google.com/about/careers/applications/apply/...` (Customer Engineer, AI Natives, Junior Talent Programme — London). Not tested on other Google Careers reqs, but the widget looks shared across the whole careers site, so likely universal there.

---

## Symptoms

Step 1 ("Get started") of Google's Careers application has a "Upload your résumé*" block with **both** a drag-and-drop zone ("Drag and drop your résumé") and a **Browse** button. Every other field on this step (legal name, email, phone + country code, Alphabet-employment radio, consent checkboxes) fills normally via `fill_input` / `click_element`.

1. `set_file_input(hint="Browse for résumé", ...)` and `set_file_input(hint="", ...)` both return:
   ```
   No file input found matching "..."
   ```

2. Deep DOM query (including open shadow roots, recursively) finds **zero** `input[type=file]` elements anywhere on the page, before or after clicking "Browse":
   ```js
   function allInputsDeep(root, results) {
     results = results || [];
     root.querySelectorAll('input').forEach(i => results.push({type:i.type, id:i.id}));
     root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) allInputsDeep(el.shadowRoot, results); });
     return results;
   }
   // → only text/radio/checkbox inputs (name, email, phone, consent) — never type=file
   ```
   `list_frames` also confirms no relevant same-origin iframe hosts the widget (only unrelated Google auth/GAPI proxy iframes).

3. Clicking the **Browse** button (`click_element(textHint="Browse", skip_activity_probe=true)`) produces no new `input[type=file]` in the DOM afterward either, and no native OS file-picker dialog appears to be capturing the browser (screenshot shows the page normally, not blocked). Best guess: the button handler uses the **File System Access API** (`window.showOpenFilePicker()`) rather than a hidden `<input type=file>.click()` — this API has no DOM backing at all, so there is nothing for `DOM.setFileInputFiles` (which is what `set_file_input` uses under the hood) to ever target.

4. Tried synthesizing the **drag-and-drop** path instead, since the dropzone text implies real HTML5 DnD listeners independent of the Browse button's picker mechanism:
   ```js
   const dt = new DataTransfer();
   dt.items.add(new File([blob], 'AndrewRobertsonResume.pdf', {type: 'application/pdf'}));
   ['dragenter','dragover','drop'].forEach(type => {
     const evt = new Event(type, {bubbles: true, cancelable: true});
     Object.defineProperty(evt, 'dataTransfer', {value: dt});
     zone.dispatchEvent(evt);
   });
   ```
   Never got this far to check whether the dropzone itself would have accepted it — see next point, the blocker was upstream of this.

5. To build the `File` object without inlining ~240KB of base64 into an `execute_script` call (expensive and slow), tried fetching the local résumé PDF from an in-page `fetch()` against a throwaway local HTTP server (`python3 -m http.server` on `127.0.0.1`, with `Access-Control-Allow-Origin: *` **and** `Access-Control-Allow-Private-Network: true` on both the real response and a handled `OPTIONS` preflight, specifically to satisfy Chrome's Private Network Access check for a public `https://www.google.com` origin calling a loopback address):
   ```js
   const resp = await fetch('http://127.0.0.1:8935/AndrewRobertsonResume.pdf');
   const blob = await resp.blob();
   ```
   This **hung indefinitely** — `execute_script` timed out at both 30000ms and a retried 8000ms/10000ms, even wrapped in try/catch (so it wasn't a fast-rejecting CSP `TypeError`, it just never resolved or rejected). Confirmed via `curl` from the host machine that the local server itself was healthy and answering both `GET` and `OPTIONS` correctly the whole time. This matches the tool's own documented behavior ("fetch() against authenticated APIs is often blocked by the page's connect-src directive... switch to fetch_url") but the *hang-instead-of-reject* behavior specifically cost two full timeout cycles before I gave up on this path — a fast, explicit "blocked by CSP" signal would have saved real time.

6. `fetch_url` (the documented workaround for in-page CSP-blocked fetches) does solve the "get bytes past CSP" problem, but doesn't solve this specific issue: it returns data to the **agent's context**, not into the **page's JS realm**, so it cannot inject the fetched bytes into a `File`/`DataTransfer` on the page without still round-tripping the full base64 payload through an `execute_script` call — right back to the size/cost problem in point 5 that it was meant to avoid.

## Net result

Abandoned automation for this one field. Highlighted the Browse button with `highlight_region` + `wait_for_click` for the human to complete manually — but the user was away from the machine ("I'm not there. Can't click"), so the application sat blocked on this single field with everything else filled and ready, until the user was back.

## Root-cause hypothesis

Google's Careers upload widget almost certainly uses `window.showOpenFilePicker()` (File System Access API) for the Browse path, which has zero DOM footprint — there is no `<input type=file>` to ever exist, click, or target via CDP's `DOM.setFileInputFiles`. This is a fundamentally different mechanism from the classic hidden-input pattern every other ATS in this repo's issue history uses (Greenhouse, Lever, Workday, Phenom, etc.), so none of the existing file-upload tooling applies. The dropzone's separate HTML5 DnD path was never actually tested end-to-end because the in-page `fetch()`-to-localhost step to build the `File` object hung first.

## Suggested fixes / mitigations (priority order)

1. **Detect File System Access API widgets and say so immediately**, rather than letting the agent burn several `set_file_input` / deep-DOM-query cycles discovering there's no input at all. A quick check — does the page reference `showOpenFilePicker` anywhere reachable, or is there a visible "Browse"/"Upload" control with zero `input[type=file]` anywhere in the full DOM (light + open shadow) — could short-circuit straight to "this widget has no automatable file-input surface, hand off to the human" instead of the current silent `"No file input found matching..."` per-hint failure.

2. **A trusted, CDP-level file-picker response primitive.** If Chrome's CDP supports intercepting `window.showOpenFilePicker()` calls the way `Page.setInterceptFileChooserDialog` / `Page.handleFileChooser` intercept classic `<input type=file>.click()` dialogs, wiring that up would let `set_file_input` (or a new tool) supply a file to ANY file-picker mechanism, not just the DOM-input one. This is the one fix that would make this whole class of widget automatable rather than needing a `drop_file` primitive per rendering style.

3. **Fast, explicit CSP-block signal from in-page `fetch()`.** Point 5 above cost two full timeout cycles (30s, then 8s+10s) because a CSP-blocked (or Private-Network-Access-blocked) `fetch()` from `execute_script` hangs rather than rejecting quickly, even inside a `try/catch`. If `execute_script` could detect "this fetch has been pending past ~2-3s with no network activity" and report `likely_csp_or_pna_blocked: true` early, that alone would save real time on this exact workaround pattern (which is otherwise a reasonable one for injecting local files without giant inline base64 payloads).

4. **A documented, cheap "inject local file into page" path.** Given `fetch_url` already solves "get bytes past the page's CSP" but hands them back to the agent's context rather than the page, a companion primitive that does the fetch in the extension's privileged context and then **injects the resulting bytes directly into the page's JS realm** (e.g. as `window.__chromeflow_injected_file__`, a real `Blob`/`File`, without the agent ever seeing the base64) would solve both point 5 and point 6 at once — and would generalize to the base64-embedding cost problem noted in `ISSUE-2026-08-15-antibot-tenant-walls.md`'s Class B (react-dropzone) too, since both are fundamentally "get a real local file into page-context JS without a working `<input type=file>`."

## Workaround (current)

None from the automated session. This specific widget needs either (a) the real user physically clicking Browse and picking the file via the native macOS picker, or (b) a new CDP-level file-picker-interception capability that doesn't exist in the current toolset. Everything else on the same form step (name, phone, consent, radios) automates fine — only the résumé upload is blocked.
