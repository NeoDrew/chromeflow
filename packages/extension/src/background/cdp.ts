// CDP dispatch + probing cluster. BARREL: the implementation now lives in
// ./cdp/*.ts, subdivided by domain. This file re-exports every symbol the
// cluster ever exported so existing `from "./cdp"` (background.ts) and
// `from "../cdp"` (background/handlers/*) imports keep working unchanged.
//
// All functions are tab-scoped (take a tabId) and carry no module-level
// connection/window state — they depend only on chrome.* and each other.
// The one piece of shared module-level state (the debugger mutex + refcount)
// lives in ./cdp/debugger and is imported by the modules that attach.

export { tabDebuggerLocks, tabDebuggerRefCount, withDebugger } from "./cdp/debugger";
export {
  dispatchTapGesture,
  dispatchKeyboardActivation,
  dispatchHumanMouseClick,
  dispatchDragDropFile,
  freshTargetPoint,
} from "./cdp/dispatch";
export {
  type ActivityProbeResult,
  snapshotVisibleCount,
  runActivityProbe,
  countInFlightRequests,
} from "./cdp/probe";
export { getSubmitSignalCounts, classifyTopDialog } from "./cdp/dialog";
export { setupBeforeunloadAutoDismiss, armBeforeunloadDismissOnAttachedTab } from "./cdp/beforeunload";
export { type CDPNode, findShadowMarkedBackendNodeId, walkForMarker } from "./cdp/nodes";
export {
  injectAlertCapture,
  PHASE_BUDGET_MULT,
  phaseRace,
  commitReactControlState,
  pierceFileCount,
  pierceFilePoll,
} from "./cdp/misc";
