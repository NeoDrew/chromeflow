/**
 * Form-field enumeration shared by the get_form_fields handler and the
 * find_input discovery tool. Pulled out of content/index.ts so both code
 * paths produce identical inventory data.
 *
 * Pass an iframe's contentDocument as `doc` to enumerate fields inside a
 * same-origin iframe — used by find_input's frame= parameter.
 */

export interface EnumeratedField {
  index: number;
  type: string;
  label: string;
  value: string;
  y: number;
  selector: string;
  context?: string;
}

export interface EnumerateResult {
  fields: EnumeratedField[];
  hiddenFieldCount: number;
}

/**
 * Walk up an element's ancestors looking for the nearest section-like
 * heading. Returns the heading's trimmed text, or "" if none found within
 * 8 levels.
 */
export function getNearestHeading(el: Element, doc: Document): string {
  const body = doc.body;
  let node: Element | null = el.parentElement;
  for (let d = 0; d < 8 && node && node !== body; d++) {
    for (const sel of [
      "h1,h2,h3,h4,h5,h6",
      "legend",
      "[class*='section-title'],[class*='heading'],[class*='section-header']",
    ]) {
      const h = node.querySelector(sel);
      if (h && h !== el && !h.contains(el)) {
        return (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      }
    }
    node = node.parentElement;
  }
  return "";
}

/**
 * Compute a stable document-y coordinate even for hidden / zero-size
 * elements. getBoundingClientRect returns 0 for display:none elements,
 * which combined with scrollY produces the current scroll position
 * (wrong). Fall back to the offsetParent chain.
 */
function getDocumentY(el: HTMLElement, doc: Document): number {
  const view = doc.defaultView;
  const scrollY = view?.scrollY ?? 0;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return Math.round(rect.top + scrollY);
  }
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

/**
 * Derive a human-readable label for a form input by checking, in order:
 * placeholder, aria-label, associated <label>, and nearby parent text.
 */
export function deriveInputLabel(el: HTMLElement, doc: Document): string {
  const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  let label =
    inputEl.getAttribute("placeholder") || inputEl.getAttribute("aria-label") || "";
  if (!label && el.id) {
    const lbl = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) label = (lbl.textContent ?? "").trim();
  }
  if (!label) {
    let node: Element | null = el.parentElement;
    for (let d = 0; d < 4 && node && node !== doc.body; d++) {
      const heading = node.querySelector(
        "label, h1, h2, h3, h4, h5, legend, [class*='label']"
      );
      if (heading && heading !== el) {
        label = (heading.textContent ?? "").trim();
        break;
      }
      node = node.parentElement;
    }
  }
  return label;
}

/**
 * Derive a label for a file input, with a special-case parent-text climb
 * that's permissive enough to pick up labels on hidden-input drag-and-drop
 * uploaders.
 */
function deriveFileLabel(el: HTMLInputElement, doc: Document): string {
  let label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
  if (!label && el.id) {
    const lbl = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) label = (lbl.textContent ?? "").trim();
  }
  if (!label) {
    let node: Element | null = el.parentElement;
    for (let d = 0; d < 5 && node; d++) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text && text.length < 120) {
        label = text.slice(0, 80);
        break;
      }
      node = node.parentElement;
    }
  }
  return label;
}

/**
 * Build a unique-ish CSS selector for an element. Prefers id, falls back
 * to tag:nth-of-type. Mirrors the inline pattern in get_form_fields.
 */
function buildSelector(el: Element, doc: Document): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const idx = Array.from(doc.querySelectorAll(el.tagName)).indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

/**
 * Enumerate every form field in `doc`: file inputs, standard inputs,
 * textareas, selects, CodeMirror editors, Monaco editors. Returns the
 * fields in document-order (sorted by y) plus a count of hidden fields
 * that didn't make the cut.
 */
export function enumerateFormFields(doc: Document = document): EnumerateResult {
  const fields: EnumeratedField[] = [];
  let idx = 0;

  // File inputs — always include even if visually hidden (often 0×0 behind
  // custom drag zones). Tagged label includes a usage hint for Claude.
  for (const el of Array.from(doc.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
    const label = deriveFileLabel(el, doc);
    const context = getNearestHeading(el, doc);
    fields.push({
      index: ++idx,
      type: "file",
      label:
        (label.replace(/\s+/g, " ").slice(0, 80) || "(unnamed)") +
        " — use set_file_input(hint, filePath) to upload",
      value: el.files?.[0]?.name ?? "",
      y: getDocumentY(el, doc),
      selector: el.id ? `#${CSS.escape(el.id)}` : "input[type=file]",
      ...(context ? { context } : {}),
    });
  }

  // Standard inputs (file handled above), textareas, selects
  const FIELD_SELECTORS =
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]), textarea, select";
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(FIELD_SELECTORS))) {
    const view = doc.defaultView;
    const s = view ? view.getComputedStyle(el) : null;
    if (s && (s.display === "none" || s.visibility === "hidden")) continue;

    const label = deriveInputLabel(el, doc);

    let value = "";
    if (el instanceof HTMLSelectElement) {
      value = el.options[el.selectedIndex]?.text ?? el.value;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      value = el.checked ? "checked" : "unchecked";
    } else {
      value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
    }

    const context = getNearestHeading(el, doc);
    fields.push({
      index: ++idx,
      type: el instanceof HTMLInputElement ? (el.type || "text") : el.tagName.toLowerCase(),
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: value.slice(0, 60),
      y: getDocumentY(el, doc),
      selector: buildSelector(el, doc),
      ...(context ? { context } : {}),
    });
  }

  // CodeMirror 6 editors
  for (const editor of Array.from(doc.querySelectorAll<HTMLElement>(".cm-editor"))) {
    const view = doc.defaultView;
    const s = view ? view.getComputedStyle(editor) : null;
    if (s && (s.display === "none" || s.visibility === "hidden")) continue;
    const rect = editor.getBoundingClientRect();
    const scrollY = view?.scrollY ?? 0;

    let label = editor.getAttribute("aria-label") ?? "";
    if (!label) {
      const container = editor.closest("div[class], section, fieldset, li") ?? editor.parentElement;
      if (container) {
        const heading = container.querySelector(
          "label, h1, h2, h3, h4, h5, legend, [class*='label']"
        );
        if (heading) label = (heading.textContent ?? "").trim();
      }
    }

    const currentText = (editor.querySelector(".cm-content")?.textContent ?? "").slice(0, 60);
    const context = getNearestHeading(editor, doc);
    fields.push({
      index: ++idx,
      type: "codemirror",
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: currentText,
      y: Math.round(rect.top + scrollY),
      selector: ".cm-editor",
      ...(context ? { context } : {}),
    });
  }

  // Monaco editors
  for (const editor of Array.from(doc.querySelectorAll<HTMLElement>(".monaco-editor"))) {
    const view = doc.defaultView;
    const s = view ? view.getComputedStyle(editor) : null;
    if (s && (s.display === "none" || s.visibility === "hidden")) continue;

    let label = editor.getAttribute("aria-label") ?? "";
    if (!label) {
      const container = editor.closest("div[class], section, fieldset, li") ?? editor.parentElement;
      if (container) {
        const heading = container.querySelector(
          "label, h1, h2, h3, h4, h5, legend, [class*='label'], [class*='title']"
        );
        if (heading && !editor.contains(heading)) label = (heading.textContent ?? "").trim();
      }
    }

    const lines = editor.querySelectorAll(".view-line");
    const currentText = Array.from(lines)
      .slice(0, 3)
      .map((l) => (l.textContent ?? "").trim())
      .join(" ")
      .slice(0, 60);
    const context = getNearestHeading(editor, doc);
    fields.push({
      index: ++idx,
      type: "monaco — use execute_script with monaco.editor.getModels() to read/write",
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: currentText,
      y: getDocumentY(editor, doc),
      selector: ".monaco-editor",
      ...(context ? { context } : {}),
    });
  }

  // Sort by vertical position on page, then renumber
  fields.sort((a, b) => a.y - b.y);
  fields.forEach((f, i) => {
    f.index = i + 1;
  });

  // Count hidden fields for the warning that get_form_fields appends.
  const hiddenFields = Array.from(
    doc.querySelectorAll<HTMLElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select"
    )
  ).filter((el) => {
    const view = doc.defaultView;
    if (!view) return false;
    const s = view.getComputedStyle(el);
    return (
      s.display === "none" ||
      s.visibility === "hidden" ||
      el.getAttribute("aria-hidden") === "true"
    );
  });

  return { fields, hiddenFieldCount: hiddenFields.length };
}
