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
import { clickElement, prepareClickTarget, postClickInspect, scrollSmartIntoView, reactFiberClickByHint, findTopmostDialog, findDialogByQuery, pointerChainOnTagged } from "./click.js";
import { collectShadowHosts, countShadowHosts, extractTextDeep, queryAllDeep } from "./shadow.js";
import { enumerateFormFields } from "./forms.js";
import { findText, findInputs, waitForText } from "./find.js";
import { markerIds } from "../markers.js";
import { redactSecrets } from "./redact.js";
import { SET_FILE_FROM_CONTENT, type SetFileFromContentMessage } from "../connections.js";

type IncomingMessage = {
  type: string;
  requestId: string;
  [key: string]: unknown;
};

/**
 * Resolve a `frame` selector to its iframe's contentDocument. Returns the
 * top-level document when no frame is given, and null when the frame
 * selector matched nothing or the iframe is cross-origin.
 */
function resolveFrameDocument(frame: string | undefined): Document | null {
  if (!frame) return document;
  const iframe = document.querySelector<HTMLIFrameElement>(frame);
  if (!iframe) return null;
  try {
    return iframe.contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Build an actionable error for a frame that couldn't be read. A cross-origin
 * iframe (e.g. a cloudfront.net component viewer) can't be reached by in-page
 * DOM tools at all, but its HTML IS retrievable via fetch_url, which runs in
 * the extension's privileged context with cookies. Point the agent there
 * instead of leaving it stuck.
 */
function frameErrorHint(frame: string | undefined): string {
  if (!frame) return "No frame specified.";
  const iframe = document.querySelector<HTMLIFrameElement>(frame);
  if (!iframe) return `Iframe "${frame}" not found.`;
  let crossOrigin = false;
  try {
    crossOrigin = !iframe.contentDocument;
  } catch {
    crossOrigin = true;
  }
  const src = iframe.getAttribute("src") ?? "";
  if (crossOrigin) {
    return src
      ? `Iframe "${frame}" is cross-origin — in-page DOM tools can't read it. Retrieve its HTML with fetch_url("${src}") (privileged context, cookies included), or use take_screenshot for visual content.`
      : `Iframe "${frame}" is cross-origin and has no readable src — use take_screenshot for its visual content.`;
  }
  return `Iframe "${frame}" contentDocument unavailable (it may not have loaded yet — retry, or wait_for a selector inside it).`;
}

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
      let x = msg.x as number | undefined;
      let y = msg.y as number | undefined;
      let width = msg.width as number | undefined;
      let height = msg.height as number | undefined;

      // If a selector is provided, resolve coordinates from the DOM.
      // Uses queryAllDeep to pierce open AND closed shadow roots so
      // selectors targeting shadow DOM elements (Outlier panels,
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

    case "start_click_watch": {
      // Disarm the pre-buffer listener since we're taking over with a real watch.
      preClickCleanup?.();
      preClickCleanup = null;

      if (pendingPreClick) {
        // User already clicked while the highlight was showing — fire immediately.
        const captured = pendingPreClick;
        pendingPreClick = false;
        chrome.runtime.sendMessage({
          source: "chromeflow-content",
          type: "click_detected",
          requestId: msg.requestId as string,
          target: captured,
        });
      } else {
        startClickWatch(msg.requestId as string);
      }
      return { type: "action_done", requestId: msg.requestId };
    }

    case "click_element": {
      const result = clickElement(msg.textHint as string, msg.nth as number | undefined);
      return { type: "click_element_response", requestId: msg.requestId, ...result };
    }

    case "prepare_click_target": {
      const result = await prepareClickTarget(
        msg.textHint as string | undefined,
        msg.nth as number | undefined,
        msg.within_selector as string | undefined,
        msg.near_text as string | undefined,
        msg.selector as string | undefined,
        msg.in_dialog as boolean | undefined,
        msg.dialog_query as string | undefined,
      );
      return { type: "action_done", requestId: msg.requestId, ...result };
    }

    case "pointer_chain_click": {
      const result = pointerChainOnTagged();
      return { type: "action_done", requestId: msg.requestId, ...result };
    }

    case "post_click_inspect": {
      const result = postClickInspect();
      return { type: "action_done", requestId: msg.requestId, ...result };
    }

    case "tag_for_react": {
      // Used by background.react_set_input and background.react_call_prop to
      // bridge MAIN-world prototype access with content-script shadow piercing.
      // queryAllDeep walks open AND closed shadow roots (via
      // chrome.dom.openOrClosedShadowRoot), so selectors that target inputs
      // inside Radix/Stencil/Lit web components resolve here even when plain
      // doc.querySelector from MAIN world wouldn't find them.
      const sel = msg.selector as string;
      const tagId = msg.tagId as string;
      try {
        const matches = queryAllDeep<Element>(document, sel);
        const el = matches[0];
        if (!el) {
          return { type: "action_done", requestId: msg.requestId, tagged: false, in_shadow: false };
        }
        // Walk parent chain to detect if the element lives inside a shadow root.
        let cur: Node | null = el;
        let inShadow = false;
        while (cur) {
          if (cur instanceof ShadowRoot) { inShadow = true; break; }
          cur = cur.parentNode;
        }
        el.setAttribute("data-chromeflow-react-target", tagId);
        return { type: "action_done", requestId: msg.requestId, tagged: true, in_shadow: inShadow };
      } catch {
        return { type: "action_done", requestId: msg.requestId, tagged: false, in_shadow: false };
      }
    }

    case "react_fiber_click": {
      // Opt-in fallback used by background.click_element when the activity
      // probe reports silently_rejected. Re-resolves the target with the same
      // match logic and invokes __reactProps$.onClick directly.
      const result = reactFiberClickByHint(
        msg.textHint as string,
        msg.nth as number | undefined,
        msg.within_selector as string | undefined,
        msg.near_text as string | undefined,
        msg.in_dialog as boolean | undefined,
        msg.dialog_query as string | undefined,
      );
      return { type: "action_done", requestId: msg.requestId, ...result };
    }

    case "wait_for_change": {
      const selector = msg.selector as string;
      const timeoutMs = (msg.timeout as number) ?? 30_000;
      const settleMs = (msg.settle as number) ?? 150;

      // queryAllDeep so selectors inside open shadow roots work
      const target = queryAllDeep<Element>(document, selector)[0];
      if (!target) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          ok: false,
          reason: "not-found",
          message: `Selector "${selector}" not found. Call wait_for_selector first if the element may still be loading.`,
        };
      }

      return new Promise<unknown>((resolve) => {
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new MutationObserver(() => {
          // Debounce: on each mutation, (re)start the settle window. Resolve
          // when the window elapses without further mutations — this lets
          // batched updates (multiple appended nodes, style changes, text
          // flips) settle before we read.
          if (settleTimer !== null) clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, settleMs);
        });

        const timeoutTimer = setTimeout(() => {
          observer.disconnect();
          if (settleTimer !== null) clearTimeout(settleTimer);
          // Return current text even on timeout — often useful to see what
          // state the element is actually in.
          const fallbackText = extractTextDeep(target)
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s*\n+/g, "\n\n")
            .trim();
          resolve({
            type: "action_done",
            requestId: msg.requestId,
            ok: false,
            reason: "timeout",
            message: `No mutation in "${selector}" after ${timeoutMs / 1000}s. Current text (may still be useful):`,
            text: redactSecrets(fallbackText).text,
          });
        }, timeoutMs);

        function finish() {
          observer.disconnect();
          clearTimeout(timeoutTimer);
          const raw = extractTextDeep(target)
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s*\n+/g, "\n\n")
            .trim();
          resolve({
            type: "action_done",
            requestId: msg.requestId,
            ok: true,
            reason: "mutation",
            text: redactSecrets(raw).text,
          });
        }

        observer.observe(target, {
          childList: true,
          characterData: true,
          attributes: true,
          subtree: true,
        });
      });
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
      const result = fillInput(
        msg.textHint as string,
        msg.value as string,
        msg.nth as number | undefined,
        (msg.exact as boolean | undefined) ?? false
      );
      return { type: "fill_response", requestId: msg.requestId, ...result };
    }

    case "read_element": {
      const value = readElementValue(msg.textHint as string);
      return { type: "read_response", requestId: msg.requestId, value };
    }

    case "get_page_text": {
      const selector = msg.selector as string | undefined;
      const startIndex = (msg.startIndex as number | undefined) ?? 0;
      const chunkSize = 10000;
      let root: Element;
      let selectorMissed = false;
      let selectorInShadow = false;
      if (selector) {
        // Plain querySelector first (cheap, common case). If it misses, try
        // shadow-piercing — Radix portals and similar host content inside
        // closed shadow roots that find_text reports selectors for, but
        // document.querySelector can't reach.
        let el = document.querySelector(selector);
        if (!el) {
          const deep = queryAllDeep(document, selector)[0];
          if (deep) {
            el = deep;
            selectorInShadow = true;
          }
        }
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
      // Hydrate empty content-visibility spans from React fiber props (Whitebeard
      // renders LaTeX/math into such spans whose innerHTML is empty but whose
      // React fiber holds the source markdown at __reactProps.children.props.markdown).
      hydrateContentVisibilityFromFiber(root, clone);
      // Extract text including shadow DOM descendants from the LIVE root (clones
      // don't include shadow roots). Append to the cleaned clone's text so we
      // get React-fiber-hydrated content + shadow-rooted content.
      const cloneText = clone.textContent ?? "";
      const deepText = extractTextDeep(root, new Set(["NAV", "HEADER", "FOOTER"]));
      // If the deep walk found significantly more text (i.e. shadow content
      // exists), use it; otherwise stick with the clone.
      let text = (deepText.length > cloneText.length * 1.1 ? deepText : cloneText)
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
      // Redact high-confidence secret patterns (API keys, JWTs, etc.) so they
      // don't silently end up in Claude's context. Claude still sees a
      // [REDACTED:KIND] placeholder and can ask the user or use read_element.
      const { text: redacted, redactions } = redactSecrets(text);
      text = redacted;
      if (redactions.length > 0) {
        const byKind: Record<string, number> = {};
        for (const r of redactions) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        const summary = Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join(", ");
        text = `[chromeflow redacted ${redactions.length} secret${redactions.length === 1 ? "" : "s"}: ${summary}. Use read_element + write_to_env to capture specific values intentionally.]\n\n` + text;
      }
      if (selectorMissed) {
        text = `[Warning: selector "${selector}" not found — returning full page text]\n\n` + text;
      }
      // Shadow-host census so the agent can recognise pages where
      // execute_script returns an empty document (Radix portals, Stencil/Lit
      // web components). When this is > 0 and the agent is staring at "no
      // buttons / no text" from execute_script, that's the signal to switch
      // to find_text / get_page_text / click_element / fill_input — those
      // pierce shadow DOM.
      let shadowHostsSeen = 0;
      try {
        shadowHostsSeen = countShadowHosts(document);
      } catch { /* best-effort */ }
      const totalLength = text.length;
      text = text.slice(startIndex, startIndex + chunkSize);
      if (startIndex + chunkSize < totalLength) {
        text += `\n\n... (${totalLength - startIndex - chunkSize} more characters — call get_page_text with startIndex=${startIndex + chunkSize} to continue)`;
      }
      // Viewport / page / scroll snapshot so agents can compute click
      // coordinates without a separate execute_script probe. Cheap to gather
      // here since we're already on the page reading state.
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const page = {
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      };
      const scroll = {
        x: window.scrollX,
        y: window.scrollY,
      };

      return {
        type: "page_text_response",
        requestId: msg.requestId,
        text,
        selector_missed: selectorMissed,
        selector_in_shadow: selectorInShadow,
        shadow_hosts_seen: shadowHostsSeen,
        viewport,
        page,
        scroll,
      };
    }

    case "get_page_html": {
      const selector = msg.selector as string | undefined;
      const maxChars = (msg.max_chars as number | undefined) ?? 50000;
      let root: Element;
      let selectorMissed = false;
      let selectorInShadow = false;
      if (selector) {
        let el = document.querySelector(selector);
        if (!el) {
          const deep = queryAllDeep(document, selector)[0];
          if (deep) {
            el = deep;
            selectorInShadow = true;
          }
        }
        if (!el) selectorMissed = true;
        root = el ?? document.body;
      } else {
        const main = document.querySelector("main, [role='main']");
        root = (main && (main.textContent ?? "").trim().length > 80) ? main : document.body;
      }
      // outerHTML on the live element. Caller is responsible for paginating /
      // truncating large pages via max_chars. We strip <script> and <style>
      // tags so the agent doesn't burn tokens on JS bundles.
      const clone = root.cloneNode(true) as Element;
      ["script", "style", "noscript"].forEach((tag) => {
        clone.querySelectorAll(tag).forEach((el) => el.remove());
      });
      const fullHtml = (clone as HTMLElement).outerHTML;
      const totalChars = fullHtml.length;
      const truncated = totalChars > maxChars;
      const html = truncated ? fullHtml.slice(0, maxChars) : fullHtml;
      return {
        type: "page_html_response",
        requestId: msg.requestId,
        html,
        total_chars: totalChars,
        truncated,
        selector_missed: selectorMissed,
        selector_in_shadow: selectorInShadow,
      };
    }

    case "get_elements": {
      const SELECTORS = 'input:not([type=hidden]), textarea, select, button, a[href], [role=button], [role=link], [role=menuitem], [role=option], [role=tab], [onclick], [tabindex]';
      const results: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> = [];
      let idx = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(SELECTORS))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // No viewport filter — include off-screen elements so Claude can see the full page
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
      const { fields, hiddenFieldCount, captcha, oauthIndicators } = enumerateFormFields(document);
      const onlyEmpty = msg.only_empty === true;

      let warning = "";
      if (hiddenFieldCount > 0) {
        warning = `\n\n⚠ ${hiddenFieldCount} hidden field(s) not shown above — they may appear after you interact with radio buttons, checkboxes, or toggles. Call get_form_fields() again after any such interaction to get an updated inventory.`;
      }
      const filtered = onlyEmpty ? fields.filter((f) => f.required && f.empty) : fields;
      // Renumber so visible indices stay 1..N within the filtered slice.
      filtered.forEach((f, i) => { f.index = i + 1; });
      if (onlyEmpty) {
        const skipped = fields.length - filtered.length;
        warning += skipped > 0
          ? `\n\nℹ only_empty=true: showing ${filtered.length} required-but-empty field(s); ${skipped} other field(s) skipped.`
          : `\n\nℹ only_empty=true: no required-but-empty fields detected. If Submit is still disabled, the page may use a custom validation hook (try react_call_prop on the validation handler) or required-ness comes from radio/checkbox groups not flagged with required.`;
      }

      return { type: "form_fields_response", requestId: msg.requestId, fields: filtered, warning, captcha, oauthIndicators };
    }

    case "find_text": {
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

    case "find_input": {
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

    case "wait_for_text": {
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

    case "scroll_to_element": {
      const query = (msg.query as string).toLowerCase();
      let target: Element | null = null;
      let matchedText = "";

      // Try as CSS selector first — pierce shadow roots so selectors returned
      // by find_text (which walks closed shadow trees) resolve correctly.
      try {
        target = queryAllDeep(document, msg.query as string)[0] ?? null;
        if (target) matchedText = msg.query as string;
      } catch { /* invalid selector */ }

      // Otherwise search by label/text. Pierce shadow roots so labels and
      // headings inside Radix portals are reachable.
      if (!target) {
        for (const el of queryAllDeep<HTMLElement>(document, "input, textarea, select, button, [role=button], label, h1, h2, h3, h4, h5, h6")) {
          const text = (el.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "").toLowerCase();
          if (text.includes(query)) {
            target = el;
            matchedText = (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 60);
            break;
          }
        }
      }

      if (!target) return { type: "action_done", requestId: msg.requestId, message: `No element found matching "${msg.query}"` };
      // Capture stable document y BEFORE scrolling — getBoundingClientRect after smooth scroll
      // returns a mid-animation value which is inconsistent and confusing.
      const docY = Math.round(target.getBoundingClientRect().top + window.scrollY);
      // scrollSmartIntoView walks overflow:auto/scroll ancestors so inner
      // scroll panes (SPAs where the outer document is tiny but the inner
      // pane scrolls 15000+px) actually move. Plain scrollIntoView only
      // moves whichever scroll container the browser happens to pick,
      // which is often the outer document.
      scrollSmartIntoView(target);
      return {
        type: "action_done",
        requestId: msg.requestId,
        message: `Scrolled to "${matchedText}" (document y: ${docY})`,
      };
    }

    case "save_page_state": {
      const state: Array<{ selector: string; type: string; value: string; checked?: boolean }> = [];
      // Track positional counters per tag for fallback selectors
      const tagCounts: Record<string, number> = {};
      for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))) {
        const tag = el.tagName.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        const isCheckable = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
        // Build selector: prefer id > name > positional nth-of-type fallback
        let selector: string;
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else if (el.name) {
          selector = isCheckable
            ? `[name="${el.name}"][value="${(el as HTMLInputElement).value}"]`
            : `[name="${el.name}"]`;
        } else {
          // Fallback: use tag + nth-of-type for elements with no id or name
          selector = `${tag}:nth-of-type(${tagCounts[tag]})`;
        }
        if (isCheckable) {
          state.push({ selector, type: (el as HTMLInputElement).type, value: (el as HTMLInputElement).value, checked: (el as HTMLInputElement).checked });
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
      // Monaco editors — save via model value if available
      try {
        const monacoModels = (window as any).monaco?.editor?.getModels?.() as any[] | undefined;
        if (monacoModels) {
          monacoModels.forEach((model: any, i: number) => {
            const content = model.getValue?.() ?? "";
            if (content.trim()) state.push({ selector: `monaco-model-${i}`, type: "monaco", value: content });
          });
        }
      } catch { /* monaco not available */ }
      return { type: "save_state_response", requestId: msg.requestId, state };
    }

    case "restore_page_state": {
      const stateItems = msg.state as Array<{ selector: string; type: string; value: string; checked?: boolean }>;
      let restored = 0;
      for (const item of stateItems) {
        if (item.type === "codemirror") {
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
        if (item.type === "monaco") {
          try {
            const match = item.selector.match(/monaco-model-(\d+)/);
            const i = match ? parseInt(match[1], 10) : 0;
            const models = (window as any).monaco?.editor?.getModels?.();
            if (models?.[i]) { models[i].setValue(item.value); restored++; }
          } catch { /* monaco not available */ }
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

    case "fill_form": {
      const formFields = msg.fields as Array<{ label: string; value: string }>;
      const exact = (msg.exact as boolean | undefined) ?? false;
      const results: Array<{ label: string; success: boolean; message: string; matched?: string }> = [];
      for (const field of formFields) {
        const result = fillInput(field.label, field.value, 1, exact);
        results.push({ label: field.label, success: result.success, message: result.message, matched: result.matched });
        // Brief pause between fills so React can process each change event
        await new Promise((r) => setTimeout(r, 80));
      }
      const succeeded = results.filter((r) => r.success).length;
      return { type: "fill_form_response", requestId: msg.requestId, results, succeeded, total: formFields.length };
    }

    case "tag_file_input": {
      const hint = ((msg.hint as string) ?? "").trim();
      const hintLower = hint.toLowerCase();
      let found: HTMLInputElement | null = null;

      // An explicit CSS selector hint is a precise instruction, not a fuzzy
      // search term. Honour it exactly: if it doesn't resolve to a file input,
      // FAIL LOUDLY rather than silently routing to some other file input on
      // the page (the bug where "#screenshot-uuid" landed the file in the
      // adjacent output slot). Three sibling file inputs each with a unique id
      // is the canonical case this protects.
      const hintIsSelector =
        !!hint && (hint.startsWith("#") || hint.startsWith(".") || hint.startsWith("input") || hint.startsWith("["));
      if (hintIsSelector) {
        let matches: Element[] = [];
        try {
          matches = queryAllDeep<Element>(document, hint);
        } catch {
          return {
            type: "action_done",
            requestId: msg.requestId,
            found: false,
            message: `Hint "${hint}" is not a valid CSS selector. Pass the file input's id/selector or a text label.`,
          };
        }
        // The match itself, or a single file input descended from it.
        for (const m of matches) {
          if (m instanceof HTMLInputElement && m.type === "file") { found = m; break; }
        }
        if (!found) {
          for (const m of matches) {
            const innerFiles = m.querySelectorAll?.('input[type="file"]') ?? [];
            if (innerFiles.length === 1) { found = innerFiles[0] as HTMLInputElement; break; }
          }
        }
        if (!found) {
          return {
            type: "action_done",
            requestId: msg.requestId,
            found: false,
            message: matches.length
              ? `Selector "${hint}" matched ${matches.length} element(s) but none is a file input (and none wraps exactly one). Refusing to route the upload to a different input. Target the input[type=file] itself.`
              : `Selector "${hint}" matched nothing. Refusing to fall back to a fuzzy match. Check the selector, or pass a text label instead of a "#"/"."/"["-prefixed selector.`,
          };
        }
        const desc = found.id ? `#${found.id}` : (found.getAttribute("name") ?? "input[type=file]");
        const attr = markerIds.fileTargetAttr();
        found.setAttribute(attr, "true");
        return { type: "action_done", requestId: msg.requestId, found: true, attr, matched_desc: desc, matched_via: "css-selector" };
      }

      // Try matching by ID directly (e.g. hint="import-problem-file" matches id="import-problem-file").
      // getElementById is light-DOM only; fall back to a piercing query for IDs inside shadow roots.
      if (!found && hint) {
        const byId = (document.getElementById(hint) as HTMLInputElement | null)
          ?? (queryAllDeep<HTMLInputElement>(document, `#${CSS.escape(hint)}`)[0] ?? null);
        if (byId && byId.type === "file") found = byId;
      }

      // Label/text matching — pierce shadow roots so file inputs inside Stencil/
      // Radix/Lit web components are reachable.
      if (!found) {
        for (const el of queryAllDeep<HTMLInputElement>(document, "input[type=file]")) {
          let label = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || "";
          if (!label && el.id) {
            // Labels are scoped to their containing root (Document or ShadowRoot);
            // queryAllDeep walks every root so we still find them.
            const lbl = queryAllDeep<HTMLLabelElement>(document, `label[for="${CSS.escape(el.id)}"]`)[0];
            if (lbl) label = (lbl.textContent ?? "").trim();
          }
          if (!label) {
            let node: Element | null = el.parentElement;
            for (let d = 0; d < 5 && node; d++) {
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              if (text && text.length < 120) { label = text; break; }
              node = node.parentElement;
            }
          }
          if (!hintLower || label.toLowerCase().includes(hintLower)) { found = el; break; }
        }
      }

      // Fallback: first file input anywhere on the page (including shadow roots).
      if (!found) found = queryAllDeep<HTMLInputElement>(document, "input[type=file]")[0] ?? null;

      if (!found) {
        return { type: "action_done", requestId: msg.requestId, found: false, message: `No file input found matching "${msg.hint}"` };
      }

      // Tag so CDP can target it by selector
      const attr = markerIds.fileTargetAttr();
      found.setAttribute(attr, "true");
      const desc = found.id ? `#${found.id}` : (found.getAttribute("name") ?? "input[type=file]");
      return { type: "action_done", requestId: msg.requestId, found: true, attr, matched_desc: desc, matched_via: "label/id" };
    }

    case "untag_file_input": {
      const attr = markerIds.fileTargetAttr();
      queryAllDeep(document, `[${attr}]`).forEach((el) => {
        el.removeAttribute(attr);
      });
      return { type: "action_done", requestId: msg.requestId };
    }

    case "dispatch_file_change_events": {
      // Used by background.set_file_input after CDP DOM.setFileInputFiles
      // commits the upload. We can't use Runtime.evaluate from CDP to dispatch
      // events because document.querySelector in MAIN world doesn't pierce
      // shadow roots — for closed-shadow-rooted file inputs the query returns
      // null. queryAllDeep here (content-script ISOLATED world) pierces via
      // chrome.dom.openOrClosedShadowRoot.
      const attr = (msg.attr as string) ?? markerIds.fileTargetAttr();
      const el = queryAllDeep<HTMLInputElement>(document, `[${attr}="true"]`)[0] ?? null;
      if (el) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { type: "action_done", requestId: msg.requestId, found: true };
      }
      return { type: "action_done", requestId: msg.requestId, found: false };
    }

    case SET_FILE_FROM_CONTENT: {
      // Inline-content file mode: rather than CDP DOM.setFileInputFiles (which
      // needs a real on-disk path), the file bytes arrive base64 on the wire and
      // we materialize a File entirely in-page. This is the only way to upload
      // content the agent generated/holds in memory without first writing it to
      // the user's disk. The target input was already marked with msg.attr by an
      // earlier tag step; queryAllDeep pierces open AND closed shadow roots (via
      // chrome.dom.openOrClosedShadowRoot) so inputs inside Stencil/Radix/Lit
      // web components resolve, matching dispatch_file_change_events above.
      const m = msg as unknown as SetFileFromContentMessage & { requestId: string };
      const input = queryAllDeep<HTMLInputElement>(document, `[${m.attr}="true"]`)[0] ?? null;
      if (!input) {
        return { type: "action_done", requestId: msg.requestId, found: false };
      }
      // base64 -> bytes. atob yields a binary string (one char per byte); map
      // each charCode into a Uint8Array so binary payloads (images, PDFs) round
      // trip intact rather than being mangled by UTF-8 decoding.
      const binary = atob(m.fileContent);
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      const file = new File([bytes], m.fileName, {
        type: m.mimeType || "application/octet-stream",
      });
      // FileList is read-only and can't be constructed directly; DataTransfer is
      // the only standard way to synthesize one and assign input.files.
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // Same change+input dispatch the path-mode commit uses, so React/Vue form
      // bindings notice the upload identically across both upload paths.
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return { type: "action_done", requestId: msg.requestId, found: true, name: m.fileName };
    }

    case "clear": {
      clearAllOverlays();
      return { type: "action_done", requestId: msg.requestId };
    }

    case "show_instance_info": {
      showInstanceInfo({
        label: msg.label as string | undefined,
        port: msg.port as number | undefined,
        host: msg.host as string | undefined,
      });
      return { type: "action_done", requestId: msg.requestId };
    }

    case "hide_instance_info": {
      hideInstanceInfo();
      return { type: "action_done", requestId: msg.requestId };
    }

    case "set_instance_info_visible": {
      setInstanceInfoVisible(msg.visible as boolean);
      return { type: "action_done", requestId: msg.requestId };
    }

    case "list_frames": {
      // Pierce shadow DOMs (open + closed) so iframes nested inside web
      // components (e.g. Reddit's chat composer inside a shadow-hosted host)
      // are discoverable. The previous behavior queried only the light DOM.
      const iframes = queryAllDeep<HTMLIFrameElement | HTMLFrameElement>(document, "iframe, frame");
      const frames = iframes.map((el, index) => {
        const src = el.getAttribute("src") ?? "";
        let origin = "";
        try {
          origin = src ? new URL(src, location.href).origin : "";
        } catch {
          // src may be a `javascript:` scheme or otherwise unparseable.
          origin = "";
        }
        let accessible = false;
        try {
          accessible = !!(el as HTMLIFrameElement).contentDocument;
        } catch {
          accessible = false;
        }
        const rect = el.getBoundingClientRect();
        // Build a usable CSS selector — prefer #id, fall back to class chain
        // bounded by the tag, fall back to nth-of-type. The selector is
        // intended to be passed back into find_text/find_input via frame=.
        let selector: string;
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else if (el.className && typeof el.className === "string" && el.className.trim()) {
          const cls = el.className.trim().split(/\s+/).map((c) => `.${CSS.escape(c)}`).join("");
          selector = `${el.tagName.toLowerCase()}${cls}`;
        } else {
          // nth-of-type among siblings sharing the same tag (iframe/frame).
          const tag = el.tagName.toLowerCase();
          const sameTagSiblings = Array.from(document.querySelectorAll(tag));
          const idx = sameTagSiblings.indexOf(el) + 1;
          selector = `${tag}:nth-of-type(${idx})`;
        }
        // Cross-origin = has a real http(s) src we can't read in-page. Surface
        // the fetch_url escape hatch so the agent doesn't dead-end on it.
        const crossOrigin = !accessible && !!origin && origin !== location.origin;
        return {
          index: index + 1,
          selector,
          src,
          origin,
          title: el.getAttribute("title") ?? "",
          accessible,
          cross_origin: crossOrigin,
          hint: crossOrigin && src
            ? `cross-origin: read its HTML with fetch_url("${src}") or capture it with take_screenshot`
            : undefined,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
      // Augment with shadow-host inventory so the agent can spot pages whose
      // visible content is rendered inside closed shadow roots (Radix portals,
      // Stencil/Lit web components). When the agent
      // calls execute_script and gets back an empty document but the shadow
      // host list is non-empty, that's the signal to switch to find_text /
      // get_page_text / click_element / fill_input — those pierce.
      const shadowHosts = collectShadowHosts(document, 25);
      return {
        type: "list_frames_response",
        requestId: msg.requestId,
        frames,
        shadow_hosts: shadowHosts,
      };
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

type CapturedClickTarget = {
  selector: string;
  text: string;
  tag: string;
  x: number;
  y: number;
};

let pendingPreClick: CapturedClickTarget | false = false;
let preClickCleanup: (() => void) | null = null;

/**
 * Build a best-effort CSS selector for an element. Walks up to 5 ancestors,
 * preferring id > class chain > tag:nth-of-type at each level. Cheap and
 * generally unique enough for one-shot lookups; not guaranteed unique across
 * the whole document.
 */
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let d = 0; d < 5 && cur; d++) {
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    if (sameTag.length === 1) {
      parts.unshift(tag);
    } else {
      const idx = sameTag.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
    }
    cur = parent;
  }
  return parts.join(" > ");
}

function captureClickTarget(target: EventTarget | null, x: number, y: number): CapturedClickTarget | null {
  if (!(target instanceof Element)) return null;
  return {
    selector: cssPath(target).slice(0, 200),
    text: (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    tag: target.tagName.toLowerCase(),
    x: Math.round(x),
    y: Math.round(y),
  };
}

/**
 * Walks `orig` and `clone` in tandem (they share structure). For any empty
 * content-visibility span in the original whose React fiber props carry a
 * `markdown` string, writes that markdown into the clone's corresponding node
 * so textContent extraction picks it up.
 */
function hydrateContentVisibilityFromFiber(orig: Element, clone: Element) {
  const origWalker = document.createTreeWalker(orig, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  let o = origWalker.currentNode as Element | null;
  let c = cloneWalker.currentNode as Element | null;
  while (o && c) {
    const htmlEl = o as HTMLElement;
    const cv = htmlEl.style?.contentVisibility;
    if ((cv === "auto" || cv === "hidden") && (o.textContent ?? "").trim() === "") {
      const propsKey = Object.keys(o).find((k) => k.startsWith("__reactProps"));
      if (propsKey) {
        const props = (o as unknown as Record<string, unknown>)[propsKey] as
          | { children?: { props?: { markdown?: unknown } } }
          | undefined;
        const markdown = props?.children?.props?.markdown;
        if (typeof markdown === "string" && markdown.length > 0) {
          c.textContent = markdown;
        }
      }
    }
    o = origWalker.nextNode() as Element | null;
    c = cloneWalker.nextNode() as Element | null;
  }
}

function armClickBuffer() {
  // Reset any previous buffer
  preClickCleanup?.();
  pendingPreClick = false;

  const onPointerDown = (e: PointerEvent) => {
    const { clientX, clientY } = e;
    // Capture the underlying element BEFORE clearAllOverlays — the overlay is
    // the topmost element at this point, so we want the real click target.
    const underlying = document.elementFromPoint(clientX, clientY);
    pendingPreClick = captureClickTarget(underlying ?? e.target, clientX, clientY) ?? false;
    clearAllOverlays(); // remove the highlight as soon as the user clicks
    // Forward focus to the underlying element (the overlay intercepted the click,
    // so the input was never focused — fix that before fill_input is called).
    requestAnimationFrame(() => {
      if (underlying instanceof HTMLElement) underlying.focus();
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

  const notify = (clientX?: number, clientY?: number, target?: EventTarget | null) => {
    if (done) return;
    done = true;
    cleanup();
    clearAllOverlays();
    let captured: CapturedClickTarget | null = null;
    if (clientX !== undefined && clientY !== undefined) {
      const underlying = document.elementFromPoint(clientX, clientY);
      captured = captureClickTarget(underlying ?? target ?? null, clientX, clientY);
      requestAnimationFrame(() => {
        if (underlying instanceof HTMLElement) underlying.focus();
      });
    } else if (target) {
      captured = captureClickTarget(target, 0, 0);
    }
    chrome.runtime.sendMessage({
      source: "chromeflow-content",
      type: "click_detected",
      requestId,
      target: captured,
    });
  };

  const onPointerDown = (e: PointerEvent) => notify(e.clientX, e.clientY, e.target);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab") notify(undefined, undefined, e.target);
  };

  // Shadow DOM fallback: MutationObserver on document catches main-document
  // mutations, but misses state changes inside shadow roots (Outlier panels,
  // Lit components flipping visibility). Poll a shadow-pierce visible-element
  // count as a backup signal: if the count changes by >= 5 after the watch
  // starts, the user likely clicked and something happened.
  const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
  function getShadowRoot(el: Element): ShadowRoot | null {
    if (chromeDom?.openOrClosedShadowRoot) {
      try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepVisibleCount(): number {
    let count = 0;
    const seen = new WeakSet<ShadowRoot>();
    function walk(root: Document | ShadowRoot) {
      const all = root.querySelectorAll("*");
      for (const el of Array.from(all)) {
        if ((el as HTMLElement).offsetParent !== null) count++;
        const sr = getShadowRoot(el);
        if (sr && !seen.has(sr)) { seen.add(sr); walk(sr); }
      }
    }
    walk(document);
    return count;
  }
  const baselineVisible = deepVisibleCount();
  let mutCount = 0;
  const observer = new MutationObserver((records) => { mutCount += records.length; });
  observer.observe(document, { subtree: true, childList: true, attributes: true });

  const shadowPoll = setInterval(() => {
    if (done) return;
    const urlChanged = location.href !== startUrl;
    const visibleDelta = deepVisibleCount() - baselineVisible;
    if (urlChanged || mutCount > 3 || Math.abs(visibleDelta) >= 5) {
      notify();
    }
  }, 500);
  const startUrl = location.href;

  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    observer.disconnect();
    clearInterval(shadowPoll);
  };

  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("keydown", onKeyDown, { capture: true });
}
