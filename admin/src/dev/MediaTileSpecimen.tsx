import { useState, type ReactNode } from "react";
import aboutImage from "../../../site/public/brand/spotlight/about.jpg";
import educationImage from "../../../site/public/brand/spotlight/education.jpg";
import housingImage from "../../../site/public/brand/spotlight/housing.jpg";
import domeImage from "../../../site/public/brand/spotlight/under-the-dome.jpg";
import { MediaRow, MediaRowHeader } from "../components/media/MediaRow";
import { MediaTile } from "../components/media/MediaTile";
import type { MediaAssetSummary } from "../lib/functions";
import { DEFAULT_MEDIA_DISPLAY, type MediaCardField } from "../lib/media-display";
import type { MediaTileActionId } from "../lib/media-tile-actions";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import "./MediaTileSpecimen.css";

// Gallery specimens for the shared media card and list row. No route uses them yet. Local fixture images and solid black and white
// data URIs only, fixed dates, and no favorites call: every action changes local state.

export const BLACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480'%3E%3Crect width='640' height='480' fill='%23000'/%3E%3C/svg%3E";
export const WHITE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='480'%3E%3Crect width='640' height='480' fill='%23fff'/%3E%3C/svg%3E";

const CATEGORY_LABELS: Record<string, string> = { news: "News", programs: "Programs", brand: "Brand" };
export const categoryLabel = (id: string) => CATEGORY_LABELS[id] ?? id;

export function image(id: string, name: string, src: string, overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id, name, originalName: `${id}.jpg`, category: "news", categories: ["news"],
    tags: ["trenton", "statehouse", "b-roll", "exteriors"], description: null, altText: null,
    license: null, credit: null, mimeType: "image/jpeg", kind: "image", sizeBytes: 2_202_009,
    width: 2400, height: 1600,
    // Never requested: a card reads only the 480px thumbnail below.
    url: `https://media.njpbs.org/${id}.jpg`,
    thumbnails: [{ url: src, width: 640, height: 480 }],
    lifecycle: "active", version: 1, etag: `"${id}.1"`, createdAt: null, createdBy: null,
    updatedAt: "2026-09-18T19:42:00.000Z", updatedBy: null, ...overrides,
  };
}

const PDF: MediaAssetSummary = image("budget-notes", "FY2027 budget briefing notes", WHITE, {
  kind: "document", mimeType: "application/pdf", sizeBytes: 831_898, width: null, height: null,
  thumbnails: undefined, url: "https://media.njpbs.org/budget-notes.pdf", tags: ["budget", "news"],
  updatedAt: "2026-09-17T20:55:00.000Z",
});

export function video(id: string, name: string, overrides: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary {
  return {
    id, sourceId: "video-library", name, description: null, originalName: `${id}.mp4`,
    mimeType: "video/mp4", kind: "video", sizeBytes: 3_758_096_384, preview: "download_only",
    viewingCopy: { state: "ready", durationSeconds: 3_492, width: 1920, height: 1080, sizeBytes: 402_653_184 },
    license: null, credit: null, tags: ["interview", "housing", "newark", "forum"], rightsStatus: "complete",
    version: 1, uploadedBy: { uid: "u-alex", name: "Alex Rivera" }, createdAt: null,
    updatedAt: "2026-09-16T22:20:00.000Z", ...overrides,
  };
}

interface TileState {
  favorite: boolean;
  selected: boolean;
  opened: boolean;
}

function useTileState(initial: Partial<TileState>) {
  const [state, setState] = useState<TileState>({ favorite: false, selected: false, opened: false, ...initial });
  return {
    ...state,
    onOpen: () => setState((current) => ({ ...current, opened: true })),
    onSelectChange: (checked: boolean) => setState((current) => ({ ...current, selected: checked })),
    onAction: (id: MediaTileActionId) => setState((current) => {
      if (id === "favorite") return { ...current, favorite: !current.favorite };
      if (id === "select") return { ...current, selected: !current.selected };
      if (id === "open") return { ...current, opened: true };
      return current;
    }),
  };
}

function Figure({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <figure className={["media-tile-specimen-figure", className].filter(Boolean).join(" ")}>
      {children}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

type SpecimenDrawnState = "hover" | "focus";

function ImageTile({ asset, drawn, selectionMode = false, ...initial }: Partial<TileState> & {
  asset: MediaAssetSummary;
  drawn?: SpecimenDrawnState;
  selectionMode?: boolean;
}) {
  const state = useTileState(initial);
  return (
    <MediaTile
      asset={asset}
      canDelete
      categoryLabel={categoryLabel}
      data-specimen-state={drawn}
      favorite={state.favorite}
      fields={DEFAULT_MEDIA_DISPLAY.fields}
      onAction={state.onAction}
      onOpen={state.onOpen}
      onSelectChange={state.onSelectChange}
      opened={state.opened}
      selected={state.selected}
      selectionMode={selectionMode || state.selected}
      surface="images"
    />
  );
}

function VideoTile({ asset, poster, ...initial }: Partial<TileState> & { asset: SourceMediaAssetSummary; poster: string }) {
  const state = useTileState(initial);
  const [tag, setTag] = useState<string | null>(null);
  return (
    <MediaTile
      asset={asset}
      canDelete
      data-filtered-tag={tag ?? undefined}
      favorite={state.favorite}
      onAction={state.onAction}
      onOpen={state.onOpen}
      onSelectChange={state.onSelectChange}
      onTagFilter={setTag}
      opened={state.opened}
      selected={state.selected}
      selectionMode={state.selected}
      surface="video"
      thumbnail={<img alt="" decoding="async" src={poster} />}
    />
  );
}

export function MediaTileSpecimen() {
  return (
    <div className="media-tile-specimen">
      <section aria-labelledby="media-tile-states">
        <h2 id="media-tile-states">Image cards</h2>
        <p className="media-tile-specimen-note">
          Hover and focus are drawn so the capture holds them. Tab from a name walks its mark and quick actions.
        </p>
        <ul className="media-tile-specimen-grid">
          <li><Figure caption="Rest"><ImageTile asset={image("dome", "Statehouse dome at dusk, Trenton", domeImage)} /></Figure></li>
          <li><Figure caption="Hover"><ImageTile asset={image("housing", "Rowhouse framing, Jersey City", housingImage)} drawn="hover" /></Figure></li>
          <li><Figure caption="Keyboard focus"><ImageTile asset={image("classroom", "Classroom desk, morning light", educationImage)} drawn="focus" /></Figure></li>
          <li><Figure caption="Opened in details"><ImageTile asset={image("about", "Studio control room during the evening broadcast", aboutImage)} opened /></Figure></li>
          <li><Figure caption="Favorite"><ImageTile asset={image("favorite", "Election desk map graphic", domeImage, { tags: ["elections"] })} favorite /></Figure></li>
          <li><Figure caption="PDF"><ImageTile asset={PDF} /></Figure></li>
        </ul>
      </section>
      <section aria-labelledby="media-tile-selection">
        <h2 id="media-tile-selection">Selection mode</h2>
        <ul className="media-tile-specimen-grid">
          <li><Figure caption="Selected, over a white image"><ImageTile asset={image("white", "White seamless backdrop", WHITE)} favorite selected /></Figure></li>
          <li><Figure caption="Not selected, over a black image"><ImageTile asset={image("black", "Black slate before the countdown", BLACK)} favorite selectionMode /></Figure></li>
          <li><Figure caption="Selected and opened"><ImageTile asset={image("both", "Offshore wind turbines, Barnegat Bay", housingImage)} opened selected /></Figure></li>
        </ul>
      </section>
      <section aria-labelledby="media-tile-video">
        <h2 id="media-tile-video">Video cards</h2>
        <ul className="media-tile-specimen-grid media-tile-specimen-video">
          <li>
            <Figure caption="Duration, Needs review and favorite, over a black poster">
              <VideoTile
                asset={video("forum", "Community forum: Housing and rent in Newark", { rightsStatus: "pending" })}
                favorite
                poster={BLACK}
              />
            </Figure>
          </li>
          <li>
            <Figure caption="Preparing web copy">
              <VideoTile
                asset={video("pathways", "Garden State pathways", {
                  preview: "browser", viewingCopy: { state: "processing" }, tags: ["program"], uploadedBy: null,
                })}
                poster={housingImage}
              />
            </Figure>
          </li>
        </ul>
      </section>
      <section aria-labelledby="media-tile-narrow">
        <h2 id="media-tile-narrow">Narrow tile</h2>
        <Figure caption="Keeps only More" className="media-tile-specimen-narrow">
          <ImageTile asset={image("narrow", "Hoboken storefronts, blue hour", educationImage)} drawn="hover" />
        </Figure>
      </section>
    </div>
  );
}

const LIST_FIELDS: Record<MediaCardField, boolean> = { ...DEFAULT_MEDIA_DISPLAY.fields };

function Row({ asset, drawn, ...initial }: Partial<TileState> & { asset: MediaAssetSummary; drawn?: "hover" }) {
  const state = useTileState(initial);
  return (
    <MediaRow
      asset={asset}
      canDelete
      categoryLabel={categoryLabel}
      data-specimen-state={drawn}
      favorite={state.favorite}
      fields={LIST_FIELDS}
      onAction={state.onAction}
      onOpen={state.onOpen}
      onSelectChange={state.onSelectChange}
      opened={state.opened}
      selected={state.selected}
    />
  );
}

function RowList({ label }: { label: string }) {
  return (
    <div aria-label={label} className="media-row-specimen-list" role="grid">
      <MediaRowHeader fields={LIST_FIELDS} />
      <Row asset={image("dome", "Statehouse dome at dusk, Trenton", domeImage)} />
      <Row asset={image("housing", "Rowhouse framing, Jersey City", housingImage)} drawn="hover" />
      <Row asset={image("classroom", "Classroom desk, morning light", educationImage)} selected />
      <Row asset={image("favorite", "Election desk map graphic with a long name that truncates", aboutImage)} favorite />
      <Row asset={PDF} />
    </div>
  );
}

export function MediaListRowSpecimen() {
  return (
    <div className="media-tile-specimen">
      <section aria-labelledby="media-row-wide">
        <h2 id="media-row-wide">List rows</h2>
        <p className="media-tile-specimen-note">Rest, hover (drawn), selected, favorite and PDF. Columns follow Display&apos;s fields plus Updated.</p>
        <RowList label="Images" />
      </section>
      <section aria-labelledby="media-row-narrow">
        <h2 id="media-row-narrow">At 36rem</h2>
        <p className="media-tile-specimen-note">Mark, thumbnail, the name with its meta line, and More.</p>
        <div className="media-row-specimen-narrow">
          <RowList label="Images at 36rem" />
        </div>
      </section>
    </div>
  );
}
