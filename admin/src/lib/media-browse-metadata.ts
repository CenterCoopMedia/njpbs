export const MEDIA_ASPECTS = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
] as const;

export interface MediaMetadataBounds {
  updatedFrom?: string;
  updatedTo?: string;
  minDuration?: number;
  maxDuration?: number;
  aspect?: typeof MEDIA_ASPECTS[number]["value"];
}

export const MEDIA_METADATA_BOUND_FIELDS = ["updatedFrom", "updatedTo", "minDuration", "maxDuration", "aspect"] as const;

export type MediaRange = "updated" | "duration";

export function parseMediaRange(kind: MediaRange, from: string, to: string): MediaMetadataBounds | null {
  if (kind === "updated") {
    const validDate = (value: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    if (!validDate(from) || !validDate(to) || (from && to && from > to)) return null;
    return { updatedFrom: from || undefined, updatedTo: to || undefined };
  }
  const validSeconds = (value: string) => !value || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
  if (!validSeconds(from) || !validSeconds(to) || (from && to && Number(from) > Number(to))) return null;
  return { minDuration: from ? Number(from) : undefined, maxDuration: to ? Number(to) : undefined };
}

export function mediaAspect(value: string | null) {
  return MEDIA_ASPECTS.find(option => option.value === value)?.value;
}

export function matchesMediaBounds(query: MediaMetadataBounds, { updatedAt, duration, width, height }: {
  updatedAt: string | null;
  duration?: number;
  width?: number | null;
  height?: number | null;
}) {
  if (query.updatedFrom || query.updatedTo) {
    const timestamp = updatedAt ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(timestamp)) return false;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if ((query.updatedFrom && day < query.updatedFrom) || (query.updatedTo && day > query.updatedTo)) return false;
  }
  if (query.minDuration !== undefined || query.maxDuration !== undefined) {
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0 ||
        (query.minDuration !== undefined && duration < query.minDuration) ||
        (query.maxDuration !== undefined && duration > query.maxDuration)) return false;
  }
  if (query.aspect) {
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;
    if (query.aspect !== (width === height ? "square" : width > height ? "landscape" : "portrait")) return false;
  }
  return true;
}
