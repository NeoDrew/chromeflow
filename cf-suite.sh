#!/usr/bin/env bash
# Live earn-in test suite: spawns fresh headless claude instances (each its own
# chromeflow MCP server v0.12.0) sequentially against different sites, exercising
# every mechanic, then deterministically checks failure-prune + TTL.
set -uo pipefail
LOG=/tmp/cf-suite.log
RUNS=/tmp/cf-runs
: > "$LOG"
rm -rf "$RUNS"; mkdir -p "$RUNS"
FLOWS="$HOME/.chromeflow/flows.json"

say() { echo "$@" | tee -a "$LOG"; }

summary() {
  python3 - "$FLOWS" <<'PY' 2>/dev/null | tee -a "$LOG"
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("  (no flows.json:",e,")"); sys.exit()
for o,flows in d.get("origins",{}).items():
    for f in flows:
        tools="+".join(s["tool"].replace("_element","") for s in f["steps"])
        print(f"  {o:42s} {f['tier']:11s} sc={f['success_count']} fc={f['fail_count']}  [{tools}] \"{f['task_label']}\"")
PY
}

# run <n> <site-label> <prompt>
run() {
  local n="$1" label="$2" prompt="$3"
  local dir; dir=$(mktemp -d /tmp/cf-live-XXXX)
  say ""
  say "════════ RUN $n: $label ════════"
  ( cd "$dir" && timeout 220 claude -p "$prompt" --dangerously-skip-permissions ) > "$RUNS/run$n.txt" 2>&1
  local rc=$?
  # Agent's final words (trimmed) + any recall/capturable lines it quoted.
  tail -c 900 "$RUNS/run$n.txt" | tr -d '\r' | sed 's/^/  | /' | tee -a "$LOG"
  grep -ioE 'known_flow[^"]*|flow_capturable[^"]*' "$RUNS/run$n.txt" | head -3 | sed 's/^/  >> SIGNAL: /' | tee -a "$LOG"
  say "  [exit $rc] flows.json now:"
  summary
}

NAV='Use ONLY chromeflow MCP tools (mcp__chromeflow__*). Steps, nothing else: (1) open_page %s (2) click the first prominent content link / outbound link, passing until_url_changes:true to confirm it navigates; if a specific label is missing, pick ANY working link that navigates. (3) In your final reply, state the final URL, say whether the extension was connected, and QUOTE VERBATIM any tool-output line containing "known_flow" or "flow_capturable" (write "none" if you saw neither). Be terse.'

say "##### chromeflow earn-in live suite #####"
say "Starting flows.json:"; summary

# R1: example.com 2nd visit  -> PROMOTE provisional(sc1)->trusted(sc2)
run 1 "example.com (promotion)" "$(printf "$NAV" https://example.com)"
# R2: example.com 3rd visit   -> RECALL known_flow should now appear
run 2 "example.com (recall)" "$(printf "$NAV" https://example.com)"
# R3-R8, R11-R12: new origins -> autosave provisional
run 3 "example.net" "$(printf "$NAV" https://example.net)"
run 4 "example.org" "$(printf "$NAV" https://example.org)"
run 5 "iana.org" "$(printf "$NAV" https://www.iana.org)"
run 6 "wikipedia.org" "$(printf "$NAV" https://www.wikipedia.org)"
run 7 "gnu.org" "$(printf "$NAV" https://www.gnu.org)"
run 8 "news.ycombinator.com" "$(printf "$NAV" https://news.ycombinator.com)"

# R9: MANUAL save_flow -> instant trusted on a fresh origin
run 9 "python.org (manual save_flow)" 'Use ONLY chromeflow MCP tools. Steps: (1) open_page https://www.python.org (2) click a prominent navigating link with until_url_changes:true (3) THEN call save_flow with task_label "browse python docs". (4) Final reply: final URL, and quote the save_flow result message verbatim. Terse.'

# R10: type_text mechanic -> a type_text step should be buffered/saved
run 10 "duckduckgo.com (type_text)" 'Use ONLY chromeflow MCP tools. Steps: (1) open_page https://duckduckgo.com (2) type the text "chromeflow earnin test" into the search box using type_text with into_selector set to the search input (try into_selector "input[name=q]"). (3) press Enter or click the search button with until_url_changes:true so it navigates to results. (4) Final reply: final URL, extension connected?, and quote verbatim any "flow_capturable" or "known_flow" line (else "none"). Terse.'

run 11 "rfc-editor.org" "$(printf "$NAV" https://www.rfc-editor.org)"
run 12 "kernel.org" "$(printf "$NAV" https://www.kernel.org)"

say ""
say "##### FINAL flows.json after 12 live runs #####"
summary

say ""
say "##### DETERMINISTIC: failure-feedback prune + TTL (released bundle) #####"
./node_modules/.bin/esbuild "$HOME/dev/chromeflow/packages/mcp-server/src/flow-store.ts" --bundle --platform=node --format=esm --outfile=/tmp/fs.mjs >/dev/null 2>&1 || \
  ( cd "$HOME/dev/chromeflow" && ./node_modules/.bin/esbuild packages/mcp-server/src/flow-store.ts --bundle --platform=node --format=esm --outfile=/tmp/fs.mjs >/dev/null 2>&1 )
node - <<'PY' 2>&1 | tee -a "$LOG"
const { FlowStore, PROMOTE_AT_SUCCESS, PRUNE_AT_FAILS, PROVISIONAL_TTL_MS } = await import("/tmp/fs.mjs");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(),"cf-det-")); let t=1_800_000_000_000; const now=()=>t;
const O="https://det.example/submit";
const step={tool:"click_element",target:"selector=#go",selector:"#go",recovered_via:"dom-click",signal:"dom-click",reason:"x"};
const visit=(s)=>{s.noteUrl(O);s.observe(step,O);s.noteUrl("https://away.example/");};
// promote to trusted
visit(new FlowStore("0.12.0",dir,now)); visit(new FlowStore("0.12.0",dir,now));
let s=new FlowStore("0.12.0",dir,now);
console.log("  after 2 visits:", s._flowsFor(O).map(f=>f.tier+" sc"+f.success_count)[0]);
// FAILURE FEEDBACK: recall then fail PRUNE_AT_FAILS times
s.recallHint(O);
for(let i=0;i<PRUNE_AT_FAILS;i++) s.observeFailure(O,"#go");
console.log(`  after recall + ${PRUNE_AT_FAILS} failures: flows=${s._flowsFor(O).length} (expect 0 = pruned)`);
// gate check: failure WITHOUT recall must NOT touch the flow
const dir2=mkdtempSync(join(tmpdir(),"cf-det2-"));
visit(new FlowStore("0.12.0",dir2,now)); visit(new FlowStore("0.12.0",dir2,now));
let s2=new FlowStore("0.12.0",dir2,now); s2.observeFailure(O,"#go");
console.log("  failure without recall: fc=", s2._flowsFor(O)[0].fail_count, "(expect 0 = gated)");
// TTL: provisional older than TTL is dropped on load; trusted survives
const dir3=mkdtempSync(join(tmpdir(),"cf-det3-"));
visit(new FlowStore("0.12.0",dir3,now)); // provisional sc1
const prov="https://prov.example/x";
const s3=new FlowStore("0.12.0",dir3,now); s3.noteUrl(prov); s3.observe(step,prov); s3.flushAll();
t += PROVISIONAL_TTL_MS + 1;
const s4=new FlowStore("0.12.0",dir3,now);
console.log("  TTL: provisional after expiry =", s4._flowsFor(prov).length, "(expect 0); trusted =", s4._flowsFor(O).length, "(expect 1, survives)");
PY
say ""
say "##### SUITE COMPLETE #####"
