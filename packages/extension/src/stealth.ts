/**
 * Stealth patches — runs at document_start in the MAIN world (page context),
 * BEFORE any page script. Hides JS-level fingerprints commonly used by
 * anti-automation systems (LinkedIn, Outlier, Cloudflare, Datadome, etc.).
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
  } catch {
    // Stealth patches must NEVER break the page. Silently swallow any error.
  }
})();
