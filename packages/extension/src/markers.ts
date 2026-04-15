/**
 * Per-install randomized DOM marker prefix.
 *
 * Chromeflow leaves a few DOM markers while operating:
 *   - overlay container ID (highlights)
 *   - injected <style> element ID
 *   - animation names on pulsing highlights
 *   - data-attributes for click/file-upload tagging
 *
 * A stable string like "chromeflow" in these names is grep-able and forms
 * an obvious fingerprint for anti-automation systems that specifically
 * look for chromeflow. We randomize the prefix at extension install and
 * persist it in chrome.storage.local, so each chromeflow installation
 * looks different and the names don't spell out our product.
 *
 * Background and content scripts each bundle their own copy of this module
 * but read from the same chrome.storage value, so they agree on the prefix.
 */

const STORAGE_KEY = "cfMarkerPrefix";
// Fallback if storage read races against first usage. Still non-obviously-chromeflow.
const FALLBACK = "kx";

function randomPrefix(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l for readability
  let p = "";
  for (let i = 0; i < 6; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

let cached: string = FALLBACK;

/** Kick off the storage read at module load. */
const readyPromise: Promise<string> = (async () => {
  try {
    const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
    if (typeof stored === "string" && stored.length >= 3) {
      cached = stored;
      return cached;
    }
    // No prefix yet — generate and persist.
    const fresh = randomPrefix();
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    cached = fresh;
    return cached;
  } catch {
    return cached; // fallback if storage unavailable (e.g. non-extension context)
  }
})();

/** Synchronous accessor. Returns the cached prefix, or fallback if storage
 *  hasn't loaded yet. Safe to call at any time. */
export function prefix(): string {
  return cached;
}

/** Resolve when the stored prefix has been read (or generated). Await this
 *  at the top of message handlers that read marker-tagged elements. */
export function markersReady(): Promise<string> {
  return readyPromise;
}

// Handy pre-composed identifiers. These are getter functions — call at use
// site so they reflect the resolved prefix, not the module-load-time fallback.
export const markerIds = {
  overlayContainer: () => `__${prefix()}_ov__`,
  styleElement: () => `__${prefix()}_st__`,
  animationPulse: () => `${prefix()}-pulse`,
  animationFade: () => `${prefix()}-fade`,
  fileTargetAttr: () => `data-${prefix()}-file`,
  clickTargetAttr: () => `data-${prefix()}-click`,
};
