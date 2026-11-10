import { apResultsLayoutSrc } from "./ap-results-layout";

const AP_ORIGIN = "https://interactives.apelections.org";
const MAX_HEIGHT = 20_000;

/** Use AP's resizeClient message protocol without loading a third-party script. */
export function installApEmbedControls(view: Window): () => void {
  const frames = Array.from(view.document.querySelectorAll<HTMLIFrameElement>("iframe.election-map__frame"))
    .filter(frame => apResultsLayoutSrc(frame.src) !== null);
  if (!frames.length) return () => {};
  const query = (frame: HTMLIFrameElement) => frame.contentWindow?.postMessage({ type: "embed-size-query" }, AP_ORIGIN);
  const receive = (event: MessageEvent) => {
    if (event.origin !== AP_ORIGIN || !event.source || !event.data || typeof event.data !== "object") return;
    const frame = frames.find(frame => frame.contentWindow === event.source);
    if (!frame || apResultsLayoutSrc(frame.src) === null) return;
    if (event.data.type === "domain-request") {
      frame.contentWindow?.postMessage({ type: "domain-request" }, AP_ORIGIN);
    } else if (event.data.type === "embed-size") {
      const height = event.data.height;
      if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > MAX_HEIGHT) return;
      // AP layouts include a small border overflow. Once AP supplies its height,
      // disable frame scrollbars so they cannot shrink the layout and retrigger sizing.
      frame.scrolling = "no";
      frame.style.height = `${Math.ceil(height)}px`;
    }
  };
  view.addEventListener("message", receive);
  const listeners = frames.map(frame => {
    const load = () => query(frame);
    frame.addEventListener("load", load);
    query(frame);
    return () => frame.removeEventListener("load", load);
  });
  return () => {
    view.removeEventListener("message", receive);
    listeners.forEach(dispose => dispose());
  };
}
