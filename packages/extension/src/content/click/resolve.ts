import { queryAllDeep } from "../shadow.js";

/**
 * Snapshot the enabled-state signals of an element in one pass. Returns ALL
 * four fields the user's runbook says agents should read together: native
 * `disabled` property, `aria-disabled` attribute, computed `pointer-events`,
 * computed `opacity`. The `visible` field is true when the element is rendered
 * (non-zero rect, not display:none/visibility:hidden/opacity:0). Surfaced via
 * `prepareClickTarget` so a single `click_element` call carries enough info
 * for the agent to decide between "disabled is transient, wait" and "disabled
 * is permanent, find the missing field".
 */
export function readDisabledState(el: Element): {
  disabled: boolean;
  aria_disabled: string | null;
  pointer_events: string;
  opacity: string;
  visible: boolean;
} {
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    disabled: !!(el as HTMLButtonElement).disabled,
    aria_disabled: el.getAttribute("aria-disabled"),
    pointer_events: cs.pointerEvents || "auto",
    opacity: cs.opacity || "1",
    visible: (rect.width > 0 && rect.height > 0) && cs.display !== "none" && cs.visibility !== "hidden",
  };
}

/**
 * Produce a one-line description of an alternative match — used in error
 * messages when the matcher had to fall back to a 0×0/hidden candidate but a
 * visible peer existed. Format: `"Save" button at (1180, 740, 54×40)`.
 */
export function describeCandidate(el: Element, hint: string): string {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const text =
    ((el as HTMLElement).innerText || el.textContent || el.getAttribute("aria-label") || hint)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  return `"${text}" ${tag} at (${Math.round(rect.left)}, ${Math.round(rect.top)}, ${Math.round(rect.width)}×${Math.round(rect.height)})`;
}

/**
 * Resolve a clicked element to the underlying radio/checkbox input, if any.
 * Handles both the matched-element-is-input case and the matched-element-is-
 * label-of-input case (label[for=...] or label-wrapping-input).
 */
export function resolveCheckableInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    return el;
  }
  if (el instanceof HTMLLabelElement) {
    if (el.htmlFor) {
      const target = el.ownerDocument.getElementById(el.htmlFor);
      if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
        return target;
      }
    }
    const inner = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (inner instanceof HTMLInputElement) return inner;
  }
  return null;
}

/**
 * Resolve a clicked <label> to the actual form control it activates, for
 * TEXT-LIKE labelable controls — anything other than radio/checkbox, which
 * resolveCheckableInput above already handles separately (a label's whole
 * area unambiguously activates exactly one checkbox/radio, so there's
 * nothing to redirect there). A label's OWN bounding box can visually span
 * more than just its own control — a shared caption sitting above a multi-
 * field row (e.g. one "Phone number" label captioning BOTH a country-code
 * select and the number input together) is a real, reproduced case — so a
 * coordinate-based click anywhere within the label's rect can land on a
 * completely different sibling field even though the label's for= /
 * wrapping correctly points at the right control. Redirecting to the
 * control's own (necessarily single-field) rect avoids that ambiguity
 * entirely. See ISSUE-2026-09-12-smartrecruiters-spl-dropzone-file-
 * rejection.md §3.5.
 */
export function resolveLabelledControl(el: Element): HTMLElement | null {
  if (!(el instanceof HTMLLabelElement)) return null;
  let control: Element | null = null;
  if (el.htmlFor) {
    control = el.ownerDocument.getElementById(el.htmlFor);
  }
  if (!control) {
    control = el.querySelector("input, select, textarea");
  }
  if (!control) return null;
  if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
    return null; // resolveCheckableInput's job, not this one
  }
  return control instanceof HTMLElement ? control : null;
}

/**
 * Collect every candidate matching `lower`, then split into visible and
 * hidden buckets. The caller prefers visible — a hidden element (display:none,
 * [hidden] attr, 0×0 dimensions, aria-hidden) only wins if no visible peer
 * has the same text-strength.
 *
 * Without this split, an exact-text match on a hidden flair-dropdown item
 * outranks a partial-text match on the actually-visible submit button on
 * Reddit's new submit page.
 */
export function findClickableAll(lower: string, scope: Document | Element = document): { visible: Element[]; hidden: Element[] } {
  // [tabindex="-1"] deliberately excluded: that value is the well-known
  // "programmatically focusable, not part of tab order" convention, used to
  // move focus onto a heading/panel/container after a route change for
  // screen-reader announcement -- not a signal that the element handles
  // clicks. Including it let a page's own section heading (tabindex="-1",
  // exact-text match on the button's own label, e.g. an <h3>Create
  // Account</h3> title above a "Create Account" button) win the tier-1
  // exact-text slot over the button's real click target, since headings are
  // visible while Workday's own decoy <button aria-hidden="true"> holding
  // the matching text is not -- see ISSUE-2026-09-15-workday-click-filter-
  // decoy-button-textHint-mismatch.md, confirmed live via captured
  // isTrusted click events landing on the heading instead of either
  // candidate button. tabindex="0" and positive values are unaffected -- those
  // genuinely mean "part of the interactive tab sequence" and must keep
  // matching custom-interactive elements with no button/role attribute.
  //
  // `label` narrowed to `label[for], label:has(...)`: a bare <label> with no
  // `for` and no wrapped form control isn't activating anything -- it's
  // text/UI chrome mislabeled with a form element for styling reasons. Same
  // investigation caught a wizard's own step-breadcrumb (`<li><label>Create
  // Account/Sign In</label></li>` inside the step <ol>, no `for`, wraps no
  // control) partial-text-matching and winning once the heading above was
  // excluded. A real label activates its control on click; requiring that
  // relationship excludes exactly the cases that don't.
  const interactiveSelectors =
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], input[type="submit"], input[type="button"], label[for], label:has(input, select, textarea), [onclick], [tabindex]:not([tabindex="-1"])';

  // ONE shadow-pierced tree walk over the union of every selector the tiers
  // below need, instead of 4 separate queryAllDeep passes. On a page with
  // 1000+ shadow hosts (LinkedIn) each pass cost 50-150ms, so collapsing
  // 4 -> 1 saves ~200-600ms per text-hint click. The per-tier element SETS are
  // preserved exactly by re-testing each candidate with el.matches(...) (O(1),
  // no tree traversal) so ranking/ordering is byte-for-byte identical.
  const candidates = queryAllDeep(scope, interactiveSelectors + ", [aria-label], [title], [data-testid]");
  const ranked: Element[] = [];
  // Track which label-strength tier each candidate came from so the visual
  // sort below preserves "exact match beats partial" while still ordering
  // ties by reading position. Tier: 1=exact text, 2=partial text, 3=aria,
  // 4=input value, 5=title/data-testid.
  const tier: Map<Element, number> = new Map();

  function addIfNew(el: Element, t: number) {
    if (!ranked.includes(el)) {
      ranked.push(el);
      tier.set(el, t);
    }
  }

  // Exact text matches (interactive elements only — matches the original
  // text-tier candidate set, which was interactiveSelectors-scoped).
  candidates.forEach((el) => {
    if (el.matches(interactiveSelectors) && el.textContent?.toLowerCase().trim() === lower) addIfNew(el, 1);
  });

  // Partial text matches (sorted shortest first for specificity), deduplicated
  const partials = candidates
    .filter((el) => el.matches(interactiveSelectors) && !ranked.includes(el) && el.textContent?.toLowerCase().includes(lower))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  partials.forEach((el) => addIfNew(el, 2));

  // aria-label matches (any element with an aria-label)
  candidates.forEach((el) => {
    if (el.getAttribute("aria-label")?.toLowerCase().includes(lower)) addIfNew(el, 3);
  });

  // value attribute (input[type=submit], input[type=button])
  candidates.forEach((el) => {
    if (el.matches("input[type=submit], input[type=button]") && (el as HTMLInputElement).value?.toLowerCase().includes(lower)) addIfNew(el, 4);
  });

  // title / data-testid
  candidates.forEach((el) => {
    const v = el.getAttribute("title") ?? el.getAttribute("data-testid") ?? "";
    if (v.toLowerCase().includes(lower)) addIfNew(el, 5);
  });

  const visible: Element[] = [];
  const hidden: Element[] = [];
  for (const el of ranked) {
    if (isVisibleAndUsable(el)) visible.push(el);
    else hidden.push(el);
  }

  // Reorder visible candidates by visual reading order WITHIN the same
  // label-strength tier (and, for partial matches, same textContent length).
  // Without this, nth picks the next candidate in DOM-tree-traversal order —
  // and across multiple shadow hosts, DOM order doesn't match visual top-to-
  // bottom. The canonical failure mode is four "Confirmed" radios stacked in
  // separate shadow-rooted cards: tier-1-exact all match, length is identical,
  // and nth=2 winds up landing on the wrong card. Visual sort fixes that.
  visible.sort((a, b) => {
    const ta = tier.get(a) ?? 99;
    const tb = tier.get(b) ?? 99;
    if (ta !== tb) return ta - tb;
    if (ta === 2) {
      // Partial-text tier still tiebreaks on length (more specific wins).
      const la = a.textContent?.length ?? 0;
      const lb = b.textContent?.length ?? 0;
      if (la !== lb) return la - lb;
    }
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    // Round y to 10px buckets so sub-pixel wobble doesn't flip the order.
    const ya = Math.round(ra.top / 10) * 10;
    const yb = Math.round(rb.top / 10) * 10;
    if (ya !== yb) return ya - yb;
    return ra.left - rb.left;
  });

  return { visible, hidden };
}

/**
 * Compatibility shim for the synthetic-click path. Returns the nth match
 * preferring visible candidates first, falling back to hidden if none
 * visible are available.
 */
export function findClickable(lower: string, nth: number = 1): Element | null {
  const { visible, hidden } = findClickableAll(lower);
  const merged = [...visible, ...hidden];
  if (merged.length === 0) return null;
  return merged[nth - 1] ?? merged[merged.length - 1];
}

/**
 * Returns true if the element is actually rendered to the user:
 * - element AND all ancestors must not have [hidden], display:none,
 *   visibility:hidden, or opacity:0
 * - element must have non-zero bounding rect OR non-zero offsetWidth/Height
 * - aria-hidden=true on element or any ancestor disqualifies
 *
 * This is stricter than the old `isUsable` (which only checked the element's
 * own computed style and missed [hidden], ancestor display:none, and 0×0).
 * Without the ancestor walk, a hidden flair-dropdown item passed `isUsable`
 * and got picked over the actually-visible submit button on Reddit.
 */
export function isVisibleAndUsable(el: Element): boolean {
  // Walk ancestors for the obvious DOM-attribute and computed-style killers.
  for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    if (cur.hasAttribute("hidden")) return false;
    if (cur.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(cur);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden") return false;
    if (cs.opacity === "0") return false;
  }
  if ((el as HTMLButtonElement).disabled) return false;
  // 0×0 dimensions: triple-check (bounding-rect, offset, getClientRects). An
  // element clipped by an overflow:hidden scroll container still reports
  // non-zero offsetWidth/Height, so clipped-but-clickable elements pass.
  const rect = el.getBoundingClientRect();
  const htmlEl = el as HTMLElement;
  if (
    rect.width === 0 && rect.height === 0 &&
    !htmlEl.offsetWidth && !htmlEl.offsetHeight &&
    el.getClientRects().length === 0
  ) {
    return false;
  }
  return true;
}

/**
 * Find the smallest section-like container whose heading text starts with
 * `needle`. Used by `near_text` to scope click candidates without needing a
 * stable CSS selector. Pierces shadow roots.
 */
export function findSectionByHeading(needle: string): Element | null {
  const lower = needle.toLowerCase().trim();
  const headings = queryAllDeep(document, "h1, h2, h3, h4, h5, h6, [role='heading'], legend");
  for (const h of headings) {
    const text = (h.textContent ?? "").trim().toLowerCase();
    if (!text.startsWith(lower)) continue;
    const container = h.closest("section, fieldset, article, form, div, main, aside") ?? h.parentElement;
    if (container) return container;
  }
  return null;
}
