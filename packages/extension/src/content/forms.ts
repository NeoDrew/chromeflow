/**
 * Form-field enumeration shared by the get_form_fields handler and the
 * find_input discovery tool. Pulled out of content/index.ts so both code
 * paths produce identical inventory data.
 *
 * Pass an iframe's contentDocument as `doc` to enumerate fields inside a
 * same-origin iframe — used by find_input's frame= parameter.
 *
 * All queries pierce open AND closed shadow roots via queryAllDeep so form
 * fields rendered inside Radix UI portals, Stencil/Lit web components, or
 * other shadow-host wrappers are reachable.
 */

import { queryAllDeep } from "./shadow.js";

export interface EnumeratedField {
  index: number;
  type: string;
  label: string;
  value: string;
  y: number;
  selector: string;
  context?: string;
  /** True when the field is `required`, `aria-required="true"`, or its
   *  containing `<label>` text ends in `*` (the de-facto required-field
   *  convention on dashboards that don't use semantic attributes). Used by
   *  the only_empty filter to surface required-but-empty fields the user
   *  hasn't filled yet, the "why is Submit disabled" diagnostic. */
  required?: boolean;
  /** True when the field's current value is empty/unchecked/unselected.
   *  Combined with `required`, lets the caller filter to required-but-empty
   *  fields in one pass. */
  empty?: boolean;
  /** True when this field's `id` attribute is not unique on the page — a
   *  `fill_input`/`click_element` selector call using `#id` would then be
   *  ambiguous, resolving to whichever duplicate happens to come first in
   *  document order. Seen when a page renders two full copies of the same
   *  form simultaneously with colliding element ids (see
   *  ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md).
   *  `selector` already avoids `#id` for these fields (falls back to
   *  `tag:nth-of-type(n)`), but the flag is surfaced too since it's evidence
   *  the PAGE itself, not just this one field, may have duplicate content. */
  duplicate_id?: boolean;
}

export interface EnumerateResult {
  fields: EnumeratedField[];
  hiddenFieldCount: number;
  captcha: CaptchaInfo | null;
  oauthIndicators: string[];
}

/**
 * Captcha presence on the page. Detection covers the three major vendors that
 * cover ~95% of forms: Google reCAPTCHA, Cloudflare Turnstile, hCaptcha.
 * sitekey is best-effort — useful when the agent needs to surface it to the
 * user verbatim (e.g. for an off-page captcha-solving service).
 */
export interface CaptchaInfo {
  kind: "recaptcha" | "turnstile" | "hcaptcha";
  sitekey: string | null;
  /**
   * Whether the vendor's hidden response-token field currently holds a
   * non-empty value. Presence of the widget only means a captcha EXISTS on
   * the page — it says nothing about whether the underlying passive/invisible
   * check has actually resolved. A form can look completely normal (no
   * visible challenge, click "succeeds" with no error) while this stays
   * false forever, because the vendor's own behavioral risk-scoring is
   * silently withholding a token — see ISSUE-2026-09-14-icims-hcaptcha-
   * still-silent.md, where this was confirmed to vary run-to-run against
   * identical input (worked once, failed twice, worked again), i.e. a real
   * probabilistic signal from the vendor, not a deterministic page bug.
   * null when the response field itself can't be found yet (widget not
   * rendered/loaded).
   */
  responseTokenPopulated: boolean | null;
}

/**
 * True if the element OR any ancestor is `display:none`, `visibility:hidden`,
 * or `aria-hidden="true"`. Catches the common "form section in a hidden
 * collapsible parent" pattern where the input itself reports default styles
 * but is invisible because of an ancestor.
 */
function isAncestorHidden(el: Element, doc: Document): boolean {
  // aria-hidden is a SEMANTIC flag, not a visual one (checkVisibility ignores
  // it), so walk ancestors for it, piercing shadow boundaries: parentElement is
  // null at the shadow root, so jump to the host via parentNode.
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    if (cur.getAttribute("aria-hidden") === "true") return true;
    cur = cur.parentElement
      ?? (cur.parentNode instanceof ShadowRoot ? cur.parentNode.host : null);
  }

  // Visual visibility: prefer the browser's own checkVisibility(), which
  // resolves display:none anywhere up the tree AND visibility:hidden WITH
  // descendant overrides. The old manual walk returned true the moment ANY
  // ancestor was visibility:hidden — but a child can re-show with
  // visibility:visible under a visibility:hidden parent, so a genuinely-visible
  // (and submit-blocking) required field was wrongly dropped from
  // get_form_fields(only_empty). Opacity is intentionally NOT treated as hidden
  // (matches the prior behaviour). Extra option keys are ignored by older
  // Chrome builds, so passing both naming schemes is safe.
  const cv = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof cv === "function") {
    return !cv.call(el, { checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true });
  }

  // Fallback for engines without checkVisibility: the original ancestor walk.
  const view = doc.defaultView;
  if (!view) return false;
  let c: Element | null = el;
  while (c && c !== doc.documentElement) {
    const s = view.getComputedStyle(c);
    if (s.display === "none" || s.visibility === "hidden") return true;
    c = c.parentElement
      ?? (c.parentNode instanceof ShadowRoot ? (c.parentNode as ShadowRoot).host : null);
  }
  return false;
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
 * True for react-select's internal search/filter input (its `react-select-N-
 * input` id is a stable, library-wide convention set by the library itself,
 * not a site-specific hook — any site using react-select gets this exact id
 * shape). Used to widen the label-climb depth and to redirect value-reading
 * to the sibling display node below, both because this input is nested
 * several DOM levels deeper (control -> value-container -> input) than a
 * plain labelled input.
 */
function isReactSelectInput(el: Element): boolean {
  return /^react-select-.*-input$/.test(el.id);
}

/**
 * A react-select-style combobox keeps its OWN search input's `.value` empty
 * after a real selection — the chosen option renders in a separate sibling
 * node instead (react-select's stable "singleValue" CSS class, present
 * across every site using the library, not one specific tenant). Reading
 * only `el.value` makes a selection permanently invisible: not a timing gap
 * that a re-call fixes, the input's value never carries it at all.
 *
 * Scoped to THIS field's own "value-container"/"control" wrapper (react-
 * select's stable class convention — one such wrapper per field, never
 * shared between two different fields). A page with several react-select
 * controls (a country picker AND a language picker, say) means an
 * unscoped ancestor walk would find the FIRST singleValue anywhere in a
 * shared parent's subtree and misreport every OTHER field as holding the
 * same value — reproduced live on a real multi-select form (Bending
 * Spoons' application, six react-select fields on one page) where every
 * field wrongly echoed the one field that actually had a selection.
 */
function deriveSelectDisplayValue(el: Element): string {
  const control = el.closest('[class*="value-container"], [class*="valueContainer"], [class*="__control"], [class*="-control"]');
  if (!control) return "";
  const sv = control.querySelector('[class*="singleValue"], [class*="single-value"]');
  return sv ? (sv.textContent ?? "").trim() : "";
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
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
    if (lbl) label = (lbl.textContent ?? "").trim();
  }
  if (!label) {
    // react-select's search input sits deeper below the field's <label>
    // (control -> value-container -> input) than the general climb below
    // reaches, so it needs more levels before giving up.
    const maxDepth = isReactSelectInput(el) ? 10 : 4;
    let node: Element | null = el.parentElement;
    for (let d = 0; d < maxDepth && node && node !== doc.body; d++) {
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
    // Pierce shadow roots so a <label for=…> living in a separate shadow tree
    // still associates with this input.
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
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

// Validation-message phrasings that indicate a field is required. Deliberately
// specific (not a bare /required/i match) so unrelated helper text like
// "Required experience: 5 years" doesn't trip it. Covers the late-bound
// messages SPAs render only after a failed submit ("This question is required",
// "Please select an option", "You must answer this").
const REQUIRED_VALIDATION_RE =
  /\bis required\b|\brequired field\b|\bthis (?:question|field) is required\b|\bplease (?:answer|select|choose|enter|provide|complete)\b|\byou must (?:answer|select|choose|provide|complete)\b/i;

/**
 * The element's OWN text (concatenation of its direct text-node children only),
 * not its descendants'. Lets us pin a validation message to the specific
 * element that renders it (a leaf `<div>This question is required</div>`)
 * without also matching every ancestor that merely contains it.
 */
function directText(el: Element): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 /* TEXT_NODE */) s += n.textContent ?? "";
  }
  return s.trim();
}

/**
 * Late-bound / conditional required detection. Many SPA forms (survey builders,
 * annotation dashboards, Radix/headlessui disclosure panels) don't set `required` or
 * `aria-required` up front — required-ness only surfaces as a visible
 * validation message after a submit attempt, or as `aria-invalid="true"`.
 * This catches those so get_form_fields(only_empty) stops reporting "0
 * required-but-empty" while submit is actually blocked.
 */
function hasRequiredValidation(el: HTMLElement, doc: Document): boolean {
  if (el.getAttribute("aria-invalid") === "true") return true;

  // Error element referenced by the field via aria-errormessage/-describedby.
  for (const attr of ["aria-errormessage", "aria-describedby"]) {
    const ids = (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const node =
        doc.getElementById(id) ?? queryAllDeep<HTMLElement>(doc, `#${CSS.escape(id)}`)[0];
      if (
        node &&
        REQUIRED_VALIDATION_RE.test(node.textContent ?? "") &&
        !isAncestorHidden(node, doc)
      ) {
        return true;
      }
    }
  }

  // Walk up to the nearest question/group container and look for a visible
  // error-styled element whose text reads as a required-validation message.
  let node: Element | null = el.parentElement;
  for (let d = 0; d < 6 && node && node !== doc.body; d++) {
    const errs = node.querySelectorAll(
      "[role='alert'],[aria-live],[class*='error'],[class*='invalid'],[class*='required']"
    );
    for (const m of Array.from(errs)) {
      if (
        REQUIRED_VALIDATION_RE.test(m.textContent ?? "") &&
        !isAncestorHidden(m, doc)
      ) {
        return true;
      }
    }

    // Fallback for messages rendered in a plain element with no role / class
    // hook (a bare <div>This question is required</div> inside a disclosure
    // panel) — the styled-error selector above can't see those. Scan this
    // level's descendants by their OWN text only (so we match the leaf message
    // node, never a huge ancestor), capped to stay cheap, visible-only to skip
    // hidden template copies. The break-at-boundary below keeps this from
    // climbing into a sibling question's territory.
    const kids = node.querySelectorAll("*");
    const cap = Math.min(kids.length, 40);
    for (let i = 0; i < cap; i++) {
      const k = kids[i] as HTMLElement;
      const own = directText(k);
      if (own && REQUIRED_VALIDATION_RE.test(own) && !isAncestorHidden(k, doc)) {
        return true;
      }
    }
    // Stop once we've climbed to a recognisable question/group boundary so we
    // don't attribute a sibling question's error to this field.
    if (
      node.matches?.(
        "fieldset,[role='group'],[role='radiogroup'],[id*='question'],[class*='question'],[data-question],[class*='form-group']"
      )
    ) {
      break;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * True when an input is required via the standard HTML attribute, ARIA, the
 * unofficial "label ends in *" convention, or a late-bound validation message
 * / aria-invalid state (see hasRequiredValidation).
 */
function isRequiredField(el: HTMLElement, doc: Document): boolean {
  if (el.hasAttribute("required")) return true;
  if (el.getAttribute("aria-required") === "true") return true;
  if (el.id) {
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
    if (lbl && /[*✱∗]\s*$/.test((lbl.textContent ?? "").trim())) return true;
  }
  // Wrapping <label> case
  const parentLabel = el.closest?.("label");
  if (parentLabel && /[*✱∗]\s*$/.test((parentLabel.textContent ?? "").trim())) {
    return true;
  }
  if (hasRequiredValidation(el, doc)) return true;
  return false;
}

/**
 * True when the field's value (or checked state) is empty / unselected.
 * Mirrors the logic in enumerate's value-extraction so the `empty` flag is
 * consistent with the displayed `value`.
 */
function isFieldEmpty(el: HTMLElement): boolean {
  if (el instanceof HTMLSelectElement) {
    // Compare against "" explicitly — a legitimate selected option with value
    // "0" (e.g. a numeric quantity dropdown) is NOT empty, but `!el.value`
    // would treat it as empty.
    return el.value === "" || el.selectedIndex < 0;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return !el.checked;
    if (el.type === "file") return !el.files || el.files.length === 0;
    if (el.value.trim().length === 0) {
      // A react-select input's own value stays "" after a real selection —
      // check the sibling display node before calling the field empty (see
      // deriveSelectDisplayValue). Otherwise only_empty wrongly lists an
      // already-answered combobox as required-and-empty.
      return deriveSelectDisplayValue(el).trim().length === 0;
    }
    return el.value.trim().length === 0;
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.trim().length === 0;
  }
  // Custom editors (CodeMirror/Monaco): consider empty if no text content.
  return (el.textContent ?? "").trim().length === 0;
}

/**
 * Every `id` value that appears on 2+ elements in `doc` — shadow-piercing so
 * a duplicate spanning a light-DOM/shadow-DOM boundary is still caught. A
 * page rendering two full copies of the same form (Workday's Create Account
 * step, see ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-
 * form.md) produces exactly this: two independent component-instance id
 * counters both starting from the same seed, so `#input-6` resolves to
 * DIFFERENT elements (even different `type`s) depending on which copy
 * happened to render first. Computed once per enumeration, not per field.
 */
function findDuplicateIds(doc: Document): Set<string> {
  const counts = new Map<string, number>();
  for (const el of queryAllDeep<Element>(doc, "[id]")) {
    if (!el.id) continue;
    counts.set(el.id, (counts.get(el.id) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [id, count] of counts) if (count > 1) dupes.add(id);
  return dupes;
}

/**
 * Build a unique-ish CSS selector for an element. Prefers id, falls back
 * to tag:nth-of-type. Mirrors the inline pattern in get_form_fields.
 * Never returns `#id` for an id that's duplicated elsewhere on the page —
 * that selector would be genuinely ambiguous (resolves to first-in-document-
 * order, not necessarily THIS element) — nth-of-type at least stays pinned
 * to the exact element enumerateFormFields is looking at right now.
 */
function buildSelector(el: Element, doc: Document, duplicateIds: Set<string>): string {
  if (el.id && !duplicateIds.has(el.id)) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  // Pierce shadow roots so the nth-of-type fallback is stable across
  // light/shadow boundaries (otherwise the index re-counts after each shadow
  // root, producing the same selector for multiple distinct elements).
  const idx = queryAllDeep(doc, el.tagName).indexOf(el) + 1;
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
  const duplicateIds = findDuplicateIds(doc);

  // File inputs — always include even if visually hidden (often 0×0 behind
  // custom drag zones). Tagged label includes a usage hint for Claude.
  for (const el of queryAllDeep<HTMLInputElement>(doc, "input[type=file]")) {
    const label = deriveFileLabel(el, doc);
    const context = getNearestHeading(el, doc);
    const idDuplicated = !!el.id && duplicateIds.has(el.id);
    fields.push({
      index: ++idx,
      type: "file",
      label:
        (label.replace(/\s+/g, " ").slice(0, 80) || "(unnamed)") +
        " — use set_file_input(hint, filePath) to upload",
      value: el.files?.[0]?.name ?? "",
      y: getDocumentY(el, doc),
      selector: el.id && !idDuplicated ? `#${CSS.escape(el.id)}` : "input[type=file]",
      required: isRequiredField(el, doc),
      empty: isFieldEmpty(el),
      ...(idDuplicated ? { duplicate_id: true } : {}),
      ...(context ? { context } : {}),
    });
  }

  // Standard inputs (file handled above), textareas, selects
  const FIELD_SELECTORS =
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]), textarea, select";
  for (const el of queryAllDeep<HTMLElement>(doc, FIELD_SELECTORS)) {
    if (isAncestorHidden(el, doc)) continue;

    const label = deriveInputLabel(el, doc);

    let value = "";
    if (el instanceof HTMLSelectElement) {
      value = el.options[el.selectedIndex]?.text ?? el.value;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      value = el.checked ? "checked" : "unchecked";
    } else {
      value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
      // react-select's search input reports "" here even after a real
      // selection (the choice lives in a sibling "singleValue" node, not
      // this input's own value) — see deriveSelectDisplayValue.
      if (!value && el instanceof HTMLInputElement) {
        value = deriveSelectDisplayValue(el);
      }
    }

    const context = getNearestHeading(el, doc);
    fields.push({
      index: ++idx,
      type: el instanceof HTMLInputElement ? (el.type || "text") : el.tagName.toLowerCase(),
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: value.slice(0, 60),
      y: getDocumentY(el, doc),
      selector: buildSelector(el, doc, duplicateIds),
      required: isRequiredField(el, doc),
      empty: isFieldEmpty(el),
      ...(el.id && duplicateIds.has(el.id) ? { duplicate_id: true } : {}),
      ...(context ? { context } : {}),
    });
  }

  // CodeMirror 6 editors
  for (const editor of queryAllDeep<HTMLElement>(doc, ".cm-editor")) {
    if (isAncestorHidden(editor, doc)) continue;
    const view = doc.defaultView;
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
      required: isRequiredField(editor, doc),
      empty: (editor.querySelector(".cm-content")?.textContent ?? "").trim().length === 0,
      ...(context ? { context } : {}),
    });
  }

  // Monaco editors
  for (const editor of queryAllDeep<HTMLElement>(doc, ".monaco-editor")) {
    if (isAncestorHidden(editor, doc)) continue;

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
      required: isRequiredField(editor, doc),
      empty: currentText.trim().length === 0,
      ...(context ? { context } : {}),
    });
  }

  // Sort by vertical position on page, then renumber
  fields.sort((a, b) => a.y - b.y);
  fields.forEach((f, i) => {
    f.index = i + 1;
  });

  // Count hidden fields for the warning that get_form_fields appends.
  // Walks the ancestor chain so inputs inside a `display:none` collapsible
  // parent (the most common pattern for conditional form sections) are
  // counted, not just inputs hidden directly via their own style. Pierces
  // shadow roots so the count is accurate across web-component-heavy forms.
  const hiddenFields = queryAllDeep<HTMLElement>(
    doc,
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select"
  ).filter((el) => isAncestorHidden(el, doc));

  return {
    fields,
    hiddenFieldCount: hiddenFields.length,
    captcha: detectCaptcha(doc),
    oauthIndicators: detectOAuthIndicators(doc),
  };
}

function detectCaptcha(doc: Document): CaptchaInfo | null {
  const getSitekey = (el: Element | null): string | null =>
    el?.getAttribute("data-sitekey") ?? null;
  // Response-token fields are always <input>/<textarea> — read .value, not
  // textContent, and treat "field not found yet" as null (unknown) rather
  // than false (confirmed empty), since a not-yet-rendered widget isn't the
  // same signal as one that rendered and stayed empty.
  const tokenPopulated = (selector: string): boolean | null => {
    const el = queryAllDeep<HTMLInputElement | HTMLTextAreaElement>(doc, selector)[0];
    return el ? el.value.trim().length > 0 : null;
  };

  // hCaptcha and Turnstile are checked BEFORE reCAPTCHA, using each vendor's
  // own widget class as the primary signal rather than a response-field
  // name. hCaptcha's own widget script deliberately ALSO injects a hidden
  // <textarea name="g-recaptcha-response"> for drop-in reCAPTCHA
  // compatibility (a documented hCaptcha feature, so a site migrating from
  // reCAPTCHA needs no server-side changes) — confirmed empirically against
  // hCaptcha's own official test widget, which produced exactly that field
  // with no .g-recaptcha class anywhere on the page. Checking the generic
  // response-field name first would misidentify every real hCaptcha widget
  // as reCAPTCHA, with no sitekey (since there's no .g-recaptcha element to
  // read one from). reCAPTCHA's response-field name isn't a reliably
  // exclusive signal, so it's the last, most permissive check, not the
  // first.
  const hcaptchaEl = queryAllDeep(
    doc,
    '.h-captcha, [name="h-captcha-response"], iframe[src*="hcaptcha.com/captcha"]'
  )[0];
  if (hcaptchaEl) {
    return {
      kind: "hcaptcha",
      sitekey: getSitekey(queryAllDeep(doc, ".h-captcha")[0] ?? null),
      responseTokenPopulated: tokenPopulated('[name="h-captcha-response"]'),
    };
  }
  // Cloudflare Turnstile
  const turnstileEl = queryAllDeep(
    doc,
    '.cf-turnstile, [name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com/turnstile"]'
  )[0];
  if (turnstileEl) {
    return {
      kind: "turnstile",
      sitekey: getSitekey(queryAllDeep(doc, ".cf-turnstile")[0] ?? null),
      responseTokenPopulated: tokenPopulated('[name="cf-turnstile-response"]'),
    };
  }
  // Google reCAPTCHA — covers v2 (visible/invisible), v3 (token-only), Enterprise.
  const recaptchaEl = queryAllDeep(
    doc,
    '.g-recaptcha, [name="g-recaptcha-response"], iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]'
  )[0];
  if (recaptchaEl) {
    return {
      kind: "recaptcha",
      sitekey: getSitekey(queryAllDeep(doc, ".g-recaptcha")[0] ?? null),
      responseTokenPopulated: tokenPopulated('[name="g-recaptcha-response"]'),
    };
  }
  return null;
}

function detectOAuthIndicators(doc: Document): string[] {
  // Scan obvious clickable elements for "Continue with X" / "Sign in with X"
  // strings, the standard pattern for OAuth provider buttons. Cuts off after
  // 6 matches to avoid noise from sites that list every conceivable provider.
  const out: string[] = [];
  const re = /^(continue|sign in|sign up|log in|log on)\s+with\s+(google|github|microsoft|apple|facebook|twitter|x|discord|slack|gitlab|linkedin|notion)$/i;
  for (const el of queryAllDeep<HTMLElement>(doc, 'button, a, [role="button"]')) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 60) continue;
    if (re.test(text)) {
      if (!out.includes(text)) out.push(text);
      if (out.length >= 6) break;
    }
  }
  return out;
}
