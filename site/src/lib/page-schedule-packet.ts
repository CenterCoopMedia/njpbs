import { createHash } from "node:crypto";
import { readCloudSchedulePacket, type CloudSchedulePacket } from "../../scripts/cloud-schedule-packet";
import type { PreparedHomeExternalInputs } from "./no-build-home-sources";
import { createScheduleSourceSnapshot } from "./schedule-source-snapshot";
import type { BakedScheduleData } from "./schedule-feed";
import type { ScheduleExport } from "./schedule-export";
import type { PublicPublicationReceipt } from "./public-publication-receipt";
export interface PageScheduleAuthority {
  contextRevision: number;
  contextDigest: string;
  code: PublicPublicationReceipt & { deploymentId: string; contextDigest: string };
  inputs: PreparedHomeExternalInputs & { schedulePacket: CloudSchedulePacket };
}
export type { PageScheduleReceipt } from "./page-schedule-receipt";
import type { PageScheduleReceipt, Seal } from "./page-schedule-receipt";
export interface PageScheduleInputs {
  data: BakedScheduleData;
  exported: ScheduleExport;
  receipt: PageScheduleReceipt;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const publicSeal = ({ digest, size, contentType }: CloudSchedulePacket["files"]["json"]): Seal => ({ digest, size, contentType });

/** The Page caller supplies one qualified context/CODE transaction. Provider
 * provenance and raw packet seals remain separate from the public projection. */
export async function readPageSchedulePacket({ authority, storage }: {
  authority: PageScheduleAuthority;
  storage: Parameters<typeof readCloudSchedulePacket>[0]["storage"];
}) {
  const packet = authority.inputs.schedulePacket;
  const { schedule: data, exported, pdf } = await readCloudSchedulePacket({ inputs: authority.inputs, packet, storage });
  const { buildBatchId, generation, commitSha } = authority.code;
  const snapshot = createScheduleSourceSnapshot(data, { buildBatchId, generation, commitSha });
  const json = Buffer.from(`${JSON.stringify(snapshot)}\n`);
  if (json.length > 16 * 1024 * 1024) throw new Error("Schedule projection exceeds its bound");
  const receipt: PageScheduleReceipt = { schemaVersion: 1,
    contextRevision: authority.contextRevision, contextDigest: authority.contextDigest, code: authority.code,
    source: packet.source, generatedAt: packet.generatedAt, exportedAt: packet.exportedAt,
    rawJson: publicSeal(packet.files.json), retainedPdf: publicSeal(packet.files.pdf),
    projectionJson: { digest: hash(json), size: json.length, contentType: "application/json; charset=utf-8" },
    inputDigest: hash(JSON.stringify({ data, exported })) };
  return { schedule: { data, exported, receipt } satisfies PageScheduleInputs, json, pdf };
}
