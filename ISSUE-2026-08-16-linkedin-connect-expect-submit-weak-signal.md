# Issue: LinkedIn connection requests silently fail to send — `expect_submit`'s fallback cascade never fires because a weak, incidental signal (dialog closing) already satisfies the generic activity probe

- **Date observed:** 2026-08-16 (reported by Drew: "Connection requests don't work. They fail istrusted")
- **Severity:** High — every connection request via the standard LinkedIn search-results "Connect" flow silently fails to send, with no error surfaced to the caller beyond a generic `submit silently rejected` message that never got a chance to trigger recovery.
- **Reproducibility:** Confirmed live, directly, with real test data (see below) — not inferred from logs alone.

---

## 1. Summary

`flows.json` showed zero successful LinkedIn connect-flow recordings since 2026-08-01, and `usage.jsonl` showed a streak of ~15 consecutive `wait_for_selector` failures on 2026-08-15. Live testing (with explicit permission to send real test invitations) reproduced the actual failure precisely:

1. Clicking "Connect" on a search-results card works fine — trusted CDP click, opens LinkedIn's "Add a note?" confirmation dialog cleanly, no fallback needed.
2. Clicking "Send without a note" inside that dialog **dispatches** (isTrusted=true, chromeflow reports success) and the **dialog closes** — but the invitation is **never actually sent**. Confirmed via LinkedIn's own Sent Invitations page (`/mynetwork/invitation-manager/sent/`): the test targets never appear there.
3. `try_fiber: true` had zero effect. Root cause for that specifically: LinkedIn's Send button has no discoverable `__reactProps$.onClick` at all (`"no React fiber __reactProps$.onClick exists on the element or its ancestors"`) — different framework or a mangled production build. Fiber is a dead end for this button regardless of anything else.
4. Repeated rapid connect attempts (5-6 in quick succession during this test session) degraded further — even the initial "Connect" click started reporting `silently_rejected`. This looks like session/behavioral-level detection tightening with repeat attempts, not purely a per-click mechanism. Recommend capping LinkedIn connect-request rate similar to the existing X/Twitter outreach caps.

## 2. Root cause (the actual bug, general — not LinkedIn-specific)

`click_element`'s fallback cascade (tap-gesture → keyboard-enter → pointer-chain → dom-click → react-fiber) only ever ran when the general activity probe (`runActivityProbe`) reported `activity: false` — i.e., truly nothing observable happened. But the probe's "activity" signal is satisfied by ANYTHING, including a bare DOM mutation with no other context. When the "Send without a note" click causes the confirmation dialog to close (removing its DOM subtree — a mutation), the probe reports `activity: true` immediately, and the ENTIRE fallback cascade gets skipped — including `try_fiber`, even when the caller explicitly requested it.

Separately, `expect_submit` runs its OWN, stricter poll afterward (URL change / new alert / new toast / new modal), and correctly determines nothing real happened. But by the time that poll runs, the fallback cascade already had its one shot and skipped itself — `expect_submit`'s stricter verdict has no way to trigger a retry.

This is a general pattern, not LinkedIn-specific: any confirm-in-modal submit flow where the modal closes as an (possibly cosmetic) side effect of clicking its own confirm button hits this exact gap.

## 3. Fix (2026-08-16, `packages/extension/src/background/cdp/probe.ts` + `packages/extension/src/background/handlers/click.ts`)

1. `ActivityProbeResult` gained a `weak: boolean` field. `weak: true` for the two least-specific signals (a bare DOM mutation count, a focus change) — the two an incidentally-closing dialog or stray blur can trivially produce. `weak: false` for everything more specific (URL change, target state-attribute change, alert/toast/modal appearing, a large shadow-pierce visible-count jump) — these are unlikely to be incidental.
2. `click.ts`'s fallback-cascade entry gates changed from `if (!probe.activity)` to `if (needsFallback(probe))`, where `needsFallback(p) = !p.activity || (expectSubmit && p.weak)`. An `expect_submit` caller now gets a real shot at tap-gesture/keyboard-enter/pointer-chain/dom-click/react-fiber even when a weak signal already "satisfied" the generic probe. Each fallback stage propagates its own `.weak` result back into the outer `probe` object so the next gate re-evaluates correctly.
3. The two hard-`return silently_rejected` points at the end of the cascade (fiber found nothing / fiber not attempted) now only return early when `!expectSubmit`. When `expectSubmit` is true, execution falls through to `expect_submit`'s own poll instead, which gives a more specific, more accurate verdict.
4. Safety fix: the tap-gesture fallback used to dispatch at `prep.x`/`prep.y` captured *before* the click. That was safe before, because this block could only be reached when nothing observable had changed (so the target couldn't have been removed). Once a weak signal (a mutation) can also reach this block, the target may already be gone — dispatching at stale coordinates risks hitting whatever page content is now underneath instead. Fixed to re-verify the tagged target still exists via `freshTargetPoint()` immediately before dispatching, skipping (not misfiring) if it's gone.

Typecheck and build clean. Not live-tested with this exact fix (extension background.js changes aren't remotely reloadable in this environment — same limitation documented in `packages/plugin/scripts/reload-extension-remote.sh`), but every individual piece (weak-signal classification, needsFallback gating, fresh-coordinate guard) was verified by direct code tracing against the exact live failure reproduced above, not guessed.

## 4. What this does NOT fix

- React-fiber genuinely cannot help on LinkedIn's Send button (no discoverable onClick prop) — this fix routes the OTHER fallbacks (tap-gesture, keyboard-enter, pointer-chain, dom-click) to actually get a chance, but none of those were tested live against this exact button with the fix applied (couldn't — no live reload in this session). If LinkedIn's Send button also defeats those (plausible, given how thoroughly it defeated the primary trusted click), this fix narrows the gap but may not fully close it.
- The apparent session-level detection escalation with repeated rapid attempts (finding #4 above) is not something this fix addresses — that's a rate/behavioral concern, not a click-dispatch bug. Recommend a LinkedIn connect-request rate cap, mirroring the existing X/Twitter outreach caps already in project memory.
- Needs the extension reload (same standing limitation as every other extension-side fix this session) to actually go live.
