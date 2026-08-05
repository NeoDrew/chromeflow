/**
 * Shared connection model for chromeflow's configurable, multi-endpoint, scoped
 * connections. This is the single source of truth imported by offscreen.ts
 * (socket lifecycle), background.ts (routing + domain-scope enforcement), and the
 * popup (config UI). It is deliberately dependency-free (no chrome.* and no DOM)
 * so every bundle can import it.
 *
 * Design: chromeflow stays a generic browser-driving substrate. A "connection"
 * is just a WebSocket endpoint the extension drives the browser on behalf of. The
 * default local range (7878-7888, one per local Claude Code / MCP instance) keeps
 * working untouched; users can additionally configure remote endpoints and scope
 * any connection to a set of domains. None of this knows anything about what the
 * endpoint is for.
 */

/** Default loopback port range, one connection per local MCP server instance. */
export const DEFAULT_PORT_BASE = 7878;
export const DEFAULT_PORT_MAX = 7928;

/**
 * Synthetic connId floor for user-configured (non-default-port) endpoints. Kept
 * clear of the live port range so the existing port-keyed routing/window-
 * assignment plumbing (claudeInstances, getWindowId, portMeta) works unchanged:
 * a configured endpoint's connId IS its routing "port".
 */
export const SYNTHETIC_CONNID_BASE = 8000;

/** chrome.storage.local key holding the user's configured + paused connections. */
export const CONNECTIONS_STORAGE_KEY = "chromeflowConnections";

/** runtime-message source tag for background -> offscreen config pushes. */
export const CONFIG_MSG_SOURCE = "chromeflow-config";

/** content-script command for the inline-content file-input mode (feature 4). */
export const SET_FILE_FROM_CONTENT = "set_file_from_content";

export type ConnKind = "local" | "remote";

/**
 * One configured/managed connection. The default local ports do NOT need a record
 * unless the user has paused or scoped them; absence of a record means "default
 * behaviour, unrestricted". connId is the stable routing key (== port for the
 * local range, >= SYNTHETIC_CONNID_BASE for configured remotes), allocated once
 * and never reassigned on edit.
 */
export interface ConnConfig {
  connId: number;
  kind: ConnKind;
  /** User label, or the identity-handshake label for live connections. */
  label?: string;
  /** Full ws:// or wss:// URL. May itself carry an auth token as a query param. */
  url: string;
  /** Optional bearer token, also sent in the ready handshake body. */
  token?: string;
  /** False = paused: offscreen will not connect (or will disconnect) this one. */
  enabled: boolean;
  /** Host globs the connection may act on. Empty/undefined = no allow-restriction. */
  allow?: string[];
  /** Host globs the connection may never act on. Takes precedence over allow. */
  deny?: string[];
}

/** background -> offscreen: the full set of connections offscreen should hold. */
export interface ConnectionsConfigMessage {
  source: typeof CONFIG_MSG_SOURCE;
  type: "connections";
  connections: ConnConfig[];
}

/** background -> content script: materialize an inline file into a file input. */
export interface SetFileFromContentMessage {
  type: typeof SET_FILE_FROM_CONTENT;
  /** marker attribute identifying the already-tagged target input. */
  attr: string;
  /** base64-encoded file bytes (no data: prefix). */
  fileContent: string;
  fileName: string;
  mimeType?: string;
}

/** Just the scope fields, for enforcement lookups. */
export interface ConnScope {
  allow?: string[];
  deny?: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Host glob match, case-insensitive. A bare domain matches itself and any
 * subdomain (`example.com` matches `example.com` and `www.example.com`). A
 * pattern containing `*` is treated as a wildcard glob (`*.example.com` matches
 * subdomains only; `*` matches anything).
 */
export function hostMatchesGlob(host: string, pattern: string): boolean {
  // Strip a single trailing dot: `example.com.` is the fully-qualified form of
  // `example.com` and Chrome treats them as the same site, so a deny rule for
  // `example.com` must also block `example.com.` (otherwise the trailing-dot
  // form is a scope bypass).
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const p = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (!h || !p) return false;
  if (!p.includes("*")) {
    return h === p || h.endsWith("." + p);
  }
  const re = new RegExp("^" + p.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(h);
}

/**
 * Decide whether a connection's scope blocks acting on `host`. Deny wins; an
 * empty/absent allow list imposes no allow-restriction; an absent scope (the
 * default-port case) never blocks. This "absent or empty = unrestricted" rule is
 * load-bearing: it guarantees default local connections stay unrestricted unless
 * the user explicitly scopes them.
 */
export function scopeBlocks(
  scope: ConnScope | undefined,
  host: string,
): { blocked: boolean; reason?: string } {
  if (!scope) return { blocked: false };
  const { allow, deny } = scope;
  if (deny && deny.some((g) => hostMatchesGlob(host, g))) {
    return { blocked: true, reason: `domain "${host}" is on this connection's deny list` };
  }
  if (allow && allow.length > 0 && !allow.some((g) => hostMatchesGlob(host, g))) {
    return {
      blocked: true,
      reason: `domain "${host}" is not in this connection's allow list`,
    };
  }
  return { blocked: false };
}

/** Allocate a stable connId for a new configured endpoint. */
export function allocateConnId(existing: number[]): number {
  let max = SYNTHETIC_CONNID_BASE - 1;
  for (const id of existing) if (id > max) max = id;
  return max + 1;
}

export function isDefaultPort(connId: number): boolean {
  return connId >= DEFAULT_PORT_BASE && connId <= DEFAULT_PORT_MAX;
}

/**
 * A remote endpoint must be reached over TLS (wss://) so the bearer token (sent
 * in the URL query and the ready-handshake) is never exposed in cleartext on the
 * wire. Plain ws:// is permitted ONLY to loopback, for local development. Any
 * other scheme, or ws:// to a non-loopback host, is rejected. Used both by the
 * popup (reject at save time, with an explanation) and by offscreen (refuse to
 * open the socket regardless of how the config got there, e.g. a page-initiated
 * prefill).
 */
export function isSafeRemoteUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "wss:") return true;
  if (u.protocol === "ws:") {
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  }
  return false;
}

/** Parse a comma/space/newline-separated domain list from a popup text field. */
export function parseDomainList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
