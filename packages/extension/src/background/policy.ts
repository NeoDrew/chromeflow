// Pure URL / anti-bot policy helpers — no module state, safe to import anywhere.
// Extracted from background.ts to keep that file focused on wiring + handlers.

/** Hard-coded refusals: github.com (account-restoration commitment) and OAuth
 *  /authorize endpoints. Returns {blocked, reason}. */
export function isBlockedUrl(rawUrl: string): { blocked: boolean; reason?: string } {
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
        "chromeflow refuses to drive the browser at github.com (hard-coded; account-restoration commitment 2026-05-14). Use a normal browser tab manually.",
    };
  }
  const pathLower = parsed.pathname.toLowerCase();
  if (pathLower.includes("oauth") && pathLower.includes("authorize")) {
    return {
      blocked: true,
      reason:
        "chromeflow refuses to drive the browser through OAuth /authorize endpoints (hard-coded). Complete OAuth manually in a normal browser tab.",
    };
  }
  return { blocked: false };
}

/** True when a URL can host content scripts (not chrome://, about:, webstore, …). */
export function isScriptableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("edge://") &&
    !url.startsWith("about:") &&
    !url.startsWith("devtools://") &&
    !url.includes("chrome.google.com/webstore")
  );
}

/** hostname for http(s) URLs only, else null. */
export function httpHostname(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * High-confidence anti-bot block-page detection. Runs a regex pass against
 * response HTML and returns a short human-readable label for the matched
 * vendor when a block is recognised, or null otherwise.
 *
 * Read-only signal: surfaces on open_page and fetch_url responses as
 * `anti_bot_detected`. Does not change behaviour, does not retry, does not
 * fire events. The agent reads the field and decides what to do.
 *
 * Only Tier-1 structural markers (unique to block pages, virtually zero
 * false-positive risk). The generic-term and structural-integrity tiers
 * from crawler libraries are deliberately omitted — they false-positive
 * on legitimate "Access Denied" articles, login forms, and empty SPA
 * shells before hydration.
 */
export function detectAntiBot(html: string): string | null {
  if (!html || html.length < 50) return null;
  // Cap the regex pass at 200KB. Block pages are typically tiny; legitimate
  // SPA shells are huge and would slow scans without informative matches.
  const slice = html.length > 200_000 ? html.slice(0, 200_000) : html;
  const patterns: Array<[RegExp, string]> = [
    // Akamai
    [/Reference\s*#\s*[\d]+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i, "Akamai block (Reference #)"],
    [/Pardon\s+Our\s+Interruption/i, "Akamai challenge (Pardon Our Interruption)"],
    // Cloudflare
    [/challenge-form[\s\S]*?__cf_chl_f_tk=/i, "Cloudflare challenge form"],
    [/<span\s+class="cf-error-code">\d{4}<\/span>/i, "Cloudflare firewall block"],
    [/\/cdn-cgi\/challenge-platform\/\S+orchestrate/i, "Cloudflare JS challenge"],
    // PerimeterX / HUMAN
    [/window\._pxAppId\s*=/i, "PerimeterX block"],
    [/captcha\.px-cdn\.net/i, "PerimeterX captcha"],
    // DataDome
    [/captcha-delivery\.com/i, "DataDome captcha"],
    // Imperva / Incapsula
    [/_Incapsula_Resource/i, "Imperva/Incapsula block"],
    [/Incapsula\s+incident\s+ID/i, "Imperva/Incapsula incident"],
    // Sucuri
    [/Sucuri\s+WebSite\s+Firewall/i, "Sucuri firewall block"],
    // Kasada
    [/KPSDK\.scriptStart\s*=\s*KPSDK\.now\(\)/i, "Kasada challenge"],
    // Network security block (Reddit-style large SPA shell with the message buried in)
    [/blocked\s+by\s+network\s+security/i, "Network security block"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(slice)) return label;
  }
  return null;
}
