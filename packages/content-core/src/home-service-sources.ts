import { readPublishedHomeNewscast, resolvePublishedHomeNewscast } from "./home-newscast-published.ts";
import type { HomeNewscastSource } from "./home-newscast-source.ts";
import { adaptHomeNewsletter } from "./home-newsletter-source.ts";
import { homeSourceObject, homeSourceInstant } from "./home-source-curation.ts";
import { homeCatalogJson } from "./home-source-selection.ts";

export type HomeNewsletterSnapshot = { status: "error" } | {
  status: "ready"; checkedAt: string; records: readonly unknown[];
};
export interface HomeServiceSources { newsletters: HomeNewsletterSnapshot; newscast?: HomeNewscastSource }
/** Retained automatic episode only; no provider request on fast publication. */
export function forwardHomeServiceSources(services: HomeServiceSources | undefined, cutoffAt: string): HomeServiceSources | undefined {
  return services ? { ...services, ...(services.newscast ? { newscast: resolvePublishedHomeNewscast(services.newscast, cutoffAt) } : {}) } : undefined;
}

/** Consume approved public record-card exports, never working library records. */
export function projectHomeNewsletterRecord(record: unknown, checkedAt: string, cutoffAt: string): unknown | null {
  if (!homeSourceObject(record) || typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)) return null;
  const source = adaptHomeNewsletter({ newsletterIds: [record.id], actionLabel: "Sign up by email" },
    { status: "ready", checkedAt, records: [record] }, cutoffAt);
  const card = source.cards[0];
  if (!card) return null;
  return { id: card.id, kind: "newsletter", href: null, sourceVersion: card.sourceVersion,
    newsletter: { card: { title: card.title, signupUrl: card.signupHref,
      ...(card.summary ? { summary: card.summary } : {}), ...(card.frequency ? { frequency: card.frequency } : {}),
      ...(card.image ? { imageAlt: card.image.alt } : {}) },
      ...(card.image ? { image: { url: card.image.url } } : {}) } };
}

export function createHomeNewsletterSnapshot(records: readonly unknown[], checkedAt: string, cutoffAt: string, selectedIds: readonly string[] = []): HomeNewsletterSnapshot {
  if (!Array.isArray(records) || selectedIds.length > 1 || selectedIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("Home Newsletter export is invalid.");
  const projected = records.filter(record => homeSourceObject(record) && record.kind === "newsletter")
    .flatMap(record => { const card = projectHomeNewsletterRecord(record, checkedAt, cutoffAt); return card ? [card] : []; });
  return readHomeServiceSources({ newsletters: { status: "ready", checkedAt, records: projected.sort((a, b) => {
    const left = (a as { id: string }).id, right = (b as { id: string }).id;
    return Number(selectedIds.includes(right)) - Number(selectedIds.includes(left)) || left.localeCompare(right);
  }).slice(0, 200) } }, cutoffAt).newsletters;
}

/** Closed, bounded, public fields covered by the Home catalog's digest. */
export function readHomeServiceSources(value: unknown, cutoffAt: string): HomeServiceSources {
  if (!homeSourceObject(value) || Object.keys(value).length !== (Object.hasOwn(value, "newscast") ? 2 : 1) || Object.keys(value).some(key => !["newsletters", "newscast"].includes(key)) || !Object.hasOwn(value, "newsletters") || !homeSourceObject(value.newsletters)) {
    throw new Error("Home service sources are invalid.");
  }
  const newscast = Object.hasOwn(value, "newscast") ? readPublishedHomeNewscast(value.newscast) : undefined;
  if (newscast && newscast.cutoffAt !== cutoffAt) throw new Error("Newscast and Home catalog cutoffs differ.");
  const optional = newscast ? { newscast } : {};
  const snapshot = value.newsletters;
  if (snapshot.status === "error" && Object.keys(snapshot).length === 1 && Object.hasOwn(snapshot, "status")) return { newsletters: { status: "error" }, ...optional };
  const cutoff = homeSourceInstant(cutoffAt), checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 || Object.keys(snapshot).some(key => !["status", "checkedAt", "records"].includes(key)) || cutoff === null || checked === null || checked > cutoff ||
      !Array.isArray(snapshot.records) || snapshot.records.length > 200) throw new Error("Published Home Newsletters are invalid.");
  const records = snapshot.records.map(record => projectHomeNewsletterRecord(record, String(snapshot.checkedAt), cutoffAt));
  if (records.some(record => record === null) || homeCatalogJson(records) !== homeCatalogJson(snapshot.records) ||
      new Set(records.map(record => (record as { id: string }).id)).size !== records.length) {
    throw new Error("Published Home Newsletters are invalid.");
  }
  return { newsletters: { status: "ready", checkedAt: String(snapshot.checkedAt), records }, ...optional };
}

/** Cloud Home joins only referenced records. Correct/withdraw those IDs while
 * retaining unrelated approved picker candidates from the last public seal. */
export function refreshHomeNewsletterSnapshot(retained: HomeNewsletterSnapshot | undefined,
  selectedIds: readonly string[], currentRecords: readonly unknown[], cutoffAt: string): HomeNewsletterSnapshot {
  const current = createHomeNewsletterSnapshot(currentRecords, cutoffAt, cutoffAt, selectedIds);
  const selected = new Set(selectedIds);
  const kept = retained?.status === "ready" ? retained.records.filter(record =>
    homeSourceObject(record) && !selected.has(String(record.id))) : [];
  return createHomeNewsletterSnapshot([...kept, ...(current.status === "ready" ? current.records.filter(record => homeSourceObject(record) && selected.has(String(record.id))) : [])], cutoffAt, cutoffAt, selectedIds);
}
