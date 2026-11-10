import type { MediaAssetSummary } from "./functions";
import { mediaOriginLabel } from "./media-origin";
import { formatMediaBytes, formatMediaDuration, formatMediaUpdated, formatVideoBytes, viewingCopyStatus } from "./media-format";
import type { SourceMediaAssetSummary } from "./source-media";

// Hover card facts for a media card.
// Built only from the summary the list already loaded: no fetch, no other state.

/** Hover cards open after this pause for both mouse hover and keyboard focus. */
export const MEDIA_HOVER_DELAY_MS = 600;

export interface MediaHoverFact {
  label: string;
  value: string;
}

export interface MediaHoverFacts {
  /** The full name, unclamped. */
  name: string;
  facts: MediaHoverFact[];
  /** Every tag, in stored order and case. */
  tags: string[];
}

function present(facts: Array<MediaHoverFact | null>): MediaHoverFact[] {
  return facts.filter((fact): fact is MediaHoverFact => fact !== null);
}

export function imageHoverFacts(asset: MediaAssetSummary, categoryLabel: (id: string) => string): MediaHoverFacts {
  const updated = formatMediaUpdated(asset.updatedAt);
  return {
    name: asset.name,
    facts: present([
      { label: "Type", value: asset.kind === "document" ? "PDF" : asset.kind === "audio" ? "WAV audio" : "Image" },
      asset.width && asset.height ? { label: "Dimensions", value: `${asset.width} × ${asset.height}` } : null,
      { label: "Size", value: formatMediaBytes(asset.sizeBytes) },
      { label: "Category", value: categoryLabel(asset.category) },
      { label: "Origin", value: mediaOriginLabel(asset.source) },
      updated ? { label: "Updated", value: updated } : null,
    ]),
    tags: [...asset.tags],
  };
}

export function videoHoverFacts(asset: SourceMediaAssetSummary): MediaHoverFacts {
  const copy = asset.viewingCopy;
  const ready = copy?.state === "ready";
  const updated = formatMediaUpdated(asset.updatedAt);
  return {
    name: asset.name,
    facts: present([
      { label: "Type", value: "Video" },
      ready && copy?.durationSeconds !== undefined ? { label: "Duration", value: formatMediaDuration(copy.durationSeconds) } : null,
      ready && copy?.width && copy.height ? { label: "Dimensions", value: `${copy.width} × ${copy.height}` } : null,
      { label: "Size", value: formatVideoBytes(asset.sizeBytes) },
      { label: "Rights", value: asset.rightsStatus === "complete" ? "Recorded" : "Needs review" },
      { label: "Preview", value: viewingCopyStatus(asset).label },
      { label: "Uploaded by", value: asset.uploadedBy?.name ?? "Not recorded" },
      updated ? { label: "Updated", value: updated } : null,
    ]),
    tags: [...asset.tags],
  };
}
