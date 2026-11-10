import { useEffect, useRef, useState, type CSSProperties } from "react";
import businessImage from "../../../site/public/brand/spotlight/business-02.jpg";
import educationImage from "../../../site/public/brand/spotlight/education.jpg";
import energyImage from "../../../site/public/brand/spotlight/energy-environment.jpg";
import domeImage from "../../../site/public/brand/spotlight/under-the-dome.jpg";
import { Inspector, InspectorSection } from "../components/ui/Inspector";
import { Menu } from "../components/ui/Menu";
import { Button, TextInput, Textarea } from "../components/ui/Primitives";
import { TokenInput, type Token } from "../components/ui/TokenInput";
import { MediaFullViewer, type MediaFullViewerItem } from "../components/media/MediaFullViewer";
import { VideoDetailsInspector } from "../components/media/VideoDetailsInspector";
import { MediaPreviewHeaderActions } from "../components/media/MediaPreviewHeaderActions";
import { MediaBulkInspector } from "../components/media/MediaBulkInspector";
import type { MediaAssetSummary } from "../lib/functions";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import "./MediaInspectorSpecimen.css";

const field: CSSProperties = { display: "grid", gap: "var(--cms-space-1)", fontSize: "var(--cms-font-sm)", fontWeight: 700 };
const tile: CSSProperties = {
  aspectRatio: "4 / 3",
  borderRadius: "var(--cms-radius-control)",
  background: "var(--cms-surface-muted)",
};

const SUGGESTION_NOTE = "From this page and your recent tags.";
// What 4c and 4f pass: the selected items' tags, then the loaded page's, then recent tags.
const PAGE_TAGS = ["trenton", "transportation", "tropical storm", "statehouse", "shore", "newark", "education", "elections"];

const TILE_NAMES = [
  "Sunset over Newark",
  "Trenton skyline",
  "Statehouse dome",
  "Shore at dawn",
  "Newark studio",
  "Turnpike traffic",
  "Pine Barrens trail",
  "Camden waterfront",
];

/** Stand-in cards. A card opens details, so it is the opener focus returns to. */
function Results({ onOpen }: { onOpen?: (name: string) => void }) {
  return (
    <div
      aria-label="Results"
      role="region"
      style={{ display: "grid", flex: "1 1 auto", gap: "var(--cms-space-3)", gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))", minWidth: 0 }}
    >
      {TILE_NAMES.map((name) => (onOpen
        ? <button aria-label={`Open ${name}`} className="gx-tile" key={name} onClick={() => onOpen(name)} style={tile} type="button" />
        : <div key={name} style={tile} />))}
    </div>
  );
}

// Gallery specimen for the details inspector. It sits at the right of the results and drags
// between 18 and 28rem; under 62rem it becomes a modal full-height sheet over a scrim, and the
// page behind it is inert. Sections show counts. Local state only.
export function MediaInspectorSpecimen() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("Sunset over Newark");
  const [tags, setTags] = useState<Token[]>([{ value: "newark" }, { value: "skyline" }, { value: "b-roll" }]);

  return (
    <div className="panel" style={{ display: "flex", gap: "var(--cms-space-4)", alignItems: "flex-start", minHeight: "36rem" }}>
      <Results onOpen={(next) => {
        setName(next);
        setOpen(true);
      }}
      />
      <Inspector
        footer={(
          <>
            <Button aria-label="Cancel changes" variant="secondary">Cancel</Button>
            <Button aria-label="Save details" variant="primary">Save</Button>
          </>
        )}
        heading={name || "Untitled image"}
        label="Image details"
        onClose={() => setOpen(false)}
        open={open}
        storageKey="specimen"
      >
        <InspectorSection id="preview" title="Preview">
          <div style={{ ...tile, aspectRatio: "16 / 9" }} />
        </InspectorSection>
        <InspectorSection id="details" title="Details">
          <label style={field}>
            Name
            <TextInput maxLength={180} onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label style={field}>
            Description
            <Textarea defaultValue="The skyline from Riverfront Park at dusk." rows={3} />
          </label>
        </InspectorSection>
        <InspectorSection count={tags.length} id="tags" title="Tags">
          <TokenInput
            label="Tags"
            maxCount={20}
            maxLength={40}
            onChange={setTags}
            suggestions={PAGE_TAGS}
            suggestionsNote={SUGGESTION_NOTE}
            tokens={tags}
          />
        </InspectorSection>
        <InspectorSection count={2} defaultOpen={false} id="categories" title="Categories">
          <p>News (primary), Programs</p>
        </InspectorSection>
        <InspectorSection defaultOpen={false} id="file" title="File information">
          <p>2400 × 1600 · 1.2 MB · WebP</p>
        </InspectorSection>
      </Inspector>
    </div>
  );
}

const BULK_IMAGE_FIXTURES: MediaAssetSummary[] = ([
  ["statehouse", "Statehouse dome", domeImage, ["statehouse", "trenton"]],
  ["energy", "Energy and environment", energyImage, ["energy", "trenton"]],
  ["education", "Education in New Jersey", educationImage, ["education", "statehouse"]],
  ["dome", "Trenton skyline", domeImage, ["trenton", "exteriors"]],
  ["studio", "Newark studio", businessImage, ["studio", "interiors"]],
 ] as [string, string, string, string[]][]).map(([id, name, url, tags]) => ({
  id,
  name,
  originalName: `${id}.jpg`,
  category: "news",
  categories: ["news"],
  tags,
  description: id === "statehouse" ? "Inside the Statehouse." : null,
  altText: null,
  license: id === "statehouse" ? "NJ PBS owned" : null,
  credit: null,
  mimeType: "image/jpeg",
  kind: "image" as const,
  sizeBytes: 2048,
  width: 1280,
  height: 720,
  url,
  thumbnails: [{ url, width: 480, height: 270 }],
  source: "upload" as const,
  lifecycle: "active" as const,
  version: 1,
  etag: `"media.${id}.1"`,
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
}));

// Gallery specimen for bulk mode: "5 items", a
// 2 × 2 preview stack, Mixed fields with Leave unchanged, Set the same value and Clear menus,
// and mixed tag tokens with Replace all tags and Clear all tags. Local state only.
export function MediaInspectorBulkSpecimen() {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel" style={{ display: "flex", gap: "var(--cms-space-4)", alignItems: "flex-start", minHeight: "44rem" }}>
      <Results onOpen={() => setOpen(true)} />
      <MediaBulkInspector
        assets={BULK_IMAGE_FIXTURES}
        surface="images"
        open={open}
        offPageCount={2}
        pageTags={PAGE_TAGS}
        onCancel={() => setOpen(false)}
        onDirtyChange={() => {}}
        onReview={() => setOpen(false)}
      />
    </div>
  );
}

/** Types into the specimen's tag field once, so the suggestion list shows open. */
function useTypedQuery(query: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector<HTMLInputElement>("input[role='combobox']");
    if (!input || input.value === query) return;
    input.focus();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, [query]);
  return ref;
}

// Gallery specimen for tag suggestions: the list is open under the Tags field at the bottom of
// the details panel, above the panel's edge rather than clipped by its scrolling body, and its
// last line says where the suggestions come from. Local state only; nothing is requested.
export function MediaTokenSuggestionsSpecimen() {
  const [open, setOpen] = useState(true);
  const [tags, setTags] = useState<Token[]>([{ value: "energy" }, { value: "shore" }, { value: "b-roll" }]);
  const ref = useTypedQuery("tr");
  return (
    <div className="panel" ref={ref} style={{ display: "flex", gap: "var(--cms-space-4)", alignItems: "flex-start", minHeight: "36rem" }}>
      <Results onOpen={() => setOpen(true)} />
      <Inspector
        footer={(
          <>
            <Button variant="secondary">Cancel changes</Button>
            <Button variant="primary">Save details</Button>
          </>
        )}
        heading="Offshore wind turbines, Barnegat Bay"
        label="Image details"
        onClose={() => setOpen(false)}
        open={open}
        storageKey="specimen-suggestions"
      >
        <InspectorSection defaultOpen={false} id="preview" title="Preview">
          <img alt="" src={energyImage} style={{ width: "100%" }} />
        </InspectorSection>
        <InspectorSection defaultOpen={false} id="details" title="Details">
          <p>Name, filename, description and alt text</p>
        </InspectorSection>
        <InspectorSection count="NJ PBS owned" defaultOpen={false} id="rights" title="Rights">
          <p>License and credit</p>
        </InspectorSection>
        <InspectorSection count={tags.length} id="tags" title="Tags">
          <TokenInput
            label="Tags"
            maxCount={20}
            maxLength={40}
            onChange={setTags}
            suggestions={PAGE_TAGS}
            suggestionsNote={SUGGESTION_NOTE}
            tokens={tags}
          />
        </InspectorSection>
      </Inspector>
    </div>
  );
}

// Gallery specimen for the docked mode inside a viewer dialog (4d uses it for video). The
// viewer owns Escape, focus and closing: the inspector has no close control and no resize
// handle, does not take focus on open, and stacks under the player under 62rem. Not captured.
export function MediaInspectorDockedSpecimen() {
  const [open, setOpen] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (open ? closeRef : openerRef).current?.focus();
  }, [open]);

  if (!open) return <Button onClick={() => setOpen(true)} ref={openerRef}>Open viewer</Button>;
  return (
    <div
      aria-label="Video viewer"
      className="gx-viewer"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setOpen(false);
      }}
      role="dialog"
    >
      <header className="gx-viewer-header">
        <h2>Statehouse B-roll, spring session</h2>
        <Button onClick={() => setOpen(false)} ref={closeRef} variant="secondary">Close viewer</Button>
      </header>
      <div className="gx-viewer-body">
        <div className="gx-viewer-player">Player</div>
        <Inspector docked heading="Statehouse B-roll, spring session" label="Video details" open storageKey="specimen-docked">
          <InspectorSection id="details" title="Details">
            <label style={field}>
              Name
              <TextInput defaultValue="Statehouse B-roll, spring session" />
            </label>
          </InspectorSection>
          <InspectorSection count={2} id="tags" title="Tags">
            <p>statehouse, b-roll</p>
          </InspectorSection>
        </Inspector>
      </div>
    </div>
  );
}

const VIDEO_ASSET: SourceMediaAssetSummary = {
  id: "video-gallery-1",
  sourceId: "video-library",
  name: "Statehouse B-roll, spring session",
  description: "Wide and detail shots from the Statehouse chamber.",
  originalName: "statehouse-spring-session.mov",
  mimeType: "video/quicktime",
  kind: "video",
  sizeBytes: 3.5 * 1024 ** 3,
  preview: "download_only",
  license: "NJ PBS owned",
  credit: "NJ PBS newsroom",
  tags: ["statehouse", "b-roll"],
  rightsStatus: "complete",
  version: 4,
  createdAt: "2026-09-18T14:30:00.000Z",
  updatedAt: "2026-09-24T16:45:00.000Z",
  uploadedBy: { uid: "gallery-user", name: "Alex Rivera" },
  viewingCopy: {
    state: "ready",
    sizeBytes: 180 * 1024 ** 2,
    width: 1920,
    height: 1080,
    durationSeconds: 166,
  },
};

/** The shipped video viewer and details column with local data and no requests. */
export function VideoViewerInspectorSpecimen({
  getIdToken = async () => "gallery-token",
}: {
  getIdToken?: () => Promise<string>;
} = {}) {
  const [assets, setAssets] = useState(() => Array.from({ length: 24 }, (_, index) => index === 2 ? VIDEO_ASSET : {
    ...VIDEO_ASSET,
    id: `gallery-video-${index + 1}`,
    name: `Local sample video ${index + 1}`,
  }));
  const [activeRef, setActiveRef] = useState({ backend: "s3" as const, sourceId: VIDEO_ASSET.sourceId, id: VIDEO_ASSET.id });
  const [open, setOpen] = useState(true);
  const [favorites, setFavorites] = useState<string[]>([]);
  const opener = useRef<HTMLButtonElement>(null);
  const items: MediaFullViewerItem[] = assets.map(asset => ({
    ref: { backend: "s3", sourceId: asset.sourceId, id: asset.id },
    kind: "video",
    name: asset.name,
    footerNote: "Private media stays in the staff library.",
    actions: <MediaPreviewHeaderActions
      copyLink={`/media/videos?asset=${asset.id}`}
      favorite={{ name: asset.name, favorite: favorites.includes(asset.id), onToggle: () => setFavorites(current =>
        current.includes(asset.id) ? current.filter(id => id !== asset.id) : [...current, asset.id]) }}
      downloads={<Menu label="Download" tooltip="Download" icon="download" variant="primary" items={[
        { key: "web", label: "Web copy", onSelect: () => undefined },
        { key: "original", label: "Original", onSelect: () => undefined },
      ]}>Download</Menu>}
    />,
  }));

  return <>
    <Button ref={opener} onClick={() => setOpen(true)}>Open video viewer</Button>
    {open ? <MediaFullViewer
      activeRef={activeRef}
      items={items}
      onClose={() => setOpen(false)}
      onStep={item => { if (item.ref.backend === "s3") setActiveRef(item.ref); }}
      focusItem={() => { opener.current?.focus(); return Boolean(opener.current); }}
      focusFallback={() => opener.current?.focus()}
      renderBody={({ item, dirtyPrompt, footerActionsTarget, onDirtyChange, onSavingChange }) => {
        const asset = assets.find(value => value.id === item.ref.id)!;
        return <>
          <div className="component-editor-dialog-content">
            {dirtyPrompt}
            <div className="gx-video-player" aria-label="Video preview placeholder">Video preview</div>
            <p className="source-video-ready">Preview ready to watch in your browser.</p>
            <div className="gx-video-production">
              <Button>Request transcript</Button>
              <Button>Create clip</Button>
              <p>Production tools stay under the player.</p>
            </div>
          </div>
          <aside className="component-editor-dialog-settings" role="none">
            <VideoDetailsInspector key={asset.id}
              asset={asset}
              canDelete
              canEditMetadata
              deleteConfirmationId="gallery-video-delete-confirmation"
              footerTarget={footerActionsTarget}
              getIdToken={getIdToken}
              onDeleted={() => setOpen(false)}
              onDirtyChange={onDirtyChange}
              onSavingChange={onSavingChange}
              onUpdated={updated => setAssets(current => current.map(value => value.id === updated.id ? updated : value))}
              pageTags={["trenton", "legislature", "interview"]}
              recentTags={["newsroom", "archive"]}
            />
          </aside>
        </>;
      }}
    /> : null}
  </>;
}
