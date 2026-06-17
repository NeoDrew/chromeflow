import { describe, it, expect } from "vitest";
import {
  hostMatchesGlob,
  scopeBlocks,
  allocateConnId,
  isDefaultPort,
  isSafeRemoteUrl,
  parseDomainList,
  SYNTHETIC_CONNID_BASE,
  DEFAULT_PORT_BASE,
  DEFAULT_PORT_MAX,
  type ConnScope,
} from "../connections";

describe("hostMatchesGlob", () => {
  it("matches an exact host", () => {
    expect(hostMatchesGlob("example.com", "example.com")).toBe(true);
  });

  it("treats a bare domain as itself plus subdomains", () => {
    // The whole point of the "bare domain = apex + any subdomain" rule.
    expect(hostMatchesGlob("example.com", "example.com")).toBe(true);
    expect(hostMatchesGlob("www.example.com", "example.com")).toBe(true);
    expect(hostMatchesGlob("a.b.example.com", "example.com")).toBe(true);
  });

  it("does not let a bare domain match an unrelated suffix sibling", () => {
    // notexample.com must NOT match example.com (endsWith requires the dot).
    expect(hostMatchesGlob("notexample.com", "example.com")).toBe(false);
    // A different TLD/host entirely.
    expect(hostMatchesGlob("example.org", "example.com")).toBe(false);
  });

  it("matches *.example.com on subdomains only, not the bare apex", () => {
    expect(hostMatchesGlob("www.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesGlob("a.b.example.com", "*.example.com")).toBe(true);
    // The wildcard requires at least one label before the dot, so the apex fails.
    expect(hostMatchesGlob("example.com", "*.example.com")).toBe(false);
  });

  it("matches a lone * against anything non-empty", () => {
    expect(hostMatchesGlob("anything.example.com", "*")).toBe(true);
    expect(hostMatchesGlob("foo", "*")).toBe(true);
  });

  it("is case-insensitive on both host and pattern", () => {
    expect(hostMatchesGlob("WWW.Example.COM", "example.com")).toBe(true);
    expect(hostMatchesGlob("www.example.com", "EXAMPLE.COM")).toBe(true);
    expect(hostMatchesGlob("WWW.EXAMPLE.COM", "*.Example.Com")).toBe(true);
  });

  it("returns false when host or pattern is empty or whitespace", () => {
    expect(hostMatchesGlob("", "example.com")).toBe(false);
    expect(hostMatchesGlob("example.com", "")).toBe(false);
    expect(hostMatchesGlob("   ", "example.com")).toBe(false);
    expect(hostMatchesGlob("example.com", "   ")).toBe(false);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(hostMatchesGlob("  www.example.com  ", "  example.com  ")).toBe(true);
  });

  it("handles a leading-dot pattern sanely (matches nothing absurd)", () => {
    // ".example.com" has no "*", so it falls to: h === ".example.com" (no real
    // host equals that) or h.endsWith("..example.com") (never true). So it just
    // never matches a normal host rather than throwing or over-matching.
    expect(hostMatchesGlob("example.com", ".example.com")).toBe(false);
    expect(hostMatchesGlob("www.example.com", ".example.com")).toBe(false);
    expect(hostMatchesGlob(".example.com", ".example.com")).toBe(true);
  });

  it("treats a fully-qualified trailing-dot host as the same site (no bypass)", () => {
    // `example.com.` is the FQDN form of `example.com`; Chrome treats them as the
    // same site, so a rule for `example.com` must also match the trailing-dot
    // form. Otherwise `https://example.com./` is a scope/deny bypass.
    expect(hostMatchesGlob("example.com.", "example.com")).toBe(true);
    expect(hostMatchesGlob("www.example.com.", "example.com")).toBe(true);
    expect(hostMatchesGlob("www.example.com.", "*.example.com")).toBe(true);
    // Symmetric: a trailing-dot pattern still matches the bare host.
    expect(hostMatchesGlob("example.com", "example.com.")).toBe(true);
  });
});

describe("scopeBlocks", () => {
  it("never blocks when the scope is undefined (default-port case)", () => {
    expect(scopeBlocks(undefined, "example.com").blocked).toBe(false);
  });

  it("never blocks when allow and deny are both empty (unrestricted default)", () => {
    const scope: ConnScope = { allow: [], deny: [] };
    expect(scopeBlocks(scope, "example.com").blocked).toBe(false);
  });

  it("never blocks when allow and deny are both absent on a present scope", () => {
    expect(scopeBlocks({}, "example.com").blocked).toBe(false);
  });

  it("blocks on a deny match and deny wins even if allow also matches", () => {
    const scope: ConnScope = {
      allow: ["example.com"],
      deny: ["example.com"],
    };
    const result = scopeBlocks(scope, "www.example.com");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("deny list");
  });

  it("blocks when allow is non-empty and nothing matches", () => {
    const scope: ConnScope = { allow: ["example.com"] };
    const result = scopeBlocks(scope, "other.com");
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("allow list");
  });

  it("does not block on an allow match with no deny", () => {
    const scope: ConnScope = { allow: ["example.com"] };
    expect(scopeBlocks(scope, "www.example.com").blocked).toBe(false);
  });

  it("does not block when host is outside deny and there is no allow restriction", () => {
    const scope: ConnScope = { deny: ["evil.com"] };
    expect(scopeBlocks(scope, "example.com").blocked).toBe(false);
  });

  it("still denies a trailing-dot FQDN form of a denied host", () => {
    // Regression guard for the trailing-dot deny bypass.
    const scope: ConnScope = { deny: ["secret.internal"] };
    expect(scopeBlocks(scope, "secret.internal.").blocked).toBe(true);
  });
});

describe("isSafeRemoteUrl", () => {
  it("accepts wss:// to any host", () => {
    expect(isSafeRemoteUrl("wss://agent.onrender.com/ws?token=abc")).toBe(true);
    expect(isSafeRemoteUrl("wss://example.com")).toBe(true);
  });

  it("rejects ws:// to a non-loopback host (cleartext token leak)", () => {
    expect(isSafeRemoteUrl("ws://attacker.example.com/ws?token=abc")).toBe(false);
    expect(isSafeRemoteUrl("ws://192.168.1.5:9000")).toBe(false);
  });

  it("permits ws:// only to loopback for local dev", () => {
    expect(isSafeRemoteUrl("ws://localhost:8787/ws")).toBe(true);
    expect(isSafeRemoteUrl("ws://127.0.0.1:8787")).toBe(true);
    expect(isSafeRemoteUrl("ws://[::1]:8787")).toBe(true);
  });

  it("rejects non-websocket schemes and garbage", () => {
    expect(isSafeRemoteUrl("https://example.com")).toBe(false);
    expect(isSafeRemoteUrl("http://localhost")).toBe(false);
    expect(isSafeRemoteUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRemoteUrl("not a url")).toBe(false);
    expect(isSafeRemoteUrl("")).toBe(false);
  });
});

describe("allocateConnId", () => {
  it("returns at least SYNTHETIC_CONNID_BASE for an empty list", () => {
    expect(allocateConnId([])).toBe(SYNTHETIC_CONNID_BASE);
    expect(allocateConnId([])).toBeGreaterThanOrEqual(SYNTHETIC_CONNID_BASE);
  });

  it("is strictly greater than the max existing configured id", () => {
    expect(allocateConnId([8000, 8005, 8002])).toBe(8006);
    expect(allocateConnId([8000, 8005, 8002])).toBeGreaterThan(8005);
  });

  it("never collides with an existing id", () => {
    const existing = [8000, 8001, 8002, 8003];
    const id = allocateConnId(existing);
    expect(existing).not.toContain(id);
  });

  it("ignores ids below the synthetic base (e.g. default ports)", () => {
    // Default-port ids (7878..7888) must not drag the allocation below the base.
    expect(allocateConnId([7878, 7888])).toBe(SYNTHETIC_CONNID_BASE);
  });
});

describe("isDefaultPort", () => {
  it("is true at both ends of the inclusive range", () => {
    expect(isDefaultPort(DEFAULT_PORT_BASE)).toBe(true);
    expect(isDefaultPort(DEFAULT_PORT_MAX)).toBe(true);
    expect(isDefaultPort(7878)).toBe(true);
    expect(isDefaultPort(7888)).toBe(true);
    expect(isDefaultPort(7883)).toBe(true);
  });

  it("is false just outside the range and for synthetic ids", () => {
    expect(isDefaultPort(7877)).toBe(false);
    expect(isDefaultPort(7889)).toBe(false);
    expect(isDefaultPort(SYNTHETIC_CONNID_BASE)).toBe(false);
  });
});

describe("parseDomainList", () => {
  it("splits on commas, spaces, and newlines", () => {
    expect(parseDomainList("a.com, b.com c.com\nd.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
  });

  it("trims, lowercases, and drops empty entries", () => {
    expect(parseDomainList("  Example.COM ,, , www.Foo.com  \n\n")).toEqual([
      "example.com",
      "www.foo.com",
    ]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseDomainList("")).toEqual([]);
    expect(parseDomainList("   \n  , ")).toEqual([]);
  });
});
