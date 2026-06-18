// Barrel module for the CDP / synthetic click flow. The implementation now
// lives in ./click/*.ts split by domain (resolve, dialog, pointer, fiber,
// dispatch); this file re-exports the exact public surface other modules
// import (content/index.ts imports from "./click.js"), so callers are
// unchanged.
export { prepareClickTarget, postClickInspect, clickElement } from "./click/dispatch.js";
export { scrollSmartIntoView, pointerChainOnTagged } from "./click/pointer.js";
export { reactFiberClick, reactFiberClickByHint } from "./click/fiber.js";
export { findTopmostDialog, findDialogByQuery } from "./click/dialog.js";
