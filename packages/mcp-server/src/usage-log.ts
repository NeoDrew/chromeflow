// Local usage logging: an append-only JSONL record of every MCP tool call
// (name, success/failure, duration) so a human can run
// `scripts/usage-stats.mjs` and answer "how many of each command ran" and
// "is it spamming screenshots when it shouldn't." Local file only, no
// network call anywhere in this module — see CLAUDE.md's "Telemetry / data
// handling" section, which is explicit that chromeflow sends nothing
// outbound.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync, renameSync, appendFileSync, mkdirSync } from "node:fs";

export interface UsageEvent {
  ts: string;
  type: string;
  ok: boolean;
  duration_ms: number;
  error?: string;
}

const LOG_DIR = join(homedir(), ".chromeflow");
const LOG_PATH = join(LOG_DIR, "usage.jsonl");
const ROTATED_PATH = join(LOG_DIR, "usage.jsonl.1");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const ERROR_TRUNCATE_LEN = 200;

// Simple size-based rotation: once the active log crosses MAX_LOG_BYTES,
// shift it to the single ".1" backup (overwriting whatever was there) and
// start a fresh file. Keeping exactly one backup bounds disk usage forever
// without needing a log-rotation dependency.
function rotateIfNeeded(): void {
  if (!existsSync(LOG_PATH)) return;
  const { size } = statSync(LOG_PATH);
  if (size <= MAX_LOG_BYTES) return;
  renameSync(LOG_PATH, ROTATED_PATH);
}

/**
 * Append one usage event to the local log. Synchronous and best-effort: a
 * filesystem hiccup here must never throw into, or delay, a real tool call.
 * Logging is a pure side effect — the caller's own success/failure path is
 * always what actually resolves/rejects, regardless of what happens here.
 */
export function recordUsage(event: UsageEvent): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(LOG_PATH, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // Best-effort only. A disk-full or permissions error here must not
    // surface to the caller of the tool call being logged.
  }
}

/**
 * Wrap a promise-returning call with usage timing. Records ok:true/false and
 * elapsed duration on settle, then resolves or rejects exactly as `fn()`
 * would have, so the wrapped call is behaviorally identical to calling
 * `fn()` directly — logging is invisible on both the success and failure
 * path.
 */
export async function timeAndRecord<T>(type: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordUsage({ ts: new Date().toISOString(), type, ok: true, duration_ms: Date.now() - start });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordUsage({
      ts: new Date().toISOString(),
      type,
      ok: false,
      duration_ms: Date.now() - start,
      error: message.slice(0, ERROR_TRUNCATE_LEN),
    });
    throw err;
  }
}
