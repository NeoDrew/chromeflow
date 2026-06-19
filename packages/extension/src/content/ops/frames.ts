import { collectShadowHosts, queryAllDeep } from "../shadow.js";
import type { IncomingMessage } from "./frame-util.js";

export function opListFrames(msg: IncomingMessage): unknown {
  // Pierce shadow DOMs (open + closed) so iframes nested inside web
  // components (e.g. Reddit's chat composer inside a shadow-hosted host)
  // are discoverable. The previous behavior queried only the light DOM.
  const iframes = queryAllDeep<HTMLIFrameElement | HTMLFrameElement>(document, "iframe, frame");
  const frames = iframes.map((el, index) => {
    const src = el.getAttribute("src") ?? "";
    let origin = "";
    try {
      origin = src ? new URL(src, location.href).origin : "";
    } catch {
      // src may be a `javascript:` scheme or otherwise unparseable.
      origin = "";
    }
    let accessible = false;
    try {
      accessible = !!(el as HTMLIFrameElement).contentDocument;
    } catch {
      accessible = false;
    }
    const rect = el.getBoundingClientRect();
    // Build a usable CSS selector — prefer #id, fall back to class chain
    // bounded by the tag, fall back to nth-of-type. The selector is
    // intended to be passed back into find_text/find_input via frame=.
    let selector: string;
    if (el.id) {
      selector = `#${CSS.escape(el.id)}`;
    } else if (el.className && typeof el.className === "string" && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).map((c) => `.${CSS.escape(c)}`).join("");
      selector = `${el.tagName.toLowerCase()}${cls}`;
    } else {
      // nth-of-type among siblings sharing the same tag (iframe/frame).
      const tag = el.tagName.toLowerCase();
      const sameTagSiblings = Array.from(document.querySelectorAll(tag));
      const idx = sameTagSiblings.indexOf(el) + 1;
      selector = `${tag}:nth-of-type(${idx})`;
    }
    // Cross-origin = has a real http(s) src we can't read in-page. Surface
    // the fetch_url escape hatch so the agent doesn't dead-end on it.
    const crossOrigin = !accessible && !!origin && origin !== location.origin;
    return {
      index: index + 1,
      selector,
      src,
      origin,
      title: el.getAttribute("title") ?? "",
      accessible,
      cross_origin: crossOrigin,
      hint: crossOrigin && src
        ? `cross-origin: read its HTML with fetch_url("${src}") or capture it with take_screenshot`
        : undefined,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  // Augment with shadow-host inventory so the agent can spot pages whose
  // visible content is rendered inside closed shadow roots (Radix portals,
  // Stencil/Lit web components). When the agent
  // calls execute_script and gets back an empty document but the shadow
  // host list is non-empty, that's the signal to switch to find_text /
  // get_page_text / click_element / fill_input — those pierce.
  const shadowHosts = collectShadowHosts(document, 25);
  return {
    type: "list_frames_response",
    requestId: msg.requestId,
    frames,
    shadow_hosts: shadowHosts,
  };
}
