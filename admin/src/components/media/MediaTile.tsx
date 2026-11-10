import { originalStatusLabel } from "../../lib/video-original";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import type { MediaAssetSummary } from "../../lib/functions";
import type { MediaCardField, VideoMediaCardField } from "../../lib/media-display";
import { DEFAULT_VIDEO_MEDIA_DISPLAY, mediaCardFactEntries, VIDEO_MEDIA_CARD_FIELD_ORDER } from "../../lib/media-display";
import { formatMediaBytes, formatMediaDuration, formatMediaUpdated, formatVideoBytes, viewingCopyStatus } from "../../lib/media-format";
import { imageHoverFacts, MEDIA_HOVER_DELAY_MS, videoHoverFacts } from "../../lib/media-hover-facts";
import { mediaImageSources } from "../../lib/media-image";
import { lockedMenuActions, mediaClusterActions, mediaMenuItems, mediaTileActions, settledMenuActions, type MediaTileAction, type MediaTileActionId } from "../../lib/media-tile-actions";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { ActionControl } from "../ui/ActionControl";
import { AssetImage } from "../ui/AssetImage";
import { Checkbox } from "../ui/Checkbox";
import { Chip } from "../ui/Chip";
import { HoverCard } from "../ui/HoverCard";
import { Icon, type IconName } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { StatusBadge } from "../ui/Primitives";
import { MediaHoverFacts } from "./MediaHoverFacts";
import { AudioCardPlayback, audioTakeFacts, type AudioToken } from "./AudioMedia";
import "./MediaTile.css";

// One media card for the images and video libraries. The open control comes first in the DOM so a
// grid can rove focus to it; Tab then walks the mark and the quick actions. The thumbnail sits above the caption by CSS order only.

interface MediaTileCommonProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> {
  /** Undefined while favorites load: the heart is disabled and says so. */
  favorite: boolean | undefined;
  favoritePending?: boolean;
  /** False for an archived or unavailable item; its favorite action is hidden. */
  available?: boolean;
  selected: boolean;
  /** A selection exists on this surface: every mark shows and the quick actions hide. */
  selectionMode: boolean;
  /** This item's details are open in the inspector or viewer. */
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
  /** The current multi-selection's actions for this selected card's visible More button. */
  selectionMenu?: { count: number; actions: readonly MediaTileAction[]; onAction: (id: MediaTileActionId) => void };
  /**
   * True while details or an upload hold unsaved work: the mark and quick actions are disabled
   * and More offers only Open details. The name still opens, through the leave prompt.
   */
  actionsDisabled?: boolean;
  /**
   * False takes every control out of the tab order. A roving grid passes true only for the
   * card that holds its one tab stop. Defaults to true.
   */
  tabbable?: boolean;
}

export interface MediaImageTileProps extends MediaTileCommonProps {
  surface: "images";
  asset: MediaAssetSummary;
  /** Display's card fields; the meta line follows them. */
  fields: Record<MediaCardField, boolean>;
  categoryLabel: (id: string) => string;
  getAudioToken?: AudioToken;
}

export interface MediaVideoTileProps extends MediaTileCommonProps {
  surface: "video";
  asset: SourceMediaAssetSummary;
  /** Display's video card fields. Omitted callers keep the video defaults. */
  fields?: Record<VideoMediaCardField, boolean>;
  /** The poster. Reading it needs a request, so the library owns it, not the tile. */
  thumbnail: ReactNode;
  /** Makes each tag chip apply the tag filter. Without it the card shows no tag chips. */
  onTagFilter?: (tag: string) => void;
}

export type MediaTileProps = MediaImageTileProps | MediaVideoTileProps;

interface TileBadge {
  key: string;
  text: string;
  icon?: IconName;
  className?: string;
  field?: VideoMediaCardField;
}

interface VideoTileFact {
  field: VideoMediaCardField;
  text: string;
}

const VIDEO_TAG_LIMIT = 3;

function videoDuration(asset: SourceMediaAssetSummary): string | null {
  const copy = asset.viewingCopy;
  return copy?.state === "ready" && copy.durationSeconds !== undefined ? formatMediaDuration(copy.durationSeconds) : null;
}

function videoCardFactEntries(
  asset: SourceMediaAssetSummary,
  fields: Record<VideoMediaCardField, boolean>,
): VideoTileFact[] {
  const duration = videoDuration(asset);
  const updated = formatMediaUpdated(asset.updatedAt);
  const facts: Record<VideoMediaCardField, string | null> = {
    type: "Video",
    size: `Original ${formatVideoBytes(asset.sizeBytes)}`,
    duration,
    rights: asset.rightsStatus === "pending" ? "Needs review" : "Rights recorded",
    updated: updated ? `Updated ${updated}` : null,
    tags: asset.tags.length === 0 ? "No tags" : asset.tags.join(", "),
    uploader: asset.uploadedBy ? `Uploaded by ${asset.uploadedBy.name}` : "Uploader not recorded",
  };
  return VIDEO_MEDIA_CARD_FIELD_ORDER.flatMap((field) => (
    fields[field] && facts[field] ? [{ field, text: facts[field] as string }] : []
  ));
}

/** The open control's name: the item name plus its status words. */
export type MediaTileLabelInput =
  | { surface: "images"; asset: MediaAssetSummary; favorite: boolean | undefined }
  | { surface: "video"; asset: SourceMediaAssetSummary; favorite: boolean | undefined };

export function mediaTileOpenLabel(props: MediaTileLabelInput): string {
  const favorite = props.favorite ? ", favorite" : "";
  if (props.surface === "images") {
    const { asset } = props;
    return `${asset.name}, ${asset.kind === "document" ? "PDF" : asset.kind === "audio" ? "audio" : "image"}, ${formatMediaBytes(asset.sizeBytes)}${favorite}`;
  }
  const duration = videoDuration(props.asset);
  const review = props.asset.rightsStatus === "pending" ? ", needs review" : "";
  return `${props.asset.name}, video${duration ? `, ${duration}` : ""}${review}${favorite}`;
}

function favoriteBadge(favorite: boolean | undefined): TileBadge[] {
  return favorite ? [{ key: "favorite", text: "Favorite", icon: "heart", className: "media-tile-badge-favorite" }] : [];
}

export function MediaTile(props: MediaTileProps) {
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
    surface,
    tabbable = true,
    ...rest
  } = props;
  const tabIndex = tabbable ? undefined : -1;
  const factsId = `${useId()}-facts`;
  const name = asset.name;
  const actions = actionOverride ?? mediaTileActions({
    surface,
    name,
    favorite: favorite === true,
    available,
    selected,
    canDelete,
    quickLook,
    openFullSize,
    copyFileAddress: props.surface === "images" && props.asset.kind === "image" && Boolean(props.asset.url),
    uploader: surface === "video" && showUploaderFilter ? props.asset.uploadedBy : undefined,
  });
  const cluster = mediaClusterActions(actions);
  // Strip the variant props so they never reach the root element.
  const rootProps = { ...rest } as Record<string, unknown>;
  for (const key of ["fields", "categoryLabel", "thumbnail", "onTagFilter", "getAudioToken"]) delete rootProps[key];

  let thumbnail: ReactNode;
  let caption: ReactNode;
  let tags: ReactNode = null;
  let badges: TileBadge[];
  let description: string;
  let hoverFacts;
  let kind: "image" | "document" | "video" | "audio";

  if (props.surface === "images") {
    const image = props.asset;
    kind = image.kind;
    thumbnail = image.kind === "image" ? (
      <AssetImage
        {...mediaImageSources(image, 480)}
        alt=""
        decoding="async"
        fallback={<span className="media-tile-placeholder"><Icon name="image" /></span>}
        loading="lazy"
      />
    ) : (
      <span aria-hidden="true" className="media-tile-document">{image.kind === "audio" ? <Icon name="microphone" /> : <span className="media-tile-document-page" />}</span>
    );
    const facts = mediaCardFactEntries(image, props.fields, props.categoryLabel);
    const takeFacts = image.kind === "audio" ? audioTakeFacts(image) : [];
    const fileFacts = facts.filter((fact) => fact.field !== "tags");
    const tagFact = facts.find((fact) => fact.field === "tags");
    caption = <>
      {takeFacts.length > 0 ? <p className="media-audio-facts">
        {takeFacts.map(fact => <span key={fact}>{fact}</span>)}
      </p> : null}
      {facts.length > 0 ? <p className="media-tile-meta">
        {fileFacts.length > 0 ? (
          <span className="media-tile-meta-line">
            {fileFacts.map((fact, index) => (
              <span data-field={fact.field} key={fact.field}>{`${index > 0 ? " · " : ""}${fact.text}`}</span>
            ))}
          </span>
        ) : null}
        {tagFact ? (
          <span className="media-tile-meta-line" data-field="tags">
            {fileFacts.length > 0 ? <span className="media-tile-meta-sep"> · </span> : null}
            {tagFact.text}
          </span>
        ) : null}
      </p> : null}
      {image.kind === "audio" ? <AudioCardPlayback asset={image} getIdToken={props.getAudioToken} tabIndex={tabIndex} /> : null}
    </>;
    badges = [...favoriteBadge(favorite), ...(image.kind === "document" ? [{ key: "type", text: "PDF" }] : [])];
    // Type and size are already in the name; the description carries the other card facts.
    description = [...takeFacts, ...facts.filter((fact) => fact.field !== "type" && fact.field !== "size").map((fact) => fact.text)].join(", ");
    hoverFacts = imageHoverFacts(image, props.categoryLabel);
  } else {
    const video = props.asset;
    const fields = props.fields ?? DEFAULT_VIDEO_MEDIA_DISPLAY.fields;
    kind = "video";
    thumbnail = props.thumbnail;
    const status = viewingCopyStatus(video);
    const duration = videoDuration(video);
    const webCopy = video.viewingCopy?.state === "ready" && video.viewingCopy.sizeBytes
      ? formatVideoBytes(video.viewingCopy.sizeBytes)
      : null;
    const uploader = video.uploadedBy ? `Uploaded by ${video.uploadedBy.name}` : "Uploader not recorded";
    const updated = formatMediaUpdated(video.updatedAt);
    const onTagFilter = props.onTagFilter;
    const facts = videoCardFactEntries(video, fields);
    const metaFacts = facts.filter((fact) => !["duration", "rights", "tags"].includes(fact.field));
    caption = (
      <>
        <span className="media-tile-status">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <StatusBadge tone="neutral">{originalStatusLabel(video.original)}</StatusBadge>
          {status.detail ? <span>{status.detail}</span> : null}
        </span>
        {metaFacts.length > 0 ? (
          <p className="media-tile-meta">
            <span className="media-tile-meta-line">
              {metaFacts.map((fact, index) => (
                <span data-field={fact.field} key={fact.field}>{`${index > 0 ? " · " : ""}${fact.text}`}</span>
              ))}
            </span>
          </p>
        ) : null}
      </>
    );
    // The chips follow the card controls in Tab order; CSS shows them under the caption.
    tags = fields.tags && onTagFilter ? (
      <div aria-label={`Tags for ${name}`} className="media-tile-tags" data-field="tags" role="group">
        {video.tags.length === 0 ? <span className="media-tile-tag-more">No tags</span> : null}
        {video.tags.slice(0, VIDEO_TAG_LIMIT).map((tag) => (
          <Chip
            key={tag}
            label={`Filter by tag ${tag}`}
            onSelect={() => onTagFilter(tag)}
            tabIndex={tabIndex}
            value={tag}
            variant="tag"
          />
        ))}
        {video.tags.length > VIDEO_TAG_LIMIT ? (
          <span className="media-tile-tag-more">
            +{video.tags.length - VIDEO_TAG_LIMIT}
            <span className="sr-only"> more {video.tags.length - VIDEO_TAG_LIMIT === 1 ? "tag" : "tags"}</span>
          </span>
        ) : null}
      </div>
    ) : null;
    badges = [
      ...favoriteBadge(favorite),
      ...(fields.duration && duration ? [{ key: "duration", text: duration, field: "duration" as const }] : []),
      ...(fields.rights ? [{ key: "review", text: video.rightsStatus === "pending" ? "Needs review" : "Rights recorded",
        icon: "flag" as const, field: "rights" as const }] : []),
    ];
    description = [
      status.label,
      status.detail,
      video.description,
      duration ? `Duration ${duration}` : null,
      `Original ${formatVideoBytes(video.sizeBytes)}`,
      webCopy ? `Web copy ${webCopy}` : null,
      uploader,
      updated ? `Updated ${updated}` : null,
    ].filter(Boolean).join(". ");
    hoverFacts = videoHoverFacts(video);
  }

  const favoriteLabel = favorite === undefined
    ? "Loading favorite"
    : favoritePending
      ? "Saving favorite"
      : favorite ? "Remove from favorites" : "Add to favorites";
  const menuActions = lockedMenuActions(settledMenuActions([...actions], favorite !== undefined && !favoritePending), actionsDisabled);

  return (
    <div
      {...rootProps}
      className={["media-tile", className].filter(Boolean).join(" ")}
      data-kind={kind}
      data-opened={opened || undefined}
      data-selected={selected || undefined}
      data-selection-mode={selectionMode || undefined}
      data-surface={surface}
    >
      <div className="media-tile-caption">
        <h3 className="media-tile-name">
          <HoverCard
            content={<MediaHoverFacts facts={hoverFacts} />}
            delay={MEDIA_HOVER_DELAY_MS}
            focusDelay={MEDIA_HOVER_DELAY_MS}
            label={`Details for ${name}`}
          >
            <button
              aria-describedby={description ? factsId : undefined}
              aria-label={mediaTileOpenLabel(props)}
              className="media-tile-open"
              data-media-open=""
              onClick={onOpen}
              tabIndex={tabIndex}
              type="button"
            >
              {name}
            </button>
          </HoverCard>
        </h3>
        {caption}
        {description ? <span className="sr-only" id={factsId}>{description}</span> : null}
      </div>
      <div className="media-tile-thumb">
        {thumbnail}
        <Checkbox
          checked={selected}
          className="media-tile-mark"
          disabled={actionsDisabled}
          hideLabel
          label={`Select ${name}`}
          onChange={(event) => onSelectChange(event.currentTarget.checked, {
            shiftKey: Boolean((event.nativeEvent as MouseEvent).shiftKey),
          })}
          tabIndex={tabIndex}
        />
        {/* In selection mode only More stays; CSS shows it on phones and touch screens, which
            always keep the checkbox and More. */}
        <div aria-label={`Actions for ${name}`} className="media-tile-actions" role="group">
          {(selectionMode ? [] : cluster).map((action) => action.id === "favorite" ? (
            <ActionControl
              action="media-favorite"
              size="compact"
              aria-busy={favoritePending || undefined}
              aria-pressed={favorite === true}
              className="media-tile-action media-tile-favorite"
              contextLabel={name}
              disabled={favorite === undefined || actionsDisabled}
              graphic={<Icon name="heart" />}
              key={action.id}
              label={favoriteLabel}
              onClick={() => {
                if (!favoritePending) onAction("favorite");
              }}
              tabIndex={tabIndex}
              variant="ghost"
            />
          ) : (
            <ActionControl
              action="media-collect"
              size="compact"
              className="media-tile-action media-tile-collect"
              contextLabel={name}
              disabled={actionsDisabled}
              key={action.id}
              label={action.label}
              onClick={() => onAction(action.id)}
              tabIndex={tabIndex}
              variant="ghost"
            />
          ))}
          <Menu
            className="media-tile-action media-tile-more"
            items={selectionMenu ? mediaMenuItems(selectionMenu.actions, selectionMenu.onAction) : mediaMenuItems(menuActions, onAction)}
            label={selectionMenu ? `More actions: ${selectionMenu.count} items` : `More actions: ${name}`}
            tabIndex={tabIndex}
            tooltip="More actions"
          />
        </div>
        <div className="media-tile-badges">
          {badges.map((badge) => (
            <span className={["media-tile-badge", badge.className].filter(Boolean).join(" ")} data-field={badge.field} key={badge.key}>
              {badge.icon ? <><Icon name={badge.icon} /><span>{badge.text}</span></> : badge.text}
            </span>
          ))}
        </div>
      </div>
      {tags}
    </div>
  );
}
