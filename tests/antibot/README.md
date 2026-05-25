# Anti-bot validation harness

This directory holds the scaffolding for validating chromeflow's CDP
click and isTrusted=true keystroke pipelines against real anti-bot
platforms. Tests are run locally, NOT in CI — the target sites have
rate limits, fluctuating UI, and ToS considerations that make live CI
runs impractical.

## Why this exists

Chromeflow's positioning rests on a specific technical claim: the CDP
click sequence (bezier path, settle-hover micro-tremor, PointerEvent
isPrimary=true, post-click jitter) plus isTrusted=true CDP keystrokes
pass behavioural checks that public Playwright / Puppeteer code does
not. We need a way to verify that claim per release, not just trust
the implementation has stayed correct.

## What we DO claim (and validate)

| Platform | Validated capability | Test file |
|---|---|---|
| Reddit composer expand | `click_element` on the textarea-input wrapper opens the composer | `platforms/reddit-composer-expand.md` |
| Reddit comment submit | Pre-fill + highlight + `wait_for_click` lands a comment | `platforms/reddit-comment-submit.md` |
| X / Twitter tweet input | `type_text(into_selector="[data-testid='tweetTextarea_0']")` lands text | `platforms/x-tweet-input.md` |
| React Radix portal dialog | `click_element(in_dialog=true)` scopes correctly | `platforms/radix-dialog-scoping.md` |
| Closed shadow-root input | `fill_input(selector=...)` reaches inputs inside closed roots | `platforms/closed-shadow-input.md` |
| TipTap silent-drop recovery | Post-type verify + execCommand fallback on TipTap editors | `platforms/tiptap-silent-drop.md` |

## What we do NOT claim

These are explicitly out of scope. Do not add tests for them.

- reCAPTCHA / hCaptcha / Cloudflare Turnstile solving. Chromeflow
  reports captcha presence and hands off to a human gesture.
- IP-based fingerprinting / rate limits. Network-layer; chromeflow
  cannot influence.
- Server-side fraud scoring (account age, payment history, device
  telemetry). Behavioural-signal portion is maximised but server can
  still down-rank.
- "Reddit submit click fires without user gesture." It does not. The
  submit needs a real human gesture; what we validate is the pre-fill
  and highlight pipeline.

## Running locally

```bash
./run-local.sh                       # run all validations sequentially
./run-local.sh reddit-composer       # run one platform
./run-local.sh --list                # list available platforms
```

Each test is a procedure documented in `platforms/<name>.md`: setup
preconditions, exact tool calls, expected response fields, and
manual-verification steps. The runner prints PASS / FAIL / SKIP per
platform and writes a JSON summary to `last-run.json`.

Tests SKIP when the runner can't reach the platform (logged out,
rate limited, page structure changed). SKIP is not FAIL — the harness
asks the operator to re-run with a fresh login when the result matters.

## Test format

Each platform file under `platforms/` has this shape:

```markdown
# <platform>

**Validated:** Yes / No  
**Last verified:** YYYY-MM-DD on chromeflow <version>  
**Auth required:** Yes / No  
**Stability:** Stable / Flaky / Broken

## Preconditions

- ...

## Procedure

1. `open_page(...)`
2. ...

## Expected response fields

- ...

## Manual verification

- ...

## Known regressions

- ...
```

When a platform's structure changes and the tests need updates,
update the platform file's `Last verified` date and `Stability`
field.

## Release-gate use

Before tagging a new version, run `./run-local.sh` and verify all
target platforms PASS or SKIP (no FAILs). Capture the JSON summary
and reference it in the release notes:

> "Validated against {reddit-composer, x-tweet-input,
>  radix-dialog-scoping, closed-shadow-input,
>  tiptap-silent-drop} on chromeflow N.N.N (last-run.json)."

If a platform FAILs, do not ship the release without either fixing
the regression or removing the platform from the validated-against
list in `packages/plugin/skills/chromeflow/references/anti-bot.md`.

## Why not in CI

- Target sites change UI without notice; live CI gates would flake
  monthly.
- Authenticated tests need real session cookies that we don't want
  in CI environments.
- Reddit / X have rate limits that a CI cron would trip.
- Manual validation is honest about what we actually run, instead of
  greenwashing a CI job that quietly SKIPs everything.

The plan is: run locally before each release, capture evidence,
publish that evidence in the release notes.
