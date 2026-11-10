import { postFunction } from "./functions";
import { formatEditorialDate } from "../../../packages/content-core/src/editorial-date-format";
import { STATION_TIME_ZONE, zonedParts } from "../../../packages/content-core/src/station-time";

export interface OriginalAvailability {
  state: "available" | "archived" | "restoring" | "restored";
  checkedAt: string;
  archiveTier: "ARCHIVE_ACCESS" | "DEEP_ARCHIVE_ACCESS" | null;
  restoredAt?: string;
  availableUntil?: string;
}

export function originalStatusLabel(original?: OriginalAvailability) {
  const labels = { available: "Original available", archived: "Original archived", restoring: "Original restoring", restored: "Original restored" };
  return original ? labels[original.state] : "Original status unchecked";
}

export function originalAvailableUntil(original?: OriginalAvailability): string | null {
  if (original?.state !== "restored" || !original.availableUntil) return null;
  const instant = Date.parse(original.availableUntil);
  if (!Number.isFinite(instant)) return null;
  const parts = zonedParts(instant, STATION_TIME_ZONE);
  const date = formatEditorialDate(`${parts.year}-${parts.month}-${parts.day}`)!.replace(/, \d{4}$/, "");
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: STATION_TIME_ZONE, hour: "numeric", minute: "2-digit",
  }).format(instant);
  return `${date}, ${time} ET`;
}


export interface OriginalRestoreNotice {
  id: string;
  sourceId: string;
  assetId: string;
  name: string;
  outcome: "restored" | "failed" | "stale";
  completedAt: string;
}

export async function sourceMediaOriginal(token: string | null, sourceId: string, assetId: string, action: "status" | "restore") {
  const result = await postFunction<{ success: true; original: OriginalAvailability }>("cmsSourceMediaOriginal", token,
    { sourceId, assetId, action }, {}, { appCheck: action === "restore" });
  return result.original;
}

export function originalRestoreNotices(token: string | null, sourceId: string) {
  return postFunction<{ success: true; notices: OriginalRestoreNotice[] }>("cmsSourceMediaOriginal", token,
    { sourceId, action: "notices" });
}

export function dismissOriginalRestoreNotice(token: string | null, sourceId: string, noticeId: string) {
  return postFunction<{ success: true }>("cmsSourceMediaOriginal", token,
    { sourceId, noticeId, action: "dismiss" }, {}, { appCheck: true });
}

export function originalAccessMessage(error: unknown): string | null {
  const failure = error as { status?: number; data?: { code?: string }; message?: string } | null;
  return failure?.status === 409 && ["original_archived", "original_restoring"].includes(failure.data?.code ?? "") &&
    typeof failure.message === "string" ? failure.message : null;
}
