import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MediaAssetSummary } from "../../lib/functions";
import { cachedPoster } from "../../lib/media-session-cache";
import { mixedTagTokens, tagMatchFor, tagTokenEdit } from "../../lib/media-tags";
import {
  emptyBulkMetadataDraft,
  hasBulkMetadataIntent,
  type BulkMetadataDraft,
  type TextField,
} from "../../lib/source-media-bulk";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { Inspector, InspectorSection } from "../ui/Inspector";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { Button, InlineMessage, Select, Textarea, TextInput } from "../ui/Primitives";
import { TokenInput, type Token } from "../ui/TokenInput";
import "./MediaBulkInspector.css";

const SUGGESTIONS_NOTE = "From the selected items, this page and your recent tags.";
const TEXT_FIELDS = ["description", "credit", "license"] as const;
const FIELD_LABELS: Record<TextField, string> = {
  description: "Description",
  credit: "Credit",
  license: "License",
};
const MODE_LABELS: Record<BulkMetadataDraft[TextField]["mode"], string> = {
  keep: "Leave unchanged",
  set: "Set the same value",
  clear: "Clear this field",
};

interface CommonProps {
  /** The component can stay mounted with open=false while its review dialog is visible. */
  open: boolean;
  /** Optional convenience for integrations that keep open=true during review. */
  reviewing?: boolean;
  pageTags?: readonly string[];
  recentTags?: readonly string[];
  offPageCount?: number;
  /** Increment after Back to editing to open Details and focus its first field action. */
  focusRequest?: number;
  onCancel: () => void;
  onReview: (draft: BulkMetadataDraft) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export type MediaBulkInspectorProps = CommonProps & (
  | { surface: "images"; assets: readonly MediaAssetSummary[] }
  | { surface: "video"; assets: readonly SourceMediaAssetSummary[] }
);

function uniqueSuggestions(sources: readonly (readonly string[])[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of sources.flat()) {
    const value = tag.trim();
    const key = value.normalize("NFKC").toLocaleLowerCase("en-US");
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function commonText(assets: readonly { description: string | null; credit: string | null; license: string | null }[], field: TextField) {
  const first = assets[0]?.[field] ?? "";
  return assets.every(asset => (asset[field] ?? "") === first) ? { mixed: false, value: first } : { mixed: true, value: "" };
}

function frozenDraft(draft: BulkMetadataDraft): BulkMetadataDraft {
  const tags = Object.freeze({
    ...draft.tags,
    add: draft.tags.add ? Object.freeze([...draft.tags.add]) : undefined,
    remove: draft.tags.remove ? Object.freeze([...draft.tags.remove]) : undefined,
  });
  return Object.freeze({
    tags,
    description: Object.freeze({ ...draft.description }),
    credit: Object.freeze({ ...draft.credit }),
    license: Object.freeze({ ...draft.license }),
    rightsStatus: draft.rightsStatus,
  }) as BulkMetadataDraft;
}

function imageThumbnail(asset: MediaAssetSummary) {
  if (asset.kind !== "image" || !asset.thumbnails?.length) return null;
  const thumbnails = [...asset.thumbnails].sort((a, b) => a.width - b.width);
  return thumbnails.find(thumbnail => thumbnail.width >= 240) ?? thumbnails.at(-1) ?? null;
}

function PreviewTile({ asset, surface }: {
  asset: MediaAssetSummary | SourceMediaAssetSummary;
  surface: "images" | "video";
}) {
  const image = surface === "images" ? imageThumbnail(asset as MediaAssetSummary) : null;
  const poster = surface === "video"
    ? cachedPoster((asset as SourceMediaAssetSummary).sourceId, asset.id, (asset as SourceMediaAssetSummary).fileVersion)
    : undefined;
  const source = image?.url ?? poster;
  return <figure className="media-bulk-preview-item">
    {source ? <img alt="" decoding="async" src={source} />
      : <span aria-hidden="true"><Icon name={surface === "video" ? "video" : (asset as MediaAssetSummary).kind === "audio" ? "microphone" : (asset as MediaAssetSummary).kind === "document" ? "file" : "image"} /></span>}
    <figcaption className="sr-only">{asset.name}</figcaption>
  </figure>;
}

function selectionSummary(props: MediaBulkInspectorProps) {
  const offPage = props.offPageCount ?? 0;
  const away = offPage ? ` · ${offPage} not on this page` : "";
  if (props.surface === "video") return `${props.assets.length} ${props.assets.length === 1 ? "video" : "videos"}${away}`;
  const images = props.assets.filter(asset => asset.kind === "image").length;
  const documents = props.assets.filter(asset => asset.kind === "document").length;
  const audio = props.assets.filter(asset => asset.kind === "audio").length;
  const parts = [
    images ? `${images} ${images === 1 ? "image" : "images"}` : "",
    documents ? `${documents} ${documents === 1 ? "PDF" : "PDFs"}` : "",
    audio ? `${audio} ${audio === 1 ? "audio file" : "audio files"}` : "",
  ].filter(Boolean);
  return `${parts.join(", ")}${away}`;
}

function BulkTextField({
  assets,
  change,
  field,
  firstControlRef,
  onChange,
  surface,
  selectionLabel,
}: {
  assets: readonly { description: string | null; credit: string | null; license: string | null }[];
  change: BulkMetadataDraft[TextField];
  field: TextField;
  firstControlRef?: RefObject<HTMLDivElement>;
  onChange: (change: BulkMetadataDraft[TextField]) => void;
  surface: "images" | "video";
  selectionLabel: string;
}) {
  const label = FIELD_LABELS[field];
  const current = commonText(assets, field);
  const maxLength = field === "description" ? 2_000 : surface === "images" ? (field === "credit" ? 300 : 120) : 500;
  const setMode = (mode: BulkMetadataDraft[TextField]["mode"]) => {
    const value = mode === "set" ? (change.value || (!current.mixed ? current.value : "")) : "";
    onChange({ mode, value });
  };
  return <div className="media-bulk-field">
    <div className="media-bulk-field-row">
      <span>{label}</span>
      <div ref={firstControlRef}>
        <Menu className="media-bulk-field-menu" icon="chevron-down" label={`${label}: ${MODE_LABELS[change.mode]}`} items={[
          { key: "keep", label: "Leave unchanged", onSelect: () => setMode("keep") },
          { key: "set", label: "Set the same value", onSelect: () => setMode("set") },
          { key: "clear", label: "Clear this field", onSelect: () => setMode("clear") },
        ]}><span aria-hidden="true">{MODE_LABELS[change.mode]}</span><span className="sr-only">{label}: {MODE_LABELS[change.mode]}</span></Menu>
      </div>
    </div>
    {change.mode === "set" ? field === "description"
      ? <Textarea aria-label={`${label} for all selected ${selectionLabel}`} maxLength={maxLength} onChange={event => onChange({ ...change, value: event.target.value })} rows={3} value={change.value} />
      : <TextInput aria-label={`${label} for all selected ${selectionLabel}`} maxLength={maxLength} onChange={event => onChange({ ...change, value: event.target.value })} value={change.value} />
      : <div aria-label={`${label}, ${change.mode === "clear" ? "clear this field" : current.mixed ? "mixed" : "current value"}`} aria-readonly="true" className="media-bulk-field-value" role="textbox">
        {change.mode === "clear" ? "This field will be cleared." : current.mixed ? "Mixed" : current.value || "Empty"}
      </div>}
  </div>;
}

export function MediaBulkInspector(props: MediaBulkInspectorProps) {
  const {
    assets,
    focusRequest = 0,
    onCancel,
    onDirtyChange,
    onReview,
    open,
    pageTags = [],
    recentTags = [],
    reviewing = false,
    surface,
  } = props;
  const selectionLabel = surface === "video" ? "videos" : assets.some(asset => asset.kind === "audio")
    ? assets.every(asset => asset.kind === "audio") ? "audio files" : "media items" : "images";
  const match = tagMatchFor(surface);
  const originalTokens = useMemo(() => mixedTagTokens(assets, match), [assets, match]);
  const [draft, setDraft] = useState<BulkMetadataDraft>(emptyBulkMetadataDraft);
  const [tokens, setTokens] = useState<Token[]>(originalTokens);
  const [tagDraft, setTagDraft] = useState("");
  const [tagMode, setTagMode] = useState<"edit" | "replace" | "clear">("edit");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelOpener = useRef<HTMLElement | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const firstControl = useRef<HTMLDivElement>(null);
  const textAssets = assets as readonly { description: string | null; credit: string | null; license: string | null }[];
  const suggestions = useMemo(
    () => uniqueSuggestions([assets.flatMap(asset => asset.tags), pageTags, recentTags]),
    [assets, pageTags, recentTags],
  );
  const dirty = hasBulkMetadataIntent(draft) || Boolean(tagDraft.trim());
  const visible = open && !reviewing;
  const reviewDisabled = !hasBulkMetadataIntent(draft) || Boolean(tagDraft.trim()) ||
    (draft.tags.mode === "replace" && tokens.length === 0);

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) setConfirmCancel(false); }, [dirty]);
  useEffect(() => { if (confirmCancel) keepEditing.current?.focus(); }, [confirmCancel]);

  function setText(field: TextField, change: BulkMetadataDraft[TextField]) {
    setDraft(previous => ({ ...previous, [field]: change }));
  }

  function editTokens(next: Token[]) {
    const mode = tagMode === "clear" ? "replace" : tagMode;
    if (mode !== tagMode) setTagMode(mode);
    setTokens(next);
    if (mode === "replace") {
      setDraft(previous => ({ ...previous, tags: { mode: "replace", value: next.map(token => token.value).join(", ") } }));
      return;
    }
    const edit = tagTokenEdit(originalTokens, next, match);
    setDraft(previous => ({ ...previous, tags: edit.add.length || edit.remove.length
      ? { mode: "edit", value: "", ...edit }
      : { mode: "keep", value: "" } }));
  }

  function chooseTagMode(mode: "edit" | "replace" | "clear") {
    setTagMode(mode);
    setTagDraft("");
    if (mode === "edit") {
      setTokens(originalTokens);
      setDraft(previous => ({ ...previous, tags: { mode: "keep", value: "" } }));
      return;
    }
    setTokens([]);
    setDraft(previous => ({ ...previous, tags: { mode, value: "" } }));
  }

  function requestCancel() {
    if (!dirty) {
      onCancel();
      return;
    }
    cancelOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmCancel(true);
  }

  function keepCurrentDraft() {
    const opener = cancelOpener.current;
    setConfirmCancel(false);
    requestAnimationFrame(() => opener?.isConnected && opener.focus());
  }

  const footer = <>
    {confirmCancel ? <InlineMessage tone="warning" title="Discard batch changes?">
      <p>This discards the unapplied form. Previously saved changes are not undone.</p>
      <Button variant="danger-quiet" onClick={onCancel}>Discard batch changes</Button>
      <Button ref={keepEditing} onClick={keepCurrentDraft}>Keep editing</Button>
    </InlineMessage> : null}
    {tagDraft.trim() ? <p className="media-bulk-draft-warning" role="status">Press Enter or comma to add the tag before reviewing.</p> : null}
    {draft.tags.mode === "replace" && tokens.length === 0 ? <p className="media-bulk-draft-warning" role="status">Add at least one tag before reviewing a replacement.</p> : null}
    <div className="media-bulk-footer-actions">
      <Button onClick={requestCancel}>Cancel</Button>
      <Button variant="primary" disabled={reviewDisabled}
        onClick={() => onReview(frozenDraft(draft))}>Review {assets.length} changes</Button>
    </div>
  </>;

  const tagWarning = tagMode === "replace" || tagMode === "clear"
    ? `This removes the selected ${selectionLabel}' existing tags. Check the before-and-after review before applying.`
    : "";
  const preview = assets.slice(0, 4);
  const more = Math.max(0, assets.length - preview.length);
  const detailsMixed = commonText(textAssets, "description").mixed;
  const rightsMixed = TEXT_FIELDS.slice(1).some(field => commonText(textAssets, field).mixed) ||
    (surface === "video" && new Set((assets as readonly SourceMediaAssetSummary[]).map(asset => asset.rightsStatus)).size > 1);

  return <Inspector className="media-bulk-inspector" dirty={dirty} footer={footer} heading={`${assets.length} items`}
    label="Edit selected" onClose={requestCancel} onDirtyEscape={requestCancel} open={visible} storageKey={`bulk-${surface}`}>
    <InspectorSection id="preview" title="Preview">
      <p className="media-bulk-help">{surface === "video"
        ? "Leave unchanged keeps each video's own value. Titles and filenames are not changed in bulk."
        : "Only the fields you change are saved. Name, filename, alt text and categories are not changed in bulk."}</p>
      <div aria-label="Selected item previews" className="media-bulk-preview-stack" role="group">
        {preview.map((asset, index) => <div className="media-bulk-preview-cell" key={asset.id}>
          <PreviewTile asset={asset} surface={surface} />
          {index === preview.length - 1 && more ? <span aria-hidden="true" className="media-bulk-preview-more">+{more}</span> : null}
        </div>)}
      </div>
      <p className="media-bulk-summary">{selectionSummary(props)}</p>
    </InspectorSection>

    <InspectorSection count={detailsMixed ? "Mixed" : undefined} id="details" onOpenRequestHandled={() => {
      requestAnimationFrame(() => firstControl.current?.querySelector<HTMLElement>("button")?.focus());
    }} openRequest={focusRequest} title="Details">
      <BulkTextField assets={textAssets} change={draft.description} field="description" firstControlRef={firstControl}
        onChange={change => setText("description", change)} surface={surface} selectionLabel={selectionLabel} />
    </InspectorSection>

    <InspectorSection count={rightsMixed ? "Mixed" : undefined} id="rights" title="Rights">
      {surface === "video" ? <label className="media-bulk-field">Rights review
        <Select aria-label="Rights review for all selected videos" value={draft.rightsStatus}
          onChange={event => setDraft(previous => ({ ...previous, rightsStatus: event.target.value as BulkMetadataDraft["rightsStatus"] }))}>
          <option value="keep">Leave unchanged</option><option value="pending">Needs review</option><option value="complete">Recorded</option>
        </Select>
      </label> : null}
      <BulkTextField assets={textAssets} change={draft.credit} field="credit" onChange={change => setText("credit", change)} surface={surface} selectionLabel={selectionLabel} />
      <BulkTextField assets={textAssets} change={draft.license} field="license" onChange={change => setText("license", change)} surface={surface} selectionLabel={selectionLabel} />
    </InspectorSection>

    <InspectorSection count={tokens.length} id="tags" title="Tags" actions={<Menu className="media-bulk-tags-menu" icon="chevron-down"
      label="Replace all tags or clear all tags" items={[
        { key: "edit", label: "Leave tags unchanged", onSelect: () => chooseTagMode("edit") },
        { key: "replace", label: "Replace all tags", onSelect: () => chooseTagMode("replace") },
        { key: "clear", label: "Clear all tags", onSelect: () => chooseTagMode("clear") },
      ]}><span aria-hidden="true">Replace or clear</span><span className="sr-only">Replace all tags or clear all tags</span></Menu>}>
      <TokenInput draft={tagDraft} label="Tags" maxLength={surface === "video" ? 80 : 40}
        onChange={editTokens} onDraftChange={setTagDraft} placeholder="Add tag…" promoteMixed
        suggestions={suggestions} suggestionsNote={SUGGESTIONS_NOTE} tokens={tokens} />
      <p className="media-bulk-help">Dashed tags are on some of the {assets.length} {surface === "video" ? "videos" : "items"}. Removing one removes it only where it is.</p>
      {tagWarning ? <InlineMessage tone="warning" title={tagMode === "clear" ? "Clear all tags" : "Replace all tags"}>{tagWarning}</InlineMessage> : null}
    </InspectorSection>
  </Inspector>;
}
