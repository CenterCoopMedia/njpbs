/** Internal links carry record identifiers, never storage access URLs. */
export const unavailableMediaMessage = "This file is unavailable or you do not have access to it.";
const assetIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function parseMediaPermalink(search: URLSearchParams): { assetId?: string; seconds: number; error?: string } {
  const assetId = search.get("asset");
  if (assetId === null) return { seconds: 0 };
  if (!assetIdPattern.test(assetId) || search.getAll("asset").length !== 1) {
    return { seconds: 0, error: "This media link is invalid." };
  }
  const raw = search.get("t");
  if (raw !== null && (search.getAll("t").length !== 1 || !/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) > Number.MAX_SAFE_INTEGER)) {
    return { assetId, seconds: 0, error: "That time is invalid. The video starts at the beginning." };
  }
  return { assetId, seconds: raw === null ? 0 : Number(raw) };
}

export function mediaPermalink(pathname: string, assetId?: string, seconds = 0): string {
  const params = new URLSearchParams();
  if (assetId) {
    if (!assetIdPattern.test(assetId)) throw new Error("Invalid media identifier");
    params.set("asset", assetId);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= Number.MAX_SAFE_INTEGER) params.set("t", String(seconds));
  }
  return pathname + (params.size ? `?${params}` : "");
}

export function boundedMediaTime(seconds: number, duration: number): { seconds: number; message?: string } {
  if (!Number.isFinite(seconds) || seconds < 0) return { seconds: 0, message: "That time is invalid. The video starts at the beginning." };
  if (seconds > 0 && Number.isFinite(duration) && seconds >= duration) {
    return { seconds: 0, message: "That time is past the end of this file. The video starts at the beginning." };
  }
  return { seconds };
}
