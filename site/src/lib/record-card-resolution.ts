import type { RecordCardBlock } from "../../../packages/content-core/src/content-model";
import type { CmsProgramBuildData } from "./cms-programs-loader";
import { programCardData } from "./program-card-data.ts";
import type { CmsEventBuildData } from "./cms-events-loader.ts";
import { eventCardData } from "./event-card-data.ts";
import { newsletterCardData, type NewsletterCardData } from "../../../packages/content-core/src/newsletter-card-data.ts";
import type { NewsletterRecord } from "../../../packages/content-core/src/content-model.ts";
import { sponsorActiveOn, sponsorCardData, type SponsorCardData } from "./sponsor-export.ts";

export interface CardImageAsset { url: string; mimeType: string; width: number; height: number }
export interface NewsletterExportData { card: NewsletterCardData; image?: CardImageAsset }

interface CardBase {
  id: string;
  title: string;
  href: string | null;
  variant?: "card" | "compact";
}
export type RecordCardPayload =
  | (CardBase & { kind: "program"; href: string; program?: ReturnType<typeof programCardData> })
  | (CardBase & { kind: "event"; href: string; event?: ReturnType<typeof eventCardData> })
  | (CardBase & { kind: "sponsor"; sponsor?: SponsorCardData; sourceVersion?: number })
  | (CardBase & { kind: "newsletter"; href: null; newsletter?: NewsletterExportData; sourceVersion?: number });

type StoredRecord = Record<string, unknown> & { id: string };
const title = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const sourceVersion = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The build reader resolves this content from immutable approval history. */
export function approvedLibraryCardRecord(record: StoredRecord): StoredRecord | null {
  if (!["sponsor", "newsletter"].includes(String(record.type)) || record.deleted || record.status === "archived") return null;
  const approved = record.approvedLibraryVersion;
  if (!object(approved) || approved.type !== record.type || approved.status !== "approved" || approved.deleted ||
    !Number.isSafeInteger(approved.version) || Number(approved.version) < 1 ||
    !Number.isSafeInteger(record.version) || Number(approved.version) > Number(record.version)) return null;
  // Do not fill optional fields from working content or legacy published data.
  return { ...approved, id: record.id };
}

/** Shared media admission for direct reads, the fixed-cutoff bundle and its receipt. */
export function approvedLibraryCardAssetIds(record: StoredRecord, now: Date): string[] {
  const source = approvedLibraryCardRecord(record);
  if (!source) return [];
  const id = source.type === "sponsor"
    ? sponsorActiveOn(source, now) ? source.logoAssetId : undefined
    : newsletterCardData(source as unknown as NewsletterRecord)?.imageAssetId;
  return typeof id === "string" && !!id.trim() && !id.includes("/") ? [id.trim()] : [];
}

/** Read-only public card export: library kinds require a retained approved version. */
export function exportRecordCards(
  records: readonly StoredRecord[],
  programs: readonly CmsProgramBuildData[],
  now: Date,
  assets: readonly { id: string; url: string; mimeType: string; width?: number; height?: number }[] = [],
  events: readonly CmsEventBuildData[] = [],
): RecordCardPayload[] {
  const cards: RecordCardPayload[] = [];
  for (const program of programs) {
    cards.push({ kind: "program", id: program.programId, title: program.title, href: program.path, program: programCardData(program) });
  }
  for (const event of events) {
    cards.push({ kind: "event", id: event.eventId, title: event.title, href: event.path, event: eventCardData(event) });
  }
  const approvedRecords: StoredRecord[] = [];
  for (const record of records) {
    if (!["sponsor", "newsletter"].includes(String(record.type)) || record.deleted || record.status === "archived") continue;
    const source = approvedLibraryCardRecord(record);
    if (!source) {
      console.warn(`Record card ${record.id}: no approved version available; omitting the public card.`);
      continue;
    }
    approvedRecords.push(source);
  }
  return [...cards, ...projectLibraryCards(approvedRecords, now, assets)];
}

/** Authenticated saved previews may explicitly inspect working library fields. */
export function exportPreviewLibraryCards(
  records: readonly StoredRecord[], now: Date,
  assets: readonly { id: string; url: string; mimeType: string; width?: number; height?: number }[] = [],
): RecordCardPayload[] {
  return projectLibraryCards(records, now, assets);
}

function projectLibraryCards(
  records: readonly StoredRecord[], now: Date,
  assets: readonly { id: string; url: string; mimeType: string; width?: number; height?: number }[],
): RecordCardPayload[] {
  const cards: RecordCardPayload[] = [];
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  for (const record of records) {
    if (record.deleted || record.status === "archived") continue;
    if (record.type === "sponsor") {
      const name = title(record.name);
      const sponsor = sponsorCardData(record, assetMap, now);
      if (sponsor) cards.push({ kind: "sponsor", id: record.id, title: name, href: sponsor.href, sponsor, sourceVersion: sourceVersion(record.version) });
    }
    if (record.type === "newsletter") {
      const newsletter = newsletterCardData(record as unknown as NewsletterRecord);
      if (!newsletter) continue;
      const imageSource = newsletter.imageAssetId ? assetMap.get(newsletter.imageAssetId) : undefined;
      const image = imageSource && /^image\/(png|jpeg|webp|gif|avif)$/.test(imageSource.mimeType) &&
        /^https:\/\//.test(imageSource.url) && Number.isInteger(imageSource.width) && Number.isInteger(imageSource.height) &&
        Number(imageSource.width) > 0 && Number(imageSource.height) > 0
        ? { url: imageSource.url, mimeType: imageSource.mimeType, width: Number(imageSource.width), height: Number(imageSource.height) } : undefined;
      cards.push({ kind: "newsletter", id: record.id, title: newsletter.title, href: null,
        newsletter: { card: newsletter, ...(image ? { image } : {}) }, sourceVersion: sourceVersion(record.version) });
    }
  }
  return cards;
}

export function resolveRecordCard(
  block: Pick<RecordCardBlock, "data">,
  cards: readonly RecordCardPayload[],
): RecordCardPayload | null {
  const card = cards.find(candidate =>
    candidate.kind === block.data.recordKind && candidate.id === block.data.recordId);
  return card ? { ...card, variant: block.data.variant } : null;
}

/** Sponsor strips use the same fixed-cutoff card export as record cards. */
export function sponsorCardsFromRecordCards(cards: readonly RecordCardPayload[]): SponsorCardData[] {
  return cards.flatMap(card => card.kind === "sponsor" && card.sponsor ? [card.sponsor] : []);
}
