// CDP DOM-tree walking: locate a content-script-tagged node by its marker
// attribute from the background worker.

/**
 * Walk a CDP DOM tree (from DOM.getDocument({pierce: true})) and return the
 * backendNodeId of the first node carrying `attrName="true"`. Pierces shadow
 * roots and same-origin iframes via the CDP-side `shadowRoots` and
 * `contentDocument` fields.
 *
 * Used by set_file_input to locate the content-script-tagged file input from
 * the background worker. The legacy path used Runtime.evaluate + document
 * .querySelector, which is MAIN-world and can't see shadow-rooted elements.
 */
export interface CDPNode {
  backendNodeId: number;
  attributes?: string[];
  children?: CDPNode[];
  shadowRoots?: CDPNode[];
  contentDocument?: CDPNode;
}

export async function findShadowMarkedBackendNodeId(tabId: number, attrName: string): Promise<number | null> {
  const dbg = chrome.debugger as unknown as {
    sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
  };
  const docResult = await dbg.sendCommand({ tabId }, "DOM.getDocument", { pierce: true, depth: -1 }) as { root: CDPNode };
  return walkForMarker(docResult.root, attrName);
}

export function walkForMarker(node: CDPNode, attrName: string): number | null {
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length - 1; i += 2) {
      if (node.attributes[i] === attrName && node.attributes[i + 1] === "true") {
        return node.backendNodeId;
      }
    }
  }
  for (const child of node.children ?? []) {
    const found = walkForMarker(child, attrName);
    if (found) return found;
  }
  for (const sr of node.shadowRoots ?? []) {
    const found = walkForMarker(sr, attrName);
    if (found) return found;
  }
  if (node.contentDocument) {
    const found = walkForMarker(node.contentDocument, attrName);
    if (found) return found;
  }
  return null;
}
