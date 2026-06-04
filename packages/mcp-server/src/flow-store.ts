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
// Capture is explicit: the in-memory buffer records only NOTABLE atoms (ones
// that cost something to discover — a fallback fired, a verified submit, a field
// that needed real keystrokes); save_flow() commits the buffer to disk. Recall
// is passive: a compact hint is injected into an existing tool response at most
// once per origin per session.

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

interface Flow {
  id: string;
  task_label: string;
  steps: Atom[];
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

export class FlowStore {
  private path: string;
  private data: StoreData;
  private version: string;
  // In-memory, per-session state (never persisted):
  private buffer = new Map<string, Atom[]>();   // notable atoms not yet committed, by origin
  private surfaced = new Set<string>();          // origins whose recall hint already fired this session
  private lastOrigin: string | undefined;

  constructor(version: string, baseDir?: string) {
    this.version = version;
    this.path = join(baseDir ?? join(homedir(), ".chromeflow"), "flows.json");
    this.data = this.load();
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

  /** Update the "current origin" from any URL chromeflow observed. */
  noteUrl(url: string | undefined): void {
    const k = originKey(url);
    if (k) this.lastOrigin = k;
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
    list.push(atom);
    this.buffer.set(k, list);
  }

  /** Compact recall hint for an origin, at most once per origin per session. */
  recallHint(url: string | undefined): string {
    const k = originKey(url);
    if (!k || this.surfaced.has(k)) return "";
    const flows = this.data.origins[k];
    if (!flows || flows.length === 0) return "";
    this.surfaced.add(k);
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

  /** Nudge to save buffered hard-won steps, when there are uncommitted ones. */
  capturableHint(url: string | undefined): string {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k) return "";
    const buf = this.buffer.get(k);
    if (!buf || buf.length === 0) return "";
    const reasons = [...new Set(buf.map((a) => a.reason))].slice(0, 2).join("; ");
    return `\n\nℹ flow_capturable: ${buf.length} hard-won step(s) on ${k} not yet saved (${reasons}). Call save_flow("<task label>") to persist them so future runs skip the trial-and-error.`;
  }

  /** Commit the buffered atoms for an origin as a named flow. */
  commit(taskLabel: string, url?: string): { saved: number; origin: string | null; message: string } {
    const k = originKey(url) ?? this.lastOrigin;
    if (!k) return { saved: 0, origin: null, message: "No origin known yet — navigate or interact with a page first." };
    const buf = this.buffer.get(k) ?? [];
    if (buf.length === 0) {
      return { saved: 0, origin: k, message: `Nothing notable buffered for ${k}. Flows capture hard-won steps (a fallback fired, a verified submit, a field needing real keystrokes) — an ordinary first-try click isn't recorded.` };
    }
    const now = new Date().toISOString();
    const sig = JSON.stringify(buf.map((a) => [a.tool, a.target, a.selector ?? ""]));
    const flows = this.data.origins[k] ?? [];
    // Same label + same step signature already saved → bump confidence instead of duplicating.
    const existing = flows.find((f) => f.task_label === taskLabel && JSON.stringify(f.steps.map((a) => [a.tool, a.target, a.selector ?? ""])) === sig);
    if (existing) {
      existing.success_count += 1;
      existing.last_verified = now;
      existing.chromeflow_version = this.version;
    } else {
      flows.push({
        id: `${k}#${flows.length + 1}`,
        task_label: taskLabel,
        steps: buf,
        created_at: now,
        last_verified: now,
        success_count: 1,
        fail_count: 0,
        chromeflow_version: this.version,
      });
    }
    this.data.origins[k] = flows;
    this.buffer.delete(k);
    this.persist();
    return { saved: buf.length, origin: k, message: `Saved flow "${taskLabel}" (${buf.length} steps) for ${k}.` };
  }
}

/** Mark a selector fragile if it leans on a positional pseudo-class. */
export function isFragileSelector(selector: string | undefined): boolean {
  return !!selector && FRAGILE_RE.test(selector);
}
