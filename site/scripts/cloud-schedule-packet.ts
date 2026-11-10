import { isScheduleFixture } from "../src/lib/schedule-input";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isBroadcastDate } from "../src/lib/broadcast-date";
import { buildScheduleExport } from "../src/lib/schedule-export";
import { TVSS_TIME_ZONE, type BakedScheduleData } from "../src/lib/schedule-feed";
import type { PreparedHomeExternalInputs } from "../src/lib/no-build-home-sources";

const MAX_BYTES = 16 * 1024 * 1024;
const INPUT_NAMES = ["launch-media-manager.json", "spotlight-news.json", "schedule.json"];
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
interface Storage {
  get(key: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Uint8Array>;
  put(key: string, bytes: Buffer, options: { signal: AbortSignal; contentType: string }): Promise<unknown>;
}
export type { CloudSchedulePacket } from "../src/lib/cloud-schedule-packet-types";
import type { CloudSchedulePacket, FileSeal } from "../src/lib/cloud-schedule-packet-types";
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Cloud schedule packet is unavailable");
}
function sourceIdentity(inputs: PreparedHomeExternalInputs): CloudSchedulePacket["source"] {
  requireValue(inputs?.schemaVersion === 1 && /^[A-Za-z0-9]{20}$/.test(inputs.operationId) &&
    inputs.runtime?.owner === "cloudflare" && /^[a-f0-9]{40}$/.test(inputs.runtime.release) &&
    /^[a-f0-9]{64}$/.test(inputs.contentDigest) && Number.isSafeInteger(inputs.checkedAt) && inputs.checkedAt > 0 &&
    Number.isFinite(new Date(inputs.checkedAt).getTime()) && inputs.files && Object.keys(inputs.files).length === 3);
  for (const name of INPUT_NAMES) {
    const file = inputs.files[name];
    requireValue(file?.key === `post-background-v1/external-inputs/${inputs.operationId}/${name}` &&
      /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_BYTES);
  }
  return { operationId: inputs.operationId, runtime: { owner: "cloudflare", release: inputs.runtime.release },
    contentDigest: inputs.contentDigest, scheduleDigest: inputs.files["schedule.json"].digest, checkedAt: inputs.checkedAt };
}
function packetPrefix(source: CloudSchedulePacket["source"]) {
  const identity = hash(JSON.stringify([source.operationId, source.runtime.owner, source.runtime.release,
    source.contentDigest, source.scheduleDigest, source.checkedAt]));
  return `post-background-v1/schedule-packets/${source.operationId}/${identity}`;
}
function checkedSchedule(bytes: Buffer, checkedAt: number): BakedScheduleData {
  let data: BakedScheduleData;
  try { data = JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)); }
  catch { throw new Error("Cloud schedule packet is unavailable"); }
  requireValue(!isScheduleFixture(data) && ["pbs-tvss", "pbs-tvss-with-njpbs-corrections"].includes(data?.source) &&
    Number.isFinite(Date.parse(data.generatedAt)) && Date.parse(data.generatedAt) <= checkedAt &&
    data.timeZone === TVSS_TIME_ZONE && data.request?.station === "WNJT" && Array.isArray(data.request.dates) &&
    data.request.dates.length > 0 && data.request.dates.length <= 62 && data.request.dates.every(isBroadcastDate));
  for (const kind of ["broadcast", "kids"] as const) {
    const days = data.days?.[kind];
    requireValue(Array.isArray(days) && days.length > 0 && days.length <= 62 &&
      new Set(days.map(day => day.date)).size === days.length);
    for (const day of days) {
      requireValue(isBroadcastDate(day.date) && day.kind === kind && day.timeZone === TVSS_TIME_ZONE &&
        Array.isArray(day.entries) && day.entries.length > 0 && day.entries.length <= 200 &&
        (day.sourceRevision === undefined || isBroadcastDate(day.sourceRevision)) &&
        (day.sourceCheckedAt === undefined || Number.isFinite(Date.parse(day.sourceCheckedAt)) && Date.parse(day.sourceCheckedAt) <= checkedAt));
      for (const entry of day.entries) requireValue(typeof entry.title === "string" && entry.title.length > 0 && entry.title.length <= 512 &&
        Number.isFinite(Date.parse(entry.startsAt)) && Number.isFinite(Date.parse(entry.endsAt)) &&
        Date.parse(entry.endsAt) > Date.parse(entry.startsAt) &&
        (entry.episodeTitle === undefined || typeof entry.episodeTitle === "string" && entry.episodeTitle.length <= 1024));
    }
  }
  return data;
}
async function readSealed(storage: Storage, seal: FileSeal | { key: string; digest: string; size: number }) {
  const bytes = Buffer.from(await storage.get(seal.key, { signal: AbortSignal.timeout(30_000), maxBytes: MAX_BYTES }));
  requireValue(bytes.length === seal.size && hash(bytes) === seal.digest);
  return bytes;
}

/** The caller must hold the existing source/runtime guard. Fonts and logo come
 * from the committed source tree. No provider, context or queue write here. */
export async function createCloudSchedulePacket({ inputs, storage }: { inputs: PreparedHomeExternalInputs; storage: Storage }): Promise<CloudSchedulePacket> {
  const source = sourceIdentity(inputs);
  const original = await readSealed(storage, inputs.files["schedule.json"]);
  const { loadScheduleData } = await import("../src/lib/schedule-data");
  const schedule = await loadScheduleData(checkedSchedule(original, source.checkedAt), {});
  const exported = buildScheduleExport(schedule, new Date(source.checkedAt));
  const json = Buffer.from(JSON.stringify(schedule));
  const [regularFont, boldFont, blackFont, logo] = await Promise.all([
    readFile(new URL("../src/assets/pdf-fonts/PublicSans-Regular.ttf", import.meta.url)),
    readFile(new URL("../src/assets/pdf-fonts/PublicSans-Bold.ttf", import.meta.url)),
    readFile(new URL("../src/assets/pdf-fonts/PublicSans-Black.ttf", import.meta.url)),
    readFile(new URL("../public/brand/njpbs-horizontal-white-navy.png", import.meta.url)),
  ]);
  const { renderSchedulePdf } = await import("../src/lib/schedule-pdf");
  const pdf = await renderSchedulePdf(exported, { regularFont, boldFont, blackFont, logo });
  const prefix = packetPrefix(source);
  const files = {} as CloudSchedulePacket["files"];
  for (const [kind, bytes, filename, contentType] of [
    ["json", json, "schedule.json", "application/json"],
    ["pdf", pdf, "nj-pbs-schedule.pdf", "application/pdf"],
  ] as const) {
    requireValue(bytes.length > 0 && bytes.length <= MAX_BYTES);
    const seal = { key: `${prefix}/${hash(bytes)}/${filename}`, digest: hash(bytes), size: bytes.length, contentType };
    await storage.put(seal.key, bytes, { signal: AbortSignal.timeout(30_000), contentType });
    await readSealed(storage, seal);
    files[kind] = seal;
  }
  return { schemaVersion: 1, source, generatedAt: schedule.generatedAt, exportedAt: exported.exportedAt,
    startDate: exported.startDate, endDate: exported.endDate, timeZone: TVSS_TIME_ZONE, files };
}

/** The future reader supplies inputs from its exact public-context transaction.
 * Parent acceptance binds this receipt to that context; no runtime is relabeled. */
export async function readCloudSchedulePacket({ inputs, packet, storage }: {
  inputs: PreparedHomeExternalInputs; packet: CloudSchedulePacket; storage: Storage;
}) {
  const source = sourceIdentity(inputs);
  requireValue(packet?.schemaVersion === 1 && isDeepStrictEqual(packet.source, source) &&
    packet.timeZone === TVSS_TIME_ZONE && packet.exportedAt === new Date(source.checkedAt).toISOString() &&
    packet.files && Object.keys(packet.files).sort().join(",") === "json,pdf");
  for (const [kind, filename, contentType] of [
    ["json", "schedule.json", "application/json"], ["pdf", "nj-pbs-schedule.pdf", "application/pdf"],
  ] as const) {
    const file = packet.files[kind];
    requireValue(file && /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_BYTES &&
      file.contentType === contentType && file.key === `${packetPrefix(source)}/${file.digest}/${filename}`);
  }
  const [json, pdf] = await Promise.all([readSealed(storage, packet.files.json), readSealed(storage, packet.files.pdf)]);
  const schedule = checkedSchedule(json, source.checkedAt);
  const exported = buildScheduleExport(schedule, new Date(source.checkedAt));
  requireValue(schedule.generatedAt === packet.generatedAt && exported.startDate === packet.startDate &&
    exported.endDate === packet.endDate && pdf.subarray(0, 5).toString() === "%PDF-");
  return { schedule, exported, json, pdf };
}
