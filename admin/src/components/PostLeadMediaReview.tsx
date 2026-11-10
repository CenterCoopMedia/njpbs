import { useId } from "react";
import { readPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { embedPlayer, xVideoLink } from "../../../packages/content-core/src/embed-player";
import { safeHref } from "../../../packages/content-core/src/safe-href";
import { mediaImageSources } from "../lib/media-image";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import { VideoBlockEditor } from "./VideoBlockEditor";
import "./PostLeadMediaReview.css";

/** First-layer reviewers must see the selected lead before the picker ships. */
export function PostLeadMediaReview({ record, loadMedia, template = false, context = "post", onMediaPickerDirtyChange }: {
  record: Record<string, unknown>;
  loadMedia?: MediaPickerLoader;
  template?: boolean;
  context?: "post" | "entry";
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const instance = useId();
  const label = context === "entry" ? "Update media" : "Lead media";
  const lead = readPostLeadMedia(record);
  const emptyTemplate = template && record.leadMedia === undefined
    && (record.heroImage === undefined || record.heroImage === "");
  const imageId = lead?.kind === "image" ? lead.data.assetId : lead?.posterAssetId ?? "";
  const image = useResolvedMediaAsset(imageId, loadMedia);
  const source = lead && (lead.kind === "embed" || lead.kind === "linked-video")
    ? embedPlayer(lead.data.url)?.src ?? xVideoLink(lead.data.url) ?? safeHref(lead.data.url) : null;
  return <fieldset className={`editor-field post-lead-media-review${template ? " post-lead-media-review--template" : ""}`} aria-label={`${label} review`}>
    <legend className="editor-field-label-row"><span className="editor-field-label">{label}</span></legend>
    <p className="editor-field-help">{context === "entry" ? "Shown with this update." : template ? "Shown at the top of Posts made from this template." : "Shown at the top of this Post."} Videos play only after a reader chooses Play.</p>
    {!lead ? <p>{record.leadMedia === null || emptyTemplate ? `No ${label.toLowerCase()} selected.` : context === "entry" ? "The saved update media is incomplete or unavailable. Open the saved preview to review it." : "The saved lead media is incomplete or unavailable. The article will show no lead media."}</p> : <>
      <p>{lead.kind === "image" ? "Library image" : lead.kind === "library-video" ? "Library video" : lead.kind === "embed" ? "Embedded video" : "Linked video"}</p>
      {imageId ? <div>
        {image ? <img {...mediaImageSources(image, 480)} alt={lead.kind === "image" && !lead.data.altDecorative ? lead.data.alt : ""} />
          : <p role="status">{lead.kind === "image" ? context === "entry" ? "Update image" : "Lead image" : "Video poster"} preview unavailable. Open the saved preview to review {context === "entry" ? "the update" : "the article"}.</p>}
        <p>{image?.name ?? imageId}</p>
      </div> : null}
      {lead.kind === "image" ? <>
        <p>{lead.data.altDecorative ? "Decorative image" : `Alt text: ${lead.data.alt || "Not provided"}`}</p>
        {lead.data.caption ? <p>{lead.data.caption}</p> : null}
      </> : lead.kind === "library-video" ? <>
        <p>Selected video: {lead.data.assetId || "No video selected"}</p>
        <VideoBlockEditor block={{ id: `post-media-review-${instance}`, type: "video", order: 0, visible: true, data: { ...lead.data } }} readOnly onChange={() => {}} onMediaPickerDirtyChange={onMediaPickerDirtyChange} />
      </> : <>
        <p>{lead.data.title || lead.data.caption || "Video title not provided"}</p>
        {source ? <a href={source} target="_blank" rel="noopener noreferrer">{source}</a> : <p>Video source unavailable.</p>}
        {lead.data.caption ? <p>{lead.data.caption}</p> : null}
      </>}
    </>}
  </fieldset>;
}
