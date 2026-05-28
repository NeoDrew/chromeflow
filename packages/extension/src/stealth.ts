/**
 * Stealth patches — runs at document_start in the MAIN world (page context),
 * BEFORE any page script. Hides JS-level fingerprints commonly used by
 * anti-automation systems (LinkedIn, Cloudflare, Datadome, etc.).
 *
 * What this fixes:
 *   - navigator.webdriver:                  forced to false (some env flips to true)
 *   - navigator.permissions notifications:  returns "default" instead of headless "denied"
 *   - navigator.plugins:                    ensures non-empty (empty = headless tell)
 *   - navigator.languages:                  ensures non-empty
 *   - window.chrome.runtime:                ensures present (extension contexts can leak this)
 *   - Function.prototype.toString:          patches above are wrapped to look native
 *
 * What this does NOT fix:
 *   - TLS / JA3 fingerprint
 *   - Canvas / WebGL / audio fingerprints
 *   - Behavioral signals (mouse, keyboard timing)
 *
 * Pages can still detect chromeflow via behavioral analysis or canvas
 * fingerprinting. This is the JS-API layer of defense only.
 */

(() => {
  try {
    // Idempotent — if another stealth shim already ran, do nothing.
    if ((window as unknown as { __cfStealthApplied?: boolean }).__cfStealthApplied) return;
    Object.defineProperty(window, "__cfStealthApplied", { value: true, configurable: false, enumerable: false, writable: false });

    const nativeToString = Function.prototype.toString;
    const nativeCode = (name: string) => `function ${name}() { [native code] }`;
    const patchedSources = new WeakMap<Function, string>();

    const fakeNative = <T extends Function>(fn: T, name: string): T => {
      patchedSources.set(fn, nativeCode(name));
      return fn;
    };

    // Wrap Function.prototype.toString so anyone who inspects our patched
    // functions sees "[native code]" instead of our actual implementation.
    const newToString = function (this: Function) {
      const cached = patchedSources.get(this);
      if (cached) return cached;
      return nativeToString.call(this);
    };
    patchedSources.set(newToString, nativeCode("toString"));
    try { Function.prototype.toString = newToString; } catch { /* may be frozen */ }

    // navigator.webdriver — should be false. Some test contexts/extensions flip it.
    try {
      Object.defineProperty(Navigator.prototype, "webdriver", {
        get: fakeNative(function get() { return false; }, "get webdriver"),
        configurable: true,
        enumerable: true,
      });
    } catch { /* already locked */ }

    // navigator.permissions.query — patch the famous notifications/denied tell.
    try {
      const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
      if (perms && typeof perms.query === "function") {
        const origQuery = perms.query.bind(perms);
        perms.query = fakeNative(function (parameters: PermissionDescriptor) {
          if (parameters && parameters.name === "notifications") {
            return Promise.resolve({
              state: "default",
              name: "notifications",
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent() { return true; },
            } as unknown as PermissionStatus);
          }
          return origQuery(parameters);
        }, "query");
      }
    } catch { /* ignore */ }

    // navigator.plugins — empty plugins = headless tell. Ensure at least 3.
    try {
      if (navigator.plugins && navigator.plugins.length === 0) {
        const fakePlugins = [
          { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        ];
        Object.defineProperty(Navigator.prototype, "plugins", {
          get: fakeNative(function get() { return fakePlugins as unknown as PluginArray; }, "get plugins"),
          configurable: true,
          enumerable: true,
        });
      }
    } catch { /* ignore */ }

    // navigator.languages — ensure non-empty.
    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(Navigator.prototype, "languages", {
          get: fakeNative(function get() { return ["en-US", "en"]; }, "get languages"),
          configurable: true,
          enumerable: true,
        });
      }
    } catch { /* ignore */ }

    // document.hasFocus() — patch to always return true. When the user is
    // looking at their terminal/IDE instead of the Chrome window, the page
    // sees hasFocus=false. Strict Web Components (Reddit's r-post-flairs-modal,
    // r-post-form-submit-button) check this in addition to event.isTrusted and
    // silently reject clicks when false. CDP's Page.bringToFront and
    // chrome.windows.update({focused:true}) bring the tab forward in Chrome's
    // tab strip but don't make Chrome the OS-foreground window when another
    // app has it. The override here makes chromeflow's CDP clicks pass these
    // focus gates regardless of OS-level focus.
    //
    // Side effect: pages that pause/resume video on focus loss will keep
    // playing. Acceptable tradeoff for click reliability.
    try {
      Object.defineProperty(Document.prototype, "hasFocus", {
        value: fakeNative(function hasFocus() { return true; }, "hasFocus"),
        configurable: true,
        writable: true,
      });
    } catch { /* may be frozen */ }
    try {
      Object.defineProperty(Document.prototype, "hidden", {
        get: fakeNative(function get() { return false; }, "get hidden"),
        configurable: true,
        enumerable: true,
      });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(Document.prototype, "visibilityState", {
        get: fakeNative(function get() { return "visible"; }, "get visibilityState"),
        configurable: true,
        enumerable: true,
      });
    } catch { /* ignore */ }

    // navigator.userActivation.isActive — strict gates (Reddit's
    // faceplate-tracker, others) check this to verify a fresh user gesture
    // preceded the action. CDP-dispatched events create user activation,
    // but the `isActive` flag only stays true for ~5 seconds and CDP timing
    // doesn't always align with the page's check. Force both flags true so
    // chromeflow's CDP clicks always pass.
    try {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
      if (ua) {
        const proto = Object.getPrototypeOf(ua);
        Object.defineProperty(proto, "isActive", {
          get: fakeNative(function get() { return true; }, "get isActive"),
          configurable: true,
          enumerable: true,
        });
        Object.defineProperty(proto, "hasBeenActive", {
          get: fakeNative(function get() { return true; }, "get hasBeenActive"),
          configurable: true,
          enumerable: true,
        });
      }
    } catch { /* ignore */ }

    // window.chrome.runtime — extensions sometimes hide this from page context,
    // making the page appear "non-Chrome". Ensure it's at least present.
    try {
      const w = window as unknown as { chrome?: Record<string, unknown> };
      if (!w.chrome) {
        w.chrome = {};
      }
      if (!w.chrome.runtime) {
        w.chrome.runtime = {
          // Minimal shape — most detectors only check for presence
          OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
          PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
        };
      }
    } catch { /* ignore */ }

    // WebGLRenderingContext.getParameter — headless Chrome returns "Google Inc."
    // and "ANGLE (Apple, Apple M1 Pro, ...) SwiftShader" or similar tells.
    // Real Chrome on a machine with a GPU returns the actual vendor/renderer.
    // We don't know the real GPU, so only patch if the strings LOOK like headless
    // tells — don't clobber legitimate values. Common headless strings:
    //   - "Google Inc." / "Google Inc. (Google)"
    //   - "Brian Paul" / "Mesa OffScreen"
    //   - any "SwiftShader" in renderer
    try {
      const GL_VENDOR = 0x1F00;
      const GL_RENDERER = 0x1F01;
      const UNMASKED_VENDOR_WEBGL = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;

      const replacementVendor = "Intel Inc.";
      const replacementRenderer = "Intel Iris OpenGL Engine";

      const shouldReplace = (v: unknown): boolean => {
        if (typeof v !== "string") return false;
        if (v.toLowerCase().includes("swiftshader")) return true;
        if (v.toLowerCase().includes("llvmpipe")) return true;
        if (v.toLowerCase().includes("mesa offscreen")) return true;
        if (v === "Google Inc." || v === "Google Inc. (Google)") return true;
        return false;
      };

      const patchGetParameter = (proto: { prototype: { getParameter: (this: unknown, p: number) => unknown } } | null) => {
        if (!proto) return;
        const orig = proto.prototype.getParameter;
        if (!orig) return;
        const patched = fakeNative(function (this: unknown, parameter: number) {
          const raw = orig.call(this, parameter);
          if (parameter === GL_VENDOR || parameter === UNMASKED_VENDOR_WEBGL) {
            return shouldReplace(raw) ? replacementVendor : raw;
          }
          if (parameter === GL_RENDERER || parameter === UNMASKED_RENDERER_WEBGL) {
            return shouldReplace(raw) ? replacementRenderer : raw;
          }
          return raw;
        }, "getParameter");
        proto.prototype.getParameter = patched;
      };

      patchGetParameter((window as unknown as { WebGLRenderingContext?: { prototype: { getParameter: (p: number) => unknown } } }).WebGLRenderingContext ?? null);
      patchGetParameter((window as unknown as { WebGL2RenderingContext?: { prototype: { getParameter: (p: number) => unknown } } }).WebGL2RenderingContext ?? null);
    } catch { /* ignore — WebGL not available or proto locked */ }

    // WebRTC IP leak — RTCPeerConnection surfaces ICE candidates that include
    // the client's local private IP addresses (typ host candidates). Many
    // fingerprinters use this to correlate users across public-IP changes
    // and to detect VPN/proxy. We strip host candidates and mDNS
    // candidates, leaving only srflx (server reflexive / public IP) and
    // relay (TURN-relayed), which are the information the remote peer
    // legitimately needs for a connection.
    try {
      const RTCPC = (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
      if (RTCPC && RTCPC.prototype) {
        // Filter an ICE candidate string. Returns null if it should be dropped.
        const filterCandidate = (candidate: string): boolean => {
          // candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type> ...
          // Drop if typ is "host" (local interface) or if IP ends in .local (mDNS).
          const typMatch = candidate.match(/\btyp\s+(\w+)/);
          if (typMatch && typMatch[1] === "host") return false;
          if (/\s[\w-]+\.local\s/i.test(candidate)) return false;
          return true;
        };

        const origAddIceCandidate = RTCPC.prototype.addIceCandidate;
        if (origAddIceCandidate) {
          const patched = fakeNative(function (this: RTCPeerConnection, candidate?: RTCIceCandidateInit | RTCIceCandidate) {
            try {
              const str = (candidate as RTCIceCandidateInit)?.candidate;
              if (typeof str === "string" && str && !filterCandidate(str)) {
                // Swallow the candidate silently (return a resolved promise).
                return Promise.resolve();
              }
            } catch { /* fall through */ }
            return origAddIceCandidate.apply(this, arguments as unknown as [RTCIceCandidateInit]);
          }, "addIceCandidate");
          RTCPC.prototype.addIceCandidate = patched;
        }

        // Also patch the onicecandidate event path: sites that fingerprint
        // via onicecandidate enumerate all candidates. Wrap the setter so
        // delivered events only contain filtered candidates.
        const origSetter = Object.getOwnPropertyDescriptor(RTCPC.prototype, "onicecandidate")?.set;
        if (origSetter) {
          Object.defineProperty(RTCPC.prototype, "onicecandidate", {
            configurable: true,
            enumerable: true,
            get: fakeNative(function () { return (this as Record<string, unknown>).__cfOnIceCandidate ?? null; }, "get onicecandidate"),
            set: fakeNative(function (this: RTCPeerConnection, handler: ((ev: RTCPeerConnectionIceEvent) => void) | null) {
              (this as Record<string, unknown>).__cfOnIceCandidate = handler;
              const wrapped = handler
                ? (ev: RTCPeerConnectionIceEvent) => {
                    const str = ev.candidate?.candidate;
                    if (typeof str === "string" && str && !filterCandidate(str)) return;
                    handler(ev);
                  }
                : null;
              origSetter.call(this, wrapped);
            }, "set onicecandidate"),
          });
        }
      }
    } catch { /* ignore — WebRTC not available */ }
  } catch {
    // Stealth patches must NEVER break the page. Silently swallow any error.
  }
})();
