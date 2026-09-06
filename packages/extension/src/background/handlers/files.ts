// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript } from "../state";
import { withDebugger, pierceFileCount, pierceFilePoll, findShadowMarkedBackendNodeId } from "../cdp";
import { SET_FILE_FROM_CONTENT } from "../../connections";

export async function handleSetFileInput(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);

      // Ask content script to find and tag the file input. The content script
      // uses queryAllDeep, which pierces open AND closed shadow roots — file
      // inputs hidden behind Stencil/Lit/Radix drag-zones are reachable.
      const tagResult = await forwardToContentScript(tab, {
        type: "tag_file_input",
        requestId: msg.requestId,
        hint: msg.hint,
      }) as { found: boolean; message?: string; attr?: string; matched_desc?: string; matched_via?: string; zero_file_inputs_on_page?: boolean };

      if (!tagResult.found) {
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
      });
      const preTotal = (pre[0]?.result as { totalFiles: number; inputCount: number } | undefined)?.totalFiles ?? 0;

      // Use Chrome DevTools Protocol to set the file — the only way to bypass
      // the browser's script restriction on file inputs. Lookup goes through
      // DOM.getDocument({pierce: true}) so we can reach shadow-rooted inputs
      // (Runtime.evaluate's document.querySelector is MAIN-world and doesn't
      // pierce open OR closed shadow boundaries).
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
          }).catch(() => {});
        } else {
          await withDebugger(tabId, async () => {
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
          }).catch(() => {});
        }
      } finally {
        // Clean up the tag regardless of success/failure
        await forwardToContentScript(tab, {
          type: "untag_file_input",
          requestId: msg.requestId,
        }).catch(() => {});
      }

      // Poll for the upload to commit. Issue #2 (rapid back-to-back set_file_input
      // calls duplicate or overwrite uploads) and Issue #3 (no signal that the page
      // accepted the file) are both fixed by waiting here for an observable change
      // before returning. Two signals:
      //  (a) total file count across input[type=file] increased — the input still
      //      holds the file (most uploaders).
      //  (b) the page now matches verifySelector — caller-supplied confirmation
      //      element (e.g. ".photo-thumbnail" for an image carousel).
      // (a)-or-(b) success short-circuits the wait. Otherwise we wait the full
      // waitMs and report no observable change.
      const pollStart = Date.now();
      let committed = false;
      let consumed = false;
      let consumedUnconfirmed = false;
      let postTotal = preTotal;
      let verifyMatched = false;
      let filenameEverVisible = false;

      while (Date.now() - pollStart < waitMs) {
        await new Promise((r) => setTimeout(r, 200));

        const post = await chrome.scripting.executeScript({
          target: { tabId },
          func: pierceFilePoll,
          args: [filename, verifySelector ?? ""],
        });
        const result = post[0]?.result as { total: number; stillHasOurFile: boolean; verifyOk: boolean; filenameVisible: boolean } | undefined;
        if (!result) continue;

        postTotal = result.total;
        verifyMatched = result.verifyOk;
        if (result.filenameVisible) filenameEverVisible = true;

        if (verifyMatched) { committed = true; break; }
        if (postTotal > preTotal) { committed = true; break; }
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

      const noteParts: string[] = [];
      if (tagResult.matched_desc) {
        noteParts.push(`targeted ${tagResult.matched_desc}${tagResult.matched_via ? ` (via ${tagResult.matched_via})` : ""}`);
      }
      noteParts.push(`page-level file count: ${preTotal} → ${postTotal}`);
      if (verifySelector) noteParts.push(`verifySelector "${verifySelector}" ${verifyMatched ? "matched" : "did not match"}`);
      if (consumed) noteParts.push("file was consumed by the page (input was reset) and the filename appeared on the page, confirming it landed");
      const note = noteParts.join("; ");

      if (committed) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: true,
          message: `File "${filename}" uploaded — ${note}`,
        };
      }
      if (consumedUnconfirmed) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: false,
          consumed_unconfirmed: true,
          message: `File "${filename}" was accepted by the input then immediately cleared (input was reset), but the filename never appeared anywhere on the page and no file-count increase or verifySelector match was observed within ${waitMs}ms — ${note}. This looks like a silent rejection, not a successful upload (seen on react-dropzone-style widgets that read-then-discard on tenant-level rejection). Do NOT trust this as landed; verify with get_page_text/take_screenshot before retrying or reporting to the user.`,
        };
      }
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: false,
        message: `File "${filename}" set on input but the page did not show an observable change within ${waitMs}ms — ${note}. The page may have rejected the upload (size, type, format), or the change handler may be slower than the wait window. Use verifySelector or get_page_text to confirm.`,
      };
}
