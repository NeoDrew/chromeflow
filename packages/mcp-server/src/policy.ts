/**
 * URL allow/deny policy for chromeflow tools.
 *
 * Hard-coded refusal for github.com (and all subdomains, including
 * githubusercontent.com) and any OAuth `/authorize`-style endpoint. This
 * honors a commitment to GitHub Support during an account-flag review
 * (2026-05-14): "chromeflow has been updated so it cannot navigate to any
 * github.com URL or any OAuth /authorize endpoint."
 *
 * Mirrored in `packages/extension/src/background.ts` as defence in depth —
 * direct WS callers see the same refusal.
 */

export type BlockResult =
  | { blocked: false }
  | { blocked: true; reason: string };

export function isBlockedUrl(rawUrl: string): BlockResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { blocked: false };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  ) {
    return {
      blocked: true,
      reason:
        "chromeflow refuses to drive the browser at github.com. This is hard-coded per a commitment to GitHub Support during an account-restoration review (2026-05-14). Interact with GitHub manually in a normal browser tab.",
    };
  }

  const pathLower = parsed.pathname.toLowerCase();
  if (pathLower.includes("oauth") && pathLower.includes("authorize")) {
    return {
      blocked: true,
      reason:
        "chromeflow refuses to drive the browser through OAuth /authorize endpoints. This is hard-coded per the same GitHub Support commitment. Complete OAuth manually in a normal browser tab.",
    };
  }

  return { blocked: false };
}
