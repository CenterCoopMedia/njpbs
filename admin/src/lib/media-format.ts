import type { StatusTone } from "../components/ui/Primitives";
import type { SourceMediaAssetSummary } from "./source-media";

// One home for the media library's size, duration, date and preview-state strings.
// Every output is pinned by
// media-format.test.ts and matches what the admin showed before the move.
//
// Images and videos keep separate size formatters on purpose. Image and document files
// are small, so they show B, KB or MB. Video files are large, so they show MB or GB and
// never KB. Merging the two would change strings staff already see.

/** Image and document sizes: "1023 B", "812.4 KB", "2.1 MB". */
export function formatMediaBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

/** Video sizes: "180.0 MB", "3.5 GB". Never KB. */
export function formatVideoBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

/** Durations: "0:45", "12:34", "2:41:05". Rounds to the second; negatives read as 0:00. */
export function formatMediaDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

/** An update time in Eastern time, such as "Sep 23, 2026, 12:05 PM"; null when missing or invalid. */
export function formatMediaUpdated(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMATTER.format(date);
}

/** A video's viewing-copy state as a badge label, an optional detail and a tone. */
export function viewingCopyStatus(asset: SourceMediaAssetSummary): { label: string; detail?: string; tone: StatusTone } {
  const originalPreview = asset.preview === "browser";
  switch (asset.viewingCopy?.state) {
    case "ready": return { label: "Preview ready", tone: "success" };
    case "processing": return originalPreview
      ? { label: "Preparing web copy", detail: "Original preview available", tone: "publishing" }
      : { label: "Preparing preview", tone: "publishing" };
    case "failed": return originalPreview
      ? { label: "Web copy unavailable", detail: "Original preview available", tone: "failed" }
      : { label: "Preview unavailable", detail: "Original file is safe", tone: "failed" };
    case "not_prepared": return originalPreview
      ? { label: "Web copy not prepared", detail: "Original preview available", tone: "neutral" }
      : { label: "Preview not prepared", detail: "Download original to watch", tone: "neutral" };
    default: return originalPreview
      ? { label: "Preview available", tone: "brand" }
      : { label: "Download to watch", tone: "neutral" };
  }
}
