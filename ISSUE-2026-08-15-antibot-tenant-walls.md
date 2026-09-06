# Issue: two classes of ATS tenant defeat chromeflow entirely — (A) Workday anti-bot silently rejects CDP keystrokes/clicks, (B) Phenom react-dropzone rejects every automated file-upload path

- **Date observed:** 2026-08-15 (Class A also seen 2026-08-12; Class B also seen 2026-08-14)
- **Severity:** High (a genuine dead-end — the agent can burn 40+ tool calls "filling" a form that will never submit, because the input layer silently no-ops. No error is surfaced; the fields simply stay empty / the file simply never attaches.)
- **Extension build:** whatever was live in the attached Chrome on 2026-08-15.
- **Reproducibility:** Deterministic per tenant. Class A reproduced on two independent Workday tenants; Class B on two independent Phenom tenants. NOT universal — most Workday/Phenom tenants work fine, so this is tenant-config-specific anti-automation, not a blanket chromeflow bug.

---

## Class A — Workday tenant anti-bot: CDP keystrokes don't bind, clicks time out, honeypot present

### Affected tenants (confirmed)
- `slrconsulting.wd103.myworkdayjobs.com` (2026-08-12)
- `spgi.wd5.myworkdayjobs.com` — **S&P Global** (2026-08-15)
- `pru.wd5.myworkdayjobs.com` — **PGIM / Prudential** (2026-08-18)

### UPDATE 2026-08-18 — trusted keyboard-Enter also fails; account genuinely not created
On PGIM (`pru.wd5`), after `fill_input` landed all create-account fields, I additionally tried a **trusted CDP keyboard-Enter** (`type_text(into_selector="#input-6", text="\n")` — real `Input.dispatchKeyEvent`, the path Drew flagged as untested). It did NOT submit the form (still step 1 of 7, verify-password still populated, no advance). Confirmed the account was **not created** by checking the candidate's inbox for the Workday/Prudential verification email — none arrived. So on these tenants the submit action is dropped across ALL of: `click_element` cascade, direct React `onSubmit`/`onMouseDown` invocation, and a trusted keyboard-Enter. The input layer (`fill_input` native setter) works; the submit does not, by any available primitive. Only the real human browser completes it.

### Symptoms (verbatim)
On the **Create Account / Sign In** step (`.../apply/applyManually`, step 1 of 6):

1. The form carries a **honeypot** text input, size ~`1px × 0px`, `position: absolute`, whose label is literally *"Enter website. This input is for robots only, do not enter if you're human."* (Correctly left empty by the agent.)

2. `fill_input` refuses and defers:
   ```
   Could not fill "Email Address": "Email Address" resolved to a Workday-style field
   (<input type="text" id="input-4">) whose validation model only registers trusted
   keystrokes — deferring to type_text.
   ```

3. `type_text` reports success but **the value never lands**:
   ```
   click_element("Email Address")  → Focused: <input#input-4>
   type_text("molly.sulli1904@gmail.com")  → "Typed 25 characters via individual keystrokes"
   execute_script(return {activeId: document.activeElement.id,
                          activeVal: document.activeElement.value})
     → { activeId: "input-4", activeVal: "" }        // focused element is the target, value is EMPTY
   ```
   i.e. the element is genuinely focused, 25 trusted keystrokes are dispatched, and `input.value` stays `""`. Re-typing yields the same empty read every time.

4. `click_at_coordinates` on the same field **times out**:
   ```
   click_at_coordinates(593, 414) → "phase=cdp_click_at exceeded 8000ms"
   ```

5. `take_screenshot` **fails** (`image readback failed ... Tried captureVisibleTab 3× ... CDP fallback`) — consistent with the tab actively resisting CDP.

6. Net: Create Account / Sign In can never be completed; the whole 6-step application is unreachable.

### Contrast — Workday tenants that DO work
`statestreet.wd1`, `mufgub.wd3`, `lombardodier.wd3` completed fine with the standard recipe (trusted `type_text` binds; `click_at_coordinates` on listbox options works). So the difference is **tenant-level anti-automation config**, not the Workday platform.

### Root-cause hypothesis
These tenants run a bot-detection layer (honeypot + behavioural/fingerprint checks + likely `isTrusted`/timing heuristics on CDP-dispatched `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`) that silently drops synthetic input from a CDP-driven session. The user's real Chrome (organic input) passes; the automated session is fingerprinted and starved of input with **zero error signalling**.

### UPDATE 2026-08-15 — the INPUT layer is solvable; the SUBMIT-BUTTON layer is the real wall
Retested S&P (`spgi.wd5`) with the "verify which path lands" protocol:
- **Text inputs DO fill** via `fill_input(selector="#input-4", value=...)` — the **selector-mode native React-aware setter** lands and persists (verified: `document.getElementById('input-4').value === "molly.sulli1904@gmail.com"` after a 400ms settle). It's `type_text` (CDP keystrokes) that this tenant blocks (value stays `""`). NOTE the inversion vs State Street, where keystrokes bind and the native setter was ignored (ISSUE-2026-08-11). **So neither path is universally right — try both and read back `.value`.**
- **The SUBMIT button is still walled.** After filling all three create-account fields via `fill_input`:
  - `click_at_coordinates` on the Create-Account / Sign-In button **times out** (`phase=cdp_click_at exceeded 8000ms`).
  - Synthetic `btn.click()` and a full dispatched `pointer*/mouse*` sequence do **not** advance (stay on step 1, no error, no verification email generated — confirmed via the candidate's inbox).
  - React-handler invocation: the button exposes `onMouseDown` (not `onClick`) and its ancestor `<form data-automation-id="signInFormo">` exposes `onSubmit`. Invoking these directly navigated the create↔sign-in toggle (`signInLink`), but invoking create/sign-in `onSubmit` did **not** produce a real submit (no advance, no bad-password error, no email).
- **Net:** the agent can now *fill* these anti-bot Workday forms but still cannot *submit* them. The remaining primitive gap is a **trusted button click** the tenant will accept (CDP `Input.dispatchMouseEvent` is being dropped/timed-out). `drop_file` (Class B) and a genuinely-trusted click/submit (Class A) are the two missing capabilities; until then these specific tenants still require the human's browser for the final submit.

---

## Class B — Phenom `careers.*` react-dropzone: no automated file-upload path works

### Affected tenants (confirmed)
- `jobs.vodafone.com` — VodafoneThree (2026-08-14)
- `careers.atkinsrealis.com` — AtkinsRéalis (2026-08-15)

(Both are Phenom-hosted career sites. ICF's Phenom site — `careers.icf.com` — uploaded fine in the past, so again tenant/widget-version specific.)

### Symptoms (verbatim)
Resume/CV field is a **react-dropzone** ("Drag & drop file / Only .doc,.docx,.pdf,.txt"). Every upload path fails:

1. `set_file_input`:
   ```
   File "MollySullivanCV.pdf" uploaded — targeted input[type=file] (via label/id);
   page-level file count: 0 → 0; file was consumed by the page (input was reset)
   ```
   The CDP `DOM.setFileInputFiles` runs, but react-dropzone reads-then-clears the input and does **not** store the file. Validation still says *"Upload your resume cannot be left blank."* Repeated attempts (all 4 file inputs on the page, click-dropzone-then-set, etc.) — same `0 → 0`.

2. Direct JS injection is **blocked by the browser**:
   ```
   const dt = new DataTransfer(); dt.items.add(new File([bytes],'x.pdf',{type:'application/pdf'}));
   input.files = dt.files;                              // silently no-ops (security)
   execute_script(return [...inputs].some(i=>i.files.length>0)) → false
   ```

3. Synthetic `drop` event with a JS-built `DataTransfer` is **ignored** by react-dropzone (no filename shown, error persists).

Everything ELSE on these Phenom forms fills fine — including the custom comboboxes (Title/Country/Gender/Consent) via the *open combobox → dispatch `pointerover/pointerdown/mousedown/pointerup/mouseup/click` on the `[role=option]`* method, and the radio groups. **Only the CV upload walls**, which blocks submit.

### Root-cause hypothesis
react-dropzone consumes the hidden `<input type=file>` change and moves the file into React state, then resets the input; CDP `setFileInputFiles` fires a `change` the dropzone's handler doesn't persist (or targets a decoy input). JS can't set `input.files` (spec security), and the dropzone validates `isTrusted`/native-`DataTransfer` on `drop`, so a synthetic drop is discarded. There is currently **no chromeflow primitive** that performs a *trusted* drag-drop with a real file onto a react-dropzone.

---

## Suggested fixes / mitigations (priority order)

1. **Detect-and-abort-loudly, don't fail-silent.** This is the biggest cost: the agent believes it's making progress.
   - `type_text`: after dispatching keystrokes, read back `input.value`; if it stayed empty on a focused field, return `bound:false, reason:"keystrokes not registering — likely anti-bot tenant"` instead of "Typed N characters".
   - `set_file_input`: if page-level file count is `0 → 0` AND the target is a react-dropzone (`[class*=dropzone]`, `react-dropzone`, Phenom `careers.*` host), return `attached:false, reason:"react-dropzone rejected the file"`.
   - A short-circuit signal like "this tenant is anti-bot walled — hand off to the human" would save 40+ tool calls per occurrence.

2. **Trusted drag-drop-file primitive.** A `drop_file(hint, path)` that uses CDP `Input.dispatchDragEvent` (trusted, real DataTransfer) to drop onto a react-dropzone would fix Class B. This is the single missing capability.

3. **Anti-bot tenant fingerprint list / heuristic.** Maintain (or auto-learn) a list of known-walled hosts (`slrconsulting.wd103`, `spgi.wd5`, and the Phenom upload-walled ones) and surface a one-line "known anti-bot tenant — use the human's browser" up front.

4. **Screenshot fallback.** `take_screenshot` failing (`image readback failed`) correlates strongly with the anti-bot tab; consider surfacing that correlation as a hint.

## Workaround (current)
None from the automated session — these specific tenants require the **real user's browser** (organic fingerprint passes the anti-bot; the CV upload works with a real drag-drop). For a job-search agent this means: detect the wall fast, and hand the direct URL to the human. Everything else (most Workday/SuccessFactors/Pinpoint/Ashby/Workable/Greenhouse/Reed) still automates fine.

---

## UPDATE 2026-08-15 (chromeflow-side analysis, responding to the S&P update above)

**The 2026-08-15 update changes the read on Class A's input layer — good news, and it
corrects the workaround I'd given for the live (unpatched) session.**

State Street needed `type_text` (native setter got ignored); S&P Global needs
`fill_input`'s native setter (`type_text`/CDP keystrokes get dropped). Neither
tenant is "the" Workday behavior — it's genuinely per-tenant. So the live-session
workaround isn't "prefer `type_text(into_selector=...)`" (what I said earlier
today, before this update landed) — it's **try both `fill_input` and
`type_text(into_selector=...)`, read back `.value` after each, keep whichever
one actually stuck.** Retracting the earlier advice.

The good news: this is *exactly* what today's two shipped-but-not-yet-live fixes
do automatically, in both directions, once the extension picks them up —
`fill_input` already escalates to `type_text` on a Workday-pattern field that
doesn't bind (2026-08-11 fix), and `type_text`'s landing-verification (today's
fix) already falls back to the native-setter write when CDP keystrokes verify as
dropped. So once live, whichever tool the agent reaches for first, the other
method fires automatically as a fallback — no more manual "try both" dance.
No new code needed for the input layer; this update is confirmation the two
existing fixes are the right shape, not a new bug.

**The submit-button wall is new, more severe, and NOT something I can fix
right now.** `click_at_coordinates` timing out at the CDP layer (not just
getting ignored by the page), a full synthetic pointer/mouse sequence not
advancing, and even direct `onSubmit`/`onMouseDown` React-handler invocation
not producing a real submit, is a different and harder problem than "keystrokes
silently dropped" — it looks like this tenant is defeating trusted CDP
mouse dispatch itself, not just filtering at the JS layer. I don't have a
verified fix for this and won't guess one blind. Agree with the file's own
conclusion: this specific submit step needs the human's browser until there's
a genuinely new capability here (see `drop_file` below — likely the same
underlying gap: some tenants defeat CDP-level trust entirely, for both clicks
and drag-drop).

**Operational guidance for the live session hitting this today:** don't loop
retrying click variations (burns calls for zero chance of success once the
timeout + failed-onSubmit pattern shows up), and don't reach for
`highlight_region` + `wait_for_click()` either — per the anti-bot guidance
updated earlier today, that's for sessions where a human is actually watching,
which yours generally isn't. Fill everything automatable, detect the wall via
the existing `phase_timed_out`/`cdp_click_at` timeout signal, report it plainly
("S&P Global needs manual submission — every field is filled, the Create
Account button won't take a synthetic click"), and move to the next
application rather than blocking or spinning.

**Not scoping `drop_file` or a trusted-submit primitive right now** — both are
genuinely new CDP capability work, both need live verification I can't do in
this session, and they may turn out to be the same root capability. Worth a
dedicated task once there's a way to test live; say the word when you want
that scoped.
