import { readElementValue } from "../capture.js";
import { countShadowHosts, extractTextDeep, queryAllDeep } from "../shadow.js";
import { enumerateFormFields } from "../forms.js";
import { redactSecrets } from "../redact.js";
import { resolveFrameDocument, frameErrorHint, type IncomingMessage } from "./frame-util.js";

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

export function opReadElement(msg: IncomingMessage): unknown {
  const value = readElementValue(msg.textHint as string);
  return { type: "read_response", requestId: msg.requestId, value };
}

export function opGetPageText(msg: IncomingMessage): unknown {
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
  // Surface open modal dialogs. A page-scoped read roots at <main>, but
  // modals (native <dialog>, Radix/MUI/ARIA dialogs, and ones rendered inside
  // a web-component shadow host like LinkedIn's #interop-outlet Easy Apply)
  // render OUTSIDE <main> at body level, so the main walk misses them. The
  // dialog is the user's active focus, so extract it shadow-deep and put it
  // first. Dedup against the main text in case a body-rooted read already
  // included it.
  if (!selector) {
    try {
      const dialogs = queryAllDeep(
        document,
        "dialog[open], [aria-modal='true'], [role='dialog']",
      );
      const chunks: string[] = [];
      for (const d of dialogs) {
        const dt = extractTextDeep(d)
          .replace(/[ \t]+/g, " ")
          .replace(/\n\s*\n+/g, "\n\n")
          .trim();
        if (dt.length < 2) continue;
        const head = dt.slice(0, 60);
        if (text.includes(head)) continue; // already in the main text
        if (chunks.some((c) => c.includes(head))) continue; // nested/duplicate
        chunks.push(dt);
      }
      if (chunks.length) {
        text =
          chunks.map((c) => `[open dialog]\n${c}`).join("\n\n") + "\n\n" + text;
      }
    } catch {
      /* best-effort: never let dialog capture break the main read */
    }
  }
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

export function opGetPageHtml(msg: IncomingMessage): unknown {
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

export function opGetElements(msg: IncomingMessage): unknown {
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

export function opGetFormFields(msg: IncomingMessage): unknown {
  const frame = msg.frame as string | undefined;
  const doc = resolveFrameDocument(frame);
  if (!doc) {
    return {
      type: "form_fields_response",
      requestId: msg.requestId,
      fields: [],
      frame_error: frameErrorHint(frame),
    };
  }
  const { fields, hiddenFieldCount, captcha, oauthIndicators } = enumerateFormFields(doc);
  const onlyEmpty = msg.only_empty === true;

  let warning = "";
  if (hiddenFieldCount > 0) {
    warning = `\n\n⚠ ${hiddenFieldCount} hidden field(s) not shown above — they may appear after you interact with radio buttons, checkboxes, or toggles. Call get_form_fields() again after any such interaction to get an updated inventory.`;
  }
  // A duplicated id means the page rendered more than one instance of the
  // same field simultaneously (see ISSUE-2026-09-10-workday-duplicate-id-
  // colliding-create-account-form.md — Workday's Create Account step showed
  // two full copies of the form, several elements sharing literal ids across
  // copies). Every fill_input/click_element call against one of these fields
  // by id/selector risks silently landing in the wrong copy — flag it before
  // the caller spends a dozen calls rediscovering that themselves.
  const duplicateIdFields = fields.filter((f) => f.duplicate_id);
  if (duplicateIdFields.length > 0) {
    warning += `\n\n⚠ ${duplicateIdFields.length} field(s) above have an id that's DUPLICATED elsewhere on the page (indices: ${duplicateIdFields.map((f) => f.index).join(", ")}) — this usually means the page rendered more than one copy of the same form at once. Their selector already avoids the ambiguous #id form, but treat this page as unreliable for id/selector-based targeting generally: prefer scoping with within_selector/near_text, verify every fill by reading the value back immediately before submit, and expect a single fill_input/click_element call to possibly land in the WRONG copy of the form.`;
  }
  const filtered = onlyEmpty ? fields.filter((f) => f.required && f.empty) : fields;
  // Renumber so visible indices stay 1..N within the filtered slice.
  filtered.forEach((f, i) => { f.index = i + 1; });
  if (onlyEmpty) {
    const skipped = fields.length - filtered.length;
    // Branch on what was FOUND, not on whether other fields were skipped:
    // when every enumerated field is required-but-empty, skipped is 0 yet
    // there ARE matches, so the old `skipped > 0` test wrongly printed
    // "no required-but-empty fields detected" above a non-empty list.
    warning += filtered.length === 0
      ? `\n\nℹ only_empty=true: no required-but-empty fields detected. If Submit is still disabled, the page may use a custom validation hook (try react_call_prop on the validation handler) or required-ness comes from radio/checkbox groups not flagged with required.`
      : `\n\nℹ only_empty=true: showing ${filtered.length} required-but-empty field(s)${skipped > 0 ? `; ${skipped} other field(s) skipped.` : "."}`;
  }

  return { type: "form_fields_response", requestId: msg.requestId, fields: filtered, warning, captcha, oauthIndicators };
}
