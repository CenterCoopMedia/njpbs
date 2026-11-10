/** The message a custom HTML frame posts so its parent can fit the frame to its content. */
export const HTML_FRAME_HEIGHT_MESSAGE = "njpbsHtmlFrameHeight";
export const HTML_FRAME_MEASURE_MESSAGE = "njpbsHtmlFrameMeasure";
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 20_000;

/**
 * Sizes each custom HTML frame to the height its own document reports. Only a frame's
 * own window can resize that frame, and the height is clamped, so the sandboxed code
 * cannot affect anything else on the page. The frame keeps its default height without
 * this enhancement.
 */
export function installHtmlFrameControls(win: Window): () => void {
  const resize = (event: MessageEvent) => {
    const height = (event.data as Record<string, unknown> | null)?.[HTML_FRAME_HEIGHT_MESSAGE];
    if (typeof height !== "number" || !Number.isFinite(height)) return;
    for (const frame of win.document.querySelectorAll<HTMLIFrameElement>("iframe[data-html-frame]")) {
      if (frame.contentWindow !== event.source) continue;
      frame.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)))}px`;
      return;
    }
  };
  win.addEventListener("message", resize);
  // A settled frame may have sent its last height before this listener existed.
  for (const frame of win.document.querySelectorAll<HTMLIFrameElement>("iframe[data-html-frame]")) {
    frame.contentWindow?.postMessage({ [HTML_FRAME_MEASURE_MESSAGE]: true }, "*");
  }
  return () => win.removeEventListener("message", resize);
}
