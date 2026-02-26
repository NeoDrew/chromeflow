import {
  clearAllOverlays,
  findElementByText,
  highlightElement,
  renderHighlight,
} from "./highlight.js";
import { clearPanel, markStepDone, showGuidePanel } from "./panel.js";
import { readElementValue } from "./capture.js";
import { fillInput } from "./fill.js";
import { clickElement } from "./click.js";

// On load: ask background for any active guide panel state and re-inject it.
chrome.runtime.sendMessage(
  { source: "chromeflow-content", type: "get_state" },
  (response: { panel?: { title: string; steps: Array<{ text: string; done?: boolean }> } | null }) => {
    if (chrome.runtime.lastError) return; // background not ready yet
    if (response?.panel) {
      showGuidePanel(response.panel.title, response.panel.steps);
    }
  }
);

type IncomingMessage = {
  type: string;
  requestId: string;
  [key: string]: unknown;
};

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
    case "find_highlight": {
      const el = findElementByText(msg.text as string);
      if (!el) {
        return { type: "find_highlight_response", requestId: msg.requestId, found: false };
      }
      highlightElement(el, msg.message as string);
      return { type: "find_highlight_response", requestId: msg.requestId, found: true };
    }

    case "highlight_region": {
      clearAllOverlays();
      renderHighlight({
        x: msg.x as number,
        y: msg.y as number,
        width: msg.width as number,
        height: msg.height as number,
        message: msg.message as string,
      });
      return { type: "action_done", requestId: msg.requestId };
    }

    case "show_panel": {
      showGuidePanel(
        msg.title as string,
        msg.steps as Array<{ text: string; done?: boolean }>
      );
      return { type: "action_done", requestId: msg.requestId };
    }

    case "mark_step_done": {
      markStepDone(msg.stepIndex as number);
      return { type: "action_done", requestId: msg.requestId };
    }

    case "start_click_watch": {
      // Respond immediately so the message channel isn't held open.
      // Will notify background via a separate sendMessage when click detected.
      startClickWatch(msg.requestId as string);
      return { type: "action_done", requestId: msg.requestId };
    }

    case "click_element": {
      const result = clickElement(msg.textHint as string);
      return { type: "click_element_response", requestId: msg.requestId, ...result };
    }

    case "scroll_page": {
      const dir = msg.direction as "down" | "up";
      const amount = (msg.amount as number) || 400;
      // Scroll both window and any focused scroll container
      const delta = dir === "down" ? amount : -amount;
      window.scrollBy({ top: delta, behavior: "smooth" });
      // Also try scrolling the deepest overflow:scroll container in the center of the page
      const midEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      let node: Element | null = midEl;
      while (node && node !== document.documentElement) {
        const s = getComputedStyle(node);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
          node.scrollTop += delta;
          break;
        }
        node = node.parentElement;
      }
      return { type: "action_done", requestId: msg.requestId };
    }

    case "fill_input": {
      const result = fillInput(msg.textHint as string, msg.value as string);
      return { type: "fill_response", requestId: msg.requestId, ...result };
    }

    case "read_element": {
      const value = readElementValue(msg.textHint as string);
      return { type: "read_response", requestId: msg.requestId, value };
    }

    case "clear": {
      clearAllOverlays();
      clearPanel();
      return { type: "action_done", requestId: msg.requestId };
    }

    default:
      return {
        type: "error",
        requestId: msg.requestId,
        message: `Unknown message type: ${msg.type}`,
      };
  }
}

// ─── Click watching ────────────────────────────────────────────────────────

function startClickWatch(requestId: string) {
  let done = false;

  const notify = () => {
    if (done) return;
    done = true;
    cleanup();
    chrome.runtime.sendMessage({
      source: "chromeflow-content",
      type: "click_detected",
      requestId,
    });
  };

  // Accept any click on the page — the user is following the visual guide and
  // knows what to click. Filtering by position caused false negatives when
  // highlight coordinates were slightly off.
  const onPointerDown = () => notify();

  // Also advance when the user presses Enter/Tab (completing a form field)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab") notify();
  };

  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };

  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("keydown", onKeyDown, { capture: true });
}
