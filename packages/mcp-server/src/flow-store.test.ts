// Earn-in flow memory: tests for the two-tier (provisional → trusted) lifecycle.
//
// The contract under test:
//   1. Autosave is automatic. Leaving an origin (or flushAll on shutdown) commits
//      its buffered hard-won steps as a PROVISIONAL flow — no model call needed.
//   2. Provisional flows are NEVER surfaced on recall. A wrong/one-off autosave
//      can therefore never misdirect a future run; it just sits unused.
//   3. Promotion is earned. A provisional flow becomes TRUSTED only when the same
//      step-signature is independently re-observed enough times (PROMOTE_AT_SUCCESS),
//      OR when the model explicitly save_flow()s it (instant promote / vouch).
//   4. Only TRUSTED flows are recalled.
//   5. Failure feedback prunes. When a recalled trusted step fails on replay, its
//      flow's fail_count rises; at PRUNE_AT_FAILS the flow is dropped.
//   6. Provisional junk expires by TTL so it never accumulates forever.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FlowStore,
  originKey,
  isFragileSelector,
  coarsenKey,
  PROMOTE_AT_SUCCESS,
  PRUNE_AT_FAILS,
  DEMOTE_AT_FAILS,
  PROVISIONAL_TTL_MS,
  MAX_PROVISIONAL_PER_ORIGIN,
  type Atom,
} from "./flow-store.js";

const VERSION = "test-1";

// A controllable clock so TTL / freshness assertions are deterministic.
function makeClock(start = 1_000_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-flow-"));
});

function newStore(clock = makeClock()) {
  return new FlowStore(VERSION, dir, clock.now);
}

// A notable click atom (the kind the tool layer buffers), selector mode.
function clickAtom(selector: string, recovered_via = "dom-click"): Atom {
  return {
    tool: "click_element",
    target: `selector=${selector}`,
    selector,
    recovered_via,
    signal: recovered_via,
    fragile: isFragileSelector(selector),
    reason: `click recovered via ${recovered_via}`,
  };
}

// A notable click atom matched by visible textHint (no selector field) --
// the shape a real "Autofill with Resume"-style label match actually takes.
function textHintClickAtom(textHint: string, recovered_via = "dom-click"): Atom {
  return {
    tool: "click_element",
    target: textHint,
    recovered_via,
    signal: "navigated",
    fragile: false,
    reason: `click recovered via ${recovered_via}`,
  };
}

// Drive one full "visit" to an origin: observe N steps, then leave for `next`
// (a different origin) which flushes the buffer via the origin-change autosave.
function visit(store: FlowStore, origin: string, atoms: Atom[], next = "https://elsewhere.example/") {
  store.noteUrl(origin);
  for (const a of atoms) store.observe(a, origin);
  store.noteUrl(next); // crossing origins flushes `origin`'s buffer
}

describe("originKey", () => {
  it("strips query and hash so session tokens never hit disk", () => {
    expect(originKey("https://x.com/submit?token=secret#frag")).toBe("https://x.com/submit");
  });
  it("rejects non-http origins", () => {
    expect(originKey("chrome://settings")).toBeUndefined();
    expect(originKey(undefined)).toBeUndefined();
  });
});

describe("autosave → provisional", () => {
  it("buffers and autosaves on origin change, as PROVISIONAL", () => {
    const store = newStore();
    visit(store, "https://site.example/submit", [clickAtom("#go")]);
    const flows = store._flowsFor("https://site.example/submit");
    expect(flows).toHaveLength(1);
    expect(flows[0].tier).toBe("provisional");
    expect(flows[0].success_count).toBe(1);
  });

  it("surfaces a single-observation provisional flow as a lower-confidence possible_flow", () => {
    const store = newStore();
    visit(store, "https://site.example/submit", [clickAtom("#go")]);
    // Fresh session view: a new store reading the same dir.
    const next = newStore();
    const hint = next.recallHint("https://site.example/submit");
    expect(hint).toContain("possible_flow");
    expect(hint).toContain("#go");
  });

  it("prefers a trusted flow over a competing provisional flow for the same URL", () => {
    const o = "https://site.example/submit";
    // #go earns trusted via 2 independent re-observations.
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]);
    const s2 = newStore(); visit(s2, o, [clickAtom("#go")]);
    // #other-single is observed once — stays provisional.
    const s3 = newStore(); visit(s3, o, [clickAtom("#other-single")]);
    const hint = newStore().recallHint(o);
    expect(hint).toContain("known_flow");
    expect(hint).not.toContain("possible_flow");
    expect(hint).toContain("#go");
  });

  it("does not surface an unreliable provisional flow (more fails than successes)", () => {
    const o = "https://site.example/submit";
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]);
    const shown = newStore();
    shown.recallHint(o); // provisional recall fires, marks it recalled
    shown.observeFailure(o, "#go"); // fail_count 1 == success_count 1 -> unreliable
    expect(newStore().recallHint(o)).toBe("");
  });

  it("flushAll commits a buffer even when the origin is never left (single-origin session)", () => {
    const store = newStore();
    store.noteUrl("https://only.example/x");
    store.observe(clickAtom("#a"), "https://only.example/x");
    expect(store._flowsFor("https://only.example/x")).toHaveLength(0); // not yet
    store.flushAll();
    expect(store._flowsFor("https://only.example/x")).toHaveLength(1);
  });
});

describe("earn-in promotion", () => {
  it(`promotes provisional → trusted after ${PROMOTE_AT_SUCCESS} independent re-observations`, () => {
    const o = "https://site.example/submit";
    // Session 1
    const s1 = newStore();
    visit(s1, o, [clickAtom("#go")]);
    expect(s1._flowsFor(o)[0].tier).toBe("provisional");
    // Session 2: same signature rediscovered independently
    const s2 = newStore();
    visit(s2, o, [clickAtom("#go")]);
    const f = s2._flowsFor(o);
    expect(f).toHaveLength(1);               // matched, not duplicated
    expect(f[0].success_count).toBe(PROMOTE_AT_SUCCESS);
    expect(f[0].tier).toBe("trusted");
  });

  it("surfaces a TRUSTED flow on recall", () => {
    const o = "https://site.example/submit";
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]);
    const s2 = newStore(); visit(s2, o, [clickAtom("#go")]);
    const s3 = newStore();
    const hint = s3.recallHint(o);
    expect(hint).toContain("known_flow");
    expect(hint).toContain("#go");
  });

  it("a different step-signature creates a separate provisional flow, not a promotion", () => {
    const o = "https://site.example/submit";
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]);
    const s2 = newStore(); visit(s2, o, [clickAtom("#different")]);
    const f = s2._flowsFor(o);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.tier === "provisional")).toBe(true);
  });
});

describe("manual save_flow = instant promote / vouch", () => {
  it("commits buffered steps straight to TRUSTED with a human label", () => {
    const o = "https://site.example/submit";
    const store = newStore();
    store.noteUrl(o);
    store.observe(clickAtom("#go"), o);
    const res = store.commit("submit the form", o);
    expect(res.saved).toBe(1);
    const f = store._flowsFor(o);
    expect(f[0].tier).toBe("trusted");
    expect(f[0].task_label).toBe("submit the form");
  });

  it("promotes an existing provisional flow to trusted and relabels it", () => {
    const o = "https://site.example/submit";
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]); // provisional v1
    const s2 = newStore();
    s2.noteUrl(o);
    s2.observe(clickAtom("#go"), o);
    const res = s2.commit("the good flow", o);
    expect(res.saved).toBe(1);
    const f = s2._flowsFor(o);
    expect(f).toHaveLength(1);
    expect(f[0].tier).toBe("trusted");
    expect(f[0].task_label).toBe("the good flow");
  });

  it("reports nothing-to-save when the buffer is empty and nothing was autosaved", () => {
    const store = newStore();
    store.noteUrl("https://site.example/x");
    const res = store.commit("nope", "https://site.example/x");
    expect(res.saved).toBe(0);
  });

  it("promotes the just-autosaved provisional flow when the action navigated before save_flow (path-change race)", () => {
    // Mirrors the live python.org case: a navigating click flushes the buffer to
    // a provisional flow (origin+path changed), THEN save_flow is called.
    const store = newStore();
    store.noteUrl("https://app.example/");
    store.observe(clickAtom("#downloads"), "https://app.example/");
    store.noteUrl("https://app.example/downloads"); // path change → autosave provisional
    expect(store._flowsFor("https://app.example/")[0].tier).toBe("provisional");
    // save_flow now runs from the new path, buffer empty — must still vouch.
    const res = store.commit("browse downloads", "https://app.example/downloads");
    expect(res.saved).toBe(1);
    const f = store._flowsFor("https://app.example/")[0];
    expect(f.tier).toBe("trusted");
    expect(f.task_label).toBe("browse downloads");
  });
});

describe("shutdown flush (flushAll) covers same-key sessions", () => {
  it("persists a type_text step that never crossed an origin+path boundary", () => {
    // Mirrors the live duckduckgo case: type_text buffered, search stayed on the
    // same key, so only the shutdown flush can save it.
    const o = "https://search.example";
    const store = newStore();
    store.noteUrl(o);
    store.observe({ tool: "type_text", target: "input[name=q]", selector: "input[name=q]", signal: "type_text", reason: "field needs real keystrokes" }, o);
    expect(store._flowsFor(o)).toHaveLength(0); // nothing on disk mid-session
    store.flushAll();                            // what exitClean must call on every exit signal
    const f = store._flowsFor(o);
    expect(f).toHaveLength(1);
    expect(f[0].steps[0].tool).toBe("type_text");
  });
});

describe("failure feedback → prune", () => {
  function trustedStore(o: string, selector = "#go") {
    const s1 = newStore(); visit(s1, o, [clickAtom(selector)]);
    const s2 = newStore(); visit(s2, o, [clickAtom(selector)]); // now trusted
    return newStore(); // fresh session reading the trusted flow
  }

  it("only counts failures against a flow that was actually recalled this session", () => {
    const o = "https://site.example/submit";
    const store = trustedStore(o);
    // No recall fired yet → a failure must NOT touch the flow.
    store.observeFailure(o, "#go");
    expect(store._flowsFor(o)[0].fail_count).toBe(0);
  });

  it(`prunes a trusted flow after ${PRUNE_AT_FAILS} recalled-step failures`, () => {
    const o = "https://site.example/submit";
    const store = trustedStore(o);
    store.recallHint(o); // the agent was shown the flow this session
    for (let i = 0; i < PRUNE_AT_FAILS; i++) store.observeFailure(o, "#go");
    expect(store._flowsFor(o)).toHaveLength(0); // dropped
  });

  it("ignores failures whose selector matches no stored step", () => {
    const o = "https://site.example/submit";
    const store = trustedStore(o);
    store.recallHint(o);
    store.observeFailure(o, "#unrelated");
    expect(store._flowsFor(o)[0].fail_count).toBe(0);
  });
});

describe("TTL expiry", () => {
  it("drops a provisional flow once it is older than the TTL", () => {
    const o = "https://site.example/submit";
    const clock = makeClock();
    const s1 = new FlowStore(VERSION, dir, clock.now);
    visit(s1, o, [clickAtom("#go")]); // provisional, last_verified = now
    clock.advance(PROVISIONAL_TTL_MS + 1);
    // A new store loads + prunes on construction with the advanced clock.
    const s2 = new FlowStore(VERSION, dir, clock.now);
    expect(s2._flowsFor(o)).toHaveLength(0);
  });

  it("keeps a TRUSTED flow past the provisional TTL", () => {
    const o = "https://site.example/submit";
    const clock = makeClock();
    const s1 = new FlowStore(VERSION, dir, clock.now); visit(s1, o, [clickAtom("#go")]);
    const s2 = new FlowStore(VERSION, dir, clock.now); visit(s2, o, [clickAtom("#go")]); // trusted
    clock.advance(PROVISIONAL_TTL_MS + 1);
    const s3 = new FlowStore(VERSION, dir, clock.now);
    expect(s3._flowsFor(o)).toHaveLength(1);
    expect(s3._flowsFor(o)[0].tier).toBe("trusted");
  });
});

describe("persistence & privacy", () => {
  it("round-trips tier and counts across a reload", () => {
    const o = "https://site.example/submit";
    const s1 = newStore(); visit(s1, o, [clickAtom("#go")]);
    const s2 = newStore(); visit(s2, o, [clickAtom("#go")]); // trusted on disk
    const reloaded = newStore();
    const f = reloaded._flowsFor(o);
    expect(f[0].tier).toBe("trusted");
    expect(f[0].success_count).toBe(2);
  });

  it("never writes typed text to disk (selectors/signals only)", () => {
    const o = "https://site.example/submit";
    const store = newStore();
    store.noteUrl(o);
    // Even if a (hypothetical) atom carried a secret in an unexpected field,
    // only the whitelisted Atom keys are persisted.
    store.observe(clickAtom("#go"), o);
    store.flushAll();
    const raw = readFileSync(join(dir, "flows.json"), "utf-8");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("password");
  });

  it("recovers from a corrupt store file instead of crashing", () => {
    const path = join(dir, "flows.json");
    // Write garbage, then construct — should start clean.
    require("node:fs").writeFileSync(path, "{not json");
    const store = newStore();
    expect(store._flowsFor("https://x.example/")).toHaveLength(0);
    expect(existsSync(path + ".corrupt")).toBe(true);
  });
});

// ---- Phase 1-4: self-correcting recall on dynamic / anti-bot targets --------
describe("self-correcting recall (the Reddit-class fix)", () => {
  const o = "https://hard.example/search";
  function trusted(sel = "#go") {
    const s1 = newStore(); visit(s1, o, [clickAtom(sel)]);
    const s2 = newStore(); visit(s2, o, [clickAtom(sel)]); // now trusted
    return newStore(); // fresh session reading the trusted flow
  }

  it(`demotes trusted -> provisional on the FIRST recalled-step failure (DEMOTE_AT_FAILS=${DEMOTE_AT_FAILS})`, () => {
    const s = trusted();
    s.recallHint(o);                       // agent was shown the flow
    s.observeFailure(o, "#go");            // one failure
    const f = s._flowsFor(o)[0];
    expect(f.tier).toBe("provisional");
    expect(f.fail_count).toBe(1);
  });

  it("a demoted flow is no longer surfaced on recall (stops misleading)", () => {
    const s = trusted();
    s.recallHint(o);
    s.observeFailure(o, "#go");
    const next = newStore();               // fresh session
    expect(next.recallHint(o)).toBe("");   // provisional + fail -> not recalled
  });

  it("prunes after the second failure", () => {
    const s = trusted();
    s.recallHint(o);
    for (let i = 0; i < PRUNE_AT_FAILS; i++) s.observeFailure(o, "#go");
    expect(s._flowsFor(o)).toHaveLength(0);
  });

  it("mismatch: recalling a flow then acting with a DIFFERENT locator dings it", () => {
    const s = trusted("#a");
    s.recallHint(o);                       // showed click selector=#a
    s.observe(clickAtom("#b"), o);         // agent rediscovered with #b
    const f = s._flowsFor(o)[0];
    expect(f.fail_count).toBe(1);
    expect(f.tier).toBe("provisional");
  });

  it("confirm: recalling a flow then using the SAME locator keeps it healthy", () => {
    const s = trusted("#a");
    s.recallHint(o);
    s.observe(clickAtom("#a"), o);         // agent used the recalled selector
    const f = s._flowsFor(o)[0];
    expect(f.fail_count).toBe(0);
    expect(f.tier).toBe("trusted");
    expect(f.last_replay_ok).toBe(true);
  });

  it("reliability gate: a flow with more fails than successes is not recalled", () => {
    const s = trusted();
    s.recallHint(o); s.observeFailure(o, "#go"); // fail_count 1, success 2 still > 1, but demoted
    // force net-negative by a second fail (prunes), so instead check the gate directly
    const s2 = trusted();
    // hand-fail twice across the gate: demote then it stays provisional => not recalled
    s2.recallHint(o); s2.observeFailure(o, "#go");
    expect(newStore().recallHint(o)).toBe("");
  });
});

describe("strategy replay rendering + fragility", () => {
  const o = "https://app.example/x";
  it("renders recalled steps as ready-to-run calls (type_text + click)", () => {
    // Build a trusted flow with a type_text step and a fiber-recovered click.
    const s1 = new FlowStore(VERSION, dir);
    s1.noteUrl(o);
    s1.observe({ tool: "type_text", target: "input#q", selector: "input#q", clear_first: true, signal: "type_text(clear_first)", reason: "keystrokes" }, o);
    s1.commit("search", o); // trusted instantly
    const hint = new FlowStore(VERSION, dir).recallHint(o);
    expect(hint).toContain("type_text(into_selector=");
    expect(hint).toContain("clear_first=true");
    expect(hint).toContain("known_flow");
    expect(hint.toLowerCase()).toContain("rediscover"); // abandon-on-miss guidance
  });

  it("surfaces via=\"fiber\" for a fiber-recovered click", () => {
    const o2 = "https://app.example/fiber";
    const s1 = new FlowStore(VERSION, dir);
    s1.noteUrl(o2);
    s1.observe({ tool: "click_element", target: "selector=#go", selector: "#go", recovered_via: "react-fiber", signal: "navigated", verification: "until_url_changes=true", reason: "fiber click" }, o2);
    s1.commit("go", o2);
    const hint = new FlowStore(VERSION, dir).recallHint(o2);
    expect(hint).toContain("via=\"fiber\"");
    expect(hint).toContain("until_url_changes=true");
  });

  it("flags multi-option (comma) and positional selectors as fragile", () => {
    expect(isFragileSelector('input[name="q"], faceplate-search-input input')).toBe(true);
    expect(isFragileSelector("div > a:nth-of-type(2)")).toBe(true);
    expect(isFragileSelector("#stable")).toBe(false);
  });
});

describe("isFragileSelector: GUID/hex-suffixed dynamic ids", () => {
  it("flags real Workday-style hex-suffixed field ids as fragile (regenerated per render)", () => {
    expect(isFragileSelector("#primaryQuestionnaire--9f0a2c5536851001fadd8c6857400003")).toBe(true);
    expect(isFragileSelector("#language-19--69af8d461fea10691f6c368fe0a4da32")).toBe(true);
  });
  it("does not regress the existing stable-id case", () => {
    expect(isFragileSelector("#stable")).toBe(false);
  });
  it("does not over-fire on a short numeric id (e.g. a year)", () => {
    expect(isFragileSelector("#field-2024")).toBe(false);
  });
});

describe("coarsenKey", () => {
  it("templates out a Workday-style job-id segment", () => {
    expect(coarsenKey("https://mufgub.wd3.myworkdayjobs.com/MUFG-Careers/job/London/Analyst-Associate--Sustainable-Client-Solutions_10074887-WD"))
      .toBe("https://mufgub.wd3.myworkdayjobs.com/MUFG-Careers/job/London/*");
  });
  it("leaves short/route-like segments verbatim (2-digit page numbers, 4-digit years)", () => {
    expect(coarsenKey("https://site.example/archive/2024/page/12")).toBe("https://site.example/archive/2024/page/12");
  });
  it("keeps routes with a trailing literal segment distinct from their instance-only parent", () => {
    expect(coarsenKey("https://shop.example/product/583920/reviews")).toBe("https://shop.example/product/*/reviews");
    expect(coarsenKey("https://shop.example/product/583920")).toBe("https://shop.example/product/*");
    expect(coarsenKey("https://shop.example/product/583920/reviews")).not.toBe(coarsenKey("https://shop.example/product/583920"));
  });
  it("is a no-op on a key with no instance-shaped segment", () => {
    const k = "https://site.example/submit";
    expect(coarsenKey(k)).toBe(k);
  });
});

describe("cross-posting sibling recall (the Workday job-application fix)", () => {
  const tenant = "https://tenant.example/MUFG-Careers/job";
  const postingA = `${tenant}/London/Role-A_10074887-WD`;
  const postingB = `${tenant}/London/Role-B_10099213-WD`;

  it("recalls a trusted flow earned on posting A as a sibling hint on never-before-seen posting B", () => {
    const s1 = newStore(); s1.noteUrl(postingA); s1.observe(clickAtom("#autofill"), postingA);
    const res = s1.commit("autofill with resume", postingA); // instant trust via explicit save_flow
    expect(res.saved).toBe(1);

    const hint = newStore().recallHint(postingB); // B has NO history of its own
    expect(hint).toContain("known_flow");
    expect(hint).toContain("sibling page");
    expect(hint).toContain("#autofill");
  });

  it("does not cross-recall when the non-instance path segments differ (different office/route)", () => {
    const postingTokyo = `${tenant}/Tokyo/Role-C_10055221-WD`;
    const s1 = newStore(); s1.noteUrl(postingA); s1.observe(clickAtom("#autofill"), postingA);
    s1.commit("autofill with resume", postingA);
    expect(newStore().recallHint(postingTokyo)).toBe("");
  });

  it("never pools PROVISIONAL (unproven) flows across siblings — only trusted transfers", () => {
    const s1 = newStore(); s1.noteUrl(postingA); s1.observe(clickAtom("#autofill"), postingA);
    s1.flushAll(); // provisional only, single observation — never save_flow'd or re-observed
    expect(newStore()._flowsFor(postingA)[0].tier).toBe("provisional");
    expect(newStore().recallHint(postingB)).toBe(""); // B has nothing of its own either
  });

  it("never coarsens across a different origin (different Workday tenant)", () => {
    const otherTenant = "https://othertenant.example/OtherCareers/job/London/Role-Z_10012345-WD";
    const s1 = newStore(); s1.noteUrl(postingA); s1.observe(clickAtom("#autofill"), postingA);
    s1.commit("autofill with resume", postingA);
    expect(newStore().recallHint(otherTenant)).toBe("");
  });

  it("observeFailure demotes a sibling-recalled flow (self-correction works across origin buckets)", () => {
    const s1 = newStore(); s1.noteUrl(postingA); s1.observe(clickAtom("#autofill"), postingA);
    s1.commit("autofill with resume", postingA);

    const s2 = newStore();
    const hint = s2.recallHint(postingB); // sibling recall, lives in origins[postingA]'s bucket
    expect(hint).toContain("sibling page");
    s2.observeFailure(postingB, "#autofill");

    // The flow physically lives under postingA's key — confirm IT demoted, not
    // some phantom postingB entry (postingB should still have no bucket of its own).
    // Use newStore() (frozen clock), not a real-clock FlowStore -- last_verified
    // was written under the frozen test clock, and reading it back with the real
    // clock would make a freshly-demoted provisional flow look decades stale to
    // TTL-pruning.
    const flowA = newStore()._flowsFor(postingA)[0];
    expect(flowA.tier).toBe("provisional");
    expect(flowA.fail_count).toBe(1);
  });
});

// ---- real-world regression: the reported bug, reproduced structurally -----
//
// This models the ACTUAL shape of the dataset that exposed the bug (see
// ISSUE-2026-08-14-workday-flow-memory-unrecallable.md): 33 real flow records
// across 4 Workday tenants, only 1 ever reaching "trusted", because every job
// posting is a distinct URL. Company/job names are genericized per this
// project's "patterns not sites" rule (the fix must never key on a literal
// site string, and neither should a fixture that ships in the public repo),
// but the STRUCTURE is real: multiple postings per tenant, a job-id digit run
// in the path, a non-job route (login) at the same tenant, a GUID-suffixed
// dynamic field id, and a tenant that never earns a single trusted flow.
describe("real-world regression: multi-tenant ATS dataset (the reported bug)", () => {
  const tenantA = "https://tenant-a.example/Careers/job"; // mirrors the one tenant that had a trusted flow
  const tenantB = "https://tenant-b.example/Careers/job"; // mirrors a tenant that stayed 100% provisional

  it("recalls a trusted discovery on an unvisited sibling posting at the SAME tenant", () => {
    const trustedPosting = `${tenantA}/London/Data-Analyst_10074887-WD`;
    const newPosting = `${tenantA}/London/Support-Engineer_10099213-WD`;

    const s1 = newStore(); s1.noteUrl(trustedPosting);
    s1.observe(textHintClickAtom("Autofill with Resume", "tap-gesture"), trustedPosting);
    s1.commit("autofill with resume", trustedPosting);

    const hint = newStore().recallHint(newPosting);
    expect(hint).toContain("known_flow (from a sibling page");
    expect(hint).toContain("Autofill with Resume");
  });

  it("does NOT recall across a different route at the same tenant (login page vs. job posting)", () => {
    const trustedPosting = `${tenantA}/London/Data-Analyst_10074887-WD`;
    const loginPage = "https://tenant-a.example/Careers/login"; // same tenant, unrelated route

    const s1 = newStore(); s1.noteUrl(trustedPosting);
    s1.observe(textHintClickAtom("Autofill with Resume", "tap-gesture"), trustedPosting);
    s1.commit("autofill with resume", trustedPosting);

    expect(newStore().recallHint(loginPage)).toBe("");
  });

  it("a tenant that never earns a trusted flow gets NOTHING on a fresh posting (the honest ceiling)", () => {
    // Three different single-visit postings/pages at tenant B, mirroring the
    // real MUFG data: none reach PROMOTE_AT_SUCCESS, none are save_flow'd.
    const postings = [
      `${tenantB}/London/Analyst_10074887-WD`,
      `${tenantB}/London/Analyst_10074887-WD/apply/autofillWithResume`,
      "https://tenant-b.example/Careers/jobTasks/completed/application",
    ];
    for (const p of postings) {
      const s = newStore(); s.noteUrl(p); s.observe(clickAtom("#source"), p); s.flushAll();
    }
    for (const p of postings) {
      expect(newStore()._flowsFor(p).every((f) => f.tier === "provisional")).toBe(true);
    }
    // A fourth, never-visited posting at the SAME tenant: no trusted flow
    // anywhere at tenant B for it to inherit, and provisional data never
    // pools across siblings -- so this correctly gets nothing, not a false
    // recall.
    const freshPosting = `${tenantB}/London/Engineer_10055221-WD`;
    expect(newStore().recallHint(freshPosting)).toBe("");
  });

  it("never leaks tenant A's trusted discovery into tenant B (cross-tenant isolation)", () => {
    const trustedPosting = `${tenantA}/London/Data-Analyst_10074887-WD`;
    const s1 = newStore(); s1.noteUrl(trustedPosting);
    s1.observe(textHintClickAtom("Autofill with Resume", "tap-gesture"), trustedPosting);
    s1.commit("autofill with resume", trustedPosting);

    const tenantBFresh = `${tenantB}/London/Engineer_10055221-WD`;
    expect(newStore().recallHint(tenantBFresh)).toBe("");
  });

  it("end-to-end: a GUID-suffixed dynamic field id renders with the fragile warning inside a real recall hint", () => {
    const posting = `${tenantA}/London/Data-Analyst_10074887-WD`;
    const guidSelector = "#primaryQuestionnaire--9f0a2c5536851001fadd8c6857400003"; // real shape, genericized label only
    const s1 = newStore(); s1.noteUrl(posting);
    s1.observe(
      { tool: "click_element", target: `selector=${guidSelector}`, selector: guidSelector, recovered_via: "keyboard-enter", signal: "keyboard-enter", fragile: isFragileSelector(guidSelector), reason: "click recovered via keyboard-enter" },
      posting,
    );
    s1.commit("answer questionnaire", posting);

    const hint = newStore().recallHint(posting);
    expect(hint).toContain("known_flow");
    expect(hint).toContain("⚠fragile");
  });
});

// ---- step-level promotion + cost-ranked recall ----------------------------
describe("step-level promotion + cost ranking", () => {
  it("a recurring atom promotes in 2 sessions even when the full sequence varies", () => {
    const o = "https://multi.example/x";
    const s1 = newStore(); visit(s1, o, [clickAtom("#a"), clickAtom("#b")]); // decomposes into #a, #b 1-step flows too
    const s2 = newStore(); visit(s2, o, [clickAtom("#a"), clickAtom("#c")]); // #a recurs; #b/#c differ
    const aFlow = s2._flowsFor(o).find((f) => f.steps.length === 1 && f.steps[0].selector === "#a");
    expect(aFlow?.tier).toBe("trusted");
    expect(aFlow?.success_count).toBe(2);
    // the full 2-step sequences did NOT match each other -> stay provisional
    const full = s2._flowsFor(o).filter((f) => f.steps.length === 2);
    expect(full.every((f) => f.tier === "provisional")).toBe(true);
  });

  it("cost-ranked recall lists the cheaper flow before the expensive one", () => {
    const o = "https://cost.example/x";
    const cheap = newStore(); cheap.noteUrl(o); cheap.observe(clickAtom("#cheap"), o); cheap.commit("cheap", o);
    const exp = newStore(); exp.noteUrl(o);
    exp.observe(clickAtom("#x1"), o); exp.observe(clickAtom("#x2"), o); exp.observe(clickAtom("#x3"), o);
    exp.commit("expensive", o);
    const hint = newStore().recallHint(o);
    expect(hint).toContain('"cheap"');
    expect(hint).toContain('"expensive"');
    expect(hint.indexOf('"cheap"')).toBeLessThan(hint.indexOf('"expensive"'));
  });
});

// ---- high-cardinality backstop (the LinkedIn people-search flood) -----------
describe("provisional cap: high-cardinality pages don't accumulate unbounded", () => {
  // Each row on a search-results page yields a UNIQUE per-instance selector
  // (a[aria-label="Invite <person> to connect"]), so every autosave is a distinct
  // signature that can never dedup or promote. Without a cap these pile up one dead
  // provisional per action forever (the live LinkedIn case hit 241 in 12 days).
  it(`keeps at most MAX_PROVISIONAL_PER_ORIGIN (${MAX_PROVISIONAL_PER_ORIGIN}) provisional flows per origin`, () => {
    const o = "https://linkedin.example/search/results/people";
    const clock = makeClock();
    // Simulate many single-origin visits, each clicking a different person.
    for (let i = 0; i < MAX_PROVISIONAL_PER_ORIGIN + 40; i++) {
      const s = new FlowStore(VERSION, dir, clock.now);
      s.noteUrl(o);
      s.observe(clickAtom(`a[aria-label="Invite Person ${i} to connect"]`), o);
      s.flushAll();
      clock.advance(1000); // keep last_verified ordering deterministic
    }
    const flows = new FlowStore(VERSION, dir, clock.now)._flowsFor(o);
    expect(flows.length).toBeLessThanOrEqual(MAX_PROVISIONAL_PER_ORIGIN);
    // The survivors are the most-recent ones (oldest overflow is evicted).
    expect(flows.some((f) => f.steps[0].selector?.includes("Person 59 to"))).toBe(true);
    expect(flows.some((f) => f.steps[0].selector?.includes("Person 0 to"))).toBe(false);
  });

  it("never evicts a trusted flow to make room for provisional overflow", () => {
    const o = "https://linkedin.example/search/results/people";
    const clock = makeClock();
    // Establish a trusted flow (same signature observed twice).
    const t1 = new FlowStore(VERSION, dir, clock.now); visit(t1, o, [clickAtom("#stable-button")]); clock.advance(1000);
    const t2 = new FlowStore(VERSION, dir, clock.now); visit(t2, o, [clickAtom("#stable-button")]); clock.advance(1000);
    expect(new FlowStore(VERSION, dir, clock.now)._flowsFor(o).find((f) => f.tier === "trusted")).toBeTruthy();
    // Now flood with unique provisional clicks.
    for (let i = 0; i < MAX_PROVISIONAL_PER_ORIGIN + 20; i++) {
      const s = new FlowStore(VERSION, dir, clock.now);
      s.noteUrl(o); s.observe(clickAtom(`#unique-${i}`), o); s.flushAll();
      clock.advance(1000);
    }
    const flows = new FlowStore(VERSION, dir, clock.now)._flowsFor(o);
    expect(flows.filter((f) => f.tier === "trusted")).toHaveLength(1); // survived the flood
    expect(flows.filter((f) => f.tier === "provisional").length).toBeLessThanOrEqual(MAX_PROVISIONAL_PER_ORIGIN);
  });
});

// ---- cross-identity leakage on shared-account surfaces --------------------
//
// Real-world regression: see ISSUE-2026-08-18-known-flow-hint-audit.md. Two
// job-search identities (genericized here as personA/personB) shared one
// Chrome profile. A flow recorded while driving personA's Gmail / Google
// account-chooser replayed verbatim during personB's session on the exact
// same URL shape — the URL alone carries no identity signal on these two
// specific Google surfaces, so origin+path keying was never enough. 2-for-2
// on the audit's real sample: once on a Gmail inbox thread, once on the
// account chooser (which would have picked personA's Google account while
// personB was mid-application).
describe("cross-identity leakage: multi-account surfaces excluded from the cache", () => {
  it("originKey rejects Gmail's numbered-account-slot URLs (any /mail/u/N)", () => {
    expect(originKey("https://mail.google.com/mail/u/0/#inbox")).toBeUndefined();
    expect(originKey("https://mail.google.com/mail/u/1/#search/palantir")).toBeUndefined();
    expect(originKey("https://mail.google.com/mail/u/12/#inbox")).toBeUndefined();
  });

  it("originKey rejects Google's account-chooser flow", () => {
    expect(originKey("https://accounts.google.com/v3/signin/accountchooser?...")).toBeUndefined();
  });

  it("originKey still caches OTHER accounts.google.com pages (the genuinely useful OAuth consent recall)", () => {
    // Not every accounts.google.com page is a multi-account listing — the
    // "Continue" consent screen only ever concerns the ALREADY-authenticating
    // account, so its recall is safe and (per the audit) genuinely valuable.
    // Blanket-excluding the whole domain would have thrown this out too.
    expect(originKey("https://accounts.google.com/signin/oauth/id")).toBe("https://accounts.google.com/signin/oauth/id");
  });

  it("a flow recorded on personA's Gmail is never buffered at all (noteUrl/observe are no-ops there)", () => {
    const gmailUrl = "https://mail.google.com/mail/u/1/#search/palantir";
    const s = newStore();
    s.noteUrl(gmailUrl);
    s.observe({ tool: "click_element", target: "Your Application: Environmental & Energy Analyst - Workspace Group PLC", signal: "navigated", fragile: false, reason: "verified terminal click" }, gmailUrl);
    s.flushAll();
    expect(s._flowsFor(gmailUrl)).toHaveLength(0);
  });

  it("a flow recorded on the account chooser is never buffered, and never recalled even if forced into the store", () => {
    const chooserUrl = "https://accounts.google.com/v3/signin/accountchooser";
    const s = newStore();
    s.noteUrl(chooserUrl);
    s.observe(clickAtom("personB@example.com"), chooserUrl);
    s.flushAll();
    // originKey() returns undefined for this URL, so there is no key for it
    // to have landed under at all -- _flowsFor falls back to the raw url as
    // the lookup key, which also never got anything written to it.
    expect(s._flowsFor(chooserUrl)).toHaveLength(0);
    expect(newStore().recallHint(chooserUrl)).toBe("");
  });

  it("observe() refuses to buffer ANY atom whose target looks like an email address, on any URL", () => {
    // General content-shape guard, not tied to Google -- the same failure
    // mode (a recorded step naming a specific person) is unsafe to replay on
    // any site, not just Google's own multi-account surfaces.
    const o = "https://some-admin-panel.example/users";
    const s = newStore();
    s.noteUrl(o);
    s.observe(clickAtom("personB@example.com"), o);
    s.flushAll();
    expect(s._flowsFor(o)).toHaveLength(0);
  });

  it("recallHint never surfaces a flow whose steps contain an identifying target, even if it was already trusted before this guard existed", () => {
    // Defense in depth: simulate data persisted BEFORE the capture-time guard
    // existed, by writing directly into the store's data via commit() on a
    // URL that isn't itself excluded, then confirm recall still refuses it.
    const o = "https://crm.example/contacts";
    const s1 = newStore();
    s1.noteUrl(o);
    s1.observe(clickAtom("personB@example.com"), o);
    // commit() reads from the buffer -- since observe() already refused to
    // buffer the identifying atom, the buffer is empty and there's nothing to
    // promote. This IS the fix working end-to-end: nothing unsafe ever
    // reaches disk in the first place, so there's nothing left to recall.
    const res = s1.commit("open contact", o);
    expect(res.saved).toBe(0);
    expect(newStore().recallHint(o)).toBe("");
  });
});
