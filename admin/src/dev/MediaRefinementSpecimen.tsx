import { useState } from "react";
import { MediaFullViewer, type MediaFullViewerBodyContext, type MediaFullViewerItem } from "../components/media/MediaFullViewer";
import { VideoViewerBody } from "../routes/SourceMediaLibrary";
import { video } from "./MediaTileSpecimen";
import { parseMediaPermalink } from "../lib/media-permalink";

// Actual viewer/production/metadata owners. Browser fixtures intercept service
// reads and writes; this specimen never supplies live credentials or records.
const assets = [
  video("media-frame-before", "Waterfront archive · establishing shots"),
  video("media-frame-interview", "Waterfront oral history — interview master", {
    fileVersion: "synthetic-media-frame-version",
    originalName: "waterfront-neighborhood-oral-history-interview-master.mp4",
    description: "Synthetic 90-minute oral history for shared media-frame checks.",
    viewingCopy: { state: "ready", durationSeconds: 5400, width: 640, height: 360, sizeBytes: 402_653_184 },
  }),
  video("media-frame-after", "Waterfront archive · closing interview"),
];
const items: readonly MediaFullViewerItem[] = assets.map(asset => ({
  kind: "video", ref: { backend: "s3", sourceId: asset.sourceId, id: asset.id }, name: asset.name,
  footerNote: "Private media stays in the staff library.",
}));
const token = async () => "local-media-frame-fixture";

function Body({ context }: { context: MediaFullViewerBodyContext }) {
  const initial = assets.find(asset => asset.id === context.item.ref.id)!;
  const linked = parseMediaPermalink(new URLSearchParams(window.location.search));
  const [asset, setAsset] = useState(initial);
  const [favorite, setFavorite] = useState(false);
  return <VideoViewerBody asset={asset} getIdToken={token}
    initialSeek={linked.assetId === asset.id ? linked.seconds : 0}
    principal={{ id: "local-frame-editor", grants: [{ role: "editor" }] }}
    canEditMetadata canRequestProduction canDelete={false}
    onDeleted={() => undefined} onUpdated={setAsset}
    onDirtyChange={context.onDirtyChange} onSavingChange={context.onSavingChange} onBusyChange={context.onBusyChange}
    navigationBlocked={false} onDiscardNavigation={() => undefined} onKeepNavigation={() => undefined}
    favorite={{ favorite, onToggle: () => setFavorite(value => !value), name: asset.name }}
    closePrompt={context.dirtyPrompt} deleteConfirmationId="local-media-frame-delete"
    headerTarget={context.headerActionsTarget} factsTarget={context.headerFactsTarget}
    footerTarget={context.footerActionsTarget} />;
}

export function MediaRefinementSpecimen() {
  const [activeRef, setActiveRef] = useState(items[1].ref);
  const [open, setOpen] = useState(true);
  return <>
    <h2 tabIndex={-1}>Synthetic media results</h2>
    {items.map(item => <button key={item.ref.id} data-media-ref={item.ref.id} type="button"
      onClick={() => { setActiveRef(item.ref); setOpen(true); }}>Open {item.name}</button>)}
    {open ? <MediaFullViewer activeRef={activeRef} items={items} onClose={() => setOpen(false)}
      onStep={item => setActiveRef(item.ref)} renderBody={context => <Body context={context} />}
      focusItem={ref => {
        const target = document.querySelector<HTMLButtonElement>(`[data-media-ref="${ref.id}"]`);
        target?.focus(); return Boolean(target);
      }}
      focusFallback={() => document.querySelector<HTMLElement>("h2")?.focus()} /> : null}
  </>;
}
