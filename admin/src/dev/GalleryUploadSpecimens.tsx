import { useEffect, useRef, useState } from "react";
import { DropOverlay } from "../components/media/DropOverlay";
import { SelectionBar } from "../components/media/SelectionBar";
import { UploadSheet } from "../components/media/UploadSheet";
import {
  UploadTray,
  UploadTrayRows,
  type UploadTrayRow,
} from "../components/media/UploadTray";
import { Button } from "../components/ui/Primitives";

const UPLOAD_TRAY_ROWS: readonly UploadTrayRow[] = [
  { id: "active", name: "news-desk.png", status: "uploading", progress: 62 },
  { id: "complete", name: "station-id.png", status: "succeeded" },
  { id: "failed", name: "field-briefing.pdf", status: "failed", message: "The upload did not finish." },
  { id: "video", name: "studio-interview.mp4", status: "paused", progress: 41, message: "Paused. Resume with the original file." },
];

export function MediaUploadTrayGallery() {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [rows, setRows] = useState(UPLOAD_TRAY_ROWS);
  const [announcement, setAnnouncement] = useState("news-desk.png is uploading.");
  const change = (id: string, next: Partial<UploadTrayRow>) => {
    setRows(current => current.map(row => row.id === id ? { ...row, ...next } : row));
  };
  const remove = (id: string) => setRows(current => current.filter(row => row.id !== id));
  const controlled = rows.map(row => ({
    ...row,
    ...(row.status === "uploading" && row.id !== "video" ? { onStop: () => {
      change(row.id, { status: "failed", progress: undefined, message: "The upload was stopped." });
      setAnnouncement(`${row.name} was stopped.`);
    } } : {}),
    ...(row.status === "uploading" && row.id === "video" ? { onPause: () => {
      change(row.id, { status: "paused", message: "Paused. Resume with the original file." });
      setAnnouncement(`${row.name} was paused.`);
    }, onCancel: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was canceled.`);
    } } : {}),
    ...(row.status === "paused" && row.id === "video" ? { onResume: () => {
      change(row.id, { status: "uploading", message: undefined });
      setAnnouncement(`${row.name} is uploading again.`);
    }, onCancel: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was canceled.`);
    } } : {}),
    ...(row.status === "failed" ? { onRetry: () => {
      change(row.id, { status: "uploading", progress: 0, message: undefined });
      setAnnouncement(`${row.name} is uploading again.`);
    } } : {}),
    ...(row.status === "succeeded" ? { onViewAsset: () => setAnnouncement(`Opening ${row.name}.`) } : {}),
    ...(row.status !== "uploading" && row.id !== "video" ? { onClear: () => {
      remove(row.id);
      setAnnouncement(`${row.name} was cleared.`);
    } } : {}),
  }));
  return (
    <main className="media-upload-gallery-canvas media-library">
      <div className="media-library-layout">
        <div className="media-results">
          <div className="panel media-upload-gallery-results">
            <strong>Media results remain available</strong>
            <span>The tray reads only the supplied local fixture.</span>
            <div className="media-upload-gallery-actions">
              <Button onClick={() => setSheetOpen(true)}>Open upload</Button>
              <Button variant="ghost" onClick={() => undefined}>Focus result control</Button>
            </div>
          </div>
          <SelectionBar
            actions={[]}
            count={3}
            label="Image selection"
            offPage={0}
            onAction={() => undefined}
            onClear={() => undefined}
            onPageChange={() => undefined}
            pageState="some"
          />
          <UploadTray
            announcement={announcement}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onOpen={() => setSheetOpen(true)}
            rows={controlled}
            summary={`Uploading ${controlled.filter(row => row.status === "uploading").length} of ${controlled.length}`}
          />
        </div>
        <UploadSheet heading="Upload images and documents" onRequestClose={() => setSheetOpen(false)} open={sheetOpen}>
          <div className="media-upload-gallery-form">
            <p>The route-owned upload draft remains mounted while this sheet is closed.</p>
            <label>Batch name<input className="field-control" defaultValue="News desk batch" /></label>
            <UploadTrayRows label="Current uploads" rows={controlled} />
          </div>
        </UploadSheet>
      </div>
    </main>
  );
}

export function MediaUploadSheetGallery() {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<readonly UploadTrayRow[]>([
    { id: "video-sheet", name: "studio-interview.mp4", status: "paused", progress: 41, message: "Paused. Resume with the original file." },
  ]);
  const controlled = rows.map(row => ({
    ...row,
    ...(row.status === "paused" ? { onResume: () => setRows(current => current.map(item => item.id === row.id ? { ...item, status: "uploading", message: undefined } : item)) } : {}),
    onCancel: () => setRows(current => current.filter(item => item.id !== row.id)),
  }));
  return (
    <main className="media-upload-gallery-canvas media-library">
      <Button onClick={() => setOpen(true)}>Open upload</Button>
      {!open ? <p role="status">The upload sheet is closed. Its transfer owner remains available.</p> : null}
      <div className="media-library-layout">
        <div className="media-results">
          <div className="panel media-upload-gallery-results">
            <strong>Media results</strong>
            <span>The fixed sheet uses the shared inspector column.</span>
          </div>
        </div>
        <UploadSheet
          heading="Upload to Video library"
          onRequestClose={() => setOpen(false)}
          open={open}
        >
          <div className="media-upload-gallery-form">
            <div className="media-upload-gallery-actions">
              <Button variant="danger-quiet" onClick={() => setRows([])}>Clear queue</Button>
              <Button variant="primary" onClick={() => undefined}>Upload media</Button>
            </div>
            <p>Choose images, PDFs, or videos. Each file goes to the matching library. After reopening Boardwalk, select the original video to resume a transfer.</p>
            <UploadTrayRows label="Video transfers" rows={controlled} />
          </div>
        </UploadSheet>
      </div>
    </main>
  );
}

function GalleryDropOverlay({ blocked = false }: { blocked?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = host.current?.querySelector(".media-drop-target");
    if (!target) return;
    const event = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files: [] },
    });
    target.dispatchEvent(event);
  }, []);
  return (
    <div ref={host}>
      <DropOverlay blocked={blocked} canUpload destination="Images" onFiles={() => undefined}>
        <div className="panel media-upload-gallery-results">
          <strong>{blocked ? "Unsaved image details" : "Image library results"}</strong>
          <span>Drag files over this region.</span>
        </div>
      </DropOverlay>
    </div>
  );
}

export function MediaDropOverlayGallery() {
  return (
    <main className="media-upload-gallery-canvas media-upload-overlay-gallery">
      <GalleryDropOverlay />
      <GalleryDropOverlay blocked />
    </main>
  );
}
