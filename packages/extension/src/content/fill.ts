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
): { success: boolean; message: string; matched?: string; needsTrustedKeystrokes?: boolean; resolvedSelector?: string } {
  const lower = textHint.toLowerCase().trim();
  const nthExplicit = typeof nth === "number" && nth >= 1;

  // Try CodeMirror 6 editors first (.cm-editor wrapping a .cm-content div)
  const cmResult = fillCodeMirror(lower, value);
  if (cmResult) return cmResult;

  // Try tiptap / ProseMirror editors — these are contenteditable underneath,
  // but their wrapper usually doesn't carry the label heuristic that
  // findContentEditable relies on. Specific detection finds them first.
  const pmResult = fillProseMirror(lower, value);
  if (pmResult) return pmResult;

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
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
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
        active.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        const matched = describeElement(active);
        return { success: true, message: `Filled "${textHint}" → ${matched} (currently-focused contenteditable)`, matched };
      }
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        if (isEditable(active)) {
          // Try-then-verify, same as the findInput()-matched path below: try
          // the native setter FIRST and only escalate to trusted keystrokes
          // if the read-back shows it genuinely didn't land. See that path's
          // comment for why escalating on marker-presence alone is wrong on
          // tenants where it's the native setter that works and keystrokes
          // that get dropped (S&P Global, PGIM).
          const nativeSetter = Object.getOwnPropertyDescriptor(
            active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) nativeSetter.call(active, value);
          else active.value = value;
          active.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
          active.dispatchEvent(new Event("change", { bubbles: true }));
          const matched = describeElement(active);
          if (active.value !== value) {
            const escalation = checkTrustedKeystrokeEscalation(active, textHint, " (currently-focused input)");
            if (escalation) return escalation;
          }
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

  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

  // Scroll into view and briefly highlight it
  input.scrollIntoView({ behavior: "smooth", block: "center" });

  // Read back the value to confirm it was accepted (React may discard improperly dispatched events)
  const confirmedValue = (input as HTMLInputElement | HTMLTextAreaElement).value;
  let accepted = confirmedValue === value;
  let normalizedNote = "";
  if (!accepted) {
    // The naive `confirmedValue === value` check raises false alarms when the
    // component legitimately normalises the displayed value. Two common cases,
    // both meaning the value WAS accepted:
    //   (a) zero rendered as empty: a controlled field written `value={n || ""}`
    //       shows "" for 0, so writing "0" reads back "".
    //   (b) numeric coercion: a number input reformats "0.50" -> "0.5".
    const writtenNum = Number(value);
    const readNum = Number(confirmedValue);
    const isZeroWrite = value.trim() !== "" && writtenNum === 0;
    if (isZeroWrite && (confirmedValue === "" || readNum === 0)) {
      accepted = true;
      normalizedNote = confirmedValue === ""
        ? ` (wrote 0; field renders zero as empty, accepted as 0)`
        : "";
    } else if (
      confirmedValue !== "" &&
      !Number.isNaN(writtenNum) &&
      !Number.isNaN(readNum) &&
      writtenNum === readNum
    ) {
      accepted = true;
      normalizedNote = ` (normalised "${value}" → "${confirmedValue}")`;
    }
  }
  const matched = describeElement(input);
  const matchNote = `matched via ${kind}`;
  if (!accepted) {
    // Only escalate to trusted keystrokes once the native setter has
    // VERIFIABLY failed, not on the mere presence of a Workday-style marker.
    // The two are NOT interchangeable: on some anti-bot-hardened tenants
    // (S&P Global, PGIM) it's the OPPOSITE of the original Workday case —
    // the native setter lands fine and CDP keystrokes are what gets dropped.
    // Escalating unconditionally on the marker cost ~20 wasted tool calls
    // chasing the wrong fix on those tenants before this was caught (see
    // HINTS-REVIEW-2026-08-18.md #1/#4, ISSUE-2026-08-15-antibot-tenant-walls.md).
    const escalation = checkTrustedKeystrokeEscalation(input, textHint, ` (${matchNote})`);
    if (escalation) return escalation;
  }
  return {
    success: true,
    matched,
    message: accepted
      ? `Filled "${textHint}" → ${matched} (${matchNote})${normalizedNote}`
      : `Filled "${textHint}" → ${matched} (${matchNote}) — but value may not have been accepted by React (got back: "${confirmedValue.slice(0, 60)}")`,
  };
}

/**
 * Some component libraries' controlled-input state sometimes only registers
 * a REAL trusted keystroke sequence, not the native-setter + synthetic-event
 * path fillInput() otherwise uses — that path can still set input.value
 * correctly (visible on screen, execute_script confirms it) but the
 * framework's own validation model never sees it, so the field reads back as
 * required-but-empty only later, at step-transition (see
 * ISSUE-2026-08-11-workday-fill-input-not-binding.md).
 *
 * This is NOT a reliable per-platform rule, only a per-TENANT one: on other
 * anti-bot-hardened tenants running the SAME component library it's the
 * opposite — the native setter lands fine and CDP-dispatched keystrokes are
 * what gets silently dropped (see ISSUE-2026-08-15-antibot-tenant-walls.md's
 * S&P Global / PGIM cases). So this function is only ever called AFTER the
 * caller has already tried the native setter and read back a verified
 * mismatch — never on marker-presence alone. Escalating unconditionally on
 * the marker (the original design) cost ~20 wasted tool calls chasing the
 * wrong fix on tenants where the native setter was the one that actually
 * worked (HINTS-REVIEW-2026-08-18.md #1/#4).
 *
 * Still gated on Workday's own data-automation-id marker — a structural
 * framework signature, not a domain check, so it also covers non-
 * myworkdayjobs.com hosts running the same component library, and
 * generalises to any framework that stamps the same convention. Returns null
 * when no Workday marker is present. Returns a result to return immediately
 * otherwise — either the needsTrustedKeystrokes escalation signal (this
 * content script has no chrome.debugger access to type real keystrokes
 * itself, so the background handler that does must do it), or an explicit
 * failure when a marker was found but no stable selector could be derived to
 * hand off.
 */
function checkTrustedKeystrokeEscalation(
  input: HTMLInputElement | HTMLTextAreaElement,
  textHint: string,
  matchNote: string,
): { success: boolean; needsTrustedKeystrokes?: boolean; resolvedSelector?: string; matched?: string; message: string } | null {
  if (!input.closest("[data-automation-id]")) return null;
  const matched = describeElement(input);
  const resolvedSelector = canonicalSelector(input);
  if (!resolvedSelector) {
    return {
      success: false,
      matched,
      message: `"${textHint}" resolved to a Workday-style field (${matched}${matchNote}) — the native-setter fill didn't verifiably land, and this field's validation model may only register trusted keystrokes, but no stable selector (id/name/data-automation-id/aria-label/placeholder) could be derived to hand off to type_text. Fill it directly: type_text(into_selector="<selector for this field>", text="...", clear_first=true).`,
    };
  }
  return {
    success: false,
    needsTrustedKeystrokes: true,
    resolvedSelector,
    matched,
    message: `"${textHint}" resolved to a Workday-style field (${matched}${matchNote}) — the native-setter fill didn't verifiably land, escalating to trusted keystrokes (type_text).`,
  };
}

/**
 * A stable, single, re-queryable CSS selector for an already-resolved
 * element — needed so the background handler can hand the SAME element to
 * type_text's into_selector after fillInput found it by hint/label/fuzzy
 * matching (into_selector can't re-run that matching itself). Skips ids
 * that look auto-generated so a re-render between resolving here and the
 * background handler's follow-up query doesn't land on a stale/wrong node.
 *
 * Tries each candidate attribute in preference order and returns the first
 * one that resolves UNIQUELY back to `el` (verified via the same shadow-
 * piercing query the background handler's own into_selector resolution
 * uses) — a repeated form section (e.g. two "Address Line 1" fields for
 * Home/Mailing) can share an aria-label or placeholder with no id/name/
 * data-automation-id on the leaf input, and handing back an ambiguous
 * selector would let the background handler's fresh query land on the WRONG
 * field. Returns null rather than a selector we can't confirm is unique.
 */
function canonicalSelector(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  const looksHashed = (s: string) => s.length > 12 && /\d/.test(s) && /[a-z]/i.test(s) && !/[\s_-]/.test(s);
  const candidates: string[] = [];
  const id = el.id;
  if (id && !looksHashed(id)) { try { candidates.push(`#${CSS.escape(id)}`); } catch { candidates.push(`#${id}`); } }
  const name = el.getAttribute("name");
  if (name) candidates.push(`${tag}[name="${name.replace(/"/g, '\\"')}"]`);
  const automationId = el.getAttribute("data-automation-id");
  if (automationId) candidates.push(`${tag}[data-automation-id="${automationId.replace(/"/g, '\\"')}"]`);
  const aria = el.getAttribute("aria-label");
  if (aria) candidates.push(`${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`);
  const ph = el.getAttribute("placeholder");
  if (ph) candidates.push(`${tag}[placeholder="${ph.replace(/"/g, '\\"')}"]`);
  for (const candidate of candidates) {
    try {
      const matches = queryAllDeep<Element>(document, candidate);
      if (matches.length === 1 && matches[0] === el) return candidate;
    } catch { /* invalid selector from an unusual attribute value — skip */ }
  }
  return null;
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
    // inside web components (Stencil/Lit/Radix portals) are reachable.
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
  cmContent.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  cmContent.dispatchEvent(new Event("change", { bubbles: true }));
  targetEditor.scrollIntoView({ behavior: "smooth", block: "center" });

  return { success: true, message: `Filled CodeMirror editor "${lower}" with value` };
}

/**
 * Detect and fill a tiptap / ProseMirror editor. These render a contenteditable
 * surface inside a labelled wrapper, but the contenteditable itself rarely
 * carries aria-label or data-placeholder, so the generic findContentEditable
 * heuristic misses them on dense forms. Match on a labelled wrapper, then
 * fill via selectAll + insertText (the most React-compatible path).
 *
 * When only one ProseMirror editor exists and the hint doesn't match a label
 * yet, fall through to it (the "fill the prompt at the top" case — only one
 * tiptap editor on the page).
 */
function fillProseMirror(lower: string, value: string): { success: boolean; message: string; matched?: string } | null {
  const editors = queryAllDeep<HTMLElement>(
    document,
    '.ProseMirror, .tiptap, [data-tiptap-editor]'
  ).filter((el) => el.isContentEditable || el.querySelector('[contenteditable=true], .ProseMirror') !== null);
  if (editors.length === 0) return null;

  let target: HTMLElement | null = null;
  for (const ed of editors) {
    // Look for a matching label or heading anywhere in the labelled ancestor.
    let scope: Element | null = ed;
    for (let d = 0; d < 6 && scope && scope !== document.body; d++) {
      const labelText = scope.getAttribute?.("aria-label")?.toLowerCase() ?? "";
      if (labelText.includes(lower)) { target = ed; break; }
      const heading = scope.querySelector("label, h1, h2, h3, h4, h5, h6, legend, [class*='label'], [class*='heading']");
      const t = (heading?.textContent ?? "").toLowerCase().trim();
      if (t && t.includes(lower) && !ed.contains(heading as Node)) { target = ed; break; }
      scope = scope.parentElement;
    }
    if (target) break;
  }
  if (!target && editors.length === 1) target = editors[0];
  if (!target) return null;

  // Drill into the actual contenteditable surface (tiptap nests
  // .ProseMirror inside its wrapper, or the wrapper itself is the editable).
  const editable = (target.isContentEditable
    ? target
    : (target.querySelector<HTMLElement>('.ProseMirror[contenteditable=true], [contenteditable=true]') ?? target)) as HTMLElement;

  editable.focus();
  // selectAll then insertText is the path ProseMirror accepts; raw value-set
  // doesn't fire ProseMirror's input transactions.
  try { document.execCommand("selectAll"); } catch { /* ignore */ }
  try { document.execCommand("insertText", false, value); } catch { /* ignore */ }
  // Some hosts wrap the contenteditable in a React component that listens for
  // change/input on the OUTER node; fire both so both layers update.
  editable.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  editable.dispatchEvent(new Event("change", { bubbles: true }));
  if (editable !== target) {
    target.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }
  editable.scrollIntoView({ behavior: "smooth", block: "center" });
  const matched = describeElement(editable);
  return { success: true, message: `Filled "${lower}" → ${matched} (ProseMirror / tiptap)`, matched };
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
