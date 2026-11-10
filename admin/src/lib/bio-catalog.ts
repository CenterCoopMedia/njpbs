import { isBioCardData, type BioCardData } from "../../../packages/content-core/src/bio-profiles";

/** Catalog-only review metadata never belongs in a post snapshot. */
export interface BioSourceRecord { url: string; checkedAt: string; supports: string[] }
export interface BioCatalogEntry extends BioCardData { reviewStatus: "reviewed"; internalSourceIds?: string[]; sources?: BioSourceRecord[] }
export interface BioCatalog { schemaVersion: 1; profiles: BioCatalogEntry[] }

/** Explicit projection: adding internal catalog fields cannot expose them in an article. */
export function publicBioCard(value: BioCardData): BioCardData {
  return { profileId: value.profileId, kind: value.kind, name: value.name, role: value.role,
    ...(value.party ? { party: value.party } : {}), ...(value.area ? { area: value.area } : {}),
    summary: value.summary, sourceUrl: value.sourceUrl,
    sourceLabel: value.sourceLabel, asOf: value.asOf,
    ...(value.image ? { image: { assetId: value.image.assetId, alt: value.image.alt,
      ...(value.image.caption ? { caption: value.image.caption } : {}),
      ...(value.image.altDecorative === true ? { altDecorative: true } : {}) } } : {}) };
}

export function parseBioCatalog(value: unknown): BioCatalog {
  const invalid = () => new Error("The bio catalog could not be read. Try again.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || !Array.isArray(root.profiles) || root.profiles.length > 1000) throw invalid();
  const profiles = root.profiles.map((raw): BioCatalogEntry => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const entry = raw as Record<string, unknown>;
    const { reviewStatus, internalSourceIds, sources, ...card } = entry;
    if (reviewStatus !== "reviewed" || !isBioCardData(card, true) ||
      (internalSourceIds !== undefined && (!Array.isArray(internalSourceIds) || internalSourceIds.length > 100 ||
        internalSourceIds.some(id => typeof id !== "string" || id.length > 200)))) throw invalid();
    const privateSources = sources === undefined ? undefined : (() => {
      if (!Array.isArray(sources) || sources.length > 30) throw invalid();
      return sources.map((source): BioSourceRecord => {
        if (!source || typeof source !== "object" || Array.isArray(source) ||
          Object.keys(source).some(key => !["url", "checkedAt", "supports"].includes(key))) throw invalid();
        const { url, checkedAt, supports } = source;
        if (typeof url !== "string" || url.length > 2000 || /[\s\u0000-\u001f]/.test(url) ||
          typeof checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
          !Array.isArray(supports) || supports.length > 30 || supports.some(fact => typeof fact !== "string" || fact.length > 500)) throw invalid();
        const parsed = new URL(url);
        const day = new Date(`${checkedAt}T00:00:00Z`);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== checkedAt) throw invalid();
        return { url, checkedAt, supports: supports as string[] };
      });
    })();
    return { ...publicBioCard(card), reviewStatus,
      ...(privateSources ? { sources: privateSources } : {}),
      ...(internalSourceIds ? { internalSourceIds: internalSourceIds as string[] } : {}) };
  });
  if (new Set(profiles.map(profile => profile.profileId)).size !== profiles.length) throw invalid();
  return { schemaVersion: 1, profiles };
}
