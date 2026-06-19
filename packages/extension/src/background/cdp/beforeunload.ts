// Beforeunload ("Leave site?" / "Reload site?") auto-dismiss helpers.

/**
 * Attach a CDP listener that auto-accepts Chrome's native "Leave site?" /
 * "Reload site?" beforeunload dialog on the given tab. Returns a `release`
 * callback that detaches the listener and reports whether a dialog was
 * dismissed during the protected window.
 *
 * Used by navigate, close_tab, and close_other_tabs so the agent doesn't
 * hang at the WS timeout when the target tab has unsaved form state. The
 * `dismissed_beforeunload` field in the tool response tells the caller
 * that the page HAD unsaved content (so they can navigate back + recover
 * if it mattered).
 *
 * Best-effort: if the debugger attach fails (already attached, no
 * permission, non-scriptable URL), the dialog will block as before and
 * dismissed stays false. Caller can detect that via the response field.
 */
export async function setupBeforeunloadAutoDismiss(tabId: number): Promise<{
  release: () => Promise<{ dismissed: boolean }>;
}> {
  let dismissed = false;
  let attached = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as { attach: (t: { tabId: number }, v: string) => Promise<void> })
      .attach({ tabId }, "1.3");
    attached = true;
    await (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string) => Promise<unknown> })
      .sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown> })
          .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true })
          .catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch {
    // Debugger attach failed. Navigation/close proceeds without protection.
  }
  return {
    release: async () => {
      if (handler) {
        chrome.debugger.onEvent.removeListener(handler);
        handler = null;
      }
      if (attached) {
        try {
          await (chrome.debugger as unknown as { detach: (t: { tabId: number }) => Promise<void> })
            .detach({ tabId });
        } catch { /* may already be detached after tab close / navigation */ }
      }
      return { dismissed };
    },
  };
}

/**
 * Register a Page.javascriptDialogOpening listener that auto-dismisses the
 * native "Leave site?" / "Reload site?" beforeunload dialog on the given tab.
 * Assumes the caller is already inside an active withDebugger attach. Returns
 * a `release` callback that detaches the listener and reports whether a
 * dialog was dismissed during the protected window.
 *
 * Owned by click_element so the listener spans the entire flow: prep, CDP
 * click, activity probe, fallback chain, until-poll. Reddit's submit flow
 * fires the beforeunload 1-2s AFTER the click (post-API navigation), well
 * after dispatchHumanMouseClick's own withDebugger would have detached.
 */
export async function armBeforeunloadDismissOnAttachedTab(tabId: number): Promise<{
  release: () => { dismissed: boolean };
}> {
  let dismissed = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, m: string) => Promise<unknown>;
    }).sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as {
          sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown>;
        }).sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch { /* Page.enable failed; flow proceeds without protection */ }
  return {
    release: () => {
      if (handler) {
        try { chrome.debugger.onEvent.removeListener(handler); } catch { /* ignore */ }
        handler = null;
      }
      return { dismissed };
    },
  };
}
