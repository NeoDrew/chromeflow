#!/usr/bin/env node
// Standalone local usage report for chromeflow's usage.jsonl log (see
// ../src/usage-log.ts for the writer). Dependency-free ESM so it runs with
// zero setup: `node packages/mcp-server/scripts/usage-stats.mjs`.
//
// This reads a LOCAL file only — no network calls, matching CLAUDE.md's
// "Telemetry / data handling": chromeflow sends nothing outbound.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const LOG_DIR = join(homedir(), ".chromeflow");
const LOG_PATH = join(LOG_DIR, "usage.jsonl");
const ROTATED_PATH = join(LOG_DIR, "usage.jsonl.1");

// Screenshots within this many ms of the previous screenshot are considered
// part of the same "burst" for the anti-spam check below.
const BURST_GAP_MS = 10_000;
// A run longer than this many screenshots is flagged. chromeflow's own skill
// docs (references/anti-bot.md, SKILL.md) tell agents to never take more
// than 1-2 screenshots in a row, so 3+ in a fast burst is a violation worth
// surfacing.
const BURST_FLAG_THRESHOLD = 2;
const SCREENSHOT_TYPE = "screenshot"; // internal ws message type for the take_screenshot tool

function readLines(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

// Tolerant JSONL parse: a hard crash mid-write can leave a partial last
// line, so a line that fails to parse (or doesn't look like a usage event)
// is skipped rather than crashing the whole report.
function parseEvents(lines) {
  const events = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj.ts !== "string" || typeof obj.type !== "string" || typeof obj.ok !== "boolean") {
      continue;
    }
    events.push(obj);
  }
  return events;
}

function loadAllEvents() {
  // Rotated backup is strictly older than the active log, but we sort by ts
  // below anyway rather than relying on file order.
  return [...parseEvents(readLines(ROTATED_PATH)), ...parseEvents(readLines(LOG_PATH))];
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildTypeStats(events) {
  const byType = new Map();
  for (const e of events) {
    let stats = byType.get(e.type);
    if (!stats) {
      stats = { type: e.type, total: 0, ok: 0, fail: 0, okDurationSum: 0 };
      byType.set(e.type, stats);
    }
    stats.total += 1;
    if (e.ok) {
      stats.ok += 1;
      if (typeof e.duration_ms === "number") stats.okDurationSum += e.duration_ms;
    } else {
      stats.fail += 1;
    }
  }
  return [...byType.values()].sort((a, b) => b.total - a.total);
}

// Scan take_screenshot events in chronological order and group consecutive
// calls into "bursts" wherever each call follows the previous one within
// BURST_GAP_MS. A burst longer than BURST_FLAG_THRESHOLD calls is flagged.
function findScreenshotBursts(events) {
  const shots = events
    .filter((e) => e.type === SCREENSHOT_TYPE)
    .map((e) => ({ ts: e.ts, t: Date.parse(e.ts) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const bursts = [];
  let runStart = 0;
  for (let i = 1; i <= shots.length; i++) {
    const withinGap = i < shots.length && shots[i].t - shots[i - 1].t <= BURST_GAP_MS;
    if (!withinGap) {
      const runLength = i - runStart;
      if (runLength > BURST_FLAG_THRESHOLD) {
        bursts.push({
          start: shots[runStart].ts,
          end: shots[i - 1].ts,
          length: runLength,
        });
      }
      runStart = i;
    }
  }
  return { totalShots: shots.length, bursts };
}

function printReport(events) {
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  console.log("chromeflow usage report");
  console.log("========================");
  console.log(`Total calls: ${events.length}`);
  console.log(`Time range:  ${first.ts}  ->  ${last.ts}`);
  console.log("");

  console.log("Calls per tool (sorted by volume)");
  console.log("----------------------------------");
  const typeStats = buildTypeStats(events);
  const nameWidth = Math.max(4, ...typeStats.map((s) => s.type.length));
  for (const s of typeStats) {
    const errorRate = s.total > 0 ? ((s.fail / s.total) * 100).toFixed(1) : "0.0";
    const avgOkDuration = s.ok > 0 ? formatMs(s.okDurationSum / s.ok) : "n/a";
    console.log(
      `  ${s.type.padEnd(nameWidth)}  calls=${String(s.total).padStart(5)}  errors=${errorRate.padStart(5)}%  avg_ok_duration=${avgOkDuration}`
    );
  }
  console.log("");

  console.log("Screenshot spam check (take_screenshot bursts)");
  console.log("------------------------------------------------");
  const { totalShots, bursts } = findScreenshotBursts(events);
  console.log(`Total take_screenshot calls: ${totalShots}`);
  console.log(
    `A "burst" = more than ${BURST_FLAG_THRESHOLD} consecutive take_screenshot calls, each within ${BURST_GAP_MS / 1000}s of the previous one.`
  );
  if (bursts.length === 0) {
    console.log("No bursts found. Screenshot usage looks fine.");
  } else {
    console.log(`Found ${bursts.length} burst(s):`);
    for (const b of bursts) {
      console.log(`  - ${b.length} calls, ${b.start} -> ${b.end}`);
    }
  }
}

function main() {
  const haveActive = existsSync(LOG_PATH);
  const haveRotated = existsSync(ROTATED_PATH);
  if (!haveActive && !haveRotated) {
    console.log("No usage recorded yet. Use chromeflow tools, then re-run this script.");
    return;
  }

  const events = loadAllEvents();
  if (events.length === 0) {
    console.log("No usage recorded yet (log file exists but has no readable entries).");
    return;
  }

  printReport(events);
}

main();
