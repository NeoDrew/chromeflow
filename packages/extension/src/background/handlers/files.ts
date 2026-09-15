// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript } from "../state";
import { withDebugger, pierceFileCount, pierceFilePoll, findShadowMarkedBackendNodeId, freshTargetPoint, dispatchDragDropFile } from "../cdp";
import { SET_FILE_FROM_CONTENT } from "../../connections";

export async function handleSetFileInput(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const frame = msg.frame as string | undefined;

      // Ask content script to find and tag the file input. The content script
      // uses queryAllDeep, which pierces open AND closed shadow roots — file
      // inputs hidden behind Stencil/Lit/Radix drag-zones are reachable.
      // frame (optional): same-origin iframe CSS selector, mirroring find_input/
      // fill_input/get_form_fields/click_element's existing frame param — see
      // ISSUE-2026-09-14-icims-hcaptcha-still-silent.md, where the resume-upload
      // widget lived inside a same-origin iframe set_file_input had no way to
      // reach at all.
      const tagResult = await forwardToContentScript(tab, {
        type: "tag_file_input",
        requestId: msg.requestId,
        hint: msg.hint,
        frame,
      }) as { found: boolean; message?: string; attr?: string; matched_desc?: string; matched_via?: string; zero_file_inputs_on_page?: boolean; drop_zone_tagged?: boolean; drop_zone_attr?: string; frame_error?: string };

      if (tagResult.frame_error) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: tagResult.frame_error };
      }
      if (!tagResult.found) {
        // No <input type=file> anywhere, but a drop-zone candidate was tagged
        // AND we have a real on-disk path — CDP drag delivery needs a path,
        // not bytes, so inline-content mode can't use this fallback. Attempt
        // it instead of failing outright.
        if (tagResult.zero_file_inputs_on_page && tagResult.drop_zone_tagged && tagResult.drop_zone_attr && typeof msg.filePath === "string" && msg.filePath) {
          return await handleDropZoneFileUpload(tab, msg, tagResult.drop_zone_attr);
        }
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: false,
          message: tagResult.message ?? "No file input found",
          ...(tagResult.zero_file_inputs_on_page ? { zero_file_inputs_on_page: true } : {}),
        };
      }

      const tabId = tab.id!;
      const fileAttr = tagResult.attr ?? "data-cf-file";
      // Inline-content mode (feature 4): when fileContent is supplied the bytes
      // come from the caller (no local path), and the committed filename is
      // msg.fileName. Path mode keeps deriving the name from msg.filePath.
      const inlineContent = typeof msg.fileContent === "string" && (msg.fileContent as string).length > 0;
      const filename = inlineContent
        ? ((msg.fileName as string | undefined) ?? "")
        : ((msg.filePath as string).split("/").pop() ?? "");
      const waitMs = (msg.waitMs as number | undefined) ?? 3000;
      const verifySelector = msg.verifySelector as string | undefined;

      // Snapshot the page-level file count BEFORE we attach. This is the
      // single most useful signal that the upload landed: if the page shows
      // 4 file inputs with 0 files total before, and 1 file after, the
      // upload committed. Inputs that are visually hidden (drag-and-drop
      // zones) count too.
      //
      // The inline queryAllDeep helper pierces open and closed shadow roots
      // via chrome.dom.openOrClosedShadowRoot. Without it, file inputs nested
      // inside web-component shadow DOM are invisible to the count.
      const pre = await chrome.scripting.executeScript({
        target: { tabId },
        func: pierceFileCount,
        args: [frame ?? ""],
      });
      const preTotal = (pre[0]?.result as { totalFiles: number; inputCount: number } | undefined)?.totalFiles ?? 0;

      // Shared poll: waits up to waitMs for one of two signals (file count
      // increase, or verifySelector match), and separately tracks the
      // "consumed then cleared with no confirmation" signature so the
      // caller can decide whether to escalate. Used for both the initial
      // attempt and, if needed, the trusted-drop retry below — extracted so
      // neither copy can drift from the other.
      // Grace window watched AFTER a count-increase "commit" for a delayed
      // rejection signal (see below) — not applied to a verifySelector match,
      // which is caller-supplied and already trustworthy.
      const REJECTION_GRACE_MS = 2000;
      // Symmetric grace window for the OPPOSITE timing failure: some ATS
      // widgets (Workday's resume-parsing "Autofill with Resume" step,
      // confirmed live 2026-09-15 on ntrs.wd1 -- the page didn't render
      // "Successfully Uploaded!" until ~4-6s after delivery) take longer
      // than the default waitMs to confirm a consumed-but-unconfirmed file.
      // Reporting failure at that point is a false negative that tells the
      // caller "do NOT trust this, verify before retrying" -- if the caller
      // (a real agent session) retries on seeing that, the retry delivers a
      // second, genuinely duplicate file on top of the first upload that
      // was silently fine all along. Extend patience specifically for this
      // ambiguous case rather than raising the base waitMs for every upload
      // (most sites confirm well within the default; this grace only fires
      // for the slow, already-ambiguous tail).
      const CONFIRM_GRACE_MS = 4000;

      const pollForCommit = async (): Promise<{
        committed: boolean; consumed: boolean; consumedUnconfirmed: boolean;
        postTotal: number; verifyMatched: boolean; commitRejectedMessage: string | null;
      }> => {
        const pollStart = Date.now();
        let committed = false;
        let consumed = false;
        let consumedUnconfirmed = false;
        let postTotal = preTotal;
        let verifyMatched = false;
        let filenameEverVisible = false;
        let commitRejectedMessage: string | null = null;

        while (Date.now() - pollStart < waitMs) {
          await new Promise((r) => setTimeout(r, 200));

          const post = await chrome.scripting.executeScript({
            target: { tabId },
            func: pierceFilePoll,
            args: [filename, verifySelector ?? "", frame ?? ""],
          });
          const result = post[0]?.result as { total: number; stillHasOurFile: boolean; verifyOk: boolean; filenameVisible: boolean; rejectionSignal: string | null } | undefined;
          if (!result) continue;

          postTotal = result.total;
          verifyMatched = result.verifyOk;
          if (result.filenameVisible) filenameEverVisible = true;

          if (verifyMatched) { committed = true; break; }
          if (postTotal > preTotal) {
            committed = true;
            // A count increase alone isn't proof the page actually accepted
            // the file: some ATS widgets (Phenom, confirmed live 2026-09-14
            // on careers.qbe.com — see
            // ISSUE-2026-09-14-phenom-cv-upload-still-rejected.md) accept it
            // immediately, then reject it moments later via async
            // validation, rendering a role=alert/aria-live error near the
            // input. Ignore whatever rejection text was ALREADY on the page
            // at commit time (unrelated pre-existing content) and watch only
            // for one that's new/changed since — a short bounded window, not
            // the full waitMs budget, since the report's own evidence is
            // that the error renders quickly once it does appear.
            const baselineSignal = result.rejectionSignal;
            const graceStart = Date.now();
            while (Date.now() - graceStart < REJECTION_GRACE_MS) {
              await new Promise((r) => setTimeout(r, 300));
              const grace = await chrome.scripting.executeScript({
                target: { tabId },
                func: pierceFilePoll,
                args: [filename, verifySelector ?? "", frame ?? ""],
              });
              const graceResult = grace[0]?.result as { rejectionSignal: string | null } | undefined;
              if (graceResult?.rejectionSignal && graceResult.rejectionSignal !== baselineSignal) {
                commitRejectedMessage = graceResult.rejectionSignal;
                break;
              }
            }
            break;
          }
          // Some uploaders consume the file: read it from .files and reset the
          // input (a File object moved into the framework's own state — a
          // common, legitimate pattern). But that alone is NOT proof the file
          // was accepted: a widget can equally read-then-discard on rejection
          // (see ISSUE-2026-08-15-antibot-tenant-walls.md Class B). Require the
          // filename to have shown up SOMEWHERE on the page (this tick or an
          // earlier one) before trusting "consumed" as success.
          if (!result.stillHasOurFile && Date.now() - pollStart > 400) {
            if (filenameEverVisible) {
              committed = true;
              consumed = true;
              break;
            }
            consumedUnconfirmed = true; // keep polling — a late confirmation, or verifySelector/total, may still land
          }
        }

        // The main loop timed out still ambiguous — give it one more bounded
        // window before finalizing as a failure. Only fires for the already-
        // ambiguous case (consumed, never confirmed), so fast/normal uploads
        // are unaffected.
        if (consumedUnconfirmed && !committed) {
          const graceStart = Date.now();
          while (Date.now() - graceStart < CONFIRM_GRACE_MS) {
            await new Promise((r) => setTimeout(r, 300));
            const post = await chrome.scripting.executeScript({
              target: { tabId },
              func: pierceFilePoll,
              args: [filename, verifySelector ?? "", frame ?? ""],
            });
            const result = post[0]?.result as { total: number; filenameVisible: boolean; verifyOk: boolean } | undefined;
            if (!result) continue;
            if (result.verifyOk) { committed = true; verifyMatched = true; postTotal = result.total; break; }
            if (result.total > preTotal) { committed = true; postTotal = result.total; break; }
            if (result.filenameVisible) { committed = true; consumed = true; break; }
          }
          // A late confirmation here means the upload was fine all along, just
          // slow to render — clear the ambiguity flag so the caller's
          // escalation check (which only looks at consumedUnconfirmed, not
          // committed) doesn't fire a redundant second delivery on top of an
          // upload that already landed.
          if (committed) consumedUnconfirmed = false;
        }
        return { committed, consumed, consumedUnconfirmed, postTotal, verifyMatched, commitRejectedMessage };
      };

      // Use Chrome DevTools Protocol to set the file — the only way to bypass
      // the browser's script restriction on file inputs. Lookup goes through
      // DOM.getDocument({pierce: true}) so we can reach shadow-rooted inputs
      // (Runtime.evaluate's document.querySelector is MAIN-world and doesn't
      // pierce open OR closed shadow boundaries). The tag stays on the input
      // until the very end of this function now (not cleaned up immediately
      // after the first delivery attempt) — a retry below needs it to still
      // be resolvable via freshTargetPoint if the first attempt's poll comes
      // back as a silent accept-then-clear rejection.
      let escalatedNote = "";
      let retriedViaDragDrop = false;
      let pollResult: { committed: boolean; consumed: boolean; consumedUnconfirmed: boolean; postTotal: number; verifyMatched: boolean; commitRejectedMessage: string | null } = {
        committed: false, consumed: false, consumedUnconfirmed: false, postTotal: preTotal, verifyMatched: false, commitRejectedMessage: null,
      };
      try {
        if (inlineContent) {
          // Inline-content path: hand the base64 bytes to the content script,
          // which reconstructs a File and assigns it via DataTransfer on the
          // already-tagged input (pierce-aware), then dispatches its own
          // change/input events. No CDP DOM.setFileInputFiles — there is no
          // local file for CDP to point at.
          await forwardToContentScript(tab, {
            type: SET_FILE_FROM_CONTENT,
            attr: fileAttr,
            fileContent: msg.fileContent as string,
            fileName: filename,
            mimeType: msg.mimeType as string | undefined,
            frame,
          }).catch(() => {});
        } else {
          await withDebugger(tabId, async () => {
            // findShadowMarkedBackendNodeId already pierces same-origin iframes
            // (via CDP DOM.getDocument({pierce:true})'s contentDocument walk),
            // so no frame-specific handling is needed here — the marker
            // attribute set by tag_file_input above is enough regardless of
            // which document it landed in.
            const backendNodeId = await findShadowMarkedBackendNodeId(tabId, fileAttr);
            if (!backendNodeId) throw new Error("Could not locate tagged file input via CDP");

            await (chrome.debugger as any).sendCommand({ tabId }, "DOM.setFileInputFiles", {
              backendNodeId,
              files: [msg.filePath],
            });
          });

          // Dispatch change + input events from the content script so the
          // pierce-aware queryAllDeep can find the tagged input. Doing this from
          // CDP Runtime.evaluate would silently no-op on closed-shadow-rooted
          // inputs.
          await forwardToContentScript(tab, {
            type: "dispatch_file_change_events",
            requestId: msg.requestId + "-dispatch",
            attr: fileAttr,
            frame,
          }).catch(() => {});
        }

        let result = await pollForCommit();

        // Escalate to the more trusted CDP drag-drop delivery (Input.
        // dispatchDragEvent — a REAL, isTrusted=true drop, not a synthetic
        // in-page change/input dispatch) when the normal path's own signature
        // for "silently rejected" fires: accepted then cleared, no filename
        // ever surfaced, no count increase. This was previously ONLY used
        // when zero <input type=file> existed anywhere on the page; some
        // hardened upload widgets discard a JS-dispatched change/input event
        // even on a REAL, found input (confirmed independently on both
        // Personio and SmartRecruiters the same day — see ISSUE-2026-09-12-
        // personio-cv-upload-rejection.md and ISSUE-2026-09-12-
        // smartrecruiters-spl-dropzone-file-rejection.md), so the escalation
        // is keyed on the structural signature, not on "no input exists".
        // Inline-content mode can't use this (dispatchDragDropFile needs a
        // real on-disk path for CDP to point at).
        if (result.consumedUnconfirmed && !inlineContent && typeof msg.filePath === "string" && msg.filePath) {
          // visibleAncestorFallback: the tagged element here is the real
          // <input type=file> itself (found by opTagFileInput), which on
          // dropzone-style widgets (Personio, SmartRecruiters, most
          // react-dropzone/Uppy/FilePond builds) is routinely hidden
          // (display:none or a 0-size clip rect) behind a styled wrapper.
          // Without this, freshTargetPoint returns null for every such
          // widget and the escalation silently never fires, confirmed via
          // ISSUE-2026-09-14-personio-cv-upload-still-rejected.md (no
          // "trusted drag-and-drop retry" note ever appeared in the tool
          // response). Climbing to the nearest visible ancestor gives CDP's
          // drag-drop a real pixel to target, matching where a human's OS
          // drop would actually land.
          const point = await freshTargetPoint(tabId, fileAttr, { visibleAncestorFallback: true, frame });
          if (point) {
            retriedViaDragDrop = true;
            await dispatchDragDropFile(tabId, point.x, point.y, msg.filePath as string);
            const retryResult = await pollForCommit();
            if (retryResult.committed) {
              escalatedNote = " (escalated to a trusted drag-and-drop delivery after the first attempt was silently rejected)";
            }
            result = retryResult.committed ? retryResult : result;
          }
        }

        pollResult = result;
      } finally {
        // Clean up the tag regardless of success/failure — now that any
        // retry has had its chance to use it.
        await forwardToContentScript(tab, {
          type: "untag_file_input",
          requestId: msg.requestId,
          frame,
        }).catch(() => {});
      }

      const { committed, consumed, consumedUnconfirmed, postTotal, verifyMatched, commitRejectedMessage } = pollResult;

      const noteParts: string[] = [];
      if (tagResult.matched_desc) {
        noteParts.push(`targeted ${tagResult.matched_desc}${tagResult.matched_via ? ` (via ${tagResult.matched_via})` : ""}`);
      }
      noteParts.push(`page-level file count: ${preTotal} → ${postTotal}`);
      if (verifySelector) noteParts.push(`verifySelector "${verifySelector}" ${verifyMatched ? "matched" : "did not match"}`);
      if (consumed) noteParts.push("file was consumed by the page (input was reset) and the filename appeared on the page, confirming it landed");
      const note = noteParts.join("; ");

      if (committed && commitRejectedMessage) {
        // The file count increased (or verifySelector matched) — normally
        // enough to call this a success — but a role=alert/aria-live
        // rejection appeared shortly after that wasn't there at commit time.
        // A real accept doesn't get retroactively un-accepted, so this beats
        // the earlier positive signal rather than being appended as a
        // secondary note (same "a later negative signal overrides a stale
        // positive one" principle already applied to click_element's
        // native-dialog-vs-until_* fix this session — see
        // ISSUE-2026-09-14-phenom-cv-upload-still-rejected.md).
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: false,
          commit_then_rejected: true,
          message: `File "${filename}" was initially accepted (${note}) but the page then showed a rejection: "${commitRejectedMessage}". Do NOT trust the initial file-count increase as success — treat this as a failed upload. If this looks like a size/type/format issue, verify the file meets the page's stated requirements before retrying.`,
        };
      }
      if (committed) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: true,
          message: `File "${filename}" uploaded — ${note}${escalatedNote}`,
        };
      }
      if (consumedUnconfirmed) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: false,
          consumed_unconfirmed: true,
          message: `File "${filename}" was accepted by the input then immediately cleared (input was reset), but the filename never appeared anywhere on the page and no file-count increase or verifySelector match was observed within ${waitMs}ms — ${note}. This looks like a silent rejection, not a successful upload (seen on react-dropzone-style widgets that read-then-discard on tenant-level rejection).${retriedViaDragDrop ? " A trusted drag-and-drop retry was also attempted and saw the same result." : ""} Do NOT trust this as landed; verify with get_page_text/take_screenshot before retrying or reporting to the user.`,
        };
      }
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: false,
        message: `File "${filename}" set on input but the page did not show an observable change within ${waitMs}ms — ${note}. The page may have rejected the upload (size, type, format), or the change handler may be slower than the wait window. Use verifySelector or get_page_text to confirm.`,
      };
}

// Fallback path for widgets with zero <input type=file> anywhere (built on
// window.showOpenFilePicker() — see content/ops/files.ts's
// findDropZoneCandidate). Delivers the file via a simulated OS-level drag-
// and-drop onto the tagged drop-zone element instead of DOM.setFileInputFiles,
// since there's no DOM input to point that at.
async function handleDropZoneFileUpload(tab: chrome.tabs.Tab, msg: McpMsg, dropZoneAttr: string): Promise<unknown> {
  const tabId = tab.id!;
  const filePath = msg.filePath as string;
  const filename = filePath.split("/").pop() ?? "";
  const waitMs = (msg.waitMs as number | undefined) ?? 3000;
  const verifySelector = msg.verifySelector as string | undefined;
  const frame = msg.frame as string | undefined;

  try {
    const point = await freshTargetPoint(tabId, dropZoneAttr, { frame });
    if (!point) {
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: false,
        message: `Located a drop-zone candidate but it disappeared before its coordinates could be read. The page may render its upload widget lazily — try again once it's visible.`,
      };
    }
    await dispatchDragDropFile(tabId, point.x, point.y, filePath);
  } finally {
    await forwardToContentScript(tab, { type: "untag_file_input", requestId: msg.requestId, frame }).catch(() => {});
  }

  // Deliberately NOT pierceFilePoll (the shadow-piercing helper the normal
  // input-based path above uses): empirically, injecting it via
  // chrome.scripting.executeScript in THIS call pattern silently returned no
  // result on every poll tick (confirmed 0/3 across 3s/7s/15s waits, logged
  // via a temporary in-page console probe on 2026-09-09) even though the page
  // had visibly updated within milliseconds — while this plain, non-shadow-
  // piercing check succeeded 3/3. Root cause not fully isolated (suspected:
  // chrome.dom.openOrClosedShadowRoot behaving differently for a function
  // re-injected repeatedly in a tight loop vs. pierceFilePoll's proven call
  // site in the input-based path above), so the pragmatic fix is a simpler
  // check rather than a herculean chase into an intermittent extension-API
  // edge case. Trade-off: a drop-zone widget that renders its post-upload
  // filename/thumbnail ONLY inside a shadow root won't be detected here even
  // though input-based uploads on shadow-rooted inputs still work fine above.
  const pollStart = Date.now();
  let committed = false;
  let verifyMatched = false;
  while (Date.now() - pollStart < waitMs) {
    await new Promise((r) => setTimeout(r, 200));

    // Safety net: an unhandled HTML5 drop (the drop-zone candidate had no
    // real dragover/drop listener wired at all — findDropZoneCandidate is a
    // text-match heuristic, not proof of a working drop target) falls
    // through to the browser's own native default action for a dropped
    // file, which is to open it as its own navigation. A web-origin page
    // can't script-navigate itself to file://, so Chrome instead opens a
    // NEW tab pointed at file://<the path we just tried to drop> — real,
    // reproduced: ISSUE-2026-09-12-successfactors-dragdrop-fallback-
    // navigates-to-file-url.md. The poll below only ever looks at THIS tab's
    // text, so it was structurally blind to a stray sibling tab; check for
    // one on every tick instead of waiting out the full timeout first.
    const hijack = await detectAndCleanUpFileUrlHijack(tab, filename);
    if (hijack) {
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: false,
        spurious_file_navigation: true,
        message: hijack.sameTab
          ? `The drop was never handled by any real drop target on the page — the ORIGINAL tab itself navigated to "${hijack.url}" (Chrome's native fallback for an unconsumed file drop). The drop-zone candidate chromeflow found almost certainly has no real drag-and-drop handler wired. Navigate back to the application page (form state may be lost) and retry with a more specific hint, or report that this page has no automatable upload surface.`
          : `The drop was never handled by any real drop target on the page — a NEW tab opened at "${hijack.url}" (Chrome's native fallback for an unconsumed file drop; it has been closed automatically). The original tab and its form state are intact, but the drop-zone candidate chromeflow found almost certainly has no real drag-and-drop handler wired. Retry with a more specific hint, or report that this page has no automatable upload surface.`,
      };
    }

    const post = await chrome.scripting.executeScript({
      target: { tabId },
      func: (name: string, sel: string) => {
        const bodyText = document.body ? (document.body.textContent ?? "") : "";
        const filenameVisible = name ? bodyText.includes(name) : false;
        const verifyOk = sel ? document.querySelectorAll(sel).length > 0 : false;
        return { verifyOk, filenameVisible };
      },
      args: [filename, verifySelector ?? ""],
    });
    const result = post[0]?.result as { verifyOk: boolean; filenameVisible: boolean } | undefined;
    if (!result) continue;
    if (result.verifyOk || result.filenameVisible) { committed = true; verifyMatched = result.verifyOk; break; }
  }

  const note = `delivered via simulated drag-and-drop onto a located drop zone (no DOM file input existed on this page)${verifySelector ? `; verifySelector "${verifySelector}" ${verifyMatched ? "matched" : "did not match"}` : ""}`;
  if (committed) {
    return { type: "action_done", requestId: msg.requestId, success: true, message: `File "${filename}" uploaded — ${note}.` };
  }
  return {
    type: "action_done",
    requestId: msg.requestId,
    success: false,
    message: `File "${filename}" was dropped onto a located drop zone but the page did not show an observable change within ${waitMs}ms (no filename text appeared${verifySelector ? ", verifySelector did not match" : ""}). The drop may have been rejected, or the drop-zone candidate chromeflow found may not be this widget's actual drop target — verify with get_page_text/take_screenshot before retrying.`,
  };
}

// Detects the "unhandled drop fell through to Chrome's native open-file
// action" failure mode: a sibling (or the same) tab now sitting on a
// file://...<filename> URL. Closes the spurious tab if it's a NEW one (the
// original tab and its form state are untouched in that case); if the
// ORIGINAL tab itself navigated away, there's nothing safe to auto-recover
// — that's surfaced as the more severe branch in the caller. Best-effort:
// never throws, since a detection failure shouldn't crash the upload flow.
async function detectAndCleanUpFileUrlHijack(
  tab: chrome.tabs.Tab,
  filename: string,
): Promise<{ sameTab: boolean; url: string } | null> {
  if (!filename) return null;
  try {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    for (const t of tabs) {
      const url = t.url ?? "";
      if (!url.startsWith("file://")) continue;
      let decoded = url;
      try { decoded = decodeURIComponent(url); } catch { /* leave raw */ }
      if (!decoded.includes(filename) && !url.includes(encodeURIComponent(filename))) continue;
      const sameTab = t.id === tab.id;
      if (!sameTab && typeof t.id === "number") {
        await chrome.tabs.remove(t.id).catch(() => {});
      }
      return { sameTab, url };
    }
  } catch { /* best-effort; a detection failure shouldn't crash the upload flow */ }
  return null;
}
