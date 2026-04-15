/**
 * Secret redaction — pattern-match common credential formats and replace
 * them with a `[REDACTED:<kind>]` placeholder before the text is returned
 * to Claude's context.
 *
 * The goal: if a page visibly shows an API key (e.g. Stripe dashboard
 * revealing a key, or a "copy this token" flow), and Claude calls
 * `get_page_text`, we don't silently ship the secret into the LLM
 * conversation. The LLM sees "[REDACTED:STRIPE_SECRET]" and can ask the
 * user to inspect / use `read_element` + `write_to_env` explicitly.
 *
 * Only matches very high-confidence patterns — false positives would be
 * more annoying than the risk is worth. When a pattern matches, we keep
 * the first 4 and last 4 chars so Claude has enough context to know
 * WHICH key it saw, just not the secret value.
 */

type Pattern = { name: string; re: RegExp };

const PATTERNS: Pattern[] = [
  { name: "STRIPE_SECRET",     re: /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}\b/g },
  { name: "STRIPE_PUBLIC",     re: /\bpk_(?:live|test)_[a-zA-Z0-9]{20,}\b/g },
  { name: "OPENAI_KEY",        re: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{40,}\b/g },
  { name: "ANTHROPIC_KEY",     re: /\bsk-ant-(?:api|admin|test)[0-9]+-[a-zA-Z0-9_-]{80,}\b/g },
  { name: "GITHUB_TOKEN",      re: /\bgh[poshru]_[a-zA-Z0-9]{36,}\b/g },
  { name: "AWS_ACCESS_KEY",    re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "AWS_SECRET_KEY",    re: /(?<=aws_secret_access_key\s*=\s*["']?)[A-Za-z0-9/+=]{40}(?=["']?\s|$)/gi },
  { name: "GOOGLE_API_KEY",    re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "SLACK_BOT_TOKEN",   re: /\bxox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]{20,}\b/g },
  { name: "SENDGRID_KEY",      re: /\bSG\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g },
  { name: "TWILIO_ACCOUNT_SID", re: /\bAC[a-f0-9]{32}\b/g },
  { name: "DIGITALOCEAN_TOKEN", re: /\bdop_v1_[a-f0-9]{64}\b/g },
  // JWTs — generic 3-segment base64url. Must be long enough to avoid
  // matching short tokens. ALL three segments present.
  { name: "JWT",               re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  // Generic bearer-style tokens. Avoids false positives on git SHAs /
  // blockchain hashes by requiring the token-keyword context.
  { name: "GENERIC_BEARER",    re: /(?<=bearer\s+)[A-Za-z0-9._~+/-]{32,}/gi },
];

export function redactSecrets(text: string): { text: string; redactions: Array<{ kind: string; preview: string }> } {
  let out = text;
  const found: Array<{ kind: string; preview: string }> = [];

  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (match) => {
      const preview =
        match.length <= 12 ? "••••" : `${match.slice(0, 4)}••••${match.slice(-4)}`;
      found.push({ kind: name, preview });
      return `[REDACTED:${name}:${preview}]`;
    });
  }

  return { text: out, redactions: found };
}
