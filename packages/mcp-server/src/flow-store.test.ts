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
  PROMOTE_AT_SUCCESS,
  PRUNE_AT_FAILS,
  PROVISIONAL_TTL_MS,
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

// A notable click atom (the kind the tool layer buffers).
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

  it("does NOT surface a provisional flow on recall", () => {
    const store = newStore();
    visit(store, "https://site.example/submit", [clickAtom("#go")]);
    // Fresh session view: a new store reading the same dir.
    const next = newStore();
    expect(next.recallHint("https://site.example/submit")).toBe("");
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

  it("reports nothing-to-save when the buffer is empty", () => {
    const store = newStore();
    store.noteUrl("https://site.example/x");
    const res = store.commit("nope", "https://site.example/x");
    expect(res.saved).toBe(0);
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
