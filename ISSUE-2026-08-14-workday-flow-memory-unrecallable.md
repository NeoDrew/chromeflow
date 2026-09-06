# Issue: flow memory almost never recalls hard-won discoveries on ATS/ticketing-style sites (Workday) because every posting is a distinct URL

- **Date observed:** 2026-08-14 (reported by Drew: "I did a job application flow in workday and it worked hard for a specific button, figured it out, then 2 days later I did the same thing and it said it couldn't figure it out")
- **Severity:** High (silent, systemic — not a crash, just permanently-empty memory; the feature quietly does nothing for its most valuable use case)
- **Reproducibility:** Confirmed directly against the real `~/.chromeflow/flows.json` on Drew's machine, not a synthetic repro — see §3.

---

## 1. Summary

`flow-store.ts` keys every learned flow by `originKey(url)` = `url.origin + url.pathname` (exact match). On Workday (and any similarly-structured ATS/e-commerce/ticketing site), the per-instance id — a job posting number, in Workday's case — lives IN the path itself, e.g.:

```
https://mufgub.wd3.myworkdayjobs.com/MUFG-Careers/job/London/Analyst-Associate--Sustainable-Client-Solutions_10074887-WD
```

So every job posting, even at an employer chromeflow has already automated successfully, is a brand-new, never-seen-before key. `recallHint()` — the mechanism that surfaces a `known_flow` hint back to the agent — only ever returned hints for `tier === "trusted"` flows, and a flow only reaches "trusted" via either an explicit `save_flow()` call or two independent re-observations of the identical step signature (which requires literally revisiting the same URL twice). Neither happens in realistic job-hunting usage: you apply to a posting once and move on.

Net effect: chromeflow's hard-won discoveries (a button that needed a `react-fiber`/`tap-gesture`/`keyboard-enter` fallback to click, a field that needed `type_text` instead of `fill_input`) were captured to disk correctly, but were **structurally unrecallable** on essentially every subsequent visit, because the next visit was always a different exact URL and the flow was (almost) never promoted to trusted anyway.

---

## 2. Impact / why it matters

- The flow-memory feature exists specifically to save an agent from re-fighting the same UI friction every session. Job-application sites (Workday, and structurally identical ATS platforms) are exactly the domain where that friction is highest (React-fiber-only buttons, GUID-suffixed dynamic field ids, multi-step wizards) — and exactly the domain where the current per-exact-URL keying provides close to zero value, because you rarely revisit the identical posting.
- This directly undermines a real, in-progress user workflow: automated job applications. Every new posting effectively cold-starts, even at an employer chromeflow has already solved.

---

## 3. Exact evidence (real data, not hypothetical)

Queried `~/.chromeflow/flows.json` directly (read-only):

```
Workday origins: 8 | distinct tenants (employers): 4
  mufgub.wd3.myworkdayjobs.com
  ameresco.wd5.myworkdayjobs.com
  erm.wd3.myworkdayjobs.com
  dentsuaegis.wd3.myworkdayjobs.com
Total workday flow records: 33 | trusted: 1
```

33 hard-won flow records accumulated across 4 employers over about a month of real usage. Only **1** ever reached `trusted` tier — and that one only because Drew coincidentally revisited the *exact same* job posting URL 4 days apart (`created_at: 2026-07-30`, `last_verified: 2026-08-03`, `success_count: 2`). The other 32 — each one a real fallback fight (`recovered_via: "react-fiber"` on a login button, `"tap-gesture"` / `"keyboard-enter"` on "Autofill with Resume" and "Save and Continue", `"pointer-chain"` on the final Submit) — sat in `flows.json` as `tier: "provisional"`, `success_count: 1`, permanently below the promotion bar, and therefore never surfaced by `recallHint()`.

Secondary finding from the same data: many recorded selectors for Workday's dynamic form fields are hex/GUID-suffixed and almost certainly regenerated per page render, e.g. `#primaryQuestionnaire--9f0a2c5536851001fadd8c6857400003`, `#language-19--69af8d461fea10691f6c368fe0a4da32`. `isFragileSelector()` did not recognize this pattern (only flagged `:nth-*` and comma-separated selector lists), so these would have been recommended with full confidence if a flow containing them was ever recalled.

---

## 4. Root-cause

`originKey()` (exact origin + full pathname) is the correct default for genuinely page-specific facts, but it has no notion of "this URL differs from a previously-seen one only in its per-instance id segment" — so it can never generalize a lesson across sibling pages at the same site, and the promotion bar (`PROMOTE_AT_SUCCESS = 2` identical-signature re-observations, or an explicit `save_flow()` that in practice is essentially never called) was tuned assuming flows DO get revisited, which doesn't hold for job-posting-style URLs.

---

## 5. Fix implemented (2026-08-14, `packages/mcp-server/src/flow-store.ts`)

Entirely inside `flow-store.ts`, no schema/version bump, no extension changes:

1. **`coarsenKey()`** — a new read-time-only helper that templates out path segments matching a general "per-instance id" structural signal (`/\d{5,}/` — a run of 5+ consecutive digits; catches Workday's job code, order ids, ticket numbers, SKUs — not a Workday-specific string).
2. **`recallHint()`** — now checks, in priority order: (a) trusted flows for this exact URL, (b) trusted flows for a *sibling* URL that coarsens to the same template (same origin, same non-instance path segments) — labeled `known_flow (from a sibling page, ...)`, (c) a single unproven provisional flow for this exact URL (never pooled across siblings) — labeled `possible_flow`. Provisional data never transfers across siblings; only already-earned trust does.
3. **`observeFailure()`** — fixed to read from `recalledFlows` (what was actually shown) rather than `this.data.origins[k]`, since a sibling-sourced flow physically lives in a different origin's bucket. Without this, a bad sibling merge could never self-correct (demote/prune).
4. **`isFragileSelector()`** — now also flags long hex-run / UUID-shaped selector suffixes as fragile (structural signal — regenerated-per-render dynamic ids show up this way across many frameworks, not just Workday's).
5. **`capturableHint()`** — wording now notes when the current page looks instance-shaped, since `save_flow()`'s payoff is now larger (it makes the flow recallable on every sibling posting, not just this one).

Verified via `npx vitest run` (48/48 passing, including new coverage for cross-sibling recall, the observeFailure fix, `coarsenKey`, and GUID-selector fragility) and directly re-run against a **copy** of Drew's real `flows.json`: the previously-orphaned MUFG posting now surfaces as `possible_flow`, and a never-before-visited ERM posting now surfaces the trusted "Autofill with Resume" discovery from a *different* ERM posting as `known_flow (from a sibling page, ...)`.

---

## 6. What this does NOT fix (stated plainly)

- **Cross-employer transfer.** `coarsenKey` only templates the pathname; different Workday tenants (different subdomains) remain separate key spaces. A lesson that's genuinely platform-level (e.g. "this component library's buttons always need a click fallback") would need a structural-DOM-marker design, not a URL transform — considered and deliberately deferred (would require extension-side changes that can't be reload-verified in the current remote-dev setup; see the separate profile-picker/reload-reliability history in `packages/plugin/scripts/reload-extension-remote.sh`).
- **A brand-new tenant's very first posting** still cold-starts, exactly as before.
- **The underlying "save_flow is essentially never called" behavior** — the wording nudge in `capturableHint()` makes the payoff bigger and says so, but nothing forces the agent to call it more often.
