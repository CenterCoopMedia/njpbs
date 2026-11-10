import { useEffect, useState } from "react";
import domeImage from "../../../site/public/brand/spotlight/under-the-dome.jpg";
import energyImage from "../../../site/public/brand/spotlight/energy-environment.jpg";
import { MediaFullViewer, mediaFullViewerKey, type MediaFullViewerBodyContext, type MediaFullViewerItem } from "../components/media/MediaFullViewer";
import { Button } from "../components/ui/Primitives";
import { Icon } from "../components/ui/Icon";
import { Menu } from "../components/ui/Menu";
import { MediaPreviewHeaderActions } from "../components/media/MediaPreviewHeaderActions";
import "../components/media/ImageViewer.css";
import "../components/VideoProductionTools.css";
import "../routes/SourceMediaLibrary.css";

// Adopt the same header owner as the live mixed viewer consumers. The gallery
// keeps its original local download placeholder and real three-result order.
function fixtureDownloads(label: string, kind: "image" | "document" | "video") {
  return <MediaPreviewHeaderActions copyLink={() => new URL(`/gallery.html?embed=media-full-viewer-${kind}`, window.location.href).href} downloads={<Menu label="Download" tooltip="Download" icon="download" variant="primary"
    items={[{ key: "original", label, icon: "download", onSelect: () => undefined }]}>Download</Menu>} />;
}

const ITEMS: readonly MediaFullViewerItem[] = [
  {
    ref: { backend: "r2", id: "gallery-dome" },
    kind: "image",
    name: "Statehouse dome at dusk",
    facts: "JPEG · 2400 × 1600 · 2.2 MB",
    actions: fixtureDownloads("Download original", "image"),
  },
  {
    ref: { backend: "r2", id: "gallery-guide" },
    kind: "document",
    name: "NJ PBS brand guide",
    facts: "PDF · 2.9 MB",
    actions: fixtureDownloads("Download original", "document"),
  },
  {
    ref: { backend: "s3", sourceId: "gallery-source", id: "gallery-video" },
    kind: "video",
    name: "Energy report footage",
    facts: "MP4 · 02:14 · 1080p",
    actions: fixtureDownloads("Download video", "video"),
  },
];

function FixtureBody({ context, dirty, setDirty }: {
  context: MediaFullViewerBodyContext;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
}) {
  const { item, dirtyPrompt, onDirtyChange, onSavingChange } = context;
  useEffect(() => {
    onDirtyChange(false);
    onSavingChange(false);
    return () => { onDirtyChange(false); onSavingChange(false); };
  }, [onDirtyChange, onSavingChange]);
  return <>
    <div className="component-editor-dialog-content image-viewer-content">
      {dirtyPrompt}
      {item.kind === "image" ? <div className="image-viewer-original" style={{ aspectRatio: 3 / 2, width: "min(100%, 90dvh)" }}><img alt="New Jersey State House dome at dusk" src={domeImage} /></div>
        : item.kind === "document" ? <div className="image-viewer-document">
          <span aria-hidden="true" className="image-viewer-document-mark"><Icon name="file" /><strong>PDF</strong></span>
          <p>A preview is not available for this PDF.</p>
          <a href="#gallery-pdf-original">Open original <Icon name="external-link" /></a>
        </div>
          : <><video aria-label="Energy report footage" className="source-video-player" controls poster={energyImage} preload="none" style={{ aspectRatio: 16 / 9, width: "min(100%, 106dvh)" }} /><p className="source-video-ready">Private preview ready to watch.</p></>}
    </div>
    <aside className="component-editor-dialog-settings image-viewer-settings" role="none">
      <div className="media-full-viewer-specimen-details">
        <h2>{item.kind === "video" ? "Video tools" : item.kind === "document" ? "Document details" : "Image details"}</h2>
        <p>{item.name}</p>
        {item.kind === "video" ? <Button variant="secondary">Edit video details</Button>
          : <Button onClick={() => { setDirty(true); onDirtyChange(true); }} variant="secondary">Edit details</Button>}
        {dirty ? <Button onClick={() => { setDirty(false); onDirtyChange(false); }}>Save details locally</Button> : null}
      </div>
    </aside>
    {item.kind === "video" ? <div className="component-editor-dialog-sections">
      <div className="video-production-sections">
        <details open><summary>Transcript</summary><p>No transcript requested.</p><Button variant="secondary">Request transcript</Button></details>
        <details><summary>Clips</summary><p>No clips saved.</p></details>
      </div>
    </div> : null}
  </>;
}

export function MediaFullViewerSpecimen({ initialKind }: { initialKind: MediaFullViewerItem["kind"] }) {
  const [activeRef, setActiveRef] = useState(ITEMS.find(item => item.kind === initialKind)!.ref);
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  if (!open) return <div className="panel"><h2 tabIndex={-1}>Media results</h2></div>;
  return <MediaFullViewer
    activeRef={activeRef}
    items={ITEMS}
    onClose={() => setOpen(false)}
    onStep={(item) => { setDirty(false); setActiveRef(item.ref); }}
    renderBody={(context) => <FixtureBody context={context} dirty={dirty} setDirty={setDirty} />}
    focusFallback={() => document.querySelector<HTMLElement>("h2")?.focus()}
    focusItem={(ref) => {
      const tile = document.querySelector<HTMLElement>(`[data-media-ref="${mediaFullViewerKey(ref)}"]`);
      tile?.focus();
      return Boolean(tile);
    }}
  />;
}
