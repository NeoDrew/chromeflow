# Chromeflow — repo-developer guide

This file is for developers working ON chromeflow. The usage reference for
agents (Claude Code, Codex, etc.) lives in
`packages/plugin/skills/chromeflow/` (and `skills-codex/chromeflow/` for
the Codex variant). When in doubt, the canonical user-facing docs are in
the skill, not here.

## What chromeflow is

Chromeflow is a Chrome extension + MCP server pair that lets coding
agents drive the user's real Chrome browser. The extension attaches via
CDP; the MCP server exposes ~29 tools (`click_element`, `fill_input`,
`type_text`, `get_page_text`, etc.) over the standard Model Context
Protocol. Agents call those tools; the extension performs the operations
in the user's logged-in Chrome window.

The core differentiator is the click + keystroke pipeline: a humanlike
CDP bezier sequence with `pointerType: "mouse"` (firing PointerEvent
isPrimary=true alongside MouseEvent), settle-hover micro-tremor,
post-click jitter, and isTrusted=true keystrokes. This is what defeats
anti-bot checks on Reddit, X / Twitter, and similar isTrusted-strict
React UIs.

## Repository layout

```
packages/
  extension/                # Chrome MV3 extension (TypeScript)
    src/
      background.ts         # MCP message dispatcher, CDP helpers, ~3700 lines
      content/              # Content-script handlers (shadow-piercing DOM ops)
      offscreen.ts          # Persistent WebSocket connection to MCP server
      popup/                # Browser-action popup UI
      stealth.ts            # MAIN-world stealth shims (WebRTC, etc.)
    build.mjs               # esbuild
    pack.mjs                # Zip the dist/ for Chrome Web Store
    manifest.json
  mcp-server/               # MCP server bundled to packages/plugin/server/
    src/
      index.ts              # Tool registration entry
      ws-bridge.ts          # WebSocket server (extension <-> MCP)
      tools/                # Tool definitions per family
      types.ts              # Message types between MCP and extension
    package.json            # Published to npm as "chromeflow"
  plugin/                   # Claude Code / Codex plugin manifest + skill
    .claude-plugin/
      plugin.json
    skills/chromeflow/
      SKILL.md              # User-facing routing + common patterns
      references/           # Topic-specific deep references
    skills-codex/chromeflow/
      SKILL.md              # Codex variant
      references/           # Same references, copied
    server/
      chromeflow.mjs        # Bundled MCP server (esbuild output)
    scripts/
      build-server.sh       # Bundle script
```

## Development commands

**Build:**

```
cd packages/extension && node build.mjs    # extension → dist/
cd packages/extension && node pack.mjs     # dist/ → chromeflow-<version>.zip
bash packages/plugin/scripts/build-server.sh  # MCP server → packages/plugin/server/chromeflow.mjs
```

**Type-check:**

```
cd packages/extension && npx tsc --noEmit
cd packages/mcp-server && npx tsc --noEmit
```

Extension has some pre-existing TS errors in `stealth.ts` and
`content/find.ts` that are not load-bearing (the build uses esbuild,
not tsc). New errors should still be fixed.

**Test:**

```
# No unit tests today. Validation is manual + the anti-bot harness in
# tests/antibot/ (run locally; not in CI).
```

## Release process

1. Bump version in five files (the last two are marketplace listings — found
   stale at 0.9.5/0.9.8 during the 2026-09-13 repo cleanup while the other
   three had drifted to 0.12.10; nothing enforces these staying in sync, so
   don't skip them):
   - `packages/mcp-server/package.json`
   - `packages/plugin/.claude-plugin/plugin.json`
   - `packages/extension/manifest.json`
   - `.claude-plugin/marketplace.json`
   - `.agents/plugins/marketplace.json`
2. Rebuild extension and bundle: `node packages/extension/build.mjs &&
   bash packages/plugin/scripts/build-server.sh && node
   packages/extension/pack.mjs`.
3. Commit. Use the form `feat: X.Y.Z, <subject>`.
4. `git push`. GitLab CI publishes the npm package automatically when
   the version in `packages/mcp-server/package.json` differs from the
   one on the npm registry.
5. Manually upload the new `chromeflow-X.Y.Z.zip` to the Chrome Web
   Store dev console (the listing is not auto-published yet).

The GitLab CI pipeline definition is in `.gitlab-ci.yml`.

## Tool-surface philosophy

- **Prefer flags on existing primitives over new composite tools.** The
  user pruned the surface from 38 → 26 tools in 0.9.4 to fix bloat.
- **Boot-time warnings beat helper tools.** Where a diagnostic could
  be a `_doctor` or `_status` tool, prefer attaching the warning to
  the existing tool whose response would carry the diagnostic context.
- **Every response field should be structured.** Avoid free-text
  diagnostics that the agent has to parse; expose machine-readable
  fields like `silently_rejected`, `phase_timed_out`, `scope_missed`,
  `hidden_count`, `last_text`, `initial_match_warning`,
  `selector_in_shadow`, `shadow_hosts_seen`, etc.

## Fix philosophy: patterns, not sites

- **Nothing chromeflow ships fixes a specific website — it fixes a pattern
  that happens to show up on that website.** A bug report always arrives
  with a concrete site (Reddit, Workday, Reed.co.uk), but the fix must be
  keyed on a structural/behavioral signature that generalizes across any
  site sharing that pattern, not on the reporting site's domain or markup.
  Example: the fix for "Workday's `fill_input` doesn't bind" (2026-08-11)
  detects Workday's own `data-automation-id` component marker, not
  `location.hostname.includes("myworkdayjobs.com")` — the same check fires
  correctly on any other host running the same component library, and the
  underlying pattern (a controlled-input model that only registers trusted
  keystrokes, not a synthetic setter + dispatched event) is the same one
  already fixed for TipTap/ProseMirror and Reddit's faceplate-* components.
- **Ask "what's the general pattern?" before writing the check.** Domain
  strings, exact class names, and literal text lifted straight from the bug
  report are a sign the fix is pigeonholed to one site. Structural signals
  (a DOM attribute convention, an event-handling behavior, an anti-bot
  gating pattern already seen elsewhere) are the sign it generalizes.
- **Keep the concrete site in the comment, not the condition.** Cite the
  reporting site and the ISSUE-*.md file as the motivating example and
  evidence, but the code path itself should read as "sites that do X",
  never "if site is Y". These files are gitignored local notes (see
  `issues/README.md`), so citing one is a pointer for whoever has this repo
  checked out locally, not a link into version control — new ones can be
  created at `issues/open/ISSUE-YYYY-MM-DD-slug.md` directly; don't leave
  them loose at repo root.

## Anti botting

- Case 1 (NOT IMPLEMENTED) -  solving the challenge itself: classifying which image tiles contain traffic lights, transcribing distorted audio, resolving a puzzle-slider. This is the literal, unambiguous definition of "CAPTCHA solving," and it's a fundamentally different thing from chromeflow's existing click/keystroke fidelity work. Won't be implemented as it is specifically designed for anti-automation.

- Case 2 (IMPLMENTED) — visible/checkbox CAPTCHAs (trust-signal based) This is the "I'm not a robot" checkbox style (classic reCAPTCHA v2 checkbox mode, older hCaptcha checkbox mode). Under the hood, these don't grade your behavior in a sophisticated way most of the time — they check simpler trust signals: does this look like a real browser (correct navigator fingerprint, no automation flags like navigator.webdriver), is the click event a real PointerEvent/MouseEvent with isTrusted: true, is there a plausible mouse trajectory leading up to it, that kind of thing. If those signals look right, the checkbox just ticks and no image/audio challenge ever appears. This is genuinely just "chromeflow clicks like a human, on the user's real logged-in Chrome" — the exact same click pipeline (bezier path, pointerType: mouse, isPrimary, settle-hover jitter) that already exists for Reddit/X/etc. There's no separate "CAPTCHA-solving" logic; the checkbox just doesn't escalate because nothing about the interaction looks synthetic.

- Case 3 (NEEDS IMPLEMENTATION) — invisible risk-scoring CAPTCHAs This is reCAPTCHA v3, hCaptcha Enterprise's invisible mode, and similar. There's no checkbox or challenge shown at all by default. Instead the site continuously scores the whole session, mouse movement patterns over time, timing between actions, scroll behavior, device/browser fingerprint entropy, historical reputation of the IP, and produces a risk score (like reCAPTCHA v3's 0.0-1.0). If the score is too low, the site can silently block the action, show a fallback challenge, or flag the account for review, without ever telling the automation why. This is still in implementation.

## Code conventions

- TypeScript throughout. Strict mode in `tsconfig.json`. ES modules.
- The extension is MV3. Background is a service worker. Offscreen holds
  the WebSocket because service workers terminate on idle.
- Indentation: 2 spaces (extension), tabs (none — esbuild handles
  formatting). Run `prettier` if reformatting.
- Comments explain WHY, not WHAT. Code is the WHAT.
- No em-dashes / en-dashes / hyphens-as-dashes in commit messages or
  user-facing prose.
- ASCII math only in chat output and tool descriptions (no LaTeX).

## Where to look when a tool misbehaves

- **Click fired but page didn't react** → `background.ts` `case
  "click_element"` (search `silently_rejected`, `phase_timed_out`).
- **Fill landed in wrong field** → `content/fill.ts` (`findInput`
  match ranks, ambiguity refusal).
- **Shadow DOM not pierced** → grep for `queryAllDeep` in
  `content/shadow.ts` to confirm the call site is using it.
- **Screenshot hangs** → `background.ts` `case "screenshot"`
  (fullscreen fast-fail in 0.9.13+).
- **WS bridge timeouts** → `mcp-server/src/ws-bridge.ts`. Progress
  heartbeats from `type_text` route via `chromeflow-progress`
  runtime messages through offscreen.

## Validation harness

`tests/antibot/` contains the platform-validation scaffolding. Live
tests run locally with `tests/antibot/run-local.sh` (not in CI — real
target sites are flaky and have rate limits). The README in that
directory documents the validation approach and the platforms covered.

## Telemetry / data handling

- No outbound telemetry. The MCP server only talks to the local
  WebSocket bridge. The extension only talks to the active page and
  the offscreen-held WebSocket.
- `redact.ts` strips high-confidence secret patterns (API keys, JWTs)
  from `get_page_text` output so Claude doesn't accidentally read keys
  into context. Use `read_element` + `write_to_env` to capture
  specific values intentionally.

## The skill files

The user-facing reference. `packages/plugin/skills/chromeflow/SKILL.md`
is what plugin-installed agents read. The `references/` subdirectory
holds the deep-dive material (anti-bot, shadow-dom, forms, etc.). When
adding a new tool or changing a major behavior:

1. Update the relevant `references/<topic>.md`.
2. Mirror changes to `skills-codex/chromeflow/references/` (the Codex
   variant uses the same references; only the top-level SKILL.md
   differs).
3. If the new behavior is broadly relevant, add a one-line mention to
   the main SKILL.md routing table or the "Common quick recipes"
   section.

Do NOT add new content to this file. Repo-developer concerns only.

## Things deliberately NOT in chromeflow

- No LLM-mediated extraction tool. Claude is the LLM; adding another
  model call would double the latency for no gain.
- No daemon / session-management layer. The extension is persistent;
  no daemon needed.
- No hosted / cloud variant. Chromeflow's value prop is the user's
  real logged-in Chrome.
- No index-based element selection. textHint and selector resolve in
  one call; index-based would require a `get_state` round-trip.
- No `chromeflow_doctor` composite tool. Diagnostics attach to the
  tool whose response would already carry the relevant context.

## CI / publish credentials

- **npm auth**: `.gitlab-ci.yml`'s publish job is wired for Trusted
  Publishing (OIDC) — requests an `NPM_ID_TOKEN` (`aud:
  "npm:registry.npmjs.org"`), which npm CLI >= 11.5.1 auto-detects and
  exchanges for a short-lived publish credential instead of a stored
  `NPM_TOKEN`. **Status as of 2026-09-07: NOT YET WORKING.** A live publish
  attempt failed with `ENEEDAUTH` / `OIDC token exchange error - package
  not found` — npm's own docs warn a Trusted Publisher config isn't
  validated when saved, only when a publish is attempted, and that's
  exactly what happened here: the npmjs.com setup form (chromeflow →
  Settings → Trusted Publisher → GitLab CI/CD → Namespace `NeoDrew` /
  Project `chromeflow` / CI file `.gitlab-ci.yml`) hit a security-key 2FA
  challenge on submit, and nobody was able to get back past that same
  2FA wall afterward to confirm it actually saved. Needs re-verifying (or
  redoing) the connection on npmjs.com next time someone's at a machine
  with the security key — the CI-side config in `.gitlab-ci.yml` doesn't
  need further changes, this is purely an npmjs.com-side setup gap.
  Until fixed, releases need a manual `npm publish --access public` from
  a machine with valid npm credentials (see git log around 2026-09-06 for
  how 0.12.6 shipped this way).
- **OIDC**: GitLab CI also signs npm's provenance attestation via Sigstore
  using a second OIDC token (`id_tokens.SIGSTORE_ID_TOKEN: aud: sigstore`).
  Provenance generation itself is automatic once Trusted Publishing is
  actually working — no `--provenance` flag needed on `npm publish`. Note:
  the manually-published 0.12.6 has NO provenance attestation as a result
  (only releases published through a working CI OIDC flow get one).
- The old 90-day granular `NPM_TOKEN` rotation is what Trusted Publishing
  is meant to replace (npm is also restricting bypass-2FA tokens further:
  account changes since Aug 2026, direct publishing from Jan 2027). Keep
  the `NPM_TOKEN` CI/CD variable around as a fallback until OIDC is
  confirmed working end to end, then remove it.

## Chrome Web Store distribution

Currently `npx chromeflow setup` tells users to manually "Load
unpacked" from the package's `extension/dist/` path. Once the
extension is published to the Chrome Web Store, the setup command
should link to the store listing instead. Known gap.
