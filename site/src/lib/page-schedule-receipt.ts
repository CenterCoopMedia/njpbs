import type { CloudSchedulePacket } from "./cloud-schedule-packet-types";
import type { PublicPublicationReceipt } from "./public-publication-receipt";

export type Seal = { digest: string; size: number; contentType: string };
export interface PageScheduleReceipt {
  contextRevision: number;
  contextDigest: string;
  code: PublicPublicationReceipt & { deploymentId: string; contextDigest: string };
  schemaVersion: 1;
  source: CloudSchedulePacket["source"];
  generatedAt: string;
  exportedAt: string;
  rawJson: Seal;
  retainedPdf: Seal;
  projectionJson: Seal;
  inputDigest: string;
}
