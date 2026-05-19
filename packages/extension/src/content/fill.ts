import { queryAllDeep, walkTextNodesDeep } from "./shadow.js";

/**
 * Match strength used to rank fill_input candidates. Lower = stronger.
 * Anything ≤ EXACT_MAX is considered an "exact" match for the `exact: true` mode.
 */
type MatchKind =
  | "aria-eq"        // 1: aria-label === hint
  | "placeholder-eq" // 2: placeholder === hint
  | "label-text-eq"  // 3: associated <label> textContent === hint
  | "name-eq"        // 4: name attribute === hint
  | "id-eq"          // 5: id === hint
  | "aria-includes"      // 6: aria-label.includes(hint)
  | "placeholder-includes" // 7: placeholder.includes(hint)
  | "label-text-includes" // 8: associated <label> textContent.includes(hint)
  | "fuzzy-text-walk";    // 9: fuzzy walk through nearby text nodes (lowest confidence)

const RANK: Record<MatchKind, number> = {
  "aria-eq": 1,
  "placeholder-eq": 2,
  "label-text-eq": 3,
  "name-eq": 4,
  "id-eq": 5,
  "aria-includes": 6,
  "placeholder-includes": 7,
  "label-text-includes": 8,
  "fuzzy-text-walk": 9,
};

const EXACT_MAX = 5; // ranks 1-5 are exact matches; ≥6 is fuzzy

type FillableInput = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Find a form input by its label/placeholder/aria-label and set its value,
 * dispatching the synthetic events React/Vue/Svelte apps need to pick up the change.
 * Also handles contenteditable elements used by dashboards like Stripe.
 *
 * Set `exact: true` to refuse fuzzy text-walk matches — the fuzzy walker is the
 * source of "filled the wrong field" bugs on dense forms (e.g. eBay's promoted-
 * listings rate input matching against the title input). When exact is true and
 * no strict match exists, returns success: false rather than silently filling
 * the wrong field.
 */
export function fillInput(
  textHint: string,
  value: string,
  nth?: number,
  exact: boolean = false
): { success: boolean; message: string; matched?: string } {
  const lower = textHint.toLowerCase().trim();
  const nthExplicit = typeof nth === "number" && nth >= 1;

  // Try CodeMirror 6 editors first (.cm-editor wrapping a .cm-content div)
  const cmResult = fillCodeMirror(lower, value);
  if (cmResult) return cmResult;

  // Try contenteditable elements (used by Stripe, Notion, etc.)
  const editable = findContentEditable(lower);
  if (editable) {
    editable.focus();
    // Select all existing content and replace
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // insertText is the most React-compatible way to set value in contenteditable
    document.execCommand("insertText", false, value);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    editable.dispatchEvent(new Event("change", { bubbles: true }));
    editable.scrollIntoView({ behavior: "smooth", block: "center" });
    const matched = describeElement(editable);
    return { success: true, message: `Filled "${textHint}" → ${matched} (contenteditable)`, matched };
  }

  const found = findInput(lower, nth ?? 1, exact);
  if (!found) {
    // Last resort: the user may have just clicked/focused the target field via
    // wait_for_click — try to fill whatever is currently focused.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      if (active.isContentEditable) {
        active.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(active);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("insertText", false, value);
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        const matched = describeElement(active);
        return { success: true, message: `Filled "${textHint}" → ${matched} (currently-focused contenteditable)`, matched };
      }
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        if (isEditable(active)) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) nativeSetter.call(active, value);
          else active.value = value;
          active.dispatchEvent(new Event("input", { bubbles: true }));
          active.dispatchEvent(new Event("change", { bubbles: true }));
          const matched = describeElement(active);
          return { success: true, message: `Filled "${textHint}" → ${matched} (currently-focused input)`, matched };
        }
      }
    }
    if (exact) {
      return {
        success: false,
        message: `No exact-match input found for "${textHint}". Pass exact: false (the default) to allow fuzzy text-walk matching, but verify the matched element via the response.`,
      };
    }
    return { success: false, message: `No input found for "${textHint}"` };
  }

  const { input, kind, fuzzyCount, fuzzyCandidates } = found;

  // Ambiguous fuzzy walk: when the winner only matched via the lowest-confidence
  // pathway AND there were 2+ such candidates, refuse rather than silently
  // overwriting an adjacent textarea. The caller can disambiguate by passing
  // `selector=...`, `exact: true`, or an explicit `nth`.
  if (kind === "fuzzy-text-walk" && !exact && !nthExplicit && fuzzyCount >= 2) {
    const list = fuzzyCandidates.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
    return {
      success: false,
      message: `Ambiguous fuzzy match for "${textHint}" — ${fuzzyCount} candidates matched via fuzzy-text-walk and none has a stronger label association. Disambiguate with exact: true, an explicit nth, or selector="<css>". Candidates:\n${list}`,
    };
  }

  // Focus the element first (triggers any focus handlers)
  input.focus();

  if (input instanceof HTMLSelectElement) {
    // For <select>, find matching option
    const option = Array.from(input.options).find(
      (o) =>
        o.text.toLowerCase().includes(lower) ||
        o.value.toLowerCase().includes(lower)
    );
    if (option) {
      input.value = option.value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const matched = describeElement(input);
    return { success: true, message: `Selected "${option?.text ?? value}" → ${matched} (matched via ${kind})`, matched };
  }

  // For React-controlled inputs, bypass the synthetic event system by using
  // the native setter so React's onChange fires correctly. Use the prototype
  // FROM THE INSTANCE so iframe-hosted inputs (whose own constructor differs
  // from the outer window's HTMLInputElement) don't throw "Illegal invocation".
  const proto = Object.getPrototypeOf(input);
  const nativeSetter =
    Object.getOwnPropertyDescriptor(proto, "value")?.set ??
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value"
    )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    (input as HTMLInputElement).value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

  // Scroll into view and briefly highlight it
  input.scrollIntoView({ behavior: "smooth", block: "center" });

  // Read back the value to confirm it was accepted (React may discard improperly dispatched events)
  const confirmedValue = (input as HTMLInputElement | HTMLTextAreaElement).value;
  const accepted = confirmedValue === value;
  const matched = describeElement(input);
  const matchNote = `matched via ${kind}`;
  return {
    success: true,
    matched,
    message: accepted
      ? `Filled "${textHint}" → ${matched} (${matchNote})`
      : `Filled "${textHint}" → ${matched} (${matchNote}) — but value may not have been accepted by React (got back: "${confirmedValue.slice(0, 60)}")`,
  };
}

/**
 * Build a human-readable description of an element for the fill_input return
 * message — `<input name="X" id="Y" placeholder="Z">`. Used by Claude to
 * sanity-check that fill_input matched the intended field.
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parts: string[] = [];
  const name = el.getAttribute("name");
  const id = el.id || null;
  const placeholder = el.getAttribute("placeholder");
  const aria = el.getAttribute("aria-label");
  const type = el.getAttribute("type");
  if (type) parts.push(`type="${type}"`);
  if (name) parts.push(`name="${name}"`);
  if (id) parts.push(`id="${id}"`);
  if (placeholder) parts.push(`placeholder="${placeholder.slice(0, 40)}"`);
  if (aria) parts.push(`aria-label="${aria.slice(0, 40)}"`);
  return `<${tag}${parts.length ? " " + parts.join(" ") : ""}>`;
}

/**
 * Find a fillable input by hint, classifying each match by how strong the
 * association is. Returns the nth match overall (after ranking by strength)
 * along with the kind of match. `exact` removes fuzzy-text-walk and includes-
 * style partial matches from consideration — only equality matches qualify.
 */
function findInput(
  lower: string,
  nth: number = 1,
  exact: boolean = false
): { input: FillableInput; kind: MatchKind; fuzzyCount: number; fuzzyCandidates: string[] } | null {
  const matches: Array<{ input: FillableInput; kind: MatchKind }> = [];
  const seen = new Set<Element>();

  function add(el: FillableInput, kind: MatchKind) {
    if (seen.has(el)) return;
    seen.add(el);
    matches.push({ input: el, kind });
  }

  // STRONGEST: aria-label / placeholder / name / id equality on the element itself
  for (const el of queryAllDeep<FillableInput>(document, "input, textarea, select")) {
    if (!isEditable(el)) continue;
    const aria = (el.getAttribute("aria-label") ?? "").toLowerCase().trim();
    if (aria === lower) { add(el, "aria-eq"); continue; }
    const placeholder = ((el as HTMLInputElement).placeholder ?? "").toLowerCase().trim();
    if (placeholder === lower) { add(el, "placeholder-eq"); continue; }
    const name = ((el as HTMLInputElement).name ?? "").toLowerCase().trim();
    if (name === lower) { add(el, "name-eq"); continue; }
    if (el.id.toLowerCase().trim() === lower) { add(el, "id-eq"); continue; }
  }

  // Strong: <label>(textContent === hint) → input via htmlFor or descendant
  for (const label of queryAllDeep<HTMLLabelElement>(document, "label")) {
    const labelText = (label.textContent ?? "").toLowerCase().trim();
    if (!labelText) continue;
    if (labelText === lower) {
      const target = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector<FillableInput>("input, textarea, select");
      if (target && isEditable(target as FillableInput)) add(target as FillableInput, "label-text-eq");
    }
  }

  if (!exact) {
    // Medium: aria-label / placeholder includes hint
    for (const el of queryAllDeep<FillableInput>(document, "input, textarea, select")) {
      if (!isEditable(el)) continue;
      const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
      if (aria && aria.includes(lower) && aria !== lower) add(el, "aria-includes");
    }
    for (const el of queryAllDeep<HTMLInputElement | HTMLTextAreaElement>(
      document,
      "input[placeholder], textarea[placeholder]"
    )) {
      if (!isEditable(el)) continue;
      const placeholder = (el.placeholder ?? "").toLowerCase();
      if (placeholder && placeholder.includes(lower) && placeholder !== lower) add(el, "placeholder-includes");
    }
    // Medium: <label>(textContent.includes(hint)) → input via htmlFor or descendant
    for (const label of queryAllDeep<HTMLLabelElement>(document, "label")) {
      const labelText = (label.textContent ?? "").toLowerCase().trim();
      if (!labelText || labelText === lower) continue;
      if (labelText.includes(lower)) {
        const target = label.htmlFor
          ? document.getElementById(label.htmlFor)
          : label.querySelector<FillableInput>("input, textarea, select");
        if (target && isEditable(target as FillableInput)) add(target as FillableInput, "label-text-includes");
      }
    }

    // WEAK (fuzzy text walk) — last resort only. This is the pathway that's
    // historically caused fill_input to land on the wrong field on dense
    // forms (see Issue #1 — eBay promoted-listings rate filling into title).
    // We keep it for forms with no proper labels, but rank it lowest so
    // exact-match modes never see it, and it loses to every other strategy.
    // walkTextNodesDeep traverses open shadow roots so labels-near-textareas
    // inside web components (Outlier's task UI) are reachable.
    for (const textNode of walkTextNodesDeep(document.body)) {
      if (!textNode.textContent?.toLowerCase().includes(lower)) continue;
      const anchor = textNode.parentElement;
      if (!anchor) continue;
      const style = getComputedStyle(anchor);
      if (style.display === "none" || style.visibility === "hidden") continue;

      let node: Element | null = anchor;
      for (let depth = 0; depth < 8 && node; depth++) {
        // Use queryAllDeep so a label OUTSIDE a nested shadow root can match
        // an input INSIDE it (and vice versa).
        const inputs = queryAllDeep<FillableInput>(node, "input, textarea, select");
        const input = inputs.find((el) => isEditable(el));
        if (input) { add(input, "fuzzy-text-walk"); break; }
        let found = false;
        for (const sibling of [node.nextElementSibling, node.previousElementSibling]) {
          if (sibling) {
            const sibInputs = queryAllDeep<FillableInput>(sibling, "input, textarea, select");
            const sibInput = sibInputs.find((el) => isEditable(el));
            if (sibInput) { add(sibInput, "fuzzy-text-walk"); found = true; break; }
          }
        }
        if (found) break;
        // Climb past shadow roots: parentElement is null at the shadow root,
        // so fall back to the host via parentNode.
        const dnPN: Node | null = node.parentNode;
        const parent: Element | null = node.parentElement
          ?? (dnPN instanceof ShadowRoot ? dnPN.host : null);
        if (!parent || parent === document.body) break;
        node = parent;
      }
    }
  }

  if (matches.length === 0) return null;
  // Sort by rank (lower = stronger). Stable sort preserves DOM order within a rank.
  matches.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  const fuzzyMatches = matches.filter((m) => m.kind === "fuzzy-text-walk");
  const fuzzyCount = fuzzyMatches.length;
  const fuzzyCandidates = fuzzyMatches.slice(0, 5).map((m) => describeElement(m.input));
  if (exact) {
    const exactOnly = matches.filter((m) => RANK[m.kind] <= EXACT_MAX);
    if (exactOnly.length === 0) return null;
    const winner = exactOnly[nth - 1] ?? exactOnly[exactOnly.length - 1];
    return { ...winner, fuzzyCount, fuzzyCandidates };
  }
  const winner = matches[nth - 1] ?? matches[matches.length - 1];
  return { ...winner, fuzzyCount, fuzzyCandidates };
}

/**
 * Detect and fill a CodeMirror 6 editor matching the hint.
 * CM6 uses a `.cm-editor` host element containing a `.cm-content` div with role="textbox".
 * Standard fill_input doesn't work because CM6 is not a native input.
 */
function fillCodeMirror(lower: string, value: string): { success: boolean; message: string } | null {
  const editors = queryAllDeep<HTMLElement>(document, ".cm-editor");
  if (editors.length === 0) return null;

  let targetEditor: HTMLElement | null = null;

  for (const editor of editors) {
    // Look for a label, heading, or nearby text that matches the hint
    const container = editor.closest("div, li, tr, fieldset, form, section, [class]") ?? editor.parentElement;
    if (!container) continue;

    // Check siblings and ancestors for matching label text
    const containerText = (container.textContent ?? "").toLowerCase();
    const editorText = (editor.textContent ?? "").toLowerCase();
    // Hint should appear as a label near this editor, not as the editor's own content
    if (containerText.includes(lower) && !editorText.includes(lower)) {
      targetEditor = editor;
      break;
    }

    // Check aria-label on editor or cm-content
    const ariaLabel = (editor.getAttribute("aria-label") ?? editor.querySelector(".cm-content")?.getAttribute("aria-label") ?? "").toLowerCase();
    if (ariaLabel.includes(lower)) {
      targetEditor = editor;
      break;
    }
  }

  // If only one editor exists and no label was found, use it when hint is generic
  if (!targetEditor && editors.length === 1) {
    targetEditor = editors[0];
  }

  if (!targetEditor) return null;

  const cmContent = targetEditor.querySelector<HTMLElement>(".cm-content");
  if (!cmContent) return null;

  // Focus the editor
  cmContent.focus();

  // Select all existing content and replace via execCommand (works cross-framework)
  document.execCommand("selectAll");
  document.execCommand("insertText", false, value);

  // Dispatch events so any listeners pick up the change
  cmContent.dispatchEvent(new Event("input", { bubbles: true }));
  cmContent.dispatchEvent(new Event("change", { bubbles: true }));
  targetEditor.scrollIntoView({ behavior: "smooth", block: "center" });

  return { success: true, message: `Filled CodeMirror editor "${lower}" with value` };
}

function findContentEditable(lower: string): HTMLElement | null {
  for (const el of queryAllDeep<HTMLElement>(document, '[contenteditable]:not([contenteditable="false"])')) {
    const ariaLabel = (el.getAttribute("aria-label") ?? "").toLowerCase();
    const dataPlaceholder = (
      el.getAttribute("data-placeholder") ??
      el.getAttribute("placeholder") ??
      ""
    ).toLowerCase();
    if (ariaLabel.includes(lower) || dataPlaceholder.includes(lower)) return el;

    // Check for a <label> or nearby text node that matches
    const id = el.id;
    if (id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      if (label?.textContent?.toLowerCase().includes(lower)) return el;
    }
    const container = el.closest("div, li, tr, fieldset, form") ?? el.parentElement;
    if (container) {
      const text = container.textContent?.toLowerCase() ?? "";
      // Only match if the hint appears as a label near this element (not as its own content)
      const ownText = el.textContent?.toLowerCase() ?? "";
      if (text.includes(lower) && !ownText.includes(lower)) return el;
    }
  }
  return null;
}

function isEditable(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return false;
  const type = (el as HTMLInputElement).type?.toLowerCase();
  const nonFillable = ["checkbox", "radio", "submit", "button", "reset", "file", "hidden"];
  if (nonFillable.includes(type)) return false;
  return true;
}
