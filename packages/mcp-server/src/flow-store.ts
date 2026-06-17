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
//   - Only TRUSTED flows are surfaced on recall.
//   - Failure feedback: a recalled trusted step that fails on replay raises the
//     flow's fail_count; at PRUNE_AT_FAILS the flow is dropped. So a flow that
//     stops working self-heals out of the store.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface Atom {
  tool: string;            // click_element | type_text | ...
  target: string;          // textHint / selector / into_selector that worked
  selector?: string;       // explicit CSS selector when one was used
  recovered_via?: string;  // fallback path that finally fired (pointer-chain, onChange, ...)
  signal?: string;         // success signal (until_url_change, navigated, request_in_flight, ...)
  fragile?: boolean;       // resolved only via a positional selector — likely to drift
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
  chromeflow_version: string;
}

interface StoreData {
  version: 1;
  origins: Record<string, Flow[]>;
}

// Tuning constants (exported so tests and docs share one source of truth).
export const PROMOTE_AT_SUCCESS = 2;                       // re-observations to trust a provisional flow
export const PRUNE_AT_FAILS = 2;                           // recalled-step failures before a flow is dropped
export const PROVISIONAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // unpromoted autosaves expire after 30 days

// Only these keys are ever persisted from an Atom — a hard whitelist so a future
// field (or a caller mistake) can never leak typed text / PII to disk.
const ATOM_KEYS: (keyof Atom)[] = ["tool", "target", "selector", "recovered_via", "signal", "fragile", "reason"];

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

export class FlowStore {
  private path: string;
  private data: StoreData;
  private version: string;
  private now: () => number;
  // In-memory, per-session state (never persisted):
  private buffer = new Map<string, Atom[]>();   // notable atoms not yet committed, by origin
  private surfaced = new Set<string>();          // origins whose recall hint already fired this session
  private recalled = new Set<string>();          // origins whose trusted flow was actually shown this session
  private lastOrigin: string | undefined;

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
    const list = this.buffer.get(k) ?? [];
    // De-dupe consecutive identical atoms (e.g. a retried click).
    const sig = `${atom.tool}|${atom.target}|${atom.selector ?? ""}`;
    if (list.some((a) => `${a.tool}|${a.target}|${a.selector ?? ""}` === sig)) return;
    list.push(sanitizeAtom(atom));
    this.buffer.set(k, list);
  }

  /** Autosave a single origin's buffer as a provisional flow (or promote a match). */
  private autoCommit(k: string): void {
    const buf = this.buffer.get(k);
    if (!buf || buf.length === 0) return;
    this.buffer.delete(k);
    this.upsert(k, buf, null);
    this.pruneExpired();
    this.persist();
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
      existing.chromeflow_version = this.version;
      if (label !== null) {
        existing.tier = "trusted";        // manual vouch = instant promote
        existing.task_label = label;
      } else if (existing.success_count >= PROMOTE_AT_SUCCESS) {
        existing.tier = "trusted";        // earned promotion
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
        chromeflow_version: this.version,
      });
    }
    this.data.origins[k] = flows;
    return { saved: steps.length };
  }

  /** Compact recall hint for an origin (TRUSTED flows only), at most once per origin per session. */
  recallHint(url: string | undefined): string {
    const k = originKey(url);
    if (!k || this.surfaced.has(k)) return "";
    const flows = (this.data.origins[k] ?? []).filter((f) => f.tier === "trusted");
    if (flows.length === 0) return "";
    this.surfaced.add(k);
    this.recalled.add(k); // failures may now be attributed to these flows
    const best = [...flows].sort((a, b) => b.success_count - a.success_count).slice(0, 3);
    const lines = best.map((f) => {
      const steps = f.steps
        .map((s, i) => {
          const via = s.recovered_via ? ` [via ${s.recovered_via}]` : "";
          const sig = s.signal ? ` (${s.signal})` : "";
          const frag = s.fragile ? " ⚠fragile-selector" : "";
          return `   ${i + 1}. ${s.tool} ${s.target}${sig}${via}${frag}`;
        })
        .join("\n");
      const stale = f.chromeflow_version !== this.version ? ` recorded on v${f.chromeflow_version}, re-verify` : "";
      return `  "${f.task_label}" (${f.steps.length} steps, ${f.success_count}x ok${stale}):\n${steps}`;
    });
    return `\n\nℹ known_flow for ${k} — prefer these proven steps over rediscovery (verify each as usual):\n${lines.join("\n")}`;
  }

  /**
   * A recalled trusted step failed on replay. Raise its fail_count; drop the flow
   * once it crosses PRUNE_AT_FAILS. Gated on the flow having actually been recalled
   * this session, so an unrelated failure can't ding a flow the agent never used.
   */
  observeFailure(url: string | undefined, selectorOrText: string | undefined): void {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k || !selectorOrText || !this.recalled.has(k)) return;
    const flows = this.data.origins[k];
    if (!flows) return;
    let changed = false;
    for (const f of flows) {
      if (f.tier !== "trusted") continue;
      const hit = f.steps.some((s) => s.selector === selectorOrText || s.target === selectorOrText || s.target === `selector=${selectorOrText}`);
      if (hit) { f.fail_count += 1; changed = true; }
    }
    if (changed) {
      this.pruneExpired(); // drops anything now at/over the fail ceiling
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

/** Mark a selector fragile if it leans on a positional pseudo-class. */
export function isFragileSelector(selector: string | undefined): boolean {
  return !!selector && FRAGILE_RE.test(selector);
}
