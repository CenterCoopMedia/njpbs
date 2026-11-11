import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MediaAssetSummary } from "../../lib/functions";
import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { Button, InlineMessage } from "../ui/Primitives";
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { Icon } from "../ui/Icon";

function ImageViewingPane({ asset, comparison = false, labeled, detailsOpen }: {
  asset: MediaAssetSummary; comparison?: boolean; labeled?: boolean; detailsOpen: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = useState({ width: asset.width ?? 1, height: asset.height ?? 1 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const pan = useRef({ left: 0, top: 0 });
  const fit = Math.min(1, viewport.width / size.width, viewport.height / size.height);
  const scale = zoom === "fit" ? Math.max(0.01, fit) : zoom;
  const percent = Math.round(scale * 100);

  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) => {
      // A hidden phone stage has no size; keep its last real viewing bounds.
      if (entry.contentRect.width && entry.contentRect.height) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = stage.current;
    if (element) { element.scrollLeft = pan.current.left; element.scrollTop = pan.current.top; }
  }, [detailsOpen]);

  function changeZoom(value: number | "fit") {
    if (value === "fit") {
      pan.current = { left: 0, top: 0 };
      if (stage.current) { stage.current.scrollLeft = 0; stage.current.scrollTop = 0; }
    }
    setZoom(value);
  }
  return <section className="image-viewer-pane" aria-label={comparison ? "Comparison image" : "Current image"}>
    <ControlSizingProvider size="compact">
      <div className="image-viewer-toolbar" role="group" aria-label={comparison ? "Comparison image view controls" : "Image view controls"} onKeyDown={event => { if (event.key.startsWith("Arrow")) event.stopPropagation(); }}>
        {labeled ? <p className="image-viewer-identity">{asset.name} · {asset.id} · v{asset.version}</p> : null}
        <Button variant="ghost" aria-pressed={zoom === "fit"} onClick={() => changeZoom("fit")}>Fit</Button>
        <Button variant="ghost" aria-label="View at 100%" aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</Button>
        <Button variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={status !== "ready" || scale <= 0.25} onClick={() => changeZoom(Math.max(0.25, scale - 0.25))}>−</Button>
        <output aria-label="Image zoom" aria-live={zoom === "fit" ? "off" : "polite"}>{status === "ready" ? `${percent}%` : "--"}</output>
        <Button variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={status !== "ready" || scale >= 3} onClick={() => changeZoom(Math.min(3, scale + 0.25))}><Icon name="plus" /></Button>
        <span className="image-viewer-preview-size">{size.width} × {size.height} preview</span>
      </div>
    </ControlSizingProvider>
    <div className="image-viewer-stage" data-status={status} ref={stage} role="region" aria-label={comparison ? "Comparison image viewing surface" : "Image viewing surface"} tabIndex={0}
      onKeyDown={event => { if (event.key.startsWith("Arrow")) event.stopPropagation(); }}
      onScroll={event => { if (event.currentTarget.getClientRects().length) pan.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; }}>
      {status === "loading" ? <LoadingIndicator label="Loading original image" layout="stack" /> : null}
      {status === "error" ? <InlineMessage tone="error" title="Original image could not be loaded"><a href={asset.url} rel="noreferrer" target="_blank">Open original</a> to try again.</InlineMessage> : null}
      <div className="image-viewer-canvas" style={{ width: size.width * scale, height: size.height * scale }}>
        <img alt={asset.altText ?? ""} decoding="async" draggable={false} src={asset.url}
          onError={() => setStatus("error")}
          onLoad={event => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setSize({ width: image.naturalWidth, height: image.naturalHeight }); setStatus("ready"); }} />
      </div>
    </div>
  </section>;
}

/** Viewing state and the metadata draft stay mounted during comparison and Details changes. */
export function ImageViewingSurface({ asset, inspector, comparisonAssets = [] }: {
  asset: MediaAssetSummary; inspector: ReactNode; comparisonAssets?: readonly MediaAssetSummary[];
}) {
  const detailsId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const closeDetailsButton = useRef<HTMLButtonElement>(null);
  const returnToDetails = useRef(false);
  const invalidField = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth > 780);
  const [comparisonId, setComparisonId] = useState("");
  const choices = comparisonAssets.filter(item => item.id !== asset.id && item.kind === "image" && item.lifecycle === "active");
  const comparison = choices.find(item => item.id === comparisonId);

  useLayoutEffect(() => {
    if (detailsOpen && invalidField.current) {
      const field = invalidField.current;
      invalidField.current = null;
      field.reportValidity();
    } else if (detailsOpen && window.innerWidth <= 780) closeDetailsButton.current?.focus();
    if (!detailsOpen && returnToDetails.current) { returnToDetails.current = false; detailsButton.current?.focus(); }
  }, [detailsOpen]);
  useEffect(() => {
    function restoreVisibleFocus() {
      const active = document.activeElement;
      if (detailsOpen && window.innerWidth <= 780 && (active === document.body || active instanceof HTMLElement && !active.getClientRects().length)) closeDetailsButton.current?.focus();
    }
    window.addEventListener("resize", restoreVisibleFocus);
    return () => window.removeEventListener("resize", restoreVisibleFocus);
  }, [detailsOpen]);

  return <div className="image-viewer-workspace" data-details-open={detailsOpen}>
    <div className="image-viewer-workspace-controls" role="group" aria-label="Image workspace controls" onKeyDown={event => { if (event.key.startsWith("Arrow")) event.stopPropagation(); }}>
      {choices.length ? <label className="image-viewer-compare-control">Compare with
        <select value={comparison?.id ?? ""} onChange={event => setComparisonId(event.target.value)}>
          <option value="">None</option>
          {choices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id} · v{item.version}</option>)}
        </select>
      </label> : null}
      <Button ref={detailsButton} className="image-viewer-details-toggle" variant="ghost" aria-controls={detailsId} aria-expanded={detailsOpen} aria-pressed={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>Details</Button>
    </div>
    <div className="image-viewer-panes" data-comparing={Boolean(comparison)}>
      <ImageViewingPane key={asset.url} asset={asset} labeled={Boolean(comparison)} detailsOpen={detailsOpen} />
      {comparison ? <ImageViewingPane key={`${comparison.id}:${comparison.version}:${comparison.url}`} asset={comparison} comparison labeled detailsOpen={detailsOpen} /> : null}
    </div>
    <p className="image-viewer-preview-note">Viewing controls keep the file unchanged. 100% shows the preview at its pixel size.</p>
    <aside className="image-viewer-details" id={detailsId} hidden={!detailsOpen} role="none"
      onSubmitCapture={() => setDetailsOpen(true)}
      onInvalidCapture={event => {
        if (detailsOpen) return;
        event.preventDefault();
        const field = event.target;
        if (!invalidField.current && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) invalidField.current = field;
        setDetailsOpen(true);
      }}>
      <div className="image-viewer-details-heading"><h3>Image details</h3><Button ref={closeDetailsButton} variant="ghost" aria-label="Close image details" title="Close image details" onClick={() => { returnToDetails.current = true; setDetailsOpen(false); }}><Icon name="close" /></Button></div>
      {inspector}
    </aside>
  </div>;
}
