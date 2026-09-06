# Issue: Reed.co.uk job-application submit fails with "session expired" (Auth0 silent-auth / token renewal in the driven session)

- **Date observed:** 2026-07-16
- **Site:** https://www.reed.co.uk (logged-in candidate, applying to a job)
- **Severity:** Medium (blocks completing Reed "Apply now" / Easy Apply submits via chromeflow; browsing and form population work fine)
- **Reproducibility:** 100% across fresh logins and page reloads.

---

## 1. Summary

On Reed.co.uk, a logged-in candidate can browse, open a job, and click **"Apply now"** — the application dialog opens and **auto-populates correctly** from the candidate's Reed profile (name, email, phone, address, CV filename). But clicking the final **"Submit application"** button consistently flips the page into:

> **"Session expired — Your session has expired. Please refresh the page to continue."**

...and the application is **not** recorded (the job still shows "Apply now", and it never appears in the candidate's applied-jobs list). Refreshing shows the user still logged in, the dialog re-populates, and submit fails again the same way. So: **GET/browse works, the submit action fails**, specifically and repeatably.

This is NOT a click-trustworthiness problem — chromeflow's clicks fire the button and the app reacts (it navigates to the session-expired state). The failure is at the **auth/token layer on the submit request**, not the click.

---

## 2. Reproduction

1. Be signed in to reed.co.uk as a candidate (this account signs in via **Google / Auth0**).
2. Open a live job, e.g. `https://www.reed.co.uk/jobs/.../57054241`.
3. `click_element("Apply now")` → the "Application" dialog opens, fully pre-filled (name, email, phone, address, CV chip "MollySullivanCV.pdf").
4. Click **"Submit application"** (tried both `click_element` and `click_at_coordinates` on the exact button rect).
5. Result: heading becomes **"Session expired"**; application not submitted. Every time.

Verbatim states captured:
- After `click_element("Submit application")`: click "verified terminal click", text "application" appeared, but the button remained and no confirmation — submit silently did not register.
- After `click_at_coordinates` on the button rect: page `h2` became `"Session expired"`, body contained "Your session has expired. Please refresh the page to continue."

---

## 3. What works vs what fails

| Action | Mechanism | Result |
|---|---|---|
| Sign in (Google/Auth0) | redirect flow | Works (nav shows "Molly / Profile and CV") |
| Browse jobs / open job (GET) | normal navigation | Works |
| Open "Apply now" dialog | in-page | Works — dialog pre-fills from profile |
| **Submit application (POST/XHR)** | in-page action | **FAILS → "session expired"** |

The clean split (authenticated GETs fine, the submit action rejected) is the whole clue.

---

## 4. Key evidence — Reed uses Auth0, and only *flag* cookies are present

`navigator.webdriver` = **false**; no `cdc_`/selenium/driver globals; `userAgentData` present; 5 plugins; 3 languages. So this is **not** a crude automation fingerprint block — chromeflow's stealth is intact.

Cookies present on the page at submit time (names only):
```
Reed.AB.Session, Reed.HiddenJobs, Reed.GaSession, Reed.Authorised, Reed.QueryId,
Reed.LastQuery, Reed.GATags, Reed, __reed.storage,
g_state,                                   <- Google GSI
auth0.TKbAUxPEADXAXdf27NmYJv0Kg6aDfrdt.is.authenticated,
_legacy_auth0.TKbAUxPEADXAXdf27NmYJv0Kg6aDfrdt.is.authenticated,
_dd_s, _dd_s_v2,                           <- Datadog RUM (monitoring, not bot-detect)
OptanonConsent, _hjSessionUser_...
```

Crucial detail: the Auth0 cookies are **`...is.authenticated`** — these are just **boolean flags** the Auth0 SPA SDK sets to remember "this user has a session." They are **not** the access token. Auth0's browser SDK keeps the real **access token in memory** and renews it silently via a hidden iframe call to the Auth0 tenant (`checkSession` / `/authorize?prompt=none`), relying on the Auth0 **session cookie on the Auth0 domain** (third-party to reed.co.uk).

---

## 5. Root-cause hypotheses (ranked)

1. **Auth0 silent token renewal (`checkSession` / `prompt=none`) is failing in the driven session, so the submit XHR carries no valid access token → Reed's API returns 401 → the SPA renders "session expired."**
   The UI still looks logged in because it trusts the `is.authenticated` **flag cookie**, but the in-memory access token is missing/expired and silent renewal can't get a new one. Most consistent with "browse works, submit fails."

2. **chromeflow's full-page navigations (`open_page`) between steps re-initialise the SPA every time and force a fresh silent-auth on each load.** A real user stays within the SPA (no full reload) and keeps the in-memory token; driving the flow with `open_page` reloads (as this session did between each attempt) repeatedly triggers the silent-renewal path — exactly the thing that's failing. **Try doing the whole apply flow without any full navigation after login.**

3. **Third-party-cookie / SSO-iframe blocking.** Auth0's silent renewal loads a hidden iframe to the Auth0 domain and needs the Auth0 session cookie sent in a third-party context. If Chrome's third-party-cookie policy (or the driven profile's settings) blocks it, `checkSession` returns `login_required` and the token never refreshes. Worth checking the profile's third-party cookie setting and whether the Auth0 iframe request is being blocked.

4. **CSRF / anti-forgery token staleness** on the submit endpoint (lower likelihood given the Auth0 signal, but the submit may also require a per-session anti-forgery token that goes stale across reloads).

Note: `_dd_s` is Datadog RUM (client monitoring), not a bot-detector — not the cause.

---

## 6. Why this matters for chromeflow / suggested fixes

chromeflow's click + stealth are working; the gap is **SPA auth-token lifecycle** during a driven session. Suggestions:

- **Avoid full-page navigations mid-flow for SPA auth.** After login, prefer in-page interaction (the SPA keeps its in-memory token). `open_page` reloads force Auth0 re-init + silent renewal, which is the failing step. A guidance note ("for Auth0/SPA sites, don't reload between steps") would help agents.
- **Capture the failing request to confirm.** Add/lean on CDP `Network.*` capture around the submit so the agent can see the 401 and the missing/expired `Authorization: Bearer` header, plus the `checkSession`/`/authorize?prompt=none` response (`login_required`?). The in-page `fetch`/XHR wrapper approach does NOT survive because the submit triggers a navigation that wipes it — a CDP-level network log is needed here.
- **Ensure third-party cookies are allowed for auth domains** (Auth0 tenant, accounts.google.com) in the driven Chrome profile, so silent renewal can complete.
- **Consider a "let the SPA settle" step** — wait for Auth0's silent-auth (`checkSession`) to complete after load before interacting, so the in-memory token exists before the submit.
- If none of the above, a **human-handoff fallback for the final submit** on Auth0-gated sites (the user clicks Submit in their trusted session) — but the above should be fixable first.

---

## 7. Data to capture next time (to confirm root cause)

- CDP `Network` log of the **submit** request: its URL, method, `Authorization` header presence, and the response status/body (expected: 401 + a session/token error).
- The Auth0 **`checkSession` / `/authorize?prompt=none`** iframe request and its response (`login_required` / `consent_required` would confirm silent-auth failure).
- Whether the driven Chrome profile blocks third-party cookies.
- Whether running the entire flow with **no full-page reload after login** succeeds (tests hypothesis #2 directly).

---

## 8. One-line repro test

Signed in on reed.co.uk → open a job → "Apply now" (dialog pre-fills) → "Submit application" → if it flips to **"Session expired"** and the job still shows "Apply now" afterwards, this bug reproduced.
