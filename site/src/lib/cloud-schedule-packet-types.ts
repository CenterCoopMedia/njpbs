import type { TVSS_TIME_ZONE } from "./schedule-feed";

export interface FileSeal { key: string; digest: string; size: number; contentType: string }
export interface CloudSchedulePacket {
  schemaVersion: 1;
  source: { operationId: string; runtime: { owner: "cloudflare"; release: string }; contentDigest: string;
    scheduleDigest: string; checkedAt: number };
  generatedAt: string;
  exportedAt: string;
  startDate: string;
  endDate: string;
  timeZone: typeof TVSS_TIME_ZONE;
  files: { json: FileSeal; pdf: FileSeal };
}
