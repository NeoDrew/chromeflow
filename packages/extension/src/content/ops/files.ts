import { queryAllDeep } from "../shadow.js";
import { markerIds } from "../../markers.js";
import { type SetFileFromContentMessage } from "../../connections.js";
import type { IncomingMessage } from "./frame-util.js";

// Common upload-widget phrasing, used only when the caller passed no hint (or
// the hint didn't match anything) — deliberately just a vocabulary of the
// phrases these widgets themselves render ("Drag and drop", "browse files",
// "Choose file"), not a site-specific class/attribute name, so it generalizes
// across whatever framework built the widget.
const DROP_ZONE_TEXT_RE = /drag.{0,10}(and )?drop|drop.{0,10}(file|here|zone)|browse.{0,10}(file|computer)|choose file|select file|upload.{0,15}(file|resume|document|cv)/i;

// Candidate tags for a drop-zone element: interactive-shaped elements plus
// generic div/span, since most of these widgets are custom-styled containers
// with no semantic role. Bounded (not "*") and length-capped in the caller so
// this doesn't tag some giant page-level wrapper whose text happens to
// contain a match.
const DROP_ZONE_SELECTOR = 'button, [role="button"], a, label, [class*="drop" i], [class*="upload" i], div, span';

/**
 * Locate a plausible drag-and-drop target for a page with zero <input
 * type=file> elements. Only called when window.showOpenFilePicker() exists
 * (see caller) — the two-part signal that a classic set_file_input can never
 * work here. Picks the SMALLEST visible element whose own text/aria-label
 * matches the hint (or, with no hint, common upload-widget phrasing), so a
 * match on a large ancestor wrapper doesn't win over the actual widget.
 */
function findDropZoneCandidate(hint: string): HTMLElement | null {
  const hintLower = hint.toLowerCase();
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const el of queryAllDeep<HTMLElement>(document, DROP_ZONE_SELECTOR)) {
    const ownText = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!ownText || ownText.length > 150) continue;
    const matches = hintLower ? ownText.toLowerCase().includes(hintLower) : DROP_ZONE_TEXT_RE.test(ownText);
    if (!matches) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) { best = el; bestArea = area; }
  }
  return best;
}

export function opTagFileInput(msg: IncomingMessage): unknown {
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
  //
  // Deliberately does NOT fold el.id into the initial label candidate (a
  // prior version did `aria-label || name || id`): an id is an
  // implementation detail, not human-readable label text, and since almost
  // every real input has SOME id, that OR-chain made `label` truthy before
  // the label[for=]/ancestor-text fallbacks below ever ran — silently
  // defeating them on any page where the file input's id doesn't happen to
  // contain the hint text (e.g. two sibling <spl-dropzone> inputs both
  // sharing id="file-input": every hint fails to match "file-input", so the
  // loop below never fires and this always fell through to "whichever file
  // input is first in the page", regardless of hint — see ISSUE-2026-09-12-
  // smartrecruiters-spl-dropzone-file-rejection.md). Exact id-as-hint
  // matching is already handled separately above (getElementById), so
  // nothing is lost by leaving id out of the label heuristic itself.
  if (!found) {
    for (const el of queryAllDeep<HTMLInputElement>(document, "input[type=file]")) {
      let label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
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
  const allFileInputs = queryAllDeep<HTMLInputElement>(document, "input[type=file]");
  // A non-empty hint that matched NOTHING above, on a page with 2+ file
  // inputs, is exactly the ambiguous case the CSS-selector path above
  // already refuses rather than silently guessing — apply the same refusal
  // here instead of falling through to "whichever input is first in the
  // page" (the SmartRecruiters bug: a resume-upload hint silently landed on
  // an unrelated avatar-photo input purely because it came first in
  // document order).
  if (!found && hintLower && allFileInputs.length > 1) {
    const describe = (el: HTMLInputElement) => el.id ? `#${el.id}` : (el.getAttribute("name") ?? el.getAttribute("aria-label") ?? "input[type=file]");
    return {
      type: "action_done",
      requestId: msg.requestId,
      found: false,
      message: `No file input's label matched "${msg.hint}", and this page has ${allFileInputs.length} file inputs — refusing to guess which one you meant rather than silently picking the first in document order. Candidates: ${allFileInputs.map(describe).join(", ")}. Retarget with an exact selector (e.g. hint="${describe(allFileInputs[0])}") once you've confirmed which one is the resume field via get_form_fields or interactive_snapshot.`,
    };
  }
  if (!found) found = allFileInputs[0] ?? null;

  if (!found) {
    // Zero file inputs ANYWHERE (light or shadow DOM) is a different failure
    // than "your hint didn't match one of several" — it means there is no
    // DOM element for CDP's DOM.setFileInputFiles to ever target, no matter
    // what hint is tried. The common cause is a widget built on the browser-
    // native File System Access API (window.showOpenFilePicker()) rather
    // than a classic <input type=file>.click() — see
    // ISSUE-2026-08-16-google-careers-no-file-input.md. Surface this
    // structurally so the caller stops retrying hints and reports/hands off
    // instead of burning calls on a widget with no automatable surface.
    const hasFileSystemAccessApi = typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
    // These widgets almost always wire a standard HTML5 drag-and-drop listener
    // onto the same clickable surface as a redundant/accessible upload path
    // (react-dropzone, Uppy, FilePond, and hand-rolled equivalents all do this)
    // — that path doesn't go through showOpenFilePicker() at all, so a drop
    // event can still deliver a file with no DOM input element in sight. Tag a
    // candidate drop-zone element so background.ts can attempt a CDP-level
    // Input.dispatchDragEvent delivery (see ISSUE-2026-09-07-tradinghub-no-
    // file-input.md).
    const dropZone = hasFileSystemAccessApi ? findDropZoneCandidate(hint) : null;
    if (dropZone) {
      const dropAttr = markerIds.dropZoneAttr();
      dropZone.setAttribute(dropAttr, "true");
      return {
        type: "action_done",
        requestId: msg.requestId,
        found: false,
        zero_file_inputs_on_page: true,
        drop_zone_tagged: true,
        drop_zone_attr: dropAttr,
        message: `No file input found matching "${msg.hint}", and there is no input[type=file] anywhere on the page — this widget most likely opens the browser-native file picker via window.showOpenFilePicker() (the File System Access API), which leaves no DOM element to target directly. Found a plausible drop-zone element instead; chromeflow will attempt a simulated drag-and-drop file delivery onto it. This only works with file_path (an on-disk path) — file_content/inline mode cannot use this fallback.`,
      };
    }
    return {
      type: "action_done",
      requestId: msg.requestId,
      found: false,
      zero_file_inputs_on_page: true,
      message: hasFileSystemAccessApi
        ? `No file input found matching "${msg.hint}", and there is no input[type=file] anywhere on the page (light or shadow DOM) — this is not a hint-matching problem. This widget most likely opens the browser-native file picker via window.showOpenFilePicker() (the File System Access API) instead of a classic file input, which leaves no DOM element for chromeflow to target, and no drag-and-drop zone could be found either. There is currently no automated way to supply a file to this kind of widget. Do not keep retrying with different hints; report this back, or ask the user to select the file manually.`
        : `No file input found matching "${msg.hint}", and there is no input[type=file] anywhere on the page (light or shadow DOM). Do not keep retrying with different hints; the target may be rendered later, behind an interaction, or the page may have no automatable upload surface at all.`,
    };
  }

  // Tag so CDP can target it by selector
  const attr = markerIds.fileTargetAttr();
  found.setAttribute(attr, "true");
  const desc = found.id ? `#${found.id}` : (found.getAttribute("name") ?? "input[type=file]");
  return { type: "action_done", requestId: msg.requestId, found: true, attr, matched_desc: desc, matched_via: "label/id" };
}

export function opUntagFileInput(msg: IncomingMessage): unknown {
  // Strips both marker attrs unconditionally — a given upload attempt only
  // ever sets one of the two (file input OR drop zone), so clearing both is
  // simpler than threading which path fired back into the untag call.
  for (const attr of [markerIds.fileTargetAttr(), markerIds.dropZoneAttr()]) {
    queryAllDeep(document, `[${attr}]`).forEach((el) => {
      el.removeAttribute(attr);
    });
  }
  return { type: "action_done", requestId: msg.requestId };
}

export function opDispatchFileChangeEvents(msg: IncomingMessage): unknown {
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
    // Plain Event, not InputEvent: per spec (and MDN's own input-event docs),
    // only elements that "accept text input" get InputEvent/inputType on
    // their input event. <input type=file> doesn't, so a real user's file
    // selection dispatches a plain Event here, not an InputEvent — using
    // InputEvent would itself be the detectable-synthetic-event signature
    // this hardening pass exists to remove.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { type: "action_done", requestId: msg.requestId, found: true };
  }
  return { type: "action_done", requestId: msg.requestId, found: false };
}

export function opSetFileFromContent(msg: IncomingMessage): unknown {
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
  // Plain Event here too — see opDispatchFileChangeEvents above for why
  // <input type=file> never gets a real InputEvent for its input event.
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return { type: "action_done", requestId: msg.requestId, found: true, name: m.fileName };
}
