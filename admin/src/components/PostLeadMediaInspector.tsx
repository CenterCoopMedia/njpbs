import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { readPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { mediaImageSources } from "../lib/media-image";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";

/** The inspector shares the Header background row; the full form stays inside it. */
export function PostLeadMediaInspector({ record, loadMedia, mediaPickerUnavailable, error, onRemove, children }: {
  record: Record<string, unknown>;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  error?: string;
  onRemove?: () => void;
  children: ReactNode | ((picker: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode);
}) {
  const lead = readPostLeadMedia(record);
  const imageId = lead?.kind === "image" ? lead.data.assetId : lead?.posterAssetId ?? "";
  const image = useResolvedMediaAsset(imageId, loadMedia);
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const stateId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const editable = !!onRemove;
  useEffect(() => { if (!editable) setPickerOpen(false); }, [editable]);
  useEffect(() => { if (error && details.current) details.current.open = true; }, [error]);
  const kind = lead?.kind === "image" ? "Library image" : lead?.kind === "library-video" ? "Library video"
    : lead?.kind === "embed" ? "Embedded video" : "Linked video";
  const hasSource = lead && (lead.kind === "image" || lead.kind === "library-video" ? !!lead.data.assetId : !!lead.data.url.trim());
  const title = !hasSource ? lead?.kind === "image" ? "No image selected" : "No video selected"
    : lead?.kind === "image" ? image?.name || "Image selected"
    : lead ? lead.data.title.trim() || lead.data.caption?.trim() || "Video selected" : "";
  const state = lead ? `${kind} · ${title}` : record.leadMedia == null ? "No lead media" : "Lead media needs review";
  return <details ref={details} className="editor-image-role editor-image-role--lead" data-image-role="leadMedia">
    <summary ref={summary} aria-label={onRemove ? "Change lead media" : "View lead media"} aria-describedby={stateId} title={onRemove ? "Change lead media" : "View lead media"} onClick={() => {
      if (!lead && record.leadMedia == null && onRemove && loadMedia && !mediaPickerUnavailable && !details.current?.open) setPickerOpen(true);
    }}>
      <span className="editor-image-role-preview" aria-hidden="true">{image ? <img {...mediaImageSources(image, 120)} alt="" loading="lazy" decoding="async" /> : <Icon name={lead && lead.kind !== "image" ? "video" : "image"} />}</span>
      <span><strong>Lead media</strong><small id={stateId} title={state}>{state}</small></span><Icon name="pencil" />
    </summary>
    <div className="editor-image-role-fields">
      {onRemove && (lead || record.leadMedia != null) ? <ActionControl action="remove-item" label="Remove" accessibleName="Remove lead media" onClick={() => {
        onRemove();
        setPickerOpen(false);
        if (details.current) details.current.open = false;
        summary.current?.focus();
      }} /> : null}
      {typeof children === "function" ? children({ open: pickerOpen, onOpenChange: setPickerOpen }) : children}
    </div>
  </details>;
}
