import { originalStatusLabel } from "../../lib/video-original";
import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode } from "react";
import type { MediaAssetSummary, MediaSortDirection, MediaSortField } from "../../lib/functions";
import {
  DEFAULT_MEDIA_DISPLAY,
  DEFAULT_VIDEO_MEDIA_DISPLAY,
  listColumns,
  mediaCardFactEntries,
  VIDEO_MEDIA_CARD_FIELD_ORDER,
  type MediaCardField,
  type MediaListColumn,
  type VideoMediaCardField,
} from "../../lib/media-display";
import { headingSort, headingSortField } from "../../lib/media-filters";
import { formatMediaDuration, formatMediaUpdated, formatVideoBytes, viewingCopyStatus } from "../../lib/media-format";
import { imageHoverFacts, MEDIA_HOVER_DELAY_MS, videoHoverFacts } from "../../lib/media-hover-facts";
import { mediaImageSources } from "../../lib/media-image";
import type { PageSelectionState } from "../../lib/media-selection";
import { lockedMenuActions, mediaMenuItems, mediaTileActions, settledMenuActions, type MediaTileAction, type MediaTileActionId } from "../../lib/media-tile-actions";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { ActionControl } from "../ui/ActionControl";
import { AssetImage } from "../ui/AssetImage";
import { Checkbox } from "../ui/Checkbox";
import { HoverCard } from "../ui/HoverCard";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { StatusBadge } from "../ui/Primitives";
import { MediaHoverFacts } from "./MediaHoverFacts";
import { audioTakeFacts } from "./AudioMedia";
import { mediaTileOpenLabel } from "./MediaTile";
import "./MediaRow.css";

// One row of the images or video list layout:
// the mark, a thumbnail, the name, the columns, then Favorite and More. Images take their
// columns from Display's fields plus Updated last. Video columns follow
// that surface's Display fields. Each row is its own size container, so the header and every row
// collapse at the same widths: under 70rem the wide columns move into the name's meta line,
// under 54rem video keeps only Rights, and under 43rem the row is mark, thumbnail, name with
// meta, and More. A column that hides always leaves its fact in the meta line, and facts wrap
// rather than clip: a touch screen has no hover card to show a clipped fact.

/** The study asset row's rendered image width. */
const ROW_THUMB_WIDTH = 60;

const COLUMN_WIDTHS: Record<MediaCardField, string> = {
  type: "4.5rem",
  category: "7rem",
  size: "5.5rem",
  dimensions: "7.5rem",
  updated: "10rem",
  tags: "4.5rem",
};

const COLUMN_LABELS: Record<MediaCardField, string> = {
  type: "Type",
  category: "Category",
  size: "Size",
  dimensions: "Dimensions",
  updated: "Updated",
  tags: "Tags",
};

/** Columns that move into the name's meta line under 70rem. */
const MEDIUM_HIDDEN = new Set<MediaCardField>(["type", "category", "dimensions", "tags"]);

export type MediaVideoColumn = VideoMediaCardField;

interface RowColumn {
  key: string;
  label: string;
  width: string;
  /** Moves into the name's meta line on medium widths. */
  wide: boolean;
  /** Video only: also moves into the meta line under 54rem. */
  narrow?: boolean;
}

/** Video columns use Display's order. Less essential facts move into the meta line first. */
const VIDEO_COLUMN_DEFINITIONS: Readonly<Record<MediaVideoColumn, RowColumn>> = {
  type: { key: "type", label: "Type", width: "4.5rem", wide: true },
  size: { key: "size", label: "Size", width: "5.5rem", wide: false, narrow: true },
  duration: { key: "duration", label: "Duration", width: "4.5rem", wide: true },
  rights: { key: "rights", label: "Rights", width: "8rem", wide: false },
  updated: { key: "updated", label: "Updated", width: "10rem", wide: false, narrow: true },
  tags: { key: "tags", label: "Tags", width: "10rem", wide: true },
  uploader: { key: "uploader", label: "Uploaded by", width: "8rem", wide: true },
};

type RowColumnStyle = CSSProperties & Record<"--media-row-columns" | "--media-row-columns-medium", string>
  & Partial<Record<"--media-row-columns-narrow", string>>;

function fieldColumns(columns: MediaListColumn[]): MediaCardField[] {
  return columns.filter((column): column is MediaCardField => column !== "name");
}

function imageColumns(fields: Record<MediaCardField, boolean>): RowColumn[] {
  return fieldColumns(listColumns(fields)).map((column) => ({
    key: column,
    label: COLUMN_LABELS[column],
    width: COLUMN_WIDTHS[column],
    wide: MEDIUM_HIDDEN.has(column),
  }));
}

function videoColumns(fields: Record<VideoMediaCardField, boolean>): RowColumn[] {
  return VIDEO_MEDIA_CARD_FIELD_ORDER.filter((field) => fields[field]).map((field) => VIDEO_COLUMN_DEFINITIONS[field]);
}

function template(thumb: string, columns: readonly RowColumn[]): string {
  return [
    "var(--cms-control-compact-target)",
    thumb,
    "minmax(10rem, 1fr)",
    ...columns.map((column) => column.width),
    "calc(2 * var(--cms-control-compact-target) + var(--cms-space-2))",
  ].join(" ");
}

function columnStyle(thumb: string, columns: readonly RowColumn[]): RowColumnStyle {
  return {
    "--media-row-columns": template(thumb, columns),
    "--media-row-columns-medium": template(thumb, columns.filter((column) => !column.wide)),
  };
}

/** The shared track lists for the header and every row. */
export function mediaRowColumnStyle(fields: Record<MediaCardField, boolean>): RowColumnStyle {
  return columnStyle("60px", imageColumns(fields));
}

/** The video list's track lists: a 16:9 poster column and Display's video columns. */
export function videoRowColumnStyle(fields: Record<VideoMediaCardField, boolean>): RowColumnStyle {
  const columns = videoColumns(fields);
  return {
    ...columnStyle("4rem", columns),
    "--media-row-columns-narrow": template("4rem", columns.filter((column) => !column.wide && !column.narrow)),
  };
}

function cellClass(column: RowColumn): string {
  return ["media-row-cell", column.wide ? "media-row-cell-wide" : "", column.narrow ? "media-row-cell-narrow" : ""].filter(Boolean).join(" ");
}

export interface MediaRowHeaderProps {
  /** Display's card fields. Video and images each use their surface's field set. */
  fields?: Record<MediaCardField, boolean> | Record<VideoMediaCardField, boolean>;
  /** "video" gives the video list a poster column. Defaults to images. */
  surface?: "images" | "video";
  /** Makes the backend-supported headings sortable. Without it headings are plain text. */
  sort?: {
    sort: MediaSortField;
    direction: MediaSortDirection;
    onSortChange: (next: { sort: MediaSortField; direction: MediaSortDirection; page: 1 }) => void;
  };
  /** Puts the tri-state Select this page in the mark column. */
  pageSelection?: {
    state: PageSelectionState;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
  };
}

function headerSortField(column: string, surface: "images" | "video"): MediaSortField | null {
  if (surface === "video") {
    if (column === "name") return "name";
    if (column === "size") return "sizeBytes";
    if (column === "updated") return "updatedAt";
    return null;
  }
  return headingSortField(column as MediaListColumn);
}

function nextHeaderSort(
  column: string,
  surface: "images" | "video",
  current: { sort: MediaSortField; direction: MediaSortDirection },
): { sort: MediaSortField; direction: MediaSortDirection; page: 1 } | null {
  const field = headerSortField(column, surface);
  if (!field) return null;
  // The video backend has no descending name index. Re-selecting Name keeps its one valid order.
  if (surface === "video" && field === "name") return { sort: "name", direction: "asc", page: 1 };
  return headingSort(column, current);
}

// Headings sort only where the surface's backend supports a sort; only the sorted column carries
// aria-sort and an arrow (the APG sortable table).
function HeadingLabel({ column, label, sort, surface }: {
  column: string;
  label: string;
  sort: MediaRowHeaderProps["sort"];
  surface: "images" | "video";
}) {
  const field = headerSortField(column, surface);
  if (!sort || !field) return <>{label}</>;
  const sorted = sort.sort === field;
  return (
    <button
      className="media-row-sort"
      data-sorted={sorted || undefined}
      onClick={() => {
        const next = nextHeaderSort(column, surface, sort);
        if (next) sort.onSortChange(next);
      }}
      type="button"
    >
      {label}
      {sorted ? <Icon name={sort.direction === "asc" ? "arrow-up" : "arrow-down"} /> : null}
    </button>
  );
}

function ariaSort(column: string, surface: "images" | "video", sort: MediaRowHeaderProps["sort"]): "ascending" | "descending" | undefined {
  if (!sort || headerSortField(column, surface) !== sort.sort) return undefined;
  return sort.direction === "asc" ? "ascending" : "descending";
}

export function MediaRowHeader({ fields, pageSelection, sort, surface = "images" }: MediaRowHeaderProps) {
  const video = surface === "video";
  const imageFields = (fields ?? DEFAULT_MEDIA_DISPLAY.fields) as Record<MediaCardField, boolean>;
  const videoFields = (fields ?? DEFAULT_VIDEO_MEDIA_DISPLAY.fields) as Record<VideoMediaCardField, boolean>;
  const columns = video ? videoColumns(videoFields) : imageColumns(imageFields);
  return (
    <div
      className="media-row media-row-header"
      data-surface={video ? "video" : undefined}
      role="row"
      style={video ? videoRowColumnStyle(videoFields) : mediaRowColumnStyle(imageFields)}
    >
      <div className="media-row-track">
        <span className="media-row-mark-cell" role="columnheader">
          {pageSelection ? (
            <Checkbox size="compact"
              checked={pageSelection.state === "all"}
              className="media-row-mark"
              disabled={pageSelection.disabled}
              hideLabel
              indeterminate={pageSelection.state === "some"}
              label="Select this page"
              onChange={(event) => pageSelection.onChange(event.currentTarget.checked)}
            />
          ) : <span className="sr-only">Selected</span>}
        </span>
        <span role="columnheader"><span className="sr-only">{video ? "Poster" : "Preview"}</span></span>
        <span aria-sort={ariaSort("name", surface, sort)} className="media-row-main" role="columnheader">
          <HeadingLabel column="name" label="Name" sort={sort} surface={surface} />
        </span>
        {columns.map((column) => (
          <span aria-sort={ariaSort(column.key, surface, sort)} className={cellClass(column)} data-column={column.key} key={column.key} role="columnheader">
            <HeadingLabel column={column.key} label={column.label} sort={sort} surface={surface} />
          </span>
        ))}
        <span className="media-row-actions" role="columnheader"><span className="sr-only">Actions</span></span>
      </div>
    </div>
  );
}

interface MediaRowCommonProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> {
  /** Undefined while favorites load: the heart is disabled and says so. */
  favorite: boolean | undefined;
  favoritePending?: boolean;
  available?: boolean;
  selected: boolean;
  selectionMode?: boolean;
  opened?: boolean;
  canDelete: boolean;
  onOpen: () => void;
  quickLook?: boolean;
  showUploaderFilter?: boolean;
  openFullSize?: boolean;
  onSelectChange: (checked: boolean, modifiers: { shiftKey: boolean }) => void;
  onAction: (id: MediaTileActionId) => void;
  /** A mixed surface can supply its own bounded action set. */
  actionOverride?: readonly MediaTileAction[];
  /** The current multi-selection's actions for this selected row's visible More button. */
  selectionMenu?: { count: number; actions: readonly MediaTileAction[]; onAction: (id: MediaTileActionId) => void };
  /**
   * True while details or an upload hold unsaved work: the mark and Favorite are disabled and
   * More offers only Open details. The name still opens, through the leave prompt.
   */
  actionsDisabled?: boolean;
  /** False takes every control out of the tab order, for rows without the grid's tab stop. */
  tabbable?: boolean;
  /**
   * Wraps the row's cells, such as in MediaContextMenu. The row stays the grid's row and its
   * cells stay its gridcells: the wrapper sits where the cell track already sits, and the menu
   * it opens renders outside the grid.
   */
  wrapCells?: (cells: ReactElement) => ReactNode;
}

export interface MediaRowProps extends MediaRowCommonProps {
  surface?: "images";
  asset: MediaAssetSummary;
  fields: Record<MediaCardField, boolean>;
  categoryLabel: (id: string) => string;
}

export interface MediaVideoRowProps extends MediaRowCommonProps {
  surface: "video";
  asset: SourceMediaAssetSummary;
  /** Display's video fields; the list uses the same visible facts as the cards. */
  fields: Record<VideoMediaCardField, boolean>;
  /** A mixed Favorites list uses the image list's common column contract. */
  mixedFields?: Record<MediaCardField, boolean>;
  /** The poster. Reading it needs a request, so the library owns it, not the row. */
  thumbnail: ReactNode;
}

interface RowCell {
  column: RowColumn;
  /** The cell's content; null shows a dash read as None. */
  cell: ReactNode;
  /** The fact as the meta line words it, where no heading names it. */
  meta: string[];
}

function imageCells(asset: MediaAssetSummary, fields: Record<MediaCardField, boolean>, categoryLabel: (id: string) => string): RowCell[] {
  const facts = mediaCardFactEntries(asset, { ...fields, updated: true }, categoryLabel);
  return imageColumns(fields).map((column) => {
    const text = column.key === "updated"
      ? formatMediaUpdated(asset.updatedAt)
      : facts.find((fact) => fact.field === column.key)?.text ?? null;
    return { column, cell: text, meta: text ? [text] : [] };
  });
}

// The uploader is text; the filter lives in the row's menu. The meta line keeps
// the card's words: "Uploaded by NAME" or "Uploader not recorded".
function videoCells(asset: SourceMediaAssetSummary, fields: Record<VideoMediaCardField, boolean>): RowCell[] {
  const copy = asset.viewingCopy;
  const duration = copy?.state === "ready" && copy.durationSeconds !== undefined ? formatMediaDuration(copy.durationSeconds) : null;
  const size = formatVideoBytes(asset.sizeBytes);
  const updated = formatMediaUpdated(asset.updatedAt);
  const uploader = asset.uploadedBy?.name ?? null;
  const rights = asset.rightsStatus === "pending" ? "Needs review" : "Rights recorded";
  const tags = asset.tags.length > 0 ? asset.tags.join(", ") : null;
  const cells: Record<MediaVideoColumn, Omit<RowCell, "column">> = {
    type: { cell: "Video", meta: ["Video"] },
    size: { cell: size, meta: [size] },
    duration: { cell: duration, meta: duration ? [duration] : [] },
    rights: { cell: <StatusBadge tone={asset.rightsStatus === "pending" ? "pending" : "success"}>{rights}</StatusBadge>, meta: [rights] },
    updated: { cell: updated, meta: updated ? [`Updated ${updated}`] : [] },
    tags: { cell: tags, meta: tags ? [`Tags ${tags}`] : [] },
    uploader: {
      cell: uploader ?? "Uploader not recorded",
      meta: [uploader ? `Uploaded by ${uploader}` : "Uploader not recorded"],
    },
  };
  return videoColumns(fields).map((column) => ({ column, ...cells[column.key as MediaVideoColumn] }));
}

function mixedVideoCells(asset: SourceMediaAssetSummary, fields: Record<MediaCardField, boolean>): RowCell[] {
  const values: Record<MediaCardField, string | null> = {
    type: "Video",
    category: null,
    size: formatVideoBytes(asset.sizeBytes),
    dimensions: null,
    updated: formatMediaUpdated(asset.updatedAt),
    tags: asset.tags.length > 0 ? asset.tags.join(", ") : null,
  };
  return imageColumns(fields).map(column => {
    const value = values[column.key as MediaCardField];
    return { column, cell: value, meta: value ? [value] : [] };
  });
}

export function MediaRow(props: MediaRowProps | MediaVideoRowProps) {
  const {
    actionsDisabled = false,
    asset,
    available = true,
    canDelete,
    className,
    favorite,
    favoritePending = false,
    onAction,
    actionOverride,
    onOpen,
    onSelectChange,
    quickLook = false,
    showUploaderFilter = true,
    openFullSize = false,
    selectionMenu,
    opened = false,
    selected,
    selectionMode,
    style,
    surface = "images",
    tabbable = true,
    wrapCells,
    ...rest
  } = props;
  // Strip the variant props so they never reach the root element.
  const rootProps = { ...rest } as Record<string, unknown>;
  for (const key of ["fields", "categoryLabel", "thumbnail", "mixedFields"]) delete rootProps[key];
  const name = asset.name;
  const tabIndex = tabbable ? undefined : -1;

  let cells: RowCell[];
  let thumbnail: ReactNode;
  let hoverFacts;
  let openLabel: string;
  let rowStyle: RowColumnStyle;
  let kind: string;
  if (props.surface === "video") {
    cells = props.mixedFields ? mixedVideoCells(props.asset, props.mixedFields) : videoCells(props.asset, props.fields);
    thumbnail = props.thumbnail;
    hoverFacts = videoHoverFacts(props.asset);
    openLabel = mediaTileOpenLabel({ surface: "video", asset: props.asset, favorite });
    rowStyle = props.mixedFields ? mediaRowColumnStyle(props.mixedFields) : videoRowColumnStyle(props.fields);
    kind = "video";
  } else {
    const image = props.asset;
    cells = imageCells(image, props.fields, props.categoryLabel);
    thumbnail = image.kind === "image" ? (
      <AssetImage
        {...mediaImageSources(image, ROW_THUMB_WIDTH)}
        alt=""
        decoding="async"
        fallback={<Icon name="image" />}
        loading="lazy"
      />
    ) : <Icon name={image.kind === "audio" ? "microphone" : "file"} />;
    hoverFacts = imageHoverFacts(image, props.categoryLabel);
    openLabel = mediaTileOpenLabel({ surface: "images", asset: image, favorite });
    rowStyle = mediaRowColumnStyle(props.fields);
    kind = image.kind;
  }

  // The meta line under the name, in column order: between the medium and phone widths it holds
  // the facts whose columns hide there; on phones every column hides, so it holds them all,
  // Updated too. Each fact stays whole on its line, with its separator; the line breaks
  // between facts. Under 54rem the video meta line also holds Original and Updated.
  const factLine = (shown: RowCell[]) => {
    const texts = shown.flatMap((cell) => cell.meta);
    return texts.length === 0 ? null : texts.map((value, index) => {
      const more = index < texts.length - 1;
      return (
        <span key={index}>
          <span className="media-row-fact">{value}{more ? <span className="media-row-sep"> ·</span> : null}</span>
          {more ? " " : null}
        </span>
      );
    });
  };
  const sub = factLine(cells);
  const subMedium = factLine(cells.filter((cell) => cell.column.wide));
  const subNarrow = cells.some((cell) => cell.column.narrow)
    ? factLine(cells.filter((cell) => cell.column.wide || cell.column.narrow))
    : null;
  const videoStatus = props.surface === "video" ? viewingCopyStatus(props.asset) : null;
  const actions = actionOverride ?? mediaTileActions({
    surface,
    name,
    favorite: favorite === true,
    available,
    selected,
    canDelete,
    quickLook,
    openFullSize,
    copyFileAddress: props.surface !== "video" && props.asset.kind === "image" && Boolean(props.asset.url),
    uploader: props.surface === "video" && showUploaderFilter ? props.asset.uploadedBy : undefined,
  });
  const showFavorite = actions.some((action) => action.id === "favorite" && !action.hidden);
  const menuActions = lockedMenuActions(settledMenuActions([...actions], favorite !== undefined && !favoritePending), actionsDisabled);
  const favoriteLabel = favorite === undefined
    ? "Loading favorite"
    : favoritePending
      ? "Saving favorite"
      : favorite ? "Remove from favorites" : "Add to favorites";

  const track = (
    <div className="media-row-track">
      <span className="media-row-mark-cell" role="gridcell">
        <Checkbox size="compact"
          checked={selected}
          className="media-row-mark"
          disabled={actionsDisabled}
          hideLabel
          label={`Select ${name}`}
          onChange={(event) => onSelectChange(event.currentTarget.checked, {
            shiftKey: Boolean((event.nativeEvent as MouseEvent).shiftKey),
          })}
          tabIndex={tabIndex}
        />
      </span>
      <span className="media-row-thumb" role="gridcell">{thumbnail}</span>
      <span className="media-row-main" role="gridcell">
        <HoverCard
          content={<MediaHoverFacts facts={hoverFacts} />}
          delay={MEDIA_HOVER_DELAY_MS}
          focusDelay={MEDIA_HOVER_DELAY_MS}
          label={`Details for ${name}`}
        >
          <button
            aria-label={openLabel}
            className="media-row-open"
            data-media-open=""
            onClick={onOpen}
            tabIndex={tabIndex}
            type="button"
          >
            {name}
          </button>
        </HoverCard>
        {props.surface === "video" && props.mixedFields ? <StatusBadge tone="neutral">{originalStatusLabel(props.asset.original)}</StatusBadge> : null}
        {sub || favorite || videoStatus || (props.surface === "images" && props.asset.kind === "audio" && audioTakeFacts(props.asset).length > 0) ? (
          <span className="media-row-sub">
            {props.surface === "images" && props.asset.kind === "audio" ? <span className="media-row-audio-facts">
              {audioTakeFacts(props.asset).join(" · ")}
            </span> : null}
            {videoStatus ? <span className="media-row-sub-status"><StatusBadge tone={videoStatus.tone}>{videoStatus.label}</StatusBadge>
              {props.surface === "video" && !props.mixedFields ? <StatusBadge tone="neutral">{originalStatusLabel(props.asset.original)}</StatusBadge> : null}
              {videoStatus.detail ? ` ${videoStatus.detail}` : null}</span> : null}
            {favorite ? (
              <span className="media-row-sub-favorite">
                <Icon name="heart" />
                <span className="sr-only">Favorite</span>
                {sub ? " " : null}
              </span>
            ) : null}
            <span className="media-row-sub-medium">{subMedium}</span>
            {subNarrow ? <span className="media-row-sub-narrow">{subNarrow}</span> : null}
            <span className="media-row-sub-small">{sub}</span>
          </span>
        ) : null}
      </span>
      {cells.map(({ cell, column }) => (
        <span className={cellClass(column)} data-column={column.key} key={column.key} role="gridcell">
          {cell ?? <><span aria-hidden="true">—</span><span className="sr-only">None</span></>}
        </span>
      ))}
      <span className="media-row-actions" role="gridcell">
        {showFavorite ? (
          <ActionControl
            action="media-favorite"
            size="compact"
            aria-busy={favoritePending || undefined}
            aria-pressed={favorite === true}
            className="media-row-action media-row-favorite"
            contextLabel={name}
            disabled={favorite === undefined || actionsDisabled}
            key="favorite"
            label={favoriteLabel}
            onClick={() => {
              if (!favoritePending) onAction("favorite");
            }}
            tabIndex={tabIndex}
            variant="ghost"
          />
        ) : null}
        <Menu
          className="media-row-action media-row-more"
          items={selectionMenu ? mediaMenuItems(selectionMenu.actions, selectionMenu.onAction) : mediaMenuItems(menuActions, onAction)}
          label={selectionMenu ? `More actions: ${selectionMenu.count} items` : `More actions: ${name}`}
          tabIndex={tabIndex}
          tooltip="More actions"
        />
      </span>
    </div>
  );

  return (
    <div
      {...rootProps}
      aria-selected={selected}
      className={["media-row", className].filter(Boolean).join(" ")}
      data-kind={kind}
      data-opened={opened || undefined}
      data-selected={selected || undefined}
      data-selection-mode={selectionMode || undefined}
      data-surface={props.surface === "video" ? props.mixedFields ? "mixed-video" : "video" : undefined}
      role="row"
      style={{ ...style, ...rowStyle }}
    >
      {wrapCells ? wrapCells(track) : track}
    </div>
  );
}
