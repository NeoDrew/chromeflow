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
      let selectorMissed = false;
      if (selector) {
        const el = document.querySelector(selector);
        if (!el) selectorMissed = true;
        root = el ?? document.body;
      } else {
        const main = document.querySelector("main, [role='main']");
        // Fall back to body if main has insufficient text (e.g. React SPAs where
        // main is a near-empty shell and content is rendered in child components).
        root = (main && (main.textContent ?? "").trim().length > 80) ? main : document.body;
      }
      const clone = root.cloneNode(true) as Element;
      ["nav", "header", "footer", "script", "style", "noscript"].forEach((tag) => {
        clone.querySelectorAll(tag).forEach((el) => el.remove());
      });
      let text = (clone.textContent ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
      if (selectorMissed) {
        text = `[Warning: selector "${selector}" not found — returning full page text]\n\n` + text;
      }
      if (text.length > 4000) text = text.slice(0, 4000) + "\n... (truncated)";
      return { type: "page_text_response", requestId: msg.requestId, text };
    }

    case "get_elements": {
      const SELECTORS = "input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=link]";
      const results: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> = [];
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

        // Include the current value so Claude can see what's already selected/filled.
        let currentValue = "";
        if (el instanceof HTMLSelectElement) {
          currentValue = el.options[el.selectedIndex]?.text ?? el.value;
        } else if (el instanceof HTMLInputElement) {
          if (el.type === "checkbox" || el.type === "radio") {
            currentValue = el.checked ? "checked" : "unchecked";
          } else if (el.value && el.value !== el.placeholder) {
            currentValue = el.value.slice(0, 40);
          }
        } else if (el instanceof HTMLTextAreaElement) {
          if (el.value) currentValue = el.value.slice(0, 40);
        }

        results.push({
          index: ++idx,
          type,
          label: label.replace(/\s+/g, " ").trim(),
          value: currentValue,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        if (idx >= 60) break;
      }
      return { type: "elements_response", requestId: msg.requestId, elements: results };
    }

    case "get_form_fields": {
      const fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string }> = [];
      let idx = 0;

      // Standard inputs, textareas, selects
      const FIELD_SELECTORS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select";
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(FIELD_SELECTORS))) {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();

        // Derive label
        let label = "";
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        label = inputEl.getAttribute("placeholder") || inputEl.getAttribute("aria-label") || "";
        if (!label && el.id) {
          const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`);
          if (lbl) label = (lbl.textContent ?? "").trim();
        }
        if (!label) {
          // Walk up to find a nearby label-like element
          let node: Element | null = el.parentElement;
          for (let d = 0; d < 4 && node && node !== document.body; d++) {
            const heading = node.querySelector("label, h1, h2, h3, h4, h5, legend, [class*='label']");
            if (heading && heading !== el) { label = (heading.textContent ?? "").trim(); break; }
            node = node.parentElement;
          }
        }

        // Current value
        let value = "";
        if (el instanceof HTMLSelectElement) {
          value = el.options[el.selectedIndex]?.text ?? el.value;
        } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          value = el.checked ? "checked" : "unchecked";
        } else {
          value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
        }

        // Unique selector (prefer id, fall back to nth-of-type)
        const selector = el.id
          ? `#${el.id}`
          : `${el.tagName.toLowerCase()}:nth-of-type(${Array.from(document.querySelectorAll(el.tagName)).indexOf(el) + 1})`;

        fields.push({
          index: ++idx,
          type: el instanceof HTMLInputElement ? (el.type || "text") : el.tagName.toLowerCase(),
          label: label.replace(/\s+/g, " ").slice(0, 80),
          value: value.slice(0, 60),
          y: Math.round(rect.top + window.scrollY),
          selector,
        });
      }

      // CodeMirror 6 editors
      for (const editor of Array.from(document.querySelectorAll<HTMLElement>(".cm-editor"))) {
        const s = getComputedStyle(editor);
        if (s.display === "none" || s.visibility === "hidden") continue;
        const rect = editor.getBoundingClientRect();

        let label = editor.getAttribute("aria-label") ?? "";
        if (!label) {
          const container = editor.closest("div[class], section, fieldset, li") ?? editor.parentElement;
          if (container) {
            const heading = container.querySelector("label, h1, h2, h3, h4, h5, legend, [class*='label']");
            if (heading) label = (heading.textContent ?? "").trim();
          }
        }

        const currentText = (editor.querySelector(".cm-content")?.textContent ?? "").slice(0, 60);
        fields.push({
          index: ++idx,
          type: "codemirror",
          label: label.replace(/\s+/g, " ").slice(0, 80),
          value: currentText,
          y: Math.round(rect.top + window.scrollY),
          selector: ".cm-editor",
        });
      }

      // Sort by vertical position on page
      fields.sort((a, b) => a.y - b.y);
      fields.forEach((f, i) => { f.index = i + 1; });

      return { type: "form_fields_response", requestId: msg.requestId, fields };
    }

    case "scroll_to_element": {
      const query = (msg.query as string).toLowerCase();
      let target: Element | null = null;

      // Try as CSS selector first
      try { target = document.querySelector(msg.query as string); } catch { /* invalid selector */ }

      // Otherwise search by label/text
      if (!target) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select, button, [role=button], label, h1, h2, h3, h4, h5, h6"))) {
          const text = (el.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "").toLowerCase();
          if (text.includes(query)) { target = el; break; }
        }
      }

      if (!target) return { type: "action_done", requestId: msg.requestId, message: `Element matching "${msg.query}" not found` };
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      return { type: "action_done", requestId: msg.requestId };
    }

    case "save_page_state": {
      const state: Array<{ selector: string; type: string; value: string; checked?: boolean }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))) {
        if (!el.id && !el.name) continue; // skip unadressable elements
        const selector = el.id ? `#${el.id}` : `[name="${el.name}"]`;
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          state.push({ selector, type: el.type, value: el.value, checked: el.checked });
        } else {
          const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
          if (value) state.push({ selector, type: el instanceof HTMLSelectElement ? "select" : el instanceof HTMLTextAreaElement ? "textarea" : (el.type || "text"), value });
        }
      }
      // CodeMirror editors (use index-based selector)
      document.querySelectorAll<HTMLElement>(".cm-editor").forEach((editor, i) => {
        const content = editor.querySelector(".cm-content")?.textContent ?? "";
        if (content.trim()) state.push({ selector: `.cm-editor:nth-of-type(${i + 1})`, type: "codemirror", value: content });
      });
      return { type: "save_state_response", requestId: msg.requestId, state };
    }

    case "restore_page_state": {
      const stateItems = msg.state as Array<{ selector: string; type: string; value: string; checked?: boolean }>;
      let restored = 0;
      for (const item of stateItems) {
        if (item.type === "codemirror") {
          // Find the nth .cm-editor by parsing the selector
          const match = item.selector.match(/:nth-of-type\((\d+)\)/);
          const n = match ? parseInt(match[1], 10) - 1 : 0;
          const editors = document.querySelectorAll<HTMLElement>(".cm-editor");
          const editor = editors[n];
          if (editor) {
            const cmContent = editor.querySelector<HTMLElement>(".cm-content");
            if (cmContent) {
              cmContent.focus();
              document.execCommand("selectAll");
              document.execCommand("insertText", false, item.value);
              restored++;
            }
          }
          continue;
        }
        try {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(item.selector);
          if (!el) continue;
          if (item.type === "checkbox" || item.type === "radio") {
            (el as HTMLInputElement).checked = item.checked ?? false;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (el instanceof HTMLSelectElement) {
            el.value = item.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              "value"
            )?.set;
            if (nativeSetter) nativeSetter.call(el, item.value);
            else (el as HTMLInputElement).value = item.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          restored++;
        } catch { /* skip bad selectors */ }
      }
      return { type: "action_done", requestId: msg.requestId, message: `Restored ${restored} of ${stateItems.length} fields` };
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
