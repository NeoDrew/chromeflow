/**
 * Resolve a `frame` selector to its iframe's contentDocument. Returns the
 * top-level document when no frame is given, and null when the frame
 * selector matched nothing or the iframe is cross-origin.
 */
export function resolveFrameDocument(frame: string | undefined): Document | null {
  if (!frame) return document;
  const iframe = document.querySelector<HTMLIFrameElement>(frame);
  if (!iframe) return null;
  try {
    return iframe.contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * Build an actionable error for a frame that couldn't be read. A cross-origin
 * iframe (e.g. a cloudfront.net component viewer) can't be reached by in-page
 * DOM tools at all, but its HTML IS retrievable via fetch_url, which runs in
 * the extension's privileged context with cookies. Point the agent there
 * instead of leaving it stuck.
 */
export function frameErrorHint(frame: string | undefined): string {
  if (!frame) return "No frame specified.";
  const iframe = document.querySelector<HTMLIFrameElement>(frame);
  if (!iframe) return `Iframe "${frame}" not found.`;
  let crossOrigin = false;
  try {
    crossOrigin = !iframe.contentDocument;
  } catch {
    crossOrigin = true;
  }
  const src = iframe.getAttribute("src") ?? "";
  if (crossOrigin) {
    return src
      ? `Iframe "${frame}" is cross-origin — in-page DOM tools can't read it. Retrieve its HTML with fetch_url("${src}") (privileged context, cookies included), or use take_screenshot for visual content.`
      : `Iframe "${frame}" is cross-origin and has no readable src — use take_screenshot for its visual content.`;
  }
  return `Iframe "${frame}" contentDocument unavailable (it may not have loaded yet — retry, or wait_for a selector inside it).`;
}

// Shared message shape, mirrored from content/index.ts's IncomingMessage.
export type IncomingMessage = {
  type: string;
  requestId: string;
  [key: string]: unknown;
};
