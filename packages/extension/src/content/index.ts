// Content-script message router (thin entry).
//
// This file wires the chrome.runtime.onMessage listener and the web-page
// connection-request relay, then dispatches each message type to a domain
// handler in ./ops/*. The per-message-type handler BODIES live in ./ops; this
// file knows only how to route to them. The pre-armed click buffer + click
// watch machinery (shared between the highlight ops and the click ops) lives in
// ./ops/click-watch.ts.
//
// The sibling-module imports below are preserved from the pre-split router so
// that anything still wiring through index.ts (and esbuild's bundle graph)
// keeps the same module edges. The ops modules import these siblings directly.
import {
  clearAllOverlays,
  findElementByText,
  highlightElement,
  renderHighlight,
  showInstanceInfo,
  hideInstanceInfo,
  setInstanceInfoVisible,
} from "./highlight.js";
import { readElementValue } from "./capture.js";
import { fillInput } from "./fill.js";
import { clickElement, prepareClickTarget, postClickInspect, scrollSmartIntoView, findTopmostDialog, findDialogByQuery, pointerChainOnTagged } from "./click.js";
import { collectShadowHosts, countShadowHosts, extractTextDeep, queryAllDeep } from "./shadow.js";
import { enumerateFormFields } from "./forms.js";
import { findText, findInputs, waitForText } from "./find.js";
import { markerIds } from "../markers.js";
import { redactSecrets } from "./redact.js";
import { SET_FILE_FROM_CONTENT, type SetFileFromContentMessage } from "../connections.js";

import type { IncomingMessage } from "./ops/frame-util.js";
import {
  opFindHighlight,
  opHighlightRegion,
  opClear,
  opShowInstanceInfo,
  opHideInstanceInfo,
  opSetInstanceInfoVisible,
} from "./ops/highlight.js";
import {
  opStartClickWatch,
  opClickElement,
  opPrepareClickTarget,
  opPointerChainClick,
  opPostClickInspect,
  opTagForReact,
} from "./ops/click.js";
import { opWaitForChange, opScrollPage, opScrollToElement } from "./ops/wait.js";
import {
  opReadElement,
  opGetPageText,
  opGetPageHtml,
  opGetElements,
  opGetFormFields,
} from "./ops/read.js";
import { opFindText, opFindInput, opWaitForText } from "./ops/find.js";
import { opFillInput, opSavePageState, opRestorePageState, opFillForm } from "./ops/fill.js";
import {
  opTagFileInput,
  opUntagFileInput,
  opDispatchFileChangeEvents,
  opSetFileFromContent,
} from "./ops/files.js";
import { opListFrames } from "./ops/frames.js";

chrome.runtime.onMessage.addListener(
  (msg: IncomingMessage, _sender, sendResponse) => {
    handleMessage(msg)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ type: "error", requestId: msg.requestId, message: String(err) })
      );
    return true;
  }
);

async function handleMessage(msg: IncomingMessage): Promise<unknown> {
  switch (msg.type) {
    case "find_highlight":
      return opFindHighlight(msg);
    case "highlight_region":
      return opHighlightRegion(msg);
    case "start_click_watch":
      return opStartClickWatch(msg);
    case "click_element":
      return opClickElement(msg);
    case "prepare_click_target":
      return opPrepareClickTarget(msg);
    case "pointer_chain_click":
      return opPointerChainClick(msg);
    case "post_click_inspect":
      return opPostClickInspect(msg);
    case "tag_for_react":
      return opTagForReact(msg);
    case "wait_for_change":
      return opWaitForChange(msg);
    case "scroll_page":
      return opScrollPage(msg);
    case "fill_input":
      return opFillInput(msg);
    case "read_element":
      return opReadElement(msg);
    case "get_page_text":
      return opGetPageText(msg);
    case "get_page_html":
      return opGetPageHtml(msg);
    case "get_elements":
      return opGetElements(msg);
    case "get_form_fields":
      return opGetFormFields(msg);
    case "find_text":
      return opFindText(msg);
    case "find_input":
      return opFindInput(msg);
    case "wait_for_text":
      return opWaitForText(msg);
    case "scroll_to_element":
      return opScrollToElement(msg);
    case "save_page_state":
      return opSavePageState(msg);
    case "restore_page_state":
      return opRestorePageState(msg);
    case "fill_form":
      return opFillForm(msg);
    case "tag_file_input":
      return opTagFileInput(msg);
    case "untag_file_input":
      return opUntagFileInput(msg);
    case "dispatch_file_change_events":
      return opDispatchFileChangeEvents(msg);
    case SET_FILE_FROM_CONTENT:
      return opSetFileFromContent(msg);
    case "clear":
      return opClear(msg);
    case "show_instance_info":
      return opShowInstanceInfo(msg);
    case "hide_instance_info":
      return opHideInstanceInfo(msg);
    case "set_instance_info_visible":
      return opSetInstanceInfoVisible(msg);
    case "list_frames":
      return opListFrames(msg);

    default:
      return {
        type: "error",
        requestId: msg.requestId,
        message: `Unknown message type: ${msg.type}`,
      };
  }
}

// ─── Web-page-initiated connection request ───────────────────────────────────
// Any web page (e.g. a SaaS dashboard) can ask chromeflow to add a connection by
// posting `window.postMessage({ type: "chromeflow:add-connection", url, label })`.
// We relay it to the background, which opens the connection window PRE-FILLED for
// the user to confirm. The user must still click "Add" in that trusted extension
// window, so a page can never silently attach the browser to an arbitrary server.
window.addEventListener("message", (event) => {
  if (event.source !== window) return; // same-window page messages only
  const data = event.data as
    | { type?: unknown; url?: unknown; label?: unknown }
    | null;
  if (!data || typeof data !== "object") return;
  if (data.type !== "chromeflow:add-connection") return;
  if (typeof data.url !== "string" || !data.url) return;
  try {
    chrome.runtime.sendMessage({
      type: "chromeflow-web-connect",
      url: data.url,
      label: typeof data.label === "string" ? data.label : "",
      origin: event.origin,
    });
  } catch {
    // extension context may be gone (reload); ignore
  }
});
