import { TownLookupEditor } from "./TownLookupEditor";
import { BioCardEditor } from "./BioCardEditor";
import { DocumentListEditor } from "./DocumentListEditor";
import { VideoBlockEditor } from "./VideoBlockEditor";
import { Icon } from "./ui/Icon";
import { InlineDataTable } from "./InlineDataTable";
import { InlineDataFigure } from "./InlineDataFigure";
import { ContentShelfPicker } from "./ContentShelfPicker";
import { RecordPickerDialog } from "./RecordPickerDialog";
import type { RecordCardKind } from "../../../packages/content-core/src/content-model";
import { isPublishable } from "../../../packages/content-core/src/publish-gate";
import { NewsletterSignupEditor } from "./NewsletterSignupEditor";
import "../../../packages/content-core/src/custom-shelf.css";
import { installCustomShelfControls } from "../../../packages/content-core/src/custom-shelf-controls";
import { AssetImage } from "./ui/AssetImage";
import { mediaImageSources, mediaPreviewImage, mediaPreviewUrl } from "../lib/media-image";
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import { ContentShelfSources } from "./ContentShelfPicker";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type { LibrarySelection } from "../lib/content-library";
import { editRecordPath } from "../lib/routes";
import { FieldRenderer } from "./FieldRenderer";
import { MediaPickerDialog, type MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { RichTextEditor } from "./RichTextEditor";
import { useResolvedMediaAsset, useResolvedMediaAssets } from "./useResolvedMediaAsset";
import { Button, Select, TextInput } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import {
  EMPTY_RICH_TEXT_DOC,
  emptyRichTextDoc,
  richTextIsEmpty,
} from "../lib/rich-text";
import { emptyItem } from "../lib/field-defaults";
import { useRemovalNotice } from "../context/RemovalNoticeContext";
import {
  collectionItemId,
  mintCollectionItemId,
} from "../lib/collection-item-keys";
import {
  galleryImageName,
  listItemName,
  removedAssetName,
} from "../lib/destructive-actions";
import {
  GALLERY_PRESENTATION_FIELD,
  HEADLINE_LEVEL_FIELD,
  blockHasSettings,
} from "../lib/block-settings";
import {
  editorFieldValidationMessage,
  richTextHasUnsafeLink,
} from "../lib/field-validation";
import {
  clampHeadingLevel,
  ctaVariantClass,
  renderBlock,
} from "../../../packages/content-core/src/content-render";
import {
  apResultsEditorFields,
  editorFieldsForBlock,
  type EditorField,
} from "../../../packages/content-core/src/editor-admin";
import { apResultsLayoutSrc, embedPlayer, xVideoLink } from "../../../packages/content-core/src/embed-player";
import { homePassportHeading } from "../../../packages/content-core/src/home-composition-contract";
import type { AdminBlock } from "../lib/block-factory";
import { adminFieldsForBlock, homeLayoutsEnabled } from "../lib/home-layouts";
import { pageSeedAsset } from "../../../packages/content-core/src/page-composition-seeds";

const CountyComparisonEditor = lazy(() => import("./CountyComparisonEditor").then(module => ({ default: module.CountyComparisonEditor })));
const ElectionResultsEditor = lazy(() => import("./ElectionResultsEditor").then(module => ({ default: module.ElectionResultsEditor })));
import type {
  BlockType,
  CtaRowData,
  ContentShelfData,
  TopicShelfBlock,
  TopicShelfData,
  VideoPlaylistBlock,
  VideoPlaylistData,
  DividerBlock,
  EmbedBlock,
  HeadlineBlock,
  PromotionPlaylistBlock,
  CoverageListData,
  LinkCardData,
  LinkCardBlock,
  CoverageEntry,
  ImageData,
  RichTextDoc,
} from "../../../packages/content-core/src/content-model";
import type {
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../lib/functions";
import {
  COVERAGE_LIST_LIMITS,
  GALLERY_PRESENTATION_SPECS,
  NESTED_MEDIA_COLLECTION_MAX,
  galleryPresentation,
  isRichTextDoc,
  isSafeHref,
  type GalleryPresentation,
} from "../../../packages/content-core/src/content-model";
import {
  inspectCoverageProse,
  type CoverageProseInspection,
} from "../../../packages/content-core/src/coverage-list";
import {
  SHELF_ITEM_LIMITS,
  SHELF_SORTS,
  SHELF_TOPICS,
  TOPIC_SHELF_SOURCES,
  VIDEO_LIBRARIES,
} from "../../../packages/content-core/src/dynamic-shelves";
import {
  resolveTopicShelf,
  resolveVideoPlaylist,
} from "../../../packages/content-core/src/dynamic-shelf-resolve";
import {
  APPROVED_VIDEO_LIBRARY,
  RELATED_STORY_INDEX,
} from "../../../packages/content-core/src/shelf-catalog";

const INLINE_TYPES: readonly BlockType[] = [
  "document_list",
  "bio_card",
  "video",
  "data_table",
  "data_figure",
  "town_lookup",
  "election_results",
  "county_comparison",
  "prose",
  "headline",
  "divider",
  "image",
  "cta_row",
  "support_appeal",
  "image_gallery",
  "card_grid",
  "link_card",
  "faq_item",
  "coverage_list",
  "embed",
  "html",
  "content_shelf",
  "promotion_playlist",
  "newsletter_signup",
  "topic_shelf",
  "video_playlist",
  "record_card",
  "sponsor_strip",
];
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

const PROSE_CONTENT_FIELD = editorFieldsForBlock("prose")[0];
const GALLERY_ITEM_FIELDS =
  editorFieldsForBlock("image_gallery").find((field) => field.key === "images")
    ?.itemFields ?? [];

// The inline collection groups (buttons, image gallery, cards) are each a block's required list
// field. A role="group" cannot carry aria-required, so the required state has to live in the
// group's accessible name. This folds the same spoken " (required)" that FieldRenderer appends to
// a required descriptor list, so a screen reader hears one idiom across the admin, and hears it on
// reaching an empty group, before a save fails, not only after. Derived from the block's own field
// descriptor so the spoken label cannot drift from the required rule.
function collectionGroupName(base: string, blockType: BlockType): string {
  return editorFieldsForBlock(blockType)[0]?.required
    ? `${base} (required)`
    : base;
}

export function isInlineBlockType(type: BlockType): boolean {
  return INLINE_TYPES.includes(type);
}

function InlineRecordCard({ block, onChange, readOnly = false }: Pick<BlockSurfaceProps, "block" | "onChange" | "readOnly">) {
  const { loadRecord } = useContext(ContentShelfSources);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<{ title: string; status: string; available?: boolean } | null>(null);
  const kind = block.data.recordKind as RecordCardKind;
  const id = typeof block.data.recordId === "string" ? block.data.recordId : "";
  useEffect(() => {
    setChosen(null);
    if (!id || !loadRecord) return;
    let current = true;
    void loadRecord(kind, id).then(result => {
      if (!current) return;
      if (result.status !== "ready") {
        setChosen({ title: "Record unavailable", status: result.status });
        return;
      }
      const record = result.record;
      const status = record.deleted ? "deleted" : String(record.status ?? "Unknown status");
      const routed = kind === "program" || kind === "event";
      setChosen({
        title: String(record.title ?? record.name ?? "Untitled record"),
        status,
        available: status !== "deleted" && status !== "archived" &&
          (!routed || (Boolean(record.published) &&
            isPublishable(record as never, new Date()))),
      });
    }).catch(() => {
      if (current) setChosen({ title: "Record unavailable", status: "Could not load" });
    });
    return () => { current = false; };
  }, [kind, id, loadRecord]);
  const unavailable = chosen && (chosen.available === false ||
    ["missing", "deleted", "archived", "Could not load"].includes(chosen.status));
  return <section className="inline-block-surface inline-record-card" aria-label="Record card">
    {id ? <>
      <p><strong>{chosen?.title ?? "Loading record…"}</strong></p>
      <p>Status: {chosen?.status ?? "Checking…"}</p>
      {unavailable ? <p role="status">This card will be hidden on the public site until you choose an available record.</p> : null}
      <a href={editRecordPath(kind, id)}>Edit record</a>
    </> : <p>Choose a record for this card.</p>}
    <div className="button-row">
      <Button disabled={readOnly} onClick={() => setPickerOpen(true)}>{id ? "Change record" : "Choose record"}</Button>
      {id ? <Button disabled={readOnly} onClick={() => {
        setChosen(null);
        onChange({ recordKind: kind, recordId: "" });
      }}>Remove record</Button> : null}
    </div>
    <label>Display
      <Select disabled={readOnly} value={String(block.data.variant ?? "card")} onChange={event =>
        onChange({ ...block.data, variant: event.target.value })}>
        <option value="card">Card</option>
        <option value="compact">Compact</option>
      </Select>
    </label>
    <RecordPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onChoose={record => {
      setChosen({ title: record.title, status: record.status });
      onChange({ recordKind: record.kind, recordId: record.id, variant: block.data.variant ?? "card" });
    }} />
  </section>;
}

function renderedHeadlineLevel(block: AdminBlock): number {
  const rawLevel = block.data.level;
  const headline: HeadlineBlock = {
    id: block.id,
    type: "headline",
    order: block.order,
    visible: block.visible,
    data: {
      text: String(block.data.text ?? ""),
      level: typeof rawLevel === "number" ? rawLevel : undefined,
    },
  };
  const markup = renderBlock(headline);
  const match = markup.match(/^<h([1-6])>/);
  return match ? Number(match[1]) : 2;
}

function renderedDividerMarkup(block: AdminBlock): string {
  const divider: DividerBlock = {
    id: block.id,
    type: "divider",
    order: block.order,
    visible: block.visible,
    data: {},
  };
  return renderBlock(divider);
}

interface BlockSurfaceProps {
  onResolvedDataFigureLabel?: (label: string | null) => void;
  readOnly?: boolean;
  block: AdminBlock;
  errorId?: string;
  generatedHeadingLevel?: number;
  hasError: boolean;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  onRemoveImage?: (trigger: HTMLButtonElement) => void;
  onConvertCoverage?: (entries: CoverageEntry[]) => void;
  coverageCardCapacity?: number;
  showPageSeedAssets?: boolean;
  textLinkActions?: boolean;
  homeShelf?: boolean;
  onHomeText?: (value: string) => void;
}

export function InlineBlockSurface({
  onResolvedDataFigureLabel,
  block,
  readOnly = false,
  errorId,
  generatedHeadingLevel = 2,
  hasError,
  loadMedia,
  mediaPickerUnavailable = false,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onChange,
  onRemoveImage,
  onConvertCoverage,
  coverageCardCapacity = Number.POSITIVE_INFINITY,
  showPageSeedAssets = false,
  textLinkActions = false,
  homeShelf = false,
  onHomeText,
}: BlockSurfaceProps) {
  switch (block.type) {
    case "document_list":
      return <DocumentListEditor block={block} readOnly={readOnly} loadMedia={loadMedia} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory} canUploadCategory={canUploadCategory}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange} onChange={onChange} />;
    case "bio_card":
      return <BioCardEditor block={block} readOnly={readOnly} hasError={hasError} onChange={onChange}
        loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange} />;
    case "video":
      return <VideoBlockEditor block={block} readOnly={readOnly} hasError={hasError} onChange={onChange} onMediaPickerDirtyChange={onMediaPickerDirtyChange} />;
    case "record_card":
      return <InlineRecordCard block={block} readOnly={readOnly} onChange={onChange} />;
    case "prose":
      return (
        <InlineProse
          block={block}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
          onHomeText={onHomeText}
          onConvertCoverage={onConvertCoverage}
          coverageCardCapacity={coverageCardCapacity}
        />
      );

    case "headline":
      return (
        <InlineHeadline
          block={block}
          level={renderedHeadlineLevel(block)}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "divider":
      return (
        <div
          className="inline-block-surface inline-divider"
          dangerouslySetInnerHTML={{ __html: renderedDividerMarkup(block) }}
        />
      );

    case "image":
      return (
        <InlineImage
          block={block}
          hasError={hasError}
          errorId={errorId}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={uploadMedia}
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          onChange={onChange}
          onRemoveImage={onRemoveImage}
        />
      );

    case "support_appeal": {
      const fields = editorFieldsForBlock("support_appeal");
      return <fieldset className="inline-block-surface" disabled={readOnly}
        aria-invalid={hasError || undefined} aria-describedby={hasError ? errorId : undefined}>
        <legend className="sr-only">Support appeal</legend>{fields.map(field => (
        <FieldRenderer key={field.key} field={field} fieldId={`block-${block.id}-field-${field.key}`}
          error={hasError ? editorFieldValidationMessage(field, block.data[field.key], { siblings: block.data, fields }) ?? undefined : undefined}
          loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
          mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory} canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          value={block.data[field.key]} onChange={value => onChange({ ...block.data, [field.key]: value })} />
      ))}</fieldset>;
    }

    case "cta_row":
      return (
        <InlineCtaRow
          block={block}
          textLinkActions={textLinkActions}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "image_gallery":
      return (
        <InlineImageGallery
          block={block}
          hasError={hasError}
          errorId={errorId}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          uploadMedia={uploadMedia}
          mediaCategories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          onChange={onChange}
        />
      );

    case "card_grid":
      return (
        <InlineCardGrid
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          loadMedia={loadMedia}
          mediaCategories={mediaCategories}
          mediaPickerUnavailable={mediaPickerUnavailable}
          onChange={onChange}
          showPageSeedAssets={showPageSeedAssets}
        />
      );

    case "faq_item":
      return (
        <InlineFaqItem
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "link_card":
      return (
        <InlineLinkCard
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "coverage_list":
      return (
        <InlineCoverageList
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "data_table":
      return <InlineDataTable block={block} onChange={onChange} readOnly={readOnly} />;
    case "data_figure":
      return <InlineDataFigure block={block} onChange={onChange} readOnly={readOnly}
        generatedHeadingLevel={generatedHeadingLevel} onResolvedLabel={onResolvedDataFigureLabel} />;
    case "county_comparison":
      return <Suspense fallback={<p role="status">Loading county comparison…</p>}><CountyComparisonEditor block={block} onChange={onChange} readOnly={readOnly} generatedHeadingLevel={generatedHeadingLevel} /></Suspense>;
    case "town_lookup":
      return <TownLookupEditor block={block} onChange={onChange} readOnly={readOnly} />;
    case "election_results":
      return <Suspense fallback={<p role="status">Loading election results editor…</p>}><ElectionResultsEditor
        block={block} onChange={onChange} readOnly={readOnly} loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable}
        uploadMedia={uploadMedia} mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange} /></Suspense>;
    case "html":
      return <InlineHtml block={block} hasError={hasError} onChange={onChange} />;
    case "embed":
      return (
        <InlineEmbed
          block={block}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "topic_shelf":
    case "video_playlist":
      return (
        <InlineDynamicShelf
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "sponsor_strip":
      return <InlineSponsorStrip block={block} hasError={hasError} errorId={errorId} readOnly={readOnly} onChange={onChange} />;

    case "content_shelf":
      return (
        <InlineContentShelf
          block={block}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          errorId={errorId}
          onChange={onChange}
        />
      );

    case "promotion_playlist":
      return (
        <InlinePromotionPlaylist
          block={block}
          homeShelf={homeShelf}
          generatedHeadingLevel={generatedHeadingLevel}
          hasError={hasError}
          loadMedia={loadMedia}
          mediaPickerUnavailable={mediaPickerUnavailable}
          onChange={onChange}
        />
      );

    case "newsletter_signup":
      return <NewsletterSignupEditor data={block.data} onChange={onChange} readOnly={readOnly} />;

    default:
      return null;
  }
}

function InlineSponsorStrip({ block, hasError, errorId, readOnly = false, onChange }: BlockSurfaceProps) {
  const sources = useContext(ContentShelfSources);
  const data = block.data;
  const ids = Array.isArray(data.sponsorIds) ? data.sponsorIds.filter((id): id is string => typeof id === "string") : [];
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  const [savedNames, setSavedNames] = useState<Record<string, { name: string; status: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const names = { ...Object.fromEntries((selection?.records ?? []).map(record => [record.id,
    { name: record.title, status: record.status }])), ...savedNames };
  const selectedKey = ids.join("\u0000");
  useEffect(() => {
    if (!sources.loadRecord || ids.length === 0) return;
    let current = true;
    void Promise.all(ids.map(async id => {
      try {
        const result = await sources.loadRecord!("sponsor", id);
        if (result.status !== "ready") return [id, { name: "Sponsor unavailable", status: result.status }] as const;
        const record = result.record;
        return [id, { name: String(record.name ?? record.title ?? "Untitled sponsor"),
          status: record.deleted ? "deleted" : String(record.status ?? "unknown") }] as const;
      } catch {
        return [id, { name: "Sponsor unavailable", status: "could not load" }] as const;
      }
    })).then(entries => { if (current) setSavedNames(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [selectedKey, sources.loadRecord]);

  async function search(page = 1) {
    if (!sources.loadLibrarySelection) return;
    const current = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await sources.loadLibrarySelection({ ...DEFAULT_CONTENT_QUERY, types: ["sponsor"], statuses: [], q: query.trim(), page });
      if (current === request.current) setSelection({ ...result, records: result.records.filter(record => record.status !== "archived") });
    } catch {
      if (current === request.current) setError("Sponsors could not be loaded. Try the search again.");
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  function replace(next: string[]) { onChange({ ...data, sponsorIds: next }, true); }
  function move(index: number, offset: number) {
    const next = [...ids];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    replace(next);
  }

  return <section className="inline-block-surface inline-sponsor-strip">
    <label htmlFor={`block-${block.id}-heading`}>Heading</label>
    <TextInput id={`block-${block.id}-heading`} maxLength={120} value={String(data.heading ?? "")} disabled={readOnly}
      onChange={event => onChange({ ...data, heading: event.target.value })} />
    <label htmlFor={`block-${block.id}-layout`}>Layout</label>
    <Select id={`block-${block.id}-layout`} value={String(data.layout ?? "row")} disabled={readOnly}
      onChange={event => onChange({ ...data, layout: event.target.value }, true)}>
      <option value="row">Row</option><option value="grid">Grid</option>
    </Select>
    <p id={`block-${block.id}-sponsors-label`}>Sponsors (required, 1 to 12)</p>
    <ol aria-labelledby={`block-${block.id}-sponsors-label`} aria-invalid={hasError} aria-describedby={hasError ? errorId : undefined}>
      {ids.map((id, index) => <li key={id}>
        <span>{names[id] ? `${names[id].name} (${names[id].status})` : sources.loadRecord ? "Loading sponsor…" : id}</span>{" "}
        <a href={editRecordPath("sponsor", id)}>Edit sponsor</a>{" "}
        <Button disabled={readOnly || index === 0} aria-label={`Move ${names[id]?.name ?? id} up`} onClick={() => move(index, -1)}>Up</Button>{" "}
        <Button disabled={readOnly || index === ids.length - 1} aria-label={`Move ${names[id]?.name ?? id} down`} onClick={() => move(index, 1)}>Down</Button>{" "}
        <Button disabled={readOnly} aria-label={`Remove ${names[id]?.name ?? id}`} onClick={() => replace(ids.filter(item => item !== id))}>Remove</Button>
      </li>)}
    </ol>
    <div className="inline-shelf-picker">
      <label htmlFor={`block-${block.id}-query`}>Find sponsors</label>
      <TextInput id={`block-${block.id}-query`} value={query} disabled={readOnly || busy} onChange={event => setQuery(event.target.value)} />
      <Button disabled={readOnly || busy || !sources.loadLibrarySelection} onClick={() => void search()}>Search sponsors</Button>
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p role="status">Loading sponsors</p> : null}
      {selection ? <><ul>{selection.records.map(record => <li key={record.id}>
        <label><input type="checkbox" checked={ids.includes(record.id)} disabled={readOnly || (ids.length >= 12 && !ids.includes(record.id))}
          onChange={event => replace(event.target.checked ? [...ids, record.id] : ids.filter(id => id !== record.id))} />
          {record.thumbnailUrl ? <img src={record.thumbnailUrl} alt="" width="40" height="40" /> : null}
          {record.title} ({record.status})</label>
      </li>)}</ul>
      <p>{selection.records.length === 0 ? "No sponsors match on this page." : `Page ${selection.page} of ${selection.pageCount}`}</p>
      <Button disabled={readOnly || busy || selection.page <= 1} onClick={() => void search(selection.page - 1)}>Previous sponsors</Button>{" "}
      <Button disabled={readOnly || busy || selection.page >= selection.pageCount} onClick={() => void search(selection.page + 1)}>Next sponsors</Button></> : null}
    </div>
  </section>;
}

interface InlineHeadlineProps extends BlockSurfaceProps {
  level: number;
}

// A heading edited on its rendered surface. It uses a textarea, not a single-line input,
// so a long heading wraps exactly as the published <hN> wraps rather than scrolling out of
// view -- the parity the inline surface exists to give. The height tracks the content and
// the font is inherited so the textarea does not fall back to the browser's monospace
// default. The stored text stays one logical line (the model holds a single string): the
// Enter key is suppressed on the typing path, but the write-boundary guarantee is the
// onChange normalization, which strips newlines from any input the keydown guard never sees
// -- paste, drag-drop, IME, autofill. Without it a pasted multi-line title would show as
// two lines here (the textarea is pre-wrap) yet publish as one (HTML collapses the break in
// <hN>), reopening the what-you-see-is-what-ships gap this surface exists to close.
function InlineHeadline({
  block,
  level,
  hasError,
  errorId,
  onChange,
}: InlineHeadlineProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = String(block.data.text ?? "");

  useEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    surface.style.height = "auto";
    surface.style.height = `${surface.scrollHeight}px`;
  }, [text, level]);

  return (
    <div className="inline-block-surface inline-headline">
      <textarea
        ref={ref}
        className="inline-headline-input"
        rows={1}
        value={text}
        data-level={level}
        aria-label="Heading"
        aria-required="true"
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : undefined}
        placeholder="Write a heading"
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
        onChange={(event) =>
          onChange({
            ...block.data,
            text: event.target.value.replace(/[\r\n]+/g, " "),
          })
        }
      />
    </div>
  );
}

function imageFromValue(value: unknown): ImageData {
  const image =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    assetId: String(image.assetId ?? ""),
    alt: String(image.alt ?? ""),
    altDecorative: image.altDecorative === true,
    caption: String(image.caption ?? ""),
  };
}

interface InlineImageEditorProps {
  image: ImageData;
  idPrefix: string;
  labelSuffix?: string;
  hasError: boolean;
  errorId?: string;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  onChange: (image: ImageData) => void;
  onRemove?: (trigger: HTMLButtonElement) => void;
}

function InlineImageEditor({
  image,
  idPrefix,
  labelSuffix = "",
  hasError,
  errorId,
  loadMedia,
  mediaPickerUnavailable = false,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onChange,
  onRemove,
}: InlineImageEditorProps) {
  const suffix = labelSuffix ? ` ${labelSuffix}` : "";
  const assetIdInput = `${idPrefix}-asset-id`;
  const altInput = `${idPrefix}-alt`;
  const captionInput = `${idPrefix}-caption`;
  const decorativeInput = `${idPrefix}-alt-decorative`;
  const decorative = image.altDecorative === true;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<MediaAssetSummary | null>(
    null,
  );
  const noticeRemoval = useRemovalNotice();
  const resolvedAsset = useResolvedMediaAsset(image.assetId, loadMedia);
  const displayedAsset =
    selectedAsset?.id === image.assetId ? selectedAsset : resolvedAsset;
  const assetInvalid = Boolean(hasError && image.assetId.trim().length === 0);
  // Marked decorative, an empty alt is the answer WCAG 1.1.1 asks for, and a description
  // left in the box contradicts the mark instead of completing it. That contradiction is
  // the only invalid state: empty alt text on a described image is a warning, because a
  // nightly sweep fills it (#242) and it never stops a save or publish.
  const altInvalid = Boolean(hasError && decorative && image.alt.length > 0);
  const altWarningId = `${idPrefix}-alt-warning`;
  const altMissing =
    !decorative &&
    image.assetId.trim().length > 0 &&
    image.alt.trim().length === 0;

  useEffect(() => {
    if (selectedAsset && selectedAsset.id !== image.assetId) {
      setSelectedAsset(null);
    }
  }, [image.assetId, selectedAsset]);

  function chooseAsset(asset: MediaAssetSummary) {
    const changed = asset.id !== image.assetId;
    setSelectedAsset(asset);
    setPickerOpen(false);
    onChange({
      ...image,
      assetId: asset.id,
      ...(changed ? { alt: "", altDecorative: false } : {}),
    });
  }

  function clearAsset() {
    // Clearing the chosen asset also drops the alt text written for it, so it is a destructive
    // change, not a field edit. It stays a one-click action -- re-choosing an image is cheap, and
    // a modal here would sit in front of the most repeated step in image editing -- but it reports
    // what went so the editor can offer the way back by name (#1035).
    setSelectedAsset(null);
    onChange({ ...image, assetId: "", alt: "", altDecorative: false });
    noticeRemoval(removedAssetName(displayedAsset?.name));
  }

  return (
    <div className="inline-image-editor">
      <figure className="inline-image-figure">
        {/* A decorative image is one assistive tech should not announce, so the preview
            drops the img role and its name rather than reading out a placeholder name the
            published page will not have. The frame's own text stays readable, which is how
            an editor using a screen reader still hears which asset is selected. */}
        <div
          className="inline-image-frame"
          role={decorative ? undefined : "img"}
          aria-label={
            decorative ? undefined : image.alt || `Image placeholder${suffix}`
          }
        >
          {displayedAsset ? (
            <AssetImage
              src={mediaPreviewUrl(displayedAsset, 960)}
              width={displayedAsset.width ?? undefined}
              height={displayedAsset.height ?? undefined}
              alt=""
              loading="lazy"
              fallback={
                <>
                  <span className="inline-image-slot">Image slot</span>
                  <span className="inline-image-asset-id">Saved image could not be shown</span>
                </>
              }
            />
          ) : (
            <>
              <span className="inline-image-slot">Image slot</span>
              <span className="inline-image-asset-id">
                {image.assetId
                  ? loadMedia || mediaPickerUnavailable
                    ? "Saved image selected"
                    : `Asset id: ${image.assetId}`
                  : loadMedia
                    ? "No image selected"
                    : "No asset selected"}
              </span>
            </>
          )}
        </div>
        <figcaption className="inline-image-caption">
          <label htmlFor={captionInput}>Caption{suffix}</label>
          <TextInput
            id={captionInput}
            value={image.caption ?? ""}
            placeholder="Add a caption (optional)"
            onChange={(event) =>
              onChange({ ...image, caption: event.target.value })
            }
          />
        </figcaption>
      </figure>
      <div className="inline-image-fields">
        {loadMedia ? (
          <fieldset className="inline-image-picker-field">
            <legend className="inline-image-picker-label">
              Image{suffix} <span className="sr-only">(required)</span>
              <span aria-hidden="true"> *</span>
            </legend>
            <div className="inline-image-picker-selection">
              <TextInput
                className="inline-image-picker-value"
                value={
                  displayedAsset?.name ??
                  (image.assetId ? "Saved image" : "No image selected")
                }
                readOnly
                aria-label={`Image${suffix}`}
                aria-required="true"
                aria-invalid={assetInvalid || undefined}
                aria-describedby={assetInvalid ? errorId : undefined}
              />
              <div className="inline-image-picker-actions">
                <Button onClick={() => setPickerOpen(true)}>
                  {image.assetId ? "Change image" : "Choose image"}
                </Button>
                {image.assetId ? (
                  <Button variant="ghost" onClick={onRemove ? event => onRemove(event.currentTarget) : clearAsset}>
                    Remove image
                  </Button>
                ) : null}
              </div>
            </div>
          </fieldset>
        ) : mediaPickerUnavailable ? (
          <fieldset className="inline-image-picker-field">
            <legend className="inline-image-picker-label">
              Image{suffix} <span className="sr-only">(required)</span>
              <span aria-hidden="true"> *</span>
            </legend>
            <TextInput
              className="inline-image-picker-value"
              value={image.assetId ? "Saved image" : "No image selected"}
              readOnly
              aria-label={`Image${suffix}`}
              aria-required="true"
              aria-invalid={assetInvalid || undefined}
              aria-describedby={assetInvalid ? errorId : undefined}
            />
            <p>Media access is required to change this image.</p>
          </fieldset>
        ) : (
          <>
            <label htmlFor={assetIdInput}>Image{suffix}</label>
            <TextInput
              id={assetIdInput}
              value={image.assetId}
              placeholder="Asset id"
              aria-required="true"
              aria-invalid={assetInvalid || undefined}
              aria-describedby={assetInvalid ? errorId : undefined}
              onChange={(event) =>
                onChange({ ...image, assetId: event.target.value })
              }
            />
          </>
        )}
        <label htmlFor={altInput}>Alt text{suffix}</label>
        <TextInput
          id={altInput}
          value={image.alt}
          placeholder={
            decorative
              ? "Not needed for a decorative image"
              : "Describe the image"
          }
          aria-invalid={altInvalid || undefined}
          aria-describedby={
            altInvalid ? errorId : altMissing ? altWarningId : undefined
          }
          onChange={(event) => onChange({ ...image, alt: event.target.value })}
        />
        {altMissing ? (
          <p className="warning-text inline-image-alt-warning" id={altWarningId}>
            Alt text{suffix} is empty. You can save and publish, but describe the
            image or mark it decorative when you can.
          </p>
        ) : null}
        {displayedAsset?.altText && !decorative && image.alt.trim() === "" ? (
          <div className="inline-image-alt-suggestion">
            <span>Suggestion: {displayedAsset.altText}</span>
            <Button
              variant="ghost"
              onClick={() =>
                onChange({ ...image, alt: displayedAsset.altText ?? "" })
              }
            >
              Use suggestion
            </Button>
          </div>
        ) : null}
        <label className="inline-image-decorative" htmlFor={decorativeInput}>
          <input
            id={decorativeInput}
            className="editor-toggle"
            type="checkbox"
            checked={decorative}
            onChange={(event) =>
              onChange({ ...image, altDecorative: event.target.checked })
            }
          />
          <span>Mark as decorative{suffix}</span>
        </label>
      </div>
      {pickerOpen && loadMedia ? (
        <MediaPickerDialog
          destination={`Image${suffix}`}
          currentAssetId={image.assetId}
          loadMedia={loadMedia}
          uploadMedia={uploadMedia}
          categories={mediaCategories}
          defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory}
          onDirtyChange={onMediaPickerDirtyChange}
          onClose={() => setPickerOpen(false)}
          onSelect={chooseAsset}
        />
      ) : null}
    </div>
  );
}

function InlineImage({
  block,
  hasError,
  errorId,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onChange,
  onRemoveImage,
}: BlockSurfaceProps) {
  const image = imageFromValue(block.data);
  const fields = editorFieldsForBlock("image");
  const linkFields = fields.filter(field => field.key === "href" || field.key === "newTab");
  return (
    <div className="inline-block-surface inline-image">
      <InlineImageEditor
        image={image}
        idPrefix={`block-${block.id}`}
        hasError={hasError}
        errorId={errorId}
        loadMedia={loadMedia}
        mediaPickerUnavailable={mediaPickerUnavailable}
        uploadMedia={uploadMedia}
        mediaCategories={mediaCategories}
        defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange}
        onChange={(next) => onChange({ ...block.data, ...next })}
        onRemove={onRemoveImage}
      />
      <div className="inline-image-link-fields">
        {linkFields.map(field => {
          const value = block.data[field.key] ?? (field.kind === "toggle" ? false : "");
          const error = hasError ? editorFieldValidationMessage(field, value, { siblings: block.data, fields }) : null;
          return <FieldRenderer key={field.key} field={field} value={value}
            onChange={next => onChange({ ...block.data, [field.key]: next })}
            fieldId={`block-${block.id}-${field.key}`} error={error ?? undefined} />;
        })}
      </div>
    </div>
  );
}

type Cta = CtaRowData["ctas"][number];

function ctasFromBlock(block: AdminBlock): Cta[] {
  if (!Array.isArray(block.data.ctas)) return [];
  return block.data.ctas.map((value) => {
    const cta =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    return {
      label: String(cta.label ?? ""),
      href: String(cta.href ?? ""),
      variant: cta.variant === "secondary" ? "secondary" : "primary",
    };
  });
}

function InlineCtaRow({
  block,
  hasError,
  errorId,
  onChange,
  textLinkActions = false,
}: BlockSurfaceProps) {
  const ctas = ctasFromBlock(block);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [validationIndex, setValidationIndex] = useState<number | null>(null);
  const noticeRemoval = useRemovalNotice();

  // A per-button valid/invalid signature. The validation effect depends on it so that
  // fixing one incomplete button while the page error still stands recomputes the marker
  // and opens the next incomplete button -- not only on the first flip of hasError, which
  // would leave a remaining incomplete sibling unmarked.
  const invalidKey = ctas
    .map((cta) =>
      cta.label.trim().length === 0 || !isSafeHref(cta.href) ? "1" : "0",
    )
    .join("");

  useEffect(() => {
    if (!hasError) {
      setValidationIndex(null);
      return;
    }
    const firstInvalid = ctas.findIndex(
      (cta) => cta.label.trim().length === 0 || !isSafeHref(cta.href),
    );
    setValidationIndex(firstInvalid >= 0 ? firstInvalid : null);
  }, [hasError, invalidKey]);

  const selectedIndex =
    validationIndex !== null && validationIndex < ctas.length
      ? validationIndex
      : activeIndex !== null && activeIndex < ctas.length
        ? activeIndex
        : null;
  const invalid = hasError || undefined;
  const describedBy = hasError ? errorId : undefined;

  function commit(next: Cta[]) {
    onChange({ ...block.data, ctas: next });
  }

  function addCta() {
    const next = [
      ...ctas,
      { label: "", href: "", variant: "primary" as const },
    ];
    commit(next);
    setValidationIndex(null);
    setActiveIndex(next.length - 1);
  }

  function updateCta(index: number, patch: Partial<Cta>) {
    commit(
      ctas.map((cta, current) =>
        current === index ? { ...cta, ...patch } : cta,
      ),
    );
    setValidationIndex(null);
    setActiveIndex(index);
  }

  function moveCta(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= ctas.length) return;
    const next = ctas.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
    setValidationIndex(null);
    setActiveIndex(target);
  }

  function removeCta(index: number) {
    const removed = ctas[index];
    const next = ctas.filter((_, current) => current !== index);
    commit(next);
    setValidationIndex(null);
    setActiveIndex(next.length === 0 ? null : Math.min(index, next.length - 1));
    // A single button, like a gallery image, removes at once and offers the way back by name
    // rather than stopping the editor with a question (#1035).
    if (removed) noticeRemoval(listItemName("button", removed, index + 1));
  }

  const selected = selectedIndex === null ? null : ctas[selectedIndex];
  const editorId = `block-${block.id}-cta-editor`;
  const homeAction = block.section === "home-passport-action" || block.section === "home-start-action";
  if (homeAction) {
    const action = ctas[0];
    if (!action) return null;
    return (
      <div className="inline-block-surface inline-cta-row">
        <label htmlFor={`${editorId}-label`}>Button label</label>
        <TextInput
          id={`${editorId}-label`}
          value={action.label}
          aria-required="true"
          onChange={(event) => updateCta(0, { label: event.target.value })}
        />
        <p className="muted">Destination: {action.href}</p>
      </div>
    );
  }
  const labelInvalid = Boolean(
    hasError && selected && selected.label.trim().length === 0,
  );
  const hrefInvalid = Boolean(
    hasError && selected && !isSafeHref(selected.href),
  );

  return (
    <div className="inline-block-surface inline-cta-row">
      <div
        className="cta-row"
        role="group"
        aria-label={collectionGroupName("Buttons", block.type)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        {ctas.length === 0 ? (
          <p className="inline-cta-empty">No buttons added yet.</p>
        ) : null}
        {ctas.map((cta, index) => (
          <button
            key={index}
            type="button"
            className={`btn ${ctaVariantClass(cta.variant)}`}
            aria-expanded={selectedIndex === index}
            aria-controls={selectedIndex === index ? editorId : undefined}
            onClick={() => {
              setValidationIndex(null);
              setActiveIndex(index);
            }}
          >
            {cta.label || `Button ${index + 1}`}
          </button>
        ))}
      </div>

      <Button className="inline-cta-add" onClick={addCta}>
        Add button
      </Button>

      {selected && selectedIndex !== null ? (
        <div
          className="inline-cta-editor"
          id={editorId}
          role="group"
          aria-label={`Edit button ${selectedIndex + 1}`}
        >
          <div className="inline-cta-editor-fields">
            <label htmlFor={`${editorId}-label`}>Button label</label>
            <TextInput
              id={`${editorId}-label`}
              value={selected.label}
              aria-required="true"
              aria-invalid={labelInvalid || undefined}
              aria-describedby={labelInvalid ? describedBy : undefined}
              onChange={(event) =>
                updateCta(selectedIndex, { label: event.target.value })
              }
            />
            <label htmlFor={`${editorId}-href`}>Button link</label>
            <TextInput
              id={`${editorId}-href`}
              type="text"
              inputMode="url"
              value={selected.href}
              aria-required="true"
              aria-invalid={hrefInvalid || undefined}
              aria-describedby={hrefInvalid ? describedBy : undefined}
              onChange={(event) =>
                updateCta(selectedIndex, { href: event.target.value })
              }
            />
            {textLinkActions ? <p className="muted">This page section uses text links.</p> : <>
            <label htmlFor={`${editorId}-variant`}>Button variant</label>
            <Select
              id={`${editorId}-variant`}
              value={selected.variant ?? "primary"}
              onChange={(event) =>
                updateCta(selectedIndex, {
                  variant:
                    event.target.value === "secondary"
                      ? "secondary"
                      : "primary",
                })
              }
            >
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </Select>
            </>}
          </div>
          <div className="inline-cta-editor-controls">
            <ActionControl
              action="move-up"
              contextLabel={`button ${selectedIndex + 1}`}
              disabled={selectedIndex === 0}
              onClick={() => moveCta(selectedIndex, -1)}
            />
            <ActionControl
              action="move-down"
              contextLabel={`button ${selectedIndex + 1}`}
              disabled={selectedIndex === ctas.length - 1}
              onClick={() => moveCta(selectedIndex, 1)}
            />
            <Button
              variant="danger"
              aria-label={`Remove button ${selectedIndex + 1}`}
              onClick={() => removeCta(selectedIndex)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Gallery and card rows use the same persisted itemId the reducer uses for undo mapping.
// There is no parallel render-only identity layer: the id travels through save, reorder,
// undo, redo, and reload (#1127).

function InlineImageGallery({
  block,
  hasError,
  errorId,
  loadMedia,
  mediaPickerUnavailable,
  uploadMedia,
  mediaCategories,
  defaultUploadCategory,
  canUploadCategory,
  onMediaPickerDirtyChange,
  onChange,
}: BlockSurfaceProps) {
  // The stored values carry persisted itemId values. Edits preserve the current id, adds mint
  // one immediately, and moves carry the stored object as a unit (#1035, #1127). `images` is
  // the same list normalized for rendering only.
  const storedImages: readonly unknown[] = Array.isArray(block.data.images)
    ? block.data.images
    : [];
  const images = storedImages.map(imageFromValue);
  const noticeRemoval = useRemovalNotice();

  function commit(next: readonly unknown[]) {
    onChange({ ...block.data, images: next });
  }

  function addImage() {
    // Seeded from the gallery's own item descriptors, so a sub-field added to the item
    // shape reaches a new image without a second hand-written literal to remember.
    commit([
      ...storedImages,
      {
        ...imageFromValue(emptyItem(GALLERY_ITEM_FIELDS)),
        itemId: mintCollectionItemId(),
      },
    ]);
  }

  function updateImage(index: number, image: ImageData) {
    const itemId = collectionItemId(storedImages[index]) ?? mintCollectionItemId();
    commit(
      storedImages.map((current, position) =>
        position === index ? { ...image, itemId } : current,
      ),
    );
  }

  function moveImage(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= storedImages.length) return;
    const next = storedImages.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  function removeImage(index: number) {
    // One item out of a grid is a small, obvious loss: the rest of the gallery stays on screen, so
    // a modal question here would interrupt the ordinary work of curating a gallery. It removes at
    // once and names what went in the editor's undo notice instead (#1035).
    const removed = images[index];
    commit(storedImages.filter((_, position) => position !== index));
    if (removed) noticeRemoval(galleryImageName(removed, index + 1));
  }

  // The editing surface arranges itself the way the published page will (#1034). A grid edits as
  // a wrapping grid and a carousel edits as one row that scrolls sideways, so the choice made in
  // settings is something the editor can see rather than a promise they have to publish to check.
  // The public renderer marks its carousel with the same class and makes it keyboard-reachable
  // the same way, because a scroll container a keyboard cannot move is a trap in either place.
  const presentation = galleryPresentation({
    images: [],
    presentation: block.data.presentation as GalleryPresentation | undefined,
  });
  const carousel = presentation === "carousel";
  const scrollHintId = `block-${block.id}-gallery-scroll-hint`;
  const galleryDescription =
    [carousel ? scrollHintId : null, hasError ? errorId : null]
      .filter((value): value is string => Boolean(value))
      .join(" ") || undefined;

  return (
    <div
      className="inline-block-surface inline-image-gallery"
      data-presentation={presentation}
    >
      {carousel ? (
        <p className="image-gallery__hint" id={scrollHintId}>
          Scroll horizontally to see all images
        </p>
      ) : null}
      <div
        className={`image-gallery${carousel ? " image-gallery--carousel" : ""}`}
        role="group"
        tabIndex={carousel ? 0 : undefined}
        aria-label={collectionGroupName("Image gallery", block.type)}
        aria-invalid={hasError || undefined}
        aria-describedby={galleryDescription}
      >
        {images.length === 0 ? (
          <p className="inline-collection-empty">No images added yet.</p>
        ) : null}
        {images.map((image, index) => (
          <div
          className="inline-gallery-item"
          key={
            collectionItemId(storedImages[index]) ??
            `collection-item:${block.id}:images:${index + 1}`
          }
        >
            <InlineImageEditor
              image={image}
              idPrefix={`block-${block.id}-image-${index}`}
              labelSuffix={String(index + 1)}
              hasError={hasError}
              errorId={errorId}
              loadMedia={loadMedia}
              mediaPickerUnavailable={mediaPickerUnavailable}
              uploadMedia={uploadMedia}
              mediaCategories={mediaCategories}
              defaultUploadCategory={defaultUploadCategory}
              canUploadCategory={canUploadCategory}
              onMediaPickerDirtyChange={onMediaPickerDirtyChange}
              onChange={(next) => updateImage(index, next)}
            />
            <div className="inline-collection-controls">
              <ActionControl
                action="move-up"
                contextLabel={`image ${index + 1}`}
                disabled={index === 0}
                onClick={() => moveImage(index, -1)}
              />
              <ActionControl
                action="move-down"
                contextLabel={`image ${index + 1}`}
                disabled={index === images.length - 1}
                onClick={() => moveImage(index, 1)}
              />
              <Button
                variant="danger"
                className="inline-gallery-remove"
                aria-label={`Remove image ${index + 1} from gallery`}
                onClick={() => removeImage(index)}
              >
                Remove item
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button
        className="inline-collection-add"
        disabled={images.length >= NESTED_MEDIA_COLLECTION_MAX}
        onClick={addImage}
      >
        Add image
      </Button>
    </div>
  );
}

interface EditableCard {
  label: string;
  title: string;
  body: RichTextDoc;
  imageAssetId: string;
  href: string;
}

function cardsFromBlock(block: AdminBlock): EditableCard[] {
  if (!Array.isArray(block.data.cards)) return [];
  return block.data.cards.map((value) => {
    const card =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    return {
      label: String(card.label ?? ""),
      title: String(card.title ?? ""),
      body: isRichTextDoc(card.body) ? card.body : emptyRichTextDoc(),
      imageAssetId: String(card.imageAssetId ?? ""),
      href: String(card.href ?? ""),
    };
  });
}

interface InlineCardImageProps {
  assetId: string;
  fieldId: string;
  itemNumber: number;
  loadMedia?: MediaPickerLoader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  mediaPickerUnavailable?: boolean;
  onChange: (assetId: string) => void;
  seedAsset: NonNullable<ReturnType<typeof pageSeedAsset>> | null;
}

function InlineCardImage({
  assetId,
  fieldId,
  itemNumber,
  loadMedia,
  mediaCategories,
  mediaPickerUnavailable = false,
  onChange,
  seedAsset,
}: InlineCardImageProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<MediaAssetSummary | null>(
    null,
  );
  const resolvedAsset = useResolvedMediaAsset(assetId, loadMedia);
  const displayedAsset =
    selectedAsset?.id === assetId ? selectedAsset : resolvedAsset;
  const showSeedImage = seedAsset !== null && !imageFailed;
  const noticeRemoval = useRemovalNotice();

  useEffect(() => {
    setImageFailed(false);
  }, [seedAsset?.sourceUrl]);

  useEffect(() => {
    if (selectedAsset && selectedAsset.id !== assetId) {
      setSelectedAsset(null);
    }
  }, [assetId, selectedAsset]);

  function chooseAsset(asset: MediaAssetSummary) {
    setSelectedAsset(asset);
    setPickerOpen(false);
    onChange(asset.id);
  }

  return (
    <>
      <div
        className="inline-card-image-frame"
        role="img"
        aria-label={
          displayedAsset || showSeedImage
            ? `Card image ${itemNumber}`
            : `Card image placeholder ${itemNumber}`
        }
      >
        {displayedAsset ? (
          <AssetImage
            className="inline-card-seed-image"
            {...mediaImageSources(displayedAsset, 480)}
            alt=""
            loading="lazy"
            decoding="async"
            fallback={
              <>
                <span className="inline-image-slot">Card image</span>
                <span className="inline-image-asset-id">Saved image could not be shown</span>
              </>
            }
          />
        ) : showSeedImage ? (
          <img
            className="inline-card-seed-image"
            src={seedAsset.sourceUrl}
            alt=""
            width={seedAsset.width}
            height={seedAsset.height}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <>
            <span className="inline-image-slot">Card image</span>
            <span className="inline-image-asset-id">
              {assetId
                ? loadMedia || mediaPickerUnavailable
                  ? "Saved image selected"
                  : `Asset id: ${assetId}`
                : "No image selected"}
            </span>
          </>
        )}
      </div>
      {loadMedia ? (
        <fieldset className="inline-image-picker-field inline-card-image-picker">
          <legend>Card image {itemNumber}</legend>
          <div className="inline-image-picker-selection">
            <span>
              {displayedAsset?.name ??
                (assetId ? "Saved image" : "No image selected")}
            </span>
            <div className="inline-image-picker-actions">
              <Button
                aria-label={`${assetId ? "Change" : "Choose"} card image ${itemNumber}`}
                onClick={() => setPickerOpen(true)}
              >
                {assetId ? "Change image" : "Choose image"}
              </Button>
              {assetId ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove card image ${itemNumber}`}
                  onClick={() => {
                    // The same one-click media removal the image block and the gallery make, so
                    // it reports itself the same way and gets the same way back (#1035).
                    setSelectedAsset(null);
                    onChange("");
                    noticeRemoval(removedAssetName(displayedAsset?.name));
                  }}
                >
                  Remove image
                </Button>
              ) : null}
            </div>
          </div>
        </fieldset>
      ) : mediaPickerUnavailable ? (
        <fieldset className="inline-image-picker-field inline-card-image-picker">
          <legend>Card image {itemNumber}</legend>
          <span>{assetId ? "Saved image" : "No image selected"}</span>
          <p>Media access is required to change this image.</p>
        </fieldset>
      ) : (
        <>
          <label htmlFor={fieldId}>Card image {itemNumber}</label>
          <TextInput
            id={fieldId}
            value={assetId}
            placeholder="Asset id"
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      )}
      {pickerOpen && loadMedia ? (
        <MediaPickerDialog
          destination={`Card ${itemNumber} image`}
          categories={mediaCategories}
          currentAssetId={assetId}
          loadMedia={loadMedia}
          onClose={() => setPickerOpen(false)}
          onSelect={chooseAsset}
        />
      ) : null}
    </>
  );
}

function InlineCardGrid({
  block,
  generatedHeadingLevel = 2,
  hasError,
  errorId,
  loadMedia,
  mediaCategories,
  mediaPickerUnavailable,
  onChange,
  showPageSeedAssets = false,
}: BlockSurfaceProps) {
  const cards = cardsFromBlock(block);
  const headingLevel = clampHeadingLevel(generatedHeadingLevel);
  // Interpolating a rank into a tag name and casting it is a promise TypeScript
  // cannot check, so derive the tag only after the shared runtime clamp. Reuse
  // this same value for the nested rich-text offsets below so the preview cannot
  // disagree with the published renderer.
  const GeneratedHeading = `h${headingLevel}` as
    "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  // As in the gallery, untouched stored cards keep their exact values and an edited card keeps
  // its persisted itemId. That same id carries the React key and nested rich-text history through
  // remove, reorder, undo, redo, and reload (#1035, #1127).
  const storedCards: readonly unknown[] = Array.isArray(block.data.cards)
    ? block.data.cards
    : [];
  const noticeRemoval = useRemovalNotice();

  function commit(next: readonly unknown[]) {
    onChange({ ...block.data, cards: next });
  }

  // One card in the shape it is stored in. An optional label stays absent when the editor leaves
  // it blank: hydration uses an empty string so the input stays controlled, but writing that UI
  // sentinel back would add a new empty key to a card that never had one.
  function persistedCard({
    label,
    ...card
  }: EditableCard & { itemId?: string }): Record<string, unknown> {
    return label.trim() === "" ? card : { ...card, label };
  }

  function addCard() {
    commit([
      ...storedCards,
      persistedCard({
        itemId: mintCollectionItemId(),
        label: "",
        title: "",
        body: emptyRichTextDoc(),
        imageAssetId: "",
        href: "",
      }),
    ]);
  }

  function updateCard(index: number, patch: Partial<EditableCard>) {
    const edited = cards[index];
    if (!edited) return;
    const itemId = collectionItemId(storedCards[index]) ?? mintCollectionItemId();
    commit(
      storedCards.map((current, position) =>
        position === index
          ? persistedCard({ ...edited, ...patch, itemId })
          : current,
      ),
    );
  }

  function moveCard(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= storedCards.length) return;
    const next = storedCards.slice();
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  function removeCard(index: number) {
    const removed = cards[index];
    commit(storedCards.filter((_, position) => position !== index));
    if (removed) noticeRemoval(listItemName("card", removed, index + 1));
  }

  return (
    <div className="inline-block-surface inline-card-grid">
      <div
        className="card-grid"
        role="group"
        aria-label={collectionGroupName("Cards", block.type)}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : undefined}
      >
        {cards.length === 0 ? (
          <p className="inline-collection-empty">No cards added yet.</p>
        ) : null}
        {cards.map((card, index) => {
          // These finite source images explain an imported service-page composition before its
          // media records exist. The caller enables this lookup only for a seeded page, so a
          // future library asset on an unrelated editor cannot be replaced by a fixture.
          const seedAsset = showPageSeedAssets
            ? pageSeedAsset(card.imageAssetId)
            : null;
          const titleInvalid = Boolean(
            hasError && card.title.trim().length === 0,
          );
          const bodyInvalid = Boolean(
            hasError && richTextHasUnsafeLink(card.body),
          );
          const hrefInvalid = Boolean(
            hasError && card.href.trim().length > 0 && !isSafeHref(card.href),
          );
          const itemNumber = index + 1;
          return (
            <article
              className="card-grid__card inline-card-grid-card"
              key={
          collectionItemId(storedCards[index]) ??
          `collection-item:${block.id}:cards:${index + 1}`
        }
            >
              <InlineCardImage
                assetId={card.imageAssetId}
                fieldId={`block-${block.id}-card-${index}-image`}
                itemNumber={itemNumber}
                loadMedia={loadMedia}
                mediaCategories={mediaCategories}
                mediaPickerUnavailable={mediaPickerUnavailable}
                onChange={(imageAssetId) => updateCard(index, { imageAssetId })}
                seedAsset={seedAsset}
              />
              <label className="inline-card-label-field">
                <span>Card label {itemNumber}</span>
                <TextInput
                  className="inline-card-label"
                  value={card.label}
                  placeholder="Card label (optional)"
                  onChange={(event) =>
                    updateCard(index, { label: event.target.value })
                  }
                />
              </label>
              <GeneratedHeading className="card-grid__title">
                <TextInput
                  className="inline-card-title"
                  value={card.title}
                  aria-label={`Card title ${itemNumber}`}
                  aria-required="true"
                  aria-invalid={titleInvalid || undefined}
                  aria-describedby={titleInvalid ? errorId : undefined}
                  placeholder="Card title"
                  onChange={(event) =>
                    updateCard(index, { title: event.target.value })
                  }
                />
              </GeneratedHeading>
              <div className="inline-card-body">
                <RichTextEditor
                  value={card.body}
                  onChange={(body) => updateCard(index, { body })}
                  ariaLabel={`Card text ${itemNumber}`}
                  ariaInvalid={bodyInvalid}
                  ariaDescribedBy={bodyInvalid ? errorId : undefined}
                  headingLevelOffset={headingLevel - 1}
                  minimumHeadingLevel={Math.min(6, headingLevel + 1)}
                />
              </div>
              <div className="inline-card-fields">
                <label htmlFor={`block-${block.id}-card-${index}-href`}>
                  Card link {itemNumber}
                </label>
                <TextInput
                  id={`block-${block.id}-card-${index}-href`}
                  type="text"
                  inputMode="url"
                  value={card.href}
                  aria-invalid={hrefInvalid || undefined}
                  aria-describedby={hrefInvalid ? errorId : undefined}
                  onChange={(event) =>
                    updateCard(index, { href: event.target.value })
                  }
                />
              </div>
              <div className="inline-collection-controls">
                <ActionControl
                  action="move-up"
                  contextLabel={`card ${itemNumber}`}
                  disabled={index === 0}
                  onClick={() => moveCard(index, -1)}
                />
                <ActionControl
                  action="move-down"
                  contextLabel={`card ${itemNumber}`}
                  disabled={index === cards.length - 1}
                  onClick={() => moveCard(index, 1)}
                />
                <Button
                  variant="danger"
                  aria-label={`Remove card ${itemNumber}`}
                  onClick={() => removeCard(index)}
                >
                  Remove
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <Button
        className="inline-collection-add"
        disabled={cards.length >= NESTED_MEDIA_COLLECTION_MAX}
        onClick={addCard}
      >
        Add card
      </Button>
    </div>
  );
}

function coverageConversionCopy(
  inspection: CoverageProseInspection,
  cardCapacity: number,
): string[] {
  const messages: string[] = [];
  if (inspection.lostYearHeadings) {
    messages.push(
      "This text uses year headings. Link cards can only keep those year groups when each article has a full date. Add a month, day, and year to each article, or keep this as text so the headings stay.",
    );
  }
  if (inspection.overflow) {
    messages.push(
      `The converter can read up to ${COVERAGE_LIST_LIMITS.entries} articles. This text has ${inspection.entries.length}. Split the list before converting.`,
    );
  }
  if (inspection.overLimit) {
    messages.push(
      `Link cards can keep titles up to ${COVERAGE_LIST_LIMITS.title} characters, sources up to ${COVERAGE_LIST_LIMITS.outlet}, and links up to ${COVERAGE_LIST_LIMITS.url}. This text is longer. Shorten it, or keep it as text.`,
    );
  }
  if (inspection.entries.length > cardCapacity) {
    messages.push(
      `This page has room for ${cardCapacity} more link ${cardCapacity === 1 ? "card" : "cards"}. This text has ${inspection.entries.length} articles. Remove other content or split the list before converting.`,
    );
  }
  return messages;
}

function InlineProse({
  block,
  hasError,
  errorId,
  onChange,
  onHomeText,
  onConvertCoverage,
  coverageCardCapacity = Number.POSITIVE_INFINITY,
}: Pick<BlockSurfaceProps, "block" | "hasError" | "errorId" | "onChange" | "onHomeText" | "onConvertCoverage" | "coverageCardCapacity">) {
  const content = (block.data.content as RichTextDoc) ?? EMPTY_RICH_TEXT_DOC;
  if (block.section === "home-passport-copy" && isRichTextDoc(content)) {
    const heading = homePassportHeading(content) ?? "";
    const body = { type: "doc" as const, content: content.content.slice(1) };
    return (
      <div className="inline-block-surface inline-prose">
        <label htmlFor={`block-${block.id}-passport-heading`}>Heading</label>
        <TextInput
          id={`block-${block.id}-passport-heading`}
          value={heading}
          onChange={(event) => {
            const value = event.target.value;
            if (onHomeText) {
              onHomeText(value);
              return;
            }
            onChange({
              ...block.data,
              content: {
                type: "doc",
                content: [
                  { type: "heading", attrs: { level: 2 }, content: value ? [{ type: "text", text: value }] : [] },
                  ...body.content,
                ],
              },
            });
          }}
        />
        <span className="field-label">Body</span>
        <RichTextEditor
          value={body}
          onChange={(next) => onChange({
            ...block.data,
            content: {
              type: "doc",
              content: [
                { type: "heading", attrs: { level: 2 }, content: heading ? [{ type: "text", text: heading }] : [] },
                ...next.content,
              ],
            },
          })}
          ariaLabel={PROSE_CONTENT_FIELD.label}
          ariaRequired={PROSE_CONTENT_FIELD.required}
          ariaInvalid={hasError}
          ariaDescribedBy={hasError ? errorId : undefined}
          minimumHeadingLevel={3}
        />
      </div>
    );
  }
  const inspection = inspectCoverageProse(content);
  const blockedCopy = onConvertCoverage
    ? coverageConversionCopy(inspection, coverageCardCapacity)
    : [];
  const canConvert = inspection.convertible && inspection.entries.length <= coverageCardCapacity;
  return (
    <div className="inline-block-surface inline-prose">
      <RichTextEditor
        value={content}
        onChange={(next) => onChange({ ...block.data, content: next })}
        ariaLabel={PROSE_CONTENT_FIELD.label}
        ariaRequired={PROSE_CONTENT_FIELD.required}
        ariaInvalid={hasError}
        ariaDescribedBy={hasError ? errorId : undefined}
      />
      {onConvertCoverage && canConvert ? (
        <div className="inline-coverage-convert">
          <p>
            This text looks like {inspection.entries.length}{" "}
            {inspection.entries.length === 1 ? "outside article" : "outside articles"}.
            Link cards let you edit, move, show, or hide each title, source, date, and link.
            {inspection.leftover
              ? " Other sentences in this block will be removed. Move any introduction into its own text block first."
              : ""}
          </p>
          <Button
            onClick={() => onConvertCoverage(inspection.entries)}
          >
            Turn into link cards
          </Button>
        </div>
      ) : blockedCopy.length > 0 ? (
        <div className="inline-coverage-convert">
          {blockedCopy.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InlineLinkCard({
  block,
  generatedHeadingLevel = 2,
  hasError,
  errorId,
  onChange,
}: BlockSurfaceProps) {
  const fields = editorFieldsForBlock("link_card");
  const data = block.data as LinkCardData & Record<string, unknown>;
  const preview: LinkCardBlock = {
    id: block.id,
    type: "link_card",
    order: block.order,
    visible: block.visible,
    data: {
      title: typeof data.title === "string" ? data.title : "",
      url: typeof data.url === "string" ? data.url : "",
      source: typeof data.source === "string" ? data.source : "",
      date: typeof data.date === "string" ? data.date : "",
      summary: typeof data.summary === "string" ? data.summary : "",
    },
  };
  const markup = renderBlock(preview, {
    generatedHeadingLevel: clampHeadingLevel(generatedHeadingLevel),
  });
  return (
    <section
      className="inline-block-surface inline-dynamic-shelf"
      aria-invalid={hasError || undefined}
      aria-describedby={hasError ? errorId : undefined}
    >
      <div className="inline-dynamic-shelf-preview cms-page__blocks" ref={markPreviewInert}>
        {data.title || data.url ? (
          <div
            className="cms-block cms-block--link_card"
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : (
          <p className="inline-dynamic-shelf-note">Add a title and link to see the card preview.</p>
        )}
      </div>
      <div className="inline-dynamic-shelf-fields">
        {fields.map((field) => {
          const value = data[field.key];
          const error = hasError
            ? editorFieldValidationMessage(field, value, { siblings: data, fields })
            : null;
          return (
            <FieldRenderer
              key={field.key}
              field={field}
              value={value}
              onChange={(next) => onChange({ ...block.data, [field.key]: next })}
              fieldId={`block-${block.id}-${field.key}`}
              error={error ?? undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

function InlineCoverageList({
  block,
  generatedHeadingLevel = 2,
  hasError,
  errorId,
  onChange,
}: BlockSurfaceProps) {
  const fields = editorFieldsForBlock("coverage_list");
  const data = block.data as CoverageListData & Record<string, unknown>;
  const headingLevel = clampHeadingLevel(generatedHeadingLevel);
  const preview = {
    id: block.id,
    type: "coverage_list" as const,
    order: block.order,
    visible: block.visible,
    data: {
      entries: Array.isArray(data.entries) ? data.entries : [],
    },
  };
  const markup = renderBlock(preview, { generatedHeadingLevel: headingLevel });
  return (
    <section
      className="inline-block-surface inline-dynamic-shelf"
      aria-invalid={hasError || undefined}
      aria-describedby={hasError ? errorId : undefined}
    >
      <div
        className="inline-dynamic-shelf-preview cms-page__blocks"
        ref={markPreviewInert}
      >
        {markup ? (
          <div
            className="cms-block cms-block--coverage_list"
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : (
          <p className="inline-dynamic-shelf-note">Add an article to see how it will look on the page.</p>
        )}
      </div>
      <div className="inline-dynamic-shelf-fields">
        {fields.map((field) => {
          const value = data[field.key];
          const error = hasError
            ? editorFieldValidationMessage(field, value, {
                siblings: data,
                fields,
              })
            : null;
          return (
            <FieldRenderer
              key={field.key}
              field={field}
              value={value}
              onChange={(next) => onChange({ ...block.data, [field.key]: next })}
              fieldId={`block-${block.id}-${field.key}`}
              error={error ?? undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

function InlineFaqItem({
  block,
  generatedHeadingLevel = 2,
  hasError,
  errorId,
  onChange,
}: BlockSurfaceProps) {
  const question = String(block.data.question ?? "");
  const headingLevel = clampHeadingLevel(generatedHeadingLevel);
  const GeneratedHeading = `h${headingLevel}` as
    "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  // The shared frozen default, not a fresh one: this value is only read (an edit replaces it
  // through onChange), and minting one per render would hand the controlled editor a new identity
  // on every pass of the block list (#511).
  const answer = isRichTextDoc(block.data.answer)
    ? block.data.answer
    : EMPTY_RICH_TEXT_DOC;
  const questionInvalid = Boolean(hasError && question.trim().length === 0);
  const answerInvalid = Boolean(
    hasError && (richTextIsEmpty(answer) || richTextHasUnsafeLink(answer)),
  );

  return (
    <div
      className="inline-block-surface inline-faq-item faq-item"
      role="group"
      aria-label="FAQ item"
      aria-invalid={hasError || undefined}
      aria-describedby={hasError ? errorId : undefined}
    >
      <GeneratedHeading className="faq-item__question">
        <TextInput
          className="inline-faq-question"
          value={question}
          aria-label="Question"
          aria-required="true"
          aria-invalid={questionInvalid || undefined}
          aria-describedby={questionInvalid ? errorId : undefined}
          placeholder="Write the question"
          onChange={(event) =>
            onChange({ ...block.data, question: event.target.value })
          }
        />
      </GeneratedHeading>
      <RichTextEditor
        value={answer}
        onChange={(next) => onChange({ ...block.data, answer: next })}
        ariaLabel="Answer"
        ariaRequired
        ariaInvalid={answerInvalid}
        ariaDescribedBy={answerInvalid ? errorId : undefined}
        headingLevelOffset={headingLevel - 1}
        minimumHeadingLevel={Math.min(6, headingLevel + 1)}
      />
    </div>
  );
}

function renderedEmbedMarkup(block: AdminBlock): string {
  const data: EmbedBlock["data"] = {
    url: String(block.data.url ?? ""),
    caption: String(block.data.caption ?? ""),
  };
  if (typeof block.data.host === "string") data.host = block.data.host;
  if (typeof block.data.width === "number") data.width = block.data.width;
  if (typeof block.data.height === "number") data.height = block.data.height;
  if (typeof block.data.heading === "string") data.heading = block.data.heading;
  if (block.data.mapSize === "small" || block.data.mapSize === "medium" || block.data.mapSize === "large") data.mapSize = block.data.mapSize;
  if (typeof block.data.mobileHeight === "number") data.mobileHeight = block.data.mobileHeight;
  if (block.data.mapWidth === "content" || block.data.mapWidth === "wide") data.mapWidth = block.data.mapWidth;
  const embed: EmbedBlock = {
    id: block.id,
    type: "embed",
    order: block.order,
    visible: block.visible,
    data,
  };
  return renderBlock(embed);
}

// The embed preview mirrors the published markup, which for a safe url is a real
// `<a href>`. In the editor that anchor is a preview, not navigation -- the link and
// caption are edited in the fields below it. `inert` takes the whole subtree out of the
// tab order, pointer handling, and the a11y tree, so the link can never be a
// focusable-but-dead control (the reason an `onClick` preventDefault was not enough: it
// stopped a mouse click but left the anchor keyboard-focusable and inoperable). React 18
// does not pass an `inert` prop through to the DOM, so set it on the node; a stable
// callback keeps React from detaching and reattaching the ref each render.
function markPreviewInert(node: HTMLDivElement | null): void {
  if (node) node.inert = true;
}

// The two dynamic blocks (#1046) preview through the REAL renderer over the REAL
// committed catalog, not through a mock row. That is the acceptance criterion "the
// editor preview and the public renderer use the same finite query contract", made
// structural: this component builds the same block the page stores, hands it to
// renderBlock, and shows the markup the build will publish. If the shelf will be empty
// on the page, it is empty here, with the same sentence.
//
// The summary line underneath is editor-facing only and never ships: how many approved
// items the query found, what the resolver refused and why, and whether the committed
// catalog has gone stale. An editor should not have to publish a page to learn that a
// shelf found two stories, or that a pinned story is no longer in the approved list.
function dynamicShelfBlock(block: AdminBlock): TopicShelfBlock | VideoPlaylistBlock {
  const data = block.data as Record<string, unknown>;
  const shared = {
    title: String(data.title ?? ""),
    topic: typeof data.topic === "string" ? data.topic : SHELF_TOPICS[0].id,
    itemLimit: (SHELF_ITEM_LIMITS as readonly number[]).includes(
      data.itemLimit as number,
    )
      ? (data.itemLimit as TopicShelfData["itemLimit"])
      : SHELF_ITEM_LIMITS[1],
    sort: (SHELF_SORTS as readonly string[]).includes(data.sort as string)
      ? (data.sort as TopicShelfData["sort"])
      : "newest",
    pinned: Array.isArray(data.pinned)
      ? data.pinned.flatMap((entry) =>
          entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
            ? [{ id: (entry as { id: string }).id }]
            : [],
        )
      : [],
  };
  if (block.type === "video_playlist") {
    return {
      id: block.id,
      type: "video_playlist",
      order: block.order,
      visible: block.visible,
      data: {
        ...shared,
        library: (VIDEO_LIBRARIES as readonly string[]).includes(
          data.library as string,
        )
          ? (data.library as VideoPlaylistData["library"])
          : VIDEO_LIBRARIES[0],
      },
    };
  }
  return {
    id: block.id,
    type: "topic_shelf",
    order: block.order,
    visible: block.visible,
    data: {
      ...shared,
      source: (TOPIC_SHELF_SOURCES as readonly string[]).includes(
        data.source as string,
      )
        ? (data.source as TopicShelfData["source"])
        : TOPIC_SHELF_SOURCES[0],
    },
  };
}

// The pin choices for THIS block: the approved catalog, narrowed to the source or library
// the block currently names. The descriptor deliberately declares none (see
// TOPIC_SHELF_PIN_FIELDS), both because the right list depends on the block and because
// the catalog would otherwise be fused to the admin's entry chunk. Narrowing matters: a
// playlist pointed at the national library must not offer a station video, because the
// resolver would then refuse to place the pin the editor just made.
function shelfPinOptions(
  preview: TopicShelfBlock | VideoPlaylistBlock,
): { value: string; label: string }[] {
  return preview.type === "video_playlist"
    ? APPROVED_VIDEO_LIBRARY.items
        .filter((item) => item.library === preview.data.library)
        .map((item) => ({ value: item.id, label: item.title }))
    : RELATED_STORY_INDEX.items
        .filter((item) => item.source === preview.data.source)
        .map((item) => ({ value: item.id, label: item.title }));
}

// The block's fields with the pin picker's choices filled in. When the narrowed catalog
// offers nothing, the pin field is dropped entirely rather than rendered as an Add button
// that opens a picker with no choices -- a dead end that would fail validation on save.
// It returns by itself the moment the chosen library holds something.
function dynamicShelfFields(
  blockType: BlockType,
  preview: TopicShelfBlock | VideoPlaylistBlock,
): EditorField[] {
  const options = shelfPinOptions(preview);
  return editorFieldsForBlock(blockType).flatMap((field) => {
    if (field.key !== "pinned") return [field];
    if (options.length === 0) return [];
    return [
      {
        ...field,
        itemFields: (field.itemFields ?? []).map((sub) =>
          sub.key === "id" ? { ...sub, options } : sub,
        ),
      },
    ];
  });
}

function InlineDynamicShelf({
  block,
  generatedHeadingLevel = 2,
  hasError,
  onChange,
}: BlockSurfaceProps) {
  const data = block.data as Record<string, unknown>;
  const headingLevel = clampHeadingLevel(generatedHeadingLevel);
  const preview = dynamicShelfBlock(block);
  const fields = dynamicShelfFields(block.type, preview);
  const markup = renderBlock(preview, { generatedHeadingLevel: headingLevel });
  const resolved =
    preview.type === "video_playlist"
      ? resolveVideoPlaylist(preview.data, APPROVED_VIDEO_LIBRARY)
      : resolveTopicShelf(preview.data, RELATED_STORY_INDEX);
  const plural = preview.type === "video_playlist" ? "videos" : "stories";
  const noun =
    resolved.totalMatched === 1
      ? (preview.type === "video_playlist" ? "video" : "story")
      : plural;
  // A pin is an override, so a pinned item can sit outside the topic entirely. Counting it
  // inside the topic's own total produced "2 of 1 approved stories on this topic", which
  // reads as a broken shelf rather than as the override an editor asked for. The two
  // numbers are therefore reported as what they are.
  const pinnedCount = resolved.items.filter((item) => item.pinned).length;
  const cards = `${resolved.items.length} ${resolved.items.length === 1 ? "card" : "cards"}`;
  const pinnedPart = pinnedCount > 0 ? `, ${pinnedCount} pinned by hand` : "";
  const notes = [
    `This is what the page will show: ${cards}${pinnedPart}. The topic matches ${resolved.totalMatched} approved ${noun}.`,
    resolved.emptyReason === "source_empty"
      ? `The approved list has no ${plural} with complete details yet, so this block will publish its empty message. Ask a developer before relying on it.`
      : "",
    resolved.ineligibleDropped > 0
      ? `${resolved.ineligibleDropped} ${resolved.ineligibleDropped === 1 ? (preview.type === "video_playlist" ? "video was" : "story was") : `${plural} were`} left out because the details are incomplete.`
      : "",
    resolved.missingPins.length > 0
      ? `A pinned item is no longer on the approved list: ${resolved.missingPins.join(", ")}.`
      : "",
    resolved.stale
      ? "The approved list has not been refreshed in a while. Ask a developer to update it before relying on it."
      : "",
  ].filter((note) => note !== "");

  return (
    <section className="inline-block-surface inline-dynamic-shelf">
      <div
        className="inline-dynamic-shelf-preview"
        ref={markPreviewInert}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
      <p className="inline-dynamic-shelf-note">{notes.join(" ")}</p>
      <div className="inline-dynamic-shelf-fields">
        {fields.map((field) => {
          const value = data[field.key];
          const error = hasError
            ? editorFieldValidationMessage(field, value, {
                siblings: data,
                fields,
              })
            : null;
          return (
            <FieldRenderer
              key={field.key}
              field={field}
              value={value}
              onChange={(next) =>
                onChange({ ...block.data, [field.key]: next })
              }
              fieldId={`block-${block.id}-${field.key}`}
              error={error ?? undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

function InlineContentShelf({
  block,
  generatedHeadingLevel = 2,
  hasError,
  onChange,
}: BlockSurfaceProps) {
  const homeNamedShelf = block.section === "home-featured"
    || block.section === "home-more"
    || block.section === "home-spotlight";
  const data = block.data as Partial<ContentShelfData> &
    Record<string, unknown>;
  const homeLimits = data.source === "pbs_more" ? [3, 4, 6, 8, 12, 16] : [3, 4, 6, 8];
  const presentation = data.presentation ?? "rail";
  const fields = adminFieldsForBlock("content_shelf")
    .filter((field) => !homeNamedShelf || (field.key !== "source" && field.key !== "moreHref"))
    .filter((field) => field.key !== "columns" || presentation === "grid")
    .map((field) => {
      if (!homeNamedShelf || field.key !== "itemLimit" || field.kind !== "select") return field;
      return {
        ...field,
        options: field.options?.filter(option => homeLimits.includes(Number(option.value))),
      };
    });
  const headingLevel = clampHeadingLevel(generatedHeadingLevel);
  const GeneratedHeading = `h${headingLevel}` as
    "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  const sourceNote =
    data.source === "spotlight_news"
      ? "Headlines refresh from the NJ Spotlight News feed."
      : "Program cards refresh from PBS Media Manager.";

  function changeField(key: string, value: unknown) {
    const next = { ...block.data, [key]: value };
    if (!homeLayoutsEnabled()) {
      delete next.presentation;
      delete next.columns;
      // Keep at least the requested cards using the next production count.
      if (next.itemLimit === 3) next.itemLimit = 4;
      if (next.itemLimit === 6) next.itemLimit = 8;
    }
    onChange(next);
  }

  return (
    <section className="inline-block-surface inline-content-shelf">
      <header className="inline-content-shelf-head">
        <GeneratedHeading className="inline-content-shelf-title">
          {String(data.title ?? "") || "Shelf heading"}
        </GeneratedHeading>
        <span>{String(data.moreLabel ?? "") || "More link"}</span>
      </header>
      <p className="inline-content-shelf-note">{sourceNote}</p>
      {homeNamedShelf ? <p className="muted">Link destination: {String(data.moreHref ?? "")}</p> : null}
      <p className="inline-content-shelf-note">{presentation === "grid"
        ? "Cards wrap into rows. Phones show two columns; no sideways scrolling is needed."
        : "Cards stay in one horizontal row that visitors can scroll. Nothing advances automatically."}</p>
      <div className="inline-content-shelf-fields">
        {fields.map((field) => {
          const value = data[field.key] ?? (field.key === "presentation" ? "rail" : field.key === "columns" ? 3 : undefined);
          const error = hasError
            ? editorFieldValidationMessage(field, value, {
                siblings: data,
                fields,
              })
            : null;
          return (
            <FieldRenderer
              key={field.key}
              field={field}
              value={value}
              onChange={(next) => changeField(field.key, next)}
              fieldId={`block-${block.id}-${field.key}`}
              error={error ?? undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

function CustomShelfPreview({ block, loadMedia, generatedHeadingLevel }: Pick<BlockSurfaceProps, "block" | "loadMedia" | "generatedHeadingLevel">) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const assets = useResolvedMediaAssets(
    (Array.isArray(block.data.cards) ? block.data.cards : [])
      .map(card => String(card.imageAssetId ?? "")).filter(id => id.trim() !== ""),
    loadMedia,
  );
  const title = String(block.data.title ?? "");
  const previewBlock = {
    ...block,
    visible: true,
    data: {
      ...block.data,
      title: title.trim() === "" ? "Shelf heading" : title,
    },
  } as unknown as PromotionPlaylistBlock;
  const html = renderBlock(previewBlock, {
    generatedHeadingLevel,
    resolveAsset: id => {
      const asset = assets.get(id);
      if (!asset) return null;
      // The card image is a fixed 16:9 frame (custom-shelf.css). 480 by 270 is that frame.
      const image = mediaPreviewImage(asset, 480, 270);
      return {
        url: image.src,
        width: image.width,
        height: image.height,
        ...(image.srcSet ? { srcset: image.srcSet, sizes: image.sizes } : {}),
      };
    },
  });
  useEffect(() => {
    if (previewRef.current && typeof ResizeObserver !== "undefined") return installCustomShelfControls(previewRef.current);
  }, [html]);
  return <div ref={element => {
      previewRef.current = element;
      // Cards are preview text; keep only the real scrolling controls interactive.
      element?.querySelectorAll("a").forEach(link => link.removeAttribute("href"));
    }} className="inline-custom-shelf-preview"
    dangerouslySetInnerHTML={{ __html: html }} />;
}

function InlinePromotionPlaylist({
  block,
  generatedHeadingLevel = 2,
  hasError,
  loadMedia,
  mediaPickerUnavailable,
  homeShelf = false,
  onChange,
}: BlockSurfaceProps) {
  const fields = editorFieldsForBlock("promotion_playlist");
  const data = block.data;
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const presentation = data.presentation ?? "rail";
  const visibleFields = fields.filter(field =>
    (field.key !== "placement" || homeShelf) && (field.key !== "columns" || presentation === "grid"));
  return (
    <section className="inline-block-surface inline-promotion-playlist">
      {cards.length > 0 ? <CustomShelfPreview block={block} loadMedia={loadMedia} generatedHeadingLevel={generatedHeadingLevel} /> : null}
      <ContentShelfPicker disabled={cards.length >= 12} onAdd={card => onChange({ ...block.data, cards: [...cards, card] })} />
      <div className="inline-content-shelf-fields">
        {visibleFields.map(field => {
          const value = data[field.key] ?? (field.key === "presentation" ? "rail" : field.key === "columns" ? 3 : undefined);
          const error = hasError ? editorFieldValidationMessage(field, value, { siblings: data, fields }) : null;
          return <FieldRenderer key={field.key} field={field} value={value}
            onChange={next => onChange({ ...block.data, [field.key]: next })}
            fieldId={`block-${block.id}-${field.key}`} error={error ?? undefined}
            loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} />;
        })}
      </div>
    </section>
  );
}

/** Whether this editor may add or change custom HTML. The save boundary enforces the same rule. */
export const CustomHtmlEditing = createContext(true);

function InlineHtml({ block, hasError, onChange }: Pick<BlockSurfaceProps, "block" | "hasError" | "onChange">) {
  const fields = editorFieldsForBlock("html");
  const data = block.data;
  const canEdit = useContext(CustomHtmlEditing);
  if (!canEdit) {
    return (
      <div className="inline-block-surface inline-html">
        <p>Only Editors, Managers and Site owners can change custom HTML. You can still move, hide, or remove this block.</p>
      </div>
    );
  }
  return (
    <div className="inline-block-surface inline-html">
      {fields.map(field => {
        const value = data[field.key];
        const error = hasError ? editorFieldValidationMessage(field, value, { siblings: data, fields }) : null;
        return <FieldRenderer key={field.key} field={field} value={value}
          onChange={next => onChange({ ...block.data, [field.key]: next })}
          fieldId={`block-${block.id}-${field.key}`} error={error ?? undefined} />;
      })}
    </div>
  );
}

function InlineEmbed({
  block,
  hasError,
  errorId,
  onChange,
}: BlockSurfaceProps) {
  const fields = editorFieldsForBlock("embed");
  const dimensionFields = fields.filter(field => field.kind === "number");
  const url = String(block.data.url ?? "");
  const isApMap = apResultsLayoutSrc(url) !== null;
  const layoutFields = isApMap ? apResultsEditorFields() : dimensionFields;
  function changeUrl(url: string, committed = false) {
    const nextIsApMap = apResultsLayoutSrc(url) !== null;
    const data: Record<string, unknown> = { ...block.data, url };
    let otherWebLink = false;
    if (committed) {
      try {
        const link = new URL(url);
        otherWebLink = ["http:", "https:"].includes(link.protocol) && link.hostname !== "interactives.apelections.org";
      } catch { /* Empty and partial links retain their settings. */ }
    }
    if (otherWebLink || nextIsApMap || embedPlayer(url) || xVideoLink(url)) {
      const inactiveFields = nextIsApMap ? dimensionFields : apResultsEditorFields();
      for (const field of inactiveFields) delete data[field.key];
    } else if (committed) {
      const mapFields = apResultsEditorFields();
      for (const field of mapFields) {
        if (editorFieldValidationMessage(field, data[field.key], { siblings: data, fields: [...fields, ...mapFields] })) {
          delete data[field.key];
        }
      }
    }
    if (url !== block.data.url || Object.keys(data).length !== Object.keys(block.data).length) onChange(data);
  }
  const caption = String(block.data.caption ?? "");
  const urlInvalid = Boolean(hasError && !isSafeHref(url));
  const preview =
    url.trim().length > 0
      ? renderedEmbedMarkup(block)
      : '<div class="embed">No link added yet.</div>';

  return (
    <div className="inline-block-surface inline-embed">
      <div
        className="inline-embed-preview"
        ref={markPreviewInert}
        dangerouslySetInnerHTML={{ __html: preview }}
      />
      <div className="inline-embed-fields">
        <label htmlFor={`block-${block.id}-url`}>Video or embed link</label>
        <TextInput
          id={`block-${block.id}-url`}
          type="text"
          inputMode="url"
          value={url}
          aria-required="true"
          aria-invalid={urlInvalid || undefined}
          aria-describedby={urlInvalid ? errorId : undefined}
          placeholder="https://example.org/video"
          onChange={event => changeUrl(event.target.value)}
          onBlur={event => changeUrl(event.currentTarget.value, true)}
        />
        <label htmlFor={`block-${block.id}-caption`}>Caption</label>
        <TextInput
          id={`block-${block.id}-caption`}
          value={caption}
          placeholder="Add a caption (optional)"
          onChange={(event) =>
            onChange({ ...block.data, caption: event.target.value })
          }
        />
      </div>
      <div className="inline-embed-dimensions">
        {layoutFields.map(field => {
          const value = block.data[field.key] ?? (field.key === "mapSize" ? "medium" : field.key === "mapWidth" ? "content" : undefined);
          const error = hasError
            ? editorFieldValidationMessage(field, value, { siblings: block.data, fields })
            : null;
          return <FieldRenderer
            key={field.key}
            field={field}
            value={value}
            onChange={next => {
              const data = { ...block.data };
              if (next === undefined) delete data[field.key];
              else data[field.key] = next;
              onChange(data);
            }}
            fieldId={`block-${block.id}-${isApMap ? "ap-" : ""}${field.key}`}
            error={error ?? undefined}
          />;
        })}
      </div>
    </div>
  );
}

interface BlockSettingsProps {
  block: AdminBlock;
  onChange: (data: Record<string, unknown>) => void;
}

// Only a block with a settings descriptor renders a panel. The card toolbar reads the same
// module, so a block with nothing to settle shows no Settings control at all rather than opening
// a panel of explanatory text (issue #1043).
export function BlockSettings({ block, onChange }: BlockSettingsProps) {
  if (!blockHasSettings(block.type)) return null;

  if (block.type === "headline") {
    const fieldId = `block-${block.id}-level`;
    const level = renderedHeadlineLevel(block);
    return (
      <div className="block-card-fields block-settings-fields">
        <FieldRenderer
          field={HEADLINE_LEVEL_FIELD}
          value={level}
          onChange={() => {}}
          fieldId={fieldId}
          control={
            <Select
              id={fieldId}
              value={level}
              aria-describedby={`${fieldId}-help`}
              onChange={(event) =>
                onChange({ ...block.data, level: Number(event.target.value) })
              }
            >
              {HEADING_LEVELS.map((option) => (
                <option key={option} value={option}>
                  Heading {option}
                </option>
              ))}
            </Select>
          }
        />
      </div>
    );
  }

  if (block.type === "image_gallery") {
    const fieldId = `block-${block.id}-presentation`;
    const selected = galleryPresentation({
      images: [],
      presentation: block.data.presentation as GalleryPresentation | undefined,
    });
    const spec =
      GALLERY_PRESENTATION_SPECS.find((candidate) => candidate.value === selected) ??
      GALLERY_PRESENTATION_SPECS[0]!;
    return (
      <div className="block-card-fields block-settings-fields">
        <fieldset className="gallery-presentation-choices" aria-label={GALLERY_PRESENTATION_FIELD.label}>
          <legend>{GALLERY_PRESENTATION_FIELD.label}</legend>
          {GALLERY_PRESENTATION_SPECS.map(option => <label key={option.value} data-selected={selected === option.value || undefined}>
            <input type="radio" name={fieldId} value={option.value} checked={selected === option.value}
              onChange={() => onChange({ ...block.data, presentation: option.value })} />
            <Icon name={option.value === "grid" ? "dashboard" : "panel-left"} />{option.label}
          </label>)}
        </fieldset>
        {/*
          What the published page actually does, read from the same mode registry the renderer
          switches on (#1034). The click result is the half an editor cannot find out by looking:
          today a gallery image is not a link and the site has no lightbox, so the honest answer
          is that clicking does nothing, and it is said here rather than discovered after publish.
        */}
        <details className="block-settings-help">
          <summary>How this gallery behaves</summary>
          <div className="block-settings-help-copy">
            <p className="muted block-card-note">{spec.layout}</p>
            <p className="muted block-card-note">{spec.clickBehavior}</p>
            <p className="muted block-card-note">
              Gallery images are edited directly in the block.
            </p>
          </div>
        </details>
      </div>
    );
  }

  return null;
}
