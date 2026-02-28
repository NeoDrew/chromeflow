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
      highlightElement(el, msg.message as string, "#7c3aed", msg.valueToType as string | undefined);
      armClickBuffer();
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
        valueToType: msg.valueToType as string | undefined,
      });
      armClickBuffer();
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
      // Disarm the pre-buffer listener since we're taking over with a real watch.
      preClickCleanup?.();
      preClickCleanup = null;

      if (pendingPreClick) {
        // User already clicked while the highlight was showing — fire immediately.
        pendingPreClick = false;
        chrome.runtime.sendMessage({
          source: "chromeflow-content",
          type: "click_detected",
          requestId: msg.requestId as string,
        });
      } else {
        startClickWatch(msg.requestId as string);
      }
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

    case "get_page_text": {
      const selector = msg.selector as string | undefined;
      let root: Element;
      if (selector) {
        root = document.querySelector(selector) ?? document.body;
      } else {
        root = document.querySelector("main, [role='main']") ?? document.body;
      }
      const clone = root.cloneNode(true) as Element;
      ["nav", "header", "footer", "script", "style", "noscript"].forEach((tag) => {
        clone.querySelectorAll(tag).forEach((el) => el.remove());
      });
      let text = (clone.textContent ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
      if (text.length > 4000) text = text.slice(0, 4000) + "\n... (truncated)";
      return { type: "page_text_response", requestId: msg.requestId, text };
    }

    case "get_elements": {
      const SELECTORS = "input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=link]";
      const results: Array<{ index: number; type: string; label: string; x: number; y: number; width: number; height: number }> = [];
      let idx = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTORS))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") continue;

        let label = "";
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          label = el.placeholder || el.getAttribute("aria-label") || el.getAttribute("name") || "";
          if (!label && el.id) {
            const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`);
            if (lbl) label = (lbl.textContent ?? "").trim();
          }
        } else {
          label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60);
        }

        const type = el instanceof HTMLInputElement ? (el.type || "text") : el.tagName.toLowerCase();
        results.push({
          index: ++idx,
          type,
          label: label.replace(/\s+/g, " ").trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        if (idx >= 60) break;
      }
      return { type: "elements_response", requestId: msg.requestId, elements: results };
    }

    case "clear": {
      clearAllOverlays();
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

// ─── Pre-armed click buffer ─────────────────────────────────────────────────
// Arms a click listener as soon as a highlight is shown, so that if the user
// clicks before wait_for_click is called, the click is not missed.

let pendingPreClick = false;
let preClickCleanup: (() => void) | null = null;

function armClickBuffer() {
  // Reset any previous buffer
  preClickCleanup?.();
  pendingPreClick = false;

  const onPointerDown = (e: PointerEvent) => {
    const { clientX, clientY } = e;
    pendingPreClick = true;
    clearAllOverlays(); // remove the highlight as soon as the user clicks
    // Forward focus to the underlying element (the overlay intercepted the click,
    // so the input was never focused — fix that before fill_input is called).
    requestAnimationFrame(() => {
      const el = document.elementFromPoint(clientX, clientY);
      if (el instanceof HTMLElement) el.focus();
    });
    cleanup();
  };

  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown as EventListener, true);
    preClickCleanup = null;
  };

  preClickCleanup = cleanup;
  document.addEventListener("pointerdown", onPointerDown as EventListener, { capture: true, once: true });
}

// ─── Click watching ────────────────────────────────────────────────────────

function startClickWatch(requestId: string) {
  let done = false;

  const notify = (clientX?: number, clientY?: number) => {
    if (done) return;
    done = true;
    cleanup();
    clearAllOverlays(); // remove the highlight as soon as the user clicks
    // Forward focus to the underlying element so fill_input's activeElement
    // fallback can find it.
    if (clientX !== undefined && clientY !== undefined) {
      requestAnimationFrame(() => {
        const el = document.elementFromPoint(clientX, clientY);
        if (el instanceof HTMLElement) el.focus();
      });
    }
    chrome.runtime.sendMessage({
      source: "chromeflow-content",
      type: "click_detected",
      requestId,
    });
  };

  // Accept any click on the page — the user is following the visual guide and
  // knows what to click. Filtering by position caused false negatives when
  // highlight coordinates were slightly off.
  const onPointerDown = (e: PointerEvent) => notify(e.clientX, e.clientY);

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
