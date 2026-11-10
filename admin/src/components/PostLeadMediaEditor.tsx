import { useEffect, useState, type ComponentProps } from "react";
import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout";
import { embedPlayer, xVideoLink } from "../../../packages/content-core/src/content-render";
import { readPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { VIDEO_BLOCK_SOURCE_ID } from "../../../packages/content-core/src/video-block";
import { FieldRenderer } from "./FieldRenderer";
import { VideoBlockEditor } from "./VideoBlockEditor";
import { Select } from "./ui/Primitives";
import "./PostLeadMediaEditor.css";

type MediaProps = Pick<ComponentProps<typeof FieldRenderer>, "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories" | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange">;
type Draft = { kind: string; data: Record<string, unknown>; posterAssetId?: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string" ? value : "";

export function hasConflictingLeadImageAlt(record: Record<string, unknown>): boolean {
  const lead = record.leadMedia === undefined ? readPostLeadMedia(record) : record.leadMedia;
  if (!object(lead) || lead.kind !== "image" || !object(lead.data) || !lead.data.assetId) return false;
  const alt = record.leadMedia === undefined ? record.heroImageAlt : lead.data.alt;
  return lead.data.altDecorative === true && typeof alt === "string" && alt !== "";
}
function videoKey(value: unknown): string {
  const url = string(value);
  const player = embedPlayer(url)?.src;
  // Provider parsers own admission and canonical identity. Playback offsets/options do
  // not make the same source a different video for this nonblocking editorial nudge.
  if (player) {
    const canonical = new URL(player);
    for (const parameter of ["start", "end", "topbar", "endscreen", "autoplay", "muted"]) canonical.searchParams.delete(parameter);
    canonical.hash = "";
    return canonical.href;
  }
  return xVideoLink(url) ?? url.trim();
}

/** Uses the body's provider parser and visible-block rules; this is only an editorial nudge. */
export function duplicatesBodyLead(lead: Draft | null, blocks: unknown): boolean {
  if (!lead || lead.kind === "image" || !Array.isArray(blocks)) return false;
  const candidates = blocks.filter((block): block is LayoutBlock => object(block) && typeof block.type === "string");
  return visibleLayoutBlocks(candidates).some(block => {
    const body = object(block.data) ? block.data : {};
    if (lead.kind === "library-video") return block.type === "video" && !!lead.data.assetId && body.assetId === lead.data.assetId;
    return block.type === "embed" && !!string(lead.data.url).trim() && videoKey(body.url) === videoKey(lead.data.url);
  });
}

export function PostLeadMediaEditor({ record, onChange: change, fieldId, disabled = false, template = false, context = "post", error, imagePicker, ...media }: MediaProps & {
  record: Record<string, unknown>;
  onChange: (value: unknown) => void;
  fieldId: string;
  disabled?: boolean;
  template?: boolean;
  context?: "post" | "entry";
  error?: string;
  imagePicker?: ComponentProps<typeof FieldRenderer>["assetPicker"];
}) {
  const mediaLabel = context === "entry" ? "Update media" : "Lead media";
  const imageLabel = context === "entry" ? "Update image" : "Lead image";
  const placement = context === "entry" ? "Shown with this update" : `Shown at the top of ${template ? "Posts made from this template" : "this Post"}`;
  const onChange = (value: unknown) => { if (!disabled) change(value); };
  // Keep partial input in the record. The strict shared contract runs at save/publication;
  // reading through it on every keystroke would erase an unfinished URL.
  const legacy = readPostLeadMedia(record);
  const raw = record.leadMedia === undefined && legacy?.kind === "image"
    ? { ...legacy, data: { ...legacy.data, alt: string(record.heroImageAlt) } } : record.leadMedia ?? legacy;
  const lead: Draft | null = object(raw) && object(raw.data) ? raw as Draft : null;
  // The common image path is ready in two actions without creating an empty lead.
  const [emptyKind, setEmptyKind] = useState<"image" | "none">("image");
  useEffect(() => { if (imagePicker?.open && !lead) setEmptyKind("image"); }, [imagePicker?.open, lead]);
  const kind = lead?.kind ?? emptyKind;
  const data = lead?.data ?? {};
  const imageAltError = !!error && hasConflictingLeadImageAlt(record);
  const [suggestion, setSuggestion] = useState("");
  const edit = (key: string, value: unknown) => onChange({ ...lead, data: { ...data, [key]: value } });
  const choose = (next: string) => {
    if (disabled) return;
    setSuggestion("");
    setEmptyKind(next === "none" ? "none" : "image");
    onChange(next === "none" || next === "image" ? null
      : next === "library-video" ? { kind: next, data: { sourceId: VIDEO_BLOCK_SOURCE_ID, assetId: "", title: "" } }
      : { kind: next, data: { url: "", title: "" } });
  };
  const asset = (poster: boolean) => <FieldRenderer {...media}
    assetPicker={poster ? undefined : imagePicker}
    field={{ key: poster ? "posterAssetId" : "assetId", label: poster ? "Video poster" : imageLabel, kind: "asset", required: false,
      help: poster ? kind === "library-video" ? context === "entry" ? "Optional image. The player uses the library video's generated poster." : "Optional image for listings and sharing. The player uses the library video's generated poster." : context === "entry" ? "Optional image for this update's video before playback." : "Optional image for listings, sharing and the player before playback." : "Choose an image from the Boardwalk library." }}
    fieldId={`${fieldId}-${poster ? "poster" : "image"}`} value={poster ? lead?.posterAssetId ?? "" : data.assetId ?? ""}
    onChange={value => {
      if (poster) onChange({ ...lead, posterAssetId: value });
      else if (value !== data.assetId) { setSuggestion(""); if (!value) setEmptyKind("none"); onChange(value ? { kind: "image", data: { assetId: value, alt: "" } } : null); }
    }}
    onAssetSelect={asset => {
      if (poster) onChange({ ...lead, posterAssetId: asset?.id ?? "" });
      else {
        setSuggestion(asset?.altText ?? "");
        if (asset?.id !== data.assetId) {
          if (!asset?.id) setEmptyKind("none");
          onChange(asset?.id ? { kind: "image", data: { assetId: asset.id, alt: "" } } : null);
        }
      }
    }} />;
  const text = (key: string, label: string, maxLength: number, help: string, multiline = false) => <FieldRenderer
    field={{ key, label, kind: "text", required: false, maxLength, help, multiline }} fieldId={`${fieldId}-${key}`}
    value={data[key] ?? ""} onChange={value => edit(key, value)}
    invalid={key === "alt" && imageAltError}
    additionalDescriptionId={key === "alt" && imageAltError ? `${fieldId}-error` : undefined}
    warning={key === "alt" && !data.altDecorative && !string(data.alt).trim() ? `${imageLabel} alt text is empty.` : undefined}
    suggestion={key === "alt" && !data.altDecorative && !string(data.alt).trim() ? suggestion : undefined}
    onUseSuggestion={() => edit("alt", suggestion)} />;
  return <fieldset className="post-lead-media-editor" disabled={disabled} aria-describedby={`${fieldId}-help${error ? ` ${fieldId}-error` : ""}`}>
    <legend>{mediaLabel}</legend>
    <p id={`${fieldId}-help`}>{placement}. Videos play only after a reader chooses Play.</p>
    <label htmlFor={fieldId}>{mediaLabel} type</label>
    <Select id={fieldId} value={kind} aria-invalid={!!error && !imageAltError} aria-describedby={`${fieldId}-help${error ? ` ${fieldId}-error` : ""}`} onChange={event => choose(event.target.value)}>
      <option value="none">No {mediaLabel.toLowerCase()}</option><option value="image">Library image</option>
      <option value="library-video">Library video</option><option value="linked-video">Linked video</option><option value="embed">Embedded video</option>
      {!["none", "image", "library-video", "linked-video", "embed"].includes(kind) ? <option value={kind}>Choose a supported type</option> : null}
    </Select>
    {kind === "image" ? <>
      {asset(false)}
      {data.assetId ? <>
        {text("alt", `${imageLabel} alt text`, 2000, template
          ? "Describe what this image adds to Posts made from this template, or mark it decorative."
          : `Describe what this image adds ${context === "entry" ? "to this update" : "in this Post"}, or mark it decorative.`)}
        <FieldRenderer field={{ key: "altDecorative", label: `Mark ${imageLabel.toLowerCase()} as decorative`, help: "Use only when this image adds no information.", kind: "toggle", required: false }} fieldId={`${fieldId}-decorative`}
          value={data.altDecorative === true} onChange={value => onChange({ ...lead, data: { ...data, altDecorative: value, ...(value ? { alt: "" } : {}) } })} />
        {text("caption", `${imageLabel} caption`, 600, "Optional description or photo credit beneath the image.", true)}
      </> : null}
    </> : null}
    {kind === "library-video" ? <VideoBlockEditor allowCaptionName readOnly={disabled} onMediaPickerDirtyChange={media.onMediaPickerDirtyChange}
      block={{ id: fieldId, type: "video", order: 0, visible: true, data }} onChange={next => onChange({ ...lead, data: next })} /> : null}
    {kind === "linked-video" || kind === "embed" ? <>
      {text("url", kind === "embed" ? "Video link or iframe code" : "Video link", 4000,
        "YouTube, TikTok, Instagram, Facebook, X, Vimeo and PBS use the same approved players as body videos. Other HTTPS video links open the source.", true)}
      {text("title", "Video title", 200, "Provide a title or caption to name this video for screen readers.")}
      {text("caption", "Video caption", 600, "Optional text beneath the video; it can also supply its accessible name.", true)}
    </> : null}
    {lead && kind !== "image" ? <>
      {asset(true)}
      {context === "post" && kind !== "library-video" && !lead.posterAssetId ? <p className="post-lead-media-nudge" role="status">Add a poster so this video has an image in listings and sharing. You can save and publish without one.</p> : null}
      {duplicatesBodyLead(lead, record.blocks) ? <p className="post-lead-media-nudge" role="status">This video also appears in the body. Consider removing the duplicate body block.</p> : null}
    </> : null}
    {error ? <p id={`${fieldId}-error`} className="error-text" role="alert">{error}</p> : null}
  </fieldset>;
}
