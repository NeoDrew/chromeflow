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
anti-bot checks on Reddit, X / Twitter, and similar handlers, and similar
isTrusted-strict React UIs.

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

1. Bump version in three files:
   - `packages/mcp-server/package.json`
   - `packages/plugin/.claude-plugin/plugin.json`
   - `packages/extension/manifest.json`
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

- **npm token**: lives as `NPM_TOKEN` masked + protected variable in
  GitLab CI/CD Variables (Settings → CI/CD → Variables) on
  `NeoDrew/chromeflow`. Granular, Bypass 2FA enabled, scoped to the
  chromeflow package only, Read+Write. Expires every 90 days; rotate
  via https://www.npmjs.com/settings/neodrew/tokens.
- **OIDC**: GitLab CI signs npm publishes via Sigstore using GitLab's
  OIDC tokens (`id_tokens.SIGSTORE_ID_TOKEN: aud: sigstore`). No
  separate signing key.

## Chrome Web Store distribution

Currently `npx chromeflow setup` tells users to manually "Load
unpacked" from the package's `extension/dist/` path. Once the
extension is published to the Chrome Web Store, the setup command
should link to the store listing instead. Known gap.
