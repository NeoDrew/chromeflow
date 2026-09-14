/**
 * Stealth patches — runs at document_start in the MAIN world (page context),
 * BEFORE any page script. Hides JS-level fingerprints commonly used by
 * anti-automation systems (LinkedIn, Cloudflare, Datadome, etc.).
 *
 * What this fixes:
 *   - navigator.webdriver:                  only patched if some other context already
 *     flipped it true; left untouched (and native) when already false, since an
 *     unconditional override is itself a detectable tell — see CreepJS note below
 *   - navigator.permissions notifications:  returns "default" instead of headless "denied"
 *   - navigator.plugins:                    ensures non-empty (empty = headless tell)
 *   - navigator.languages:                  ensures non-empty
 *   - window.chrome.runtime:                ensures present (extension contexts can leak this)
 *   - document.hasFocus / hidden / visibilityState: always report foreground+visible, so
 *     strict Web Components don't reject CDP clicks when the OS-level window isn't focused
 *   - navigator.userActivation:             isActive/hasBeenActive forced true
 *   - WebGL vendor/renderer:                headless-tell strings (SwiftShader, "Google Inc.")
 *     replaced with a plausible real-GPU string; leaves genuine values alone
 *   - WebRTC ICE candidates:                strips host/mDNS candidates (local IP leak)
 *   - MouseEvent/PointerEvent screenX/screenY: CDP's Input.dispatchMouseEvent sets these
 *     equal to clientX/clientY (a known Chromium bug, chromium:40280325) — patched to
 *     derive from a consistent per-page-load window-position offset instead, so screenX/Y
 *     correlate with clientX/Y across different clicks the way a real mouse's would, rather
 *     than either matching client coords exactly (the bug) or staying constant regardless of
 *     click position (the naive-random-value fix real bypass tools use for this same bug)
 *   - MouseEvent/PointerEvent movementX/movementY: CDP-dispatched pointer events always
 *     report these as 0 (a real mouse's don't) — patched to track inter-event deltas
 *   - Function.prototype.toString:          patches above are wrapped to look native
 *
 * What this does NOT fix:
 *   - TLS / JA3 fingerprint
 *   - Canvas fingerprint
 *   - getCoalescedEvents() sub-frame sample density (real high-poll-rate mice produce
 *     multiple raw samples between frames; CDP dispatch produces one flat event — faking
 *     this would need literally synthesizing sub-frame samples, not just patching a getter)
 *   - Behavioral timing (keystroke/mouse inter-event cadence, frame-alignment histograms)
 *   - The CDP `chrome.debugger.attach()` infobar Chrome itself shows while attached — not a
 *     JS-visible signal directly, but in principle inferable via viewport-height changes the
 *     same way the classic automation infobar is detected; withDebugger's per-operation
 *     attach/detach (not session-long) already minimises this window
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

    // Wraps `fn` in an object-literal method-shorthand definition (computed
    // key so `name` can be an arbitrary string like "get webdriver") rather
    // than returning `fn` as-is. This matters because `fn` itself, as an
    // ordinary `function` expression, carries two shape tells a real native
    // getter/method never has: an empty/mismatched `.name` (fixed elsewhere
    // via the patchedSources toString map, but that only fakes the STRING
    // output, not the function object's own shape), and a non-configurable
    // own `.prototype` property (`delete fn.prototype` throws — it's not
    // configurable on a plain function expression, so it can't be removed
    // after the fact). A method-shorthand function has neither: per spec,
    // MethodDefinition-created functions are non-constructible and never get
    // an own `.prototype`, and a computed key automatically becomes the
    // function's real `.name`. Confirmed live against CreepJS
    // (creepjs's `hasToStringProxy` check) 2026-09-14: it was flagging
    // exactly this shape mismatch on every patched property, independent of
    // (and in addition to) the toString-string spoofing already in place.
    // `fn.apply(this, args)` forwards the real dynamic receiver through, so
    // getters/methods that rely on their actual `this` (screenX/screenY,
    // WebGL getParameter, the RTCPeerConnection overrides below) keep
    // working exactly as before — unlike `.bind()`, which would freeze
    // `this` to a fixed value and break all of those.
    const fakeNative = <T extends Function>(fn: T, name: string): T => {
      const holder: Record<string, unknown> = {
        [name](this: unknown, ...args: unknown[]) {
          return fn.apply(this, args);
        },
      };
      const wrapped = holder[name] as unknown as T;
      try {
        Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
      } catch { /* ignore */ }
      patchedSources.set(wrapped, nativeCode(name));
      return wrapped;
    };

    // Wrap Function.prototype.toString so anyone who inspects our patched
    // functions sees "[native code]" instead of our actual implementation.
    // Routed through fakeNative too (not just a raw function assignment) so
    // toString ITSELF gets the same real-native-name/no-own-prototype shape
    // fix as every other patched property, not just its own string output.
    const newToString = fakeNative(function (this: Function) {
      const cached = patchedSources.get(this);
      if (cached) return cached;
      return nativeToString.call(this);
    }, "toString");
    try { Function.prototype.toString = newToString; } catch { /* may be frozen */ }

    // Cross-realm toString "lie detector" hardening (a documented CreepJS-
    // style technique): a page can synchronously create a fresh iframe and
    // grab ITS pristine, unpatched Function.prototype.toString before this
    // content script's own document_start injection has had a chance to run
    // inside that new frame's realm — then call that pristine toString
    // against one of THIS realm's patched functions (e.g. navigator.
    // webdriver's getter) to read its real source, since native toString
    // reads a function's own [[SourceText]] regardless of which realm's
    // copy of the built-in performs the read; the WeakMap-based disguise
    // above only intercepts calls through THIS realm's own (overridden)
    // toString. Confirmed empirically: a fresh same-tick iframe's toString
    // revealed the actual minified patch source where this realm's own
    // toString correctly showed "[native code]".
    //
    // Fix: intercept contentWindow/contentDocument access on iframes so
    // that, the moment a page reaches into a new iframe's realm, THAT
    // realm's own Function.prototype.toString gets wrapped too — checked
    // against the SAME patchedSources WeakMap (captured by closure, so it
    // recognizes every function THIS outer realm has faked), not a fresh
    // one scoped to the iframe. Also marks the iframe with the SAME
    // __cfStealthApplied flag this file checks at the very top, so if this
    // iframe later runs its own natural document_start injection (via
    // all_frames), it sees the marker and skips — a fresh, independent
    // patchedSources WeakMap there would have no knowledge of THIS realm's
    // faked functions and could otherwise clobber this wrap with one that
    // doesn't protect them. Trade-off: an iframe handled this way doesn't
    // get its OWN navigator.webdriver/plugins/etc. patched — an accepted,
    // narrower scope than the specific, proven leak this closes.
    const patchToStringForRealm = (win: unknown): void => {
      try {
        const w = win as { Function?: { prototype?: object }; __cfStealthApplied?: boolean } | null | undefined;
        if (!w || w.__cfStealthApplied || !w.Function?.prototype) return;
        const realmProto = w.Function.prototype as { toString?: (this: Function) => string };
        const realmNativeToString = realmProto.toString;
        if (!realmNativeToString) return;
        const realmNewToString = fakeNative(function (this: Function) {
          const cached = patchedSources.get(this);
          if (cached) return cached;
          return realmNativeToString.call(this);
        }, "toString");
        (realmProto as Record<string, unknown>).toString = realmNewToString;
        Object.defineProperty(w, "__cfStealthApplied", { value: true, configurable: false, enumerable: false, writable: false });
      } catch { /* cross-origin realm, or otherwise inaccessible — ignore */ }
    };
    try {
      const patchFrameCtor = (ctor: { prototype: object } | undefined) => {
        if (!ctor) return;
        for (const prop of ["contentWindow", "contentDocument"] as const) {
          const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
          if (!desc?.get) continue;
          const origGetter = desc.get;
          Object.defineProperty(ctor.prototype, prop, {
            ...desc,
            get: fakeNative(function (this: HTMLIFrameElement) {
              const result = origGetter.call(this);
              if (result) {
                patchToStringForRealm(prop === "contentWindow" ? result : (result as Document).defaultView);
              }
              return result;
            }, `get ${prop}`),
          });
        }
      };
      patchFrameCtor((window as unknown as { HTMLIFrameElement?: { prototype: object } }).HTMLIFrameElement);
      patchFrameCtor((window as unknown as { HTMLFrameElement?: { prototype: object } }).HTMLFrameElement);
    } catch { /* ignore */ }

    // navigator.webdriver — only patch if it's ALREADY true. Chromeflow never
    // launches Chrome with --enable-automation (the flag that actually sets
    // this to true), so on chromeflow's real architecture this already reads
    // false natively, same as an unmodified browser. Confirmed live
    // 2026-09-14: with an unconditional override here, CreepJS's "headless"
    // bucket read 33% (webDriverIsOn true, via its lie-detector flagging the
    // replaced-but-value-identical getter); with the extension fully
    // disabled (so nothing touches navigator.webdriver at all), the same
    // bucket read a clean 0%. Overriding an already-correct native getter
    // was net negative — CreepJS's lie-detector doesn't care that the
    // returned VALUE matches, only that the getter isn't the original. Keep
    // the override only for the genuine tell this was meant to guard
    // against (some other extension, or a test harness, having already
    // flipped it to true) rather than always replacing a getter that's
    // usually already fine.
    try {
      if (navigator.webdriver === true) {
        Object.defineProperty(Navigator.prototype, "webdriver", {
          get: fakeNative(function get() { return false; }, "get webdriver"),
          configurable: true,
          enumerable: true,
        });
      }
    } catch { /* already locked */ }

    // navigator.permissions.query — patch the famous notifications/denied tell.
    try {
      const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
      if (perms && typeof perms.query === "function") {
        const origQuery = perms.query.bind(perms);
        perms.query = fakeNative(function (parameters: PermissionDescriptor) {
          if (parameters && parameters.name === "notifications") {
            // Mirror Notification.permission rather than hardcoding "default": on a
            // real (non-headless) profile with prior history for this origin, the
            // static reader can already be "granted"/"denied", and forcing this API
            // to say "default" regardless would manufacture the exact cross-API
            // contradiction this patch exists to prevent, just in the other direction.
            const real = typeof Notification !== "undefined" ? Notification.permission : "default";
            return Promise.resolve({
              state: real,
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

    // MouseEvent/PointerEvent screenX/screenY — CDP's Input.dispatchMouseEvent
    // has no screenX/screenY parameters at all (only viewport-relative x/y),
    // and Chromium's fallback sets screenX/screenY equal to clientX/clientY —
    // a real mouse's screen coordinates only equal its client coordinates if
    // the browser window happens to sit at (0,0) with zero chrome, which is
    // never true in practice. This is a known, currently-exploited signal
    // (chromium:40280325; a public tool exists specifically to spoof this
    // against Cloudflare Turnstile). That tool's fix sets one random constant
    // for the whole page load — same value on every click regardless of
    // where it landed, which is its own tell once more than one click is
    // correlated. This derives screenX/screenY from clientX/clientY plus a
    // window-position offset chosen once per page load (mirroring how a
    // real, stationary browser window behaves for its whole session), so
    // different clicks at different positions produce correspondingly
    // different, internally-consistent screen coordinates.
    try {
      const screenOffsetX = Math.floor(Math.random() * 400) + 40; // plausible window left-edge position
      const screenOffsetY = Math.floor(Math.random() * 120) + 80; // plausible top chrome + window position
      Object.defineProperty(MouseEvent.prototype, "screenX", {
        get: fakeNative(function (this: MouseEvent) { return this.clientX + screenOffsetX; }, "get screenX"),
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(MouseEvent.prototype, "screenY", {
        get: fakeNative(function (this: MouseEvent) { return this.clientY + screenOffsetY; }, "get screenY"),
        configurable: true,
        enumerable: true,
      });
    } catch { /* ignore */ }

    // MouseEvent/PointerEvent movementX/movementY — CDP-dispatched pointer
    // events always report these as 0 (a long-standing, documented Chrome/
    // Edge quirk, W3C pointerevents#131); a real mouse's movementX/Y track
    // the delta since the previous move event, so a position that visibly
    // changes across events while movementX/Y stay 0 the whole time is a
    // contradiction no real pointer produces. Tracks the last seen
    // clientX/clientY in closure state and computes the delta on read,
    // covering both real and CDP-dispatched events uniformly (a real
    // pointermove's own native movementX/Y is simply overwritten with an
    // equivalent freshly-computed value, so nothing regresses for it).
    try {
      let lastX: number | null = null;
      let lastY: number | null = null;
      Object.defineProperty(MouseEvent.prototype, "movementX", {
        get: fakeNative(function (this: MouseEvent) {
          const dx = lastX === null ? 0 : this.clientX - lastX;
          lastX = this.clientX;
          return dx;
        }, "get movementX"),
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(MouseEvent.prototype, "movementY", {
        get: fakeNative(function (this: MouseEvent) {
          const dy = lastY === null ? 0 : this.clientY - lastY;
          lastY = this.clientY;
          return dy;
        }, "get movementY"),
        configurable: true,
        enumerable: true,
      });
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
