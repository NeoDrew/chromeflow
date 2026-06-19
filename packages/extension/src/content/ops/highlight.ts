import {
  clearAllOverlays,
  findElementByText,
  highlightElement,
  renderHighlight,
  showInstanceInfo,
  hideInstanceInfo,
  setInstanceInfoVisible,
} from "../highlight.js";
import { queryAllDeep } from "../shadow.js";
import { armClickBuffer } from "./click-watch.js";
import type { IncomingMessage } from "./frame-util.js";

export function opFindHighlight(msg: IncomingMessage): unknown {
  const el = findElementByText(msg.text as string);
  if (!el) {
    return { type: "find_highlight_response", requestId: msg.requestId, found: false };
  }
  highlightElement(el, msg.message as string, "#7c3aed", msg.valueToType as string | undefined);
  armClickBuffer();
  return { type: "find_highlight_response", requestId: msg.requestId, found: true };
}

export function opHighlightRegion(msg: IncomingMessage): unknown {
  clearAllOverlays();
  let x = msg.x as number | undefined;
  let y = msg.y as number | undefined;
  let width = msg.width as number | undefined;
  let height = msg.height as number | undefined;

  // If a selector is provided, resolve coordinates from the DOM.
  // Uses queryAllDeep to pierce open AND closed shadow roots so
  // selectors targeting shadow DOM elements (annotation-dashboard panels,
  // Reddit faceplate-*, Radix portals) resolve correctly.
  if (msg.selector) {
    const el = queryAllDeep<HTMLElement>(document, msg.selector as string)[0] ?? null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const rect = el.getBoundingClientRect();
      x = Math.round(rect.left);
      y = Math.round(rect.top);
      width = Math.round(rect.width);
      height = Math.round(rect.height);
    }
  }

  if (x == null || y == null || width == null || height == null) {
    return { type: "action_done", requestId: msg.requestId, message: "Element not found for selector" };
  }

  renderHighlight({
    x, y, width, height,
    message: msg.message as string,
    valueToType: msg.valueToType as string | undefined,
  });
  armClickBuffer();
  return { type: "action_done", requestId: msg.requestId };
}

export function opClear(msg: IncomingMessage): unknown {
  clearAllOverlays();
  return { type: "action_done", requestId: msg.requestId };
}

export function opShowInstanceInfo(msg: IncomingMessage): unknown {
  showInstanceInfo({
    label: msg.label as string | undefined,
    port: msg.port as number | undefined,
    host: msg.host as string | undefined,
  });
  return { type: "action_done", requestId: msg.requestId };
}

export function opHideInstanceInfo(msg: IncomingMessage): unknown {
  hideInstanceInfo();
  return { type: "action_done", requestId: msg.requestId };
}

export function opSetInstanceInfoVisible(msg: IncomingMessage): unknown {
  setInstanceInfoVisible(msg.visible as boolean);
  return { type: "action_done", requestId: msg.requestId };
}
