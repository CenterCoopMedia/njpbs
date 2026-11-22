import { extractPartnerPlayerSrc, type AssetAvailabilityWindow } from "./media-manager-catalog.ts";
import { mediaManagerWindowAt } from "./media-manager-gating.ts";

export const MAX_CATALOG_VIDEOS = 2_000;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export interface PublicVideo {
  slug: string;
  title: string;
  description: string;
  kind: "episode" | "special";
  seasonTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  premieredOn: string | null;
  playerSrc: string;
  hasCaptions: boolean;
  captionLanguages: string[];
  window: AssetAvailabilityWindow;
}

export interface PublicVideoProgram {
  slug: string;
  title: string;
  description: string;
  genre: string | null;
  episodes: PublicVideo[];
}

export interface PublicVideoCatalog {
  checkedAt: string;
  programs: PublicVideoProgram[];
}

export function catalogSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function catalogCaptionLanguage(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(value);
}

export function catalogRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_000;
}

function ordinal(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function catalogDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate the retained public projection before it can supply routes or iframe sources. */
export function readPublicVideoCatalog(value: unknown): PublicVideoCatalog | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error("Invalid public video catalog snapshot");
  const catalog = catalogRecord(value);
  if (!catalog || typeof catalog.checkedAt !== "string" || !Array.isArray(catalog.programs) ||
      catalog.programs.length > MAX_CATALOG_VIDEOS) throw invalid();
  const checked = new Date(catalog.checkedAt);
  if (!Number.isFinite(checked.getTime()) || checked.toISOString() !== catalog.checkedAt) throw invalid();

  const programSlugs = new Set<string>();
  let count = 0;
  for (const rawProgram of catalog.programs as unknown[]) {
    const program = catalogRecord(rawProgram);
    if (!program || !catalogSlug(program.slug) || programSlugs.has(program.slug) || !text(program.title) ||
        !text(program.description) || (program.genre !== null && !text(program.genre)) ||
        !Array.isArray(program.episodes) || program.episodes.length === 0) throw invalid();
    programSlugs.add(program.slug);
    count += program.episodes.length;
    if (count > MAX_CATALOG_VIDEOS) throw invalid();
    const episodeSlugs = new Set<string>();
    for (const rawEpisode of program.episodes as unknown[]) {
      const episode = catalogRecord(rawEpisode);
      if (!episode || !catalogSlug(episode.slug) || episodeSlugs.has(episode.slug) || !text(episode.title) ||
          !text(episode.description) || (episode.kind !== "episode" && episode.kind !== "special") ||
          (episode.seasonTitle !== null && !text(episode.seasonTitle)) || !ordinal(episode.seasonNumber) ||
          !ordinal(episode.episodeNumber) || (episode.premieredOn !== null && !catalogDate(episode.premieredOn)) ||
          typeof episode.playerSrc !== "string" || extractPartnerPlayerSrc(episode.playerSrc) !== episode.playerSrc ||
          typeof episode.hasCaptions !== "boolean" || !Array.isArray(episode.captionLanguages) ||
          episode.captionLanguages.length > 20 || !episode.captionLanguages.every(catalogCaptionLanguage) ||
          (!episode.hasCaptions && episode.captionLanguages.length > 0) ||
          mediaManagerWindowAt(episode.window, checked) !== "open") throw invalid();
      episodeSlugs.add(episode.slug);
    }
  }
  return value as PublicVideoCatalog;
}
