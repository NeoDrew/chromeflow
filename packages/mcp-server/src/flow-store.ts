// Flow memory: a LOCAL, per-origin store of hard-won interaction "resolutions"
// (the selector/tool/fallback that actually worked) so chromeflow stops
// re-discovering the same site every session.
//
// Design constraints (see CLAUDE.md "deliberately NOT in chromeflow"):
//   - Local only. No cloud, no telemetry, no embedding/LLM dependency. Retrieval
//     is a structured per-origin lookup, not vector search.
//   - Guidance only. We surface what worked back to the agent; we NEVER replay
//     autonomously. The agent verifies each recalled step with its usual until_*.
//   - Privacy. We persist selectors/tools/success-signals ONLY — never the typed
//     text (passwords, post bodies, PII) and never the URL query string.
//
// Earn-in lifecycle (two tiers, MCTS-style confidence):
//   - Capture is automatic. The in-memory buffer records only NOTABLE atoms (ones
//     that cost something to discover). Leaving an origin (or flushAll() on
//     shutdown) AUTOSAVES the buffer as a PROVISIONAL flow — no model call needed.
//   - Provisional flows are NEVER recalled. A wrong / one-off autosave can never
//     misdirect a future run; it simply sits unused and TTL-expires.
//   - A provisional flow is PROMOTED to trusted only once its exact step-signature
//     has been independently re-observed PROMOTE_AT_SUCCESS times, OR when the
//     model explicitly save_flow()s it (an instant vouch).
//   - Only TRUSTED flows are surfaced on recall, and only while they are RELIABLE
//     (success_count > fail_count and the last replay didn't fail).
//   - Self-correction: a recalled step that FAILS on replay, or that the agent
//     silently rediscovered with a different locator (mismatch), DEMOTES the flow
//     to provisional on the first miss (so it stops misleading) and PRUNES it on
//     the second. This is what keeps memory net-positive on dynamic / anti-bot
//     sites where a stored selector can drift.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface Atom {
  tool: string;            // click_element | type_text | ...
  target: string;          // textHint / selector / into_selector that worked
  selector?: string;       // explicit CSS selector when one was used
  recovered_via?: string;  // fallback path that finally fired (react-fiber, tap-gesture, dom-click, ...)
  signal?: string;         // success signal (until_url_change, navigated, request_in_flight, ...)
  verification?: string;   // the until_* / expect_submit arg that verified this step (for replay)
  clear_first?: boolean;   // type_text: the field needed select-all+delete before typing
  fragile?: boolean;       // resolved via a positional or multi-option selector — likely to drift
  reason: string;          // why this was worth persisting
}

export type Tier = "provisional" | "trusted";

interface Flow {
  id: string;
  task_label: string;
  steps: Atom[];
  tier: Tier;
  created_at: string;
  last_verified: string;
  success_count: number;
  fail_count: number;
  last_replay_ok?: boolean; // false once a recalled replay failed/mismatched; gates recall
  chromeflow_version: string;
}

interface StoreData {
  version: 1;
  origins: Record<string, Flow[]>;
}

// Tuning constants (exported so tests and docs share one source of truth).
export const PROMOTE_AT_SUCCESS = 2;                       // re-observations to trust a provisional flow
export const DEMOTE_AT_FAILS = 1;                          // a single bad replay demotes trusted -> provisional
export const PRUNE_AT_FAILS = 2;                           // second failure drops the flow entirely
export const PROVISIONAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // unpromoted autosaves expire after 30 days
export const MAX_PROVISIONAL_PER_ORIGIN = 20;             // backstop: cap dead provisional junk per origin

// Only these keys are ever persisted from an Atom — a hard whitelist so a future
// field (or a caller mistake) can never leak typed text / PII to disk.
const ATOM_KEYS: (keyof Atom)[] = ["tool", "target", "selector", "recovered_via", "signal", "verification", "clear_first", "fragile", "reason"];

// origin + pathname, query/hash stripped (so session tokens never hit disk).
export function originKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return u.origin + path;
  } catch {
    return undefined;
  }
}

const FRAGILE_RE = /:nth-(of-type|child)\(|>\s*\w+:nth/;

// Stable signature of a step sequence — promotion and dedupe both key on this.
function signatureOf(steps: Atom[]): string {
  return JSON.stringify(steps.map((a) => [a.tool, a.target, a.selector ?? ""]));
}

// Execution cost of a flow, for cost-ranked recall: each step costs 1, a fragile
// (positional / multi-option) selector or a recovered-via fallback adds risk
// weight. Lower cost = cheaper + more reliable = recommended first.
function flowCost(f: { steps: Atom[] }): number {
  return f.steps.reduce((c, s) => c + 1 + (s.fragile ? 1 : 0) + (s.recovered_via ? 0.5 : 0), 0);
}

function sanitizeAtom(a: Atom): Atom {
  const out = {} as Atom;
  for (const k of ATOM_KEYS) {
    if (a[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = a[k];
  }
  return out;
}

// A short, human-ish label for an autosaved flow (the model didn't name it).
function autoLabel(k: string, steps: Atom[]): string {
  const tools = [...new Set(steps.map((s) => s.tool.replace("_element", "")))].join("+");
  let path = "/";
  try { path = new URL(k).pathname || "/"; } catch { /* k is already origin+path */ }
  return `auto: ${tools} @ ${path}`;
}

// The actionable dispatch mode to skip cold rediscovery of the fallback chain.
// react-fiber is the one that pays to replay explicitly (skips the whole CDP ->
// silent-reject -> fallback probe). tap-gesture / keyboard-enter / dom-click /
// pointer-chain are reached automatically by the default "auto" path, so we don't
// pin a `via` for them — we just keep the verification so the agent confirms.
function actionableVia(recovered_via?: string): string | null {
  if (recovered_via && recovered_via.includes("fiber")) return "fiber";
  return null;
}

// Render a stored step as a ready-to-run tool call, so the agent issues the
// PROVEN call directly instead of rediscovering the dispatch strategy.
function renderStep(s: Atom, i: number): string {
  const fragNote = s.fragile ? "  ⚠fragile — if it misses on the first try, do NOT retry it; rediscover" : "";
  if (s.tool === "type_text") {
    const sel = s.selector ?? s.target;
    const cf = s.clear_first ? ", clear_first=true" : "";
    return `   ${i + 1}. type_text(into_selector=${JSON.stringify(sel)}${cf})${fragNote}`;
  }
  if (s.tool === "click_element") {
    const isSel = s.target.startsWith("selector=");
    const targ = isSel
      ? `selector=${JSON.stringify(s.selector ?? s.target.replace(/^selector=/, ""))}`
      : `textHint=${JSON.stringify(s.target)}`;
    const via = actionableVia(s.recovered_via);
    const viaStr = via ? `, via=${JSON.stringify(via)}` : "";
    const ver = s.verification
      ? `, ${s.verification}`
      : (s.signal === "navigated" || s.signal === "until_url_change" ? ", until_url_changes=true" : "");
    return `   ${i + 1}. click_element(${targ}${viaStr}${ver})${fragNote}`;
  }
  return `   ${i + 1}. ${s.tool} ${s.target}${s.fragile ? "  ⚠fragile" : ""}`;
}

export class FlowStore {
  private path: string;
  private data: StoreData;
  private version: string;
  private now: () => number;
  // In-memory, per-session state (never persisted):
  private buffer = new Map<string, Atom[]>();   // notable atoms not yet committed, by origin
  private surfaced = new Set<string>();          // origins whose recall hint already fired this session
  private recalled = new Set<string>();          // origins whose trusted flow was actually shown this session
  private recalledFlows = new Map<string, Flow[]>(); // the flows we showed, for mismatch/confirm attribution
  private dinged = new Set<string>();            // flow ids already failed this session (no double-count)
  private lastOrigin: string | undefined;
  private lastAutosaved: { key: string; sig: string } | null = null; // most recent autosave, for save_flow to vouch for

  constructor(version: string, baseDir?: string, now: () => number = Date.now) {
    this.version = version;
    this.now = now;
    this.path = join(baseDir ?? join(homedir(), ".chromeflow"), "flows.json");
    this.data = this.load();
    this.pruneExpired();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private load(): StoreData {
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf-8"));
        if (parsed && parsed.version === 1 && parsed.origins) return parsed as StoreData;
      }
    } catch {
      // Corrupt file: back it up and start clean rather than crash the server.
      try { renameSync(this.path, this.path + ".corrupt"); } catch { /* ignore */ }
    }
    return { version: 1, origins: {} };
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = this.path + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, this.path); // atomic — concurrent sessions can't half-write
    } catch {
      // Persistence is best-effort; a failed write must not break the tool call.
    }
  }

  /** Drop expired provisional flows and any flow already past the fail ceiling. */
  private pruneExpired(): void {
    const cutoff = this.now() - PROVISIONAL_TTL_MS;
    let changed = false;
    for (const [k, flows] of Object.entries(this.data.origins)) {
      const kept = flows.filter((f) => {
        if (f.fail_count >= PRUNE_AT_FAILS) return false;
        if (f.tier === "provisional" && Date.parse(f.last_verified) < cutoff) return false;
        return true;
      });
      if (kept.length !== flows.length) {
        changed = true;
        if (kept.length === 0) delete this.data.origins[k];
        else this.data.origins[k] = kept;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Record a failed/mismatched replay against a flow: demote on first, prune on
   * second (via pruneExpired's PRUNE_AT_FAILS check). `dedupeKey` collapses the
   * repeated mismatch check (which runs on every observe) to one ding per flow
   * per session; explicit tool failures pass no key so each real failure counts.
   */
  private failFlow(f: Flow, dedupeKey?: string): void {
    if (dedupeKey) {
      if (this.dinged.has(dedupeKey)) return;
      this.dinged.add(dedupeKey);
    }
    f.fail_count += 1;
    f.last_replay_ok = false;
    if (f.tier === "trusted" && f.fail_count >= DEMOTE_AT_FAILS) f.tier = "provisional";
  }

  /**
   * Update the "current origin". Crossing to a DIFFERENT origin first autosaves
   * the origin we are leaving — that boundary is our best server-side proxy for
   * "a task on that site just finished".
   */
  noteUrl(url: string | undefined): void {
    const k = originKey(url);
    if (!k) return;
    if (this.lastOrigin && this.lastOrigin !== k && (this.buffer.get(this.lastOrigin)?.length ?? 0) > 0) {
      this.autoCommit(this.lastOrigin);
    }
    this.lastOrigin = k;
  }

  /** Buffer a notable atom against an origin (defaults to last-seen origin). */
  observe(atom: Atom | null, url?: string): void {
    if (!atom) return;
    const k = originKey(url) ?? this.lastOrigin;
    if (!k) return;
    this.reconcileAgainstRecalled(k, atom); // confirm or ding the recalled flow this step relates to
    const list = this.buffer.get(k) ?? [];
    // De-dupe consecutive identical atoms (e.g. a retried click).
    const sig = `${atom.tool}|${atom.target}|${atom.selector ?? ""}`;
    if (list.some((a) => `${a.tool}|${a.target}|${a.selector ?? ""}` === sig)) return;
    list.push(sanitizeAtom(atom));
    this.buffer.set(k, list);
  }

  /**
   * When the agent performs a notable step on an origin we recalled a flow for,
   * compare it to the recalled steps of the same tool:
   *   - same locator  -> the recalled step worked: mark the flow's replay OK.
   *   - different locator (and the recalled one was never used) -> the stored
   *     selector was wrong; the agent silently rediscovered -> fail the flow.
   * This catches the "wrong element but technically succeeded" case that the
   * explicit failure signal misses, and is what neutralises a drifted Reddit-style
   * shadow-DOM selector before it costs another session.
   */
  private reconcileAgainstRecalled(k: string, atom: Atom): void {
    const shown = this.recalledFlows.get(k);
    if (!shown) return;
    const atomLoc = atom.selector ?? atom.target;
    let changed = false;
    for (const f of shown) {
      const sameTool = f.steps.filter((s) => s.tool === atom.tool);
      if (sameTool.length === 0) continue;
      const usedRecalled = sameTool.some((s) => (s.selector ?? s.target) === atomLoc || s.target === atom.target);
      if (usedRecalled) {
        if (f.last_replay_ok !== true) { f.last_replay_ok = true; changed = true; } // confirmed good replay
      } else {
        const before = f.fail_count;
        this.failFlow(f, `mismatch:${f.id}`); // agent re-did this kind of step with a different locator
        if (f.fail_count !== before) changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Autosave a single origin's buffer as a provisional flow (or promote a match). */
  private autoCommit(k: string): void {
    const buf = this.buffer.get(k);
    if (!buf || buf.length === 0) return;
    this.buffer.delete(k);
    this.upsert(k, buf, null);
    // Step-level promotion: also register each atom as its own 1-step flow so a
    // recurring individual step (e.g. type_text -> textarea[name="q"]) earns
    // trust on its own, even when the agent's full captured sequence varies
    // run-to-run. This is what lets a hard site converge in ~2 sessions instead
    // of waiting for an identical multi-step sequence to repeat. The cheaper
    // 1-step flow then wins recall via cost-ranking below.
    if (buf.length > 1) {
      for (const atom of buf) this.upsert(k, [atom], null);
    }
    this.lastAutosaved = { key: k, sig: signatureOf(buf) }; // save_flow can still vouch for this
    this.capProvisional(k);
    this.pruneExpired();
    this.persist();
  }

  /**
   * Backstop against unbounded growth on high-cardinality pages. A search-results
   * or feed page produces a fresh per-instance selector on every action (a person's
   * name, a post id), so each autosave is a distinct signature that can never dedup,
   * never recur, and never promote — it just piles up one dead provisional per action.
   * The notability gate already screens most of these out; this caps whatever slips
   * through. Trusted flows are never evicted; only the oldest provisional overflow is.
   */
  private capProvisional(k: string): void {
    const flows = this.data.origins[k];
    if (!flows) return;
    const provisional = flows.filter((f) => f.tier === "provisional");
    if (provisional.length <= MAX_PROVISIONAL_PER_ORIGIN) return;
    const doomed = new Set(
      [...provisional]
        .sort((a, b) => Date.parse(a.last_verified) - Date.parse(b.last_verified))
        .slice(0, provisional.length - MAX_PROVISIONAL_PER_ORIGIN),
    );
    this.data.origins[k] = flows.filter((f) => !doomed.has(f));
  }

  /** Flush every buffered origin. Call on shutdown and for single-origin sessions. */
  flushAll(): void {
    for (const k of [...this.buffer.keys()]) this.autoCommit(k);
  }

  /**
   * Insert or reinforce a flow for an origin.
   * label === null  → autosave: create provisional, or bump+maybe-promote a match.
   * label is string → manual save_flow: create trusted, or promote+relabel a match.
   */
  private upsert(k: string, steps: Atom[], label: string | null): { saved: number } {
    const now = this.nowIso();
    const sig = signatureOf(steps);
    const flows = this.data.origins[k] ?? [];
    const existing = flows.find((f) => signatureOf(f.steps) === sig);
    if (existing) {
      existing.success_count += 1;
      existing.last_verified = now;
      existing.last_replay_ok = true;
      existing.chromeflow_version = this.version;
      if (label !== null) {
        existing.tier = "trusted";        // manual vouch = instant promote
        existing.task_label = label;
      } else if (existing.success_count - existing.fail_count >= PROMOTE_AT_SUCCESS) {
        existing.tier = "trusted";        // earned promotion (net of any failures)
      }
    } else {
      flows.push({
        id: `${k}#${flows.length + 1}`,
        task_label: label ?? autoLabel(k, steps),
        steps,
        tier: label !== null ? "trusted" : "provisional",
        created_at: now,
        last_verified: now,
        success_count: 1,
        fail_count: 0,
        last_replay_ok: true,
        chromeflow_version: this.version,
      });
    }
    this.data.origins[k] = flows;
    return { saved: steps.length };
  }

  /** Compact recall hint for an origin (RELIABLE trusted flows only), once per origin per session. */
  recallHint(url: string | undefined): string {
    const k = originKey(url);
    if (!k || this.surfaced.has(k)) return "";
    const flows = (this.data.origins[k] ?? []).filter(
      (f) => f.tier === "trusted" && f.success_count > f.fail_count && f.last_replay_ok !== false,
    );
    if (flows.length === 0) return "";
    this.surfaced.add(k);
    this.recalled.add(k);                 // failures may now be attributed to these flows
    // Cost-ranked recall: recommend the CHEAPEST proven path first — fewer
    // operations, no fragile selector, no recovered-via fallback. A flow that
    // does the job in one clean step is preferred over a longer/riskier one, so
    // the agent spends the fewest tokens. Ties break toward the more-proven flow.
    const best = [...flows].sort((a, b) => {
      const ca = flowCost(a), cb = flowCost(b);
      if (ca !== cb) return ca - cb;
      return b.success_count - a.success_count;
    }).slice(0, 3);
    this.recalledFlows.set(k, best);      // for confirm/mismatch reconciliation in observe()
    const lines = best.map((f) => {
      const steps = f.steps.map((s, i) => renderStep(s, i)).join("\n");
      const stale = f.chromeflow_version !== this.version ? ` recorded on v${f.chromeflow_version}, re-verify` : "";
      return `  "${f.task_label}" (${f.steps.length} steps, ${f.success_count}x ok${stale}):\n${steps}`;
    });
    return `\n\nℹ known_flow for ${k} — these calls worked before; prefer them over rediscovery, but VERIFY each. ` +
      `If a recalled step fails or its element isn't found on the first attempt, do NOT retry it — discard the hint and rediscover from scratch.\n${lines.join("\n")}`;
  }

  /**
   * A recalled step failed on replay (a click that returned success:false, or a
   * type_text that did not land). Demote the matching flow on the first miss,
   * prune on the second. Gated on the flow having actually been recalled this
   * session, so an unrelated failure can't ding a flow the agent never used.
   */
  observeFailure(url: string | undefined, selectorOrText: string | undefined): void {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k || !selectorOrText || !this.recalled.has(k)) return;
    const flows = this.data.origins[k];
    if (!flows) return;
    let changed = false;
    for (const f of flows) {
      const hit = f.steps.some(
        (s) => s.selector === selectorOrText || s.target === selectorOrText || s.target === `selector=${selectorOrText}`,
      );
      if (hit) { this.failFlow(f); changed = true; }
    }
    if (changed) {
      this.pruneExpired(); // drops anything now at/over the prune ceiling
      this.persist();
    }
  }

  /** Nudge to save buffered hard-won steps — kept as the manual instant-vouch path. */
  capturableHint(url: string | undefined): string {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k) return "";
    const buf = this.buffer.get(k);
    if (!buf || buf.length === 0) return "";
    const reasons = [...new Set(buf.map((a) => a.reason))].slice(0, 2).join("; ");
    return `\n\nℹ flow_capturable: ${buf.length} hard-won step(s) on ${k} buffered (${reasons}). They autosave on leaving the site; call save_flow("<task label>") to trust them immediately.`;
  }

  /** Manual save_flow: commit the buffered atoms for an origin as a TRUSTED flow. */
  commit(taskLabel: string, url?: string): { saved: number; origin: string | null; message: string } {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k) return { saved: 0, origin: null, message: "No origin known yet — navigate or interact with a page first." };
    const buf = this.buffer.get(k) ?? [];
    if (buf.length === 0) {
      // The steps may have already autosaved — e.g. the notable action itself
      // navigated to a new origin+path, flushing the buffer before save_flow
      // was called. Vouch for that freshly-autosaved provisional flow instead
      // of reporting nothing, so the manual instant-trust still lands.
      if (this.lastAutosaved) {
        const flows = this.data.origins[this.lastAutosaved.key] ?? [];
        const f = flows.find((x) => signatureOf(x.steps) === this.lastAutosaved!.sig);
        if (f) {
          f.tier = "trusted";
          f.task_label = taskLabel;
          f.last_verified = this.nowIso();
          const promotedKey = this.lastAutosaved.key;
          this.lastAutosaved = null; // a second save_flow shouldn't re-promote the same thing
          this.persist();
          return { saved: f.steps.length, origin: promotedKey, message: `Promoted the just-autosaved flow to trusted: "${taskLabel}" (${f.steps.length} steps) for ${promotedKey}.` };
        }
      }
      return { saved: 0, origin: k, message: `Nothing notable buffered for ${k}. Flows capture hard-won steps (a fallback fired, a verified submit, a field needing real keystrokes) — an ordinary first-try click isn't recorded.` };
    }
    this.buffer.delete(k);
    const { saved } = this.upsert(k, buf, taskLabel);
    this.pruneExpired();
    this.persist();
    return { saved, origin: k, message: `Saved flow "${taskLabel}" (${saved} steps) for ${k} — trusted.` };
  }

  /** Test-only accessor: the persisted flows for an origin. */
  _flowsFor(url: string): Flow[] {
    const k = originKey(url) ?? url;
    return this.data.origins[k] ?? [];
  }
}

/** Mark a selector fragile if it leans on a positional pseudo-class OR lists
 *  multiple fallback selectors (a comma list = "we weren't sure which matched"). */
export function isFragileSelector(selector: string | undefined): boolean {
  if (!selector) return false;
  return FRAGILE_RE.test(selector) || selector.includes(",");
}
