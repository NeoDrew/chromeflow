import { findTopmostDialog, findDialogByQuery } from "../click.js";
import { findText, findInputs, waitForText } from "../find.js";
import { resolveFrameDocument, frameErrorHint, type IncomingMessage } from "./frame-util.js";

export function opFindText(msg: IncomingMessage): unknown {
  const doc = resolveFrameDocument(msg.frame as string | undefined);
  if (doc === null) {
    return {
      type: "find_text_response",
      requestId: msg.requestId,
      matches: [],
      total_matches: 0,
      hidden_count: 0,
      truncated: false,
      frame_error: frameErrorHint(msg.frame as string | undefined),
    };
  }
  // in_dialog / dialog_query override scope_selector when set, matching
  // click_element's behavior so the same flag works across both tools.
  let scopeSelector = msg.scope_selector as string | undefined;
  if (msg.dialog_query) {
    const d = findDialogByQuery(msg.dialog_query as string);
    if (!d) {
      return {
        type: "find_text_response", requestId: msg.requestId,
        matches: [], total_matches: 0, hidden_count: 0, truncated: false,
        scope_missed: true,
        frame_error: `dialog_query "${msg.dialog_query}" did not match any open dialog`,
      };
    }
    // Tag the dialog with a temporary id we can pass as scope_selector.
    const scopeId = `chromeflow-find-scope-${Date.now()}`;
    d.setAttribute("data-chromeflow-find-scope", scopeId);
    scopeSelector = `[data-chromeflow-find-scope="${scopeId}"]`;
  } else if (msg.in_dialog) {
    const d = findTopmostDialog();
    if (!d) {
      return {
        type: "find_text_response", requestId: msg.requestId,
        matches: [], total_matches: 0, hidden_count: 0, truncated: false,
        scope_missed: true,
        frame_error: `in_dialog=true but no open dialog on the page`,
      };
    }
    const scopeId = `chromeflow-find-scope-${Date.now()}`;
    d.setAttribute("data-chromeflow-find-scope", scopeId);
    scopeSelector = `[data-chromeflow-find-scope="${scopeId}"]`;
  }
  const result = findText(
    msg.query as string,
    {
      max: msg.max as number | undefined,
      scope_selector: scopeSelector,
      regex: msg.regex as boolean | undefined,
      visible_only: msg.visible_only as boolean | undefined,
      context_chars: msg.context_chars as number | undefined,
      whole_word: msg.whole_word as boolean | undefined,
    },
    doc
  );
  // Clean up the temporary scope tag so subsequent calls don't leak.
  if (msg.in_dialog || msg.dialog_query) {
    document.querySelectorAll("[data-chromeflow-find-scope]").forEach((el) => el.removeAttribute("data-chromeflow-find-scope"));
  }
  return { type: "find_text_response", requestId: msg.requestId, ...result };
}

export function opFindInput(msg: IncomingMessage): unknown {
  const doc = resolveFrameDocument(msg.frame as string | undefined);
  if (doc === null) {
    return {
      type: "find_input_response",
      requestId: msg.requestId,
      fields: [],
      total_matches: 0,
      truncated: false,
      frame_error: frameErrorHint(msg.frame as string | undefined),
    };
  }
  const result = findInputs(
    msg.query as string,
    {
      type_filter: msg.type_filter as string | undefined,
      max: msg.max as number | undefined,
      exact: msg.exact as boolean | undefined,
    },
    doc
  );
  return { type: "find_input_response", requestId: msg.requestId, ...result };
}

export async function opWaitForText(msg: IncomingMessage): Promise<unknown> {
  const doc = resolveFrameDocument(msg.frame as string | undefined);
  if (doc === null) {
    return {
      type: "wait_for_text_response",
      requestId: msg.requestId,
      found: false,
      elapsed_ms: 0,
      frame_error: frameErrorHint(msg.frame as string | undefined),
    };
  }
  const result = await waitForText(
    msg.query as string | string[],
    {
      timeout_ms: msg.timeout_ms as number | undefined,
      scope_selector: msg.scope_selector as string | undefined,
      regex: msg.regex as boolean | undefined,
      since: msg.since as "now" | undefined,
      whole_word: msg.whole_word as boolean | undefined,
    },
    doc
  );
  return { type: "wait_for_text_response", requestId: msg.requestId, ...result };
}
