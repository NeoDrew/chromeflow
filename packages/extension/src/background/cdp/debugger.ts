// CDP debugger mutex + refcount. Shared module-level state lives HERE and is
// imported by every other cdp/* module that attaches the debugger.

// ─── Debugger mutex ────────────────────────────────────────────────────────
// Chrome allows only one debugger client per tab. If execute_script (CSP
// bypass path), type_text, and set_file_input all want to attach to the same
// tab, concurrent calls would race and the second attach fails with
// "Another debugger is already attached." This serializes all debugger
// operations per tab — each call waits for the previous one to detach.
export const tabDebuggerLocks = new Map<number, Promise<void>>();
// Refcount for nested withDebugger calls on the same tab. Lets click_element
// hold a single outer attach across prep + CDP click + activity probe +
// fallback chain + until-poll so a beforeunload listener registered at the
// outer scope stays armed when nested CDP helpers (dispatchHumanMouseClick,
// dispatchTapGesture, dispatchKeyboardActivation) finish their inner blocks.
// Without this, the inner withDebugger detaches between the click and the
// probe, and a "Leave site?" dialog that fires during the probe hangs the
// tab because the listener can no longer send Page.handleJavaScriptDialog.
export const tabDebuggerRefCount = new Map<number, number>();

export async function withDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  // Nested call inside an outer attach: skip both the queue and the
  // attach/detach pair. Just bump the refcount and run.
  const existing = tabDebuggerRefCount.get(tabId) ?? 0;
  if (existing > 0) {
    tabDebuggerRefCount.set(tabId, existing + 1);
    try {
      return await fn();
    } finally {
      const cur = tabDebuggerRefCount.get(tabId) ?? 1;
      if (cur <= 1) tabDebuggerRefCount.delete(tabId);
      else tabDebuggerRefCount.set(tabId, cur - 1);
    }
  }

  const prev = tabDebuggerLocks.get(tabId);
  if (prev) await prev.catch(() => {});

  let release!: () => void;
  const lock = new Promise<void>((r) => { release = r; });
  tabDebuggerLocks.set(tabId, lock);

  try {
    // Retry attach up to 5 times with 500ms..2500ms backoff. The most common
    // failure isn't a real conflict (DevTools, second chromeflow instance) —
    // it's a transient race inside chromeflow itself where one handler's
    // detach hasn't propagated yet when the next handler tries to attach.
    // Bumped from 3 → 5 attempts because the 3-attempt budget (~1.5s) was
    // tripping on these races even when no real conflict existed.
    const MAX_ATTEMPTS = 5;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await (chrome.debugger as any).attach({ tabId }, "1.3");
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        const msg = String(lastErr.message ?? err);
        if (msg.includes("Another debugger is already attached") && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (msg.includes("Another debugger is already attached")) {
          throw new Error(
            `Another debugger is already attached to this tab after ${MAX_ATTEMPTS} retries (waited ~7.5s). If you do not have Chrome DevTools open (Cmd+Opt+I) and no other chromeflow instance is using this tab, this is likely a transient internal race — retrying the same call should succeed. If it persists, close DevTools or move the other chromeflow instance to a separate Chrome window.`
          );
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    tabDebuggerRefCount.set(tabId, 1);
    try {
      return await fn();
    } finally {
      tabDebuggerRefCount.delete(tabId);
      await (chrome.debugger as any).detach({ tabId }).catch(() => {});
    }
  } finally {
    release();
    if (tabDebuggerLocks.get(tabId) === lock) tabDebuggerLocks.delete(tabId);
  }
}
