import { extractPartnerPlayerSrc, type AssetAvailabilityWindow } from "./media-manager-catalog.ts";

// Its serialized size bounds the catalog: 0.8 MB for 1,105 videos on Nov. 27, 2026.
// The launch file stores it pretty-printed under a 16 MiB input bound, so the compact catalog keeps half of that.
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
// Each program publishes only its newest videos, by product decision (Nov. 27, 2026), not every available video.
// Every video is its own page in the videoCatalog publication family (4,096 files, 64 MB), about 34.4 KB each.
// The newest 10 per program measured 1,425 pages and 49.05 MB on Nov. 27, 2026. A higher limit needs a higher byte cap.
export const MAX_PROGRAM_VIDEOS = 10;
// 75% of the family byte cap at 34.4 KB per page. More programs lower the per-program limit below 10.
export const MAX_CATALOG_PAGES = 1_460;

type CatalogVideo = { slug: string; premieredOn: string | null };

/**
 * Keep the newest videos per program (premiere date, then `tie`), using the largest per-program limit that keeps
 * the index, program and video pages within MAX_CATALOG_PAGES. Undefined when one video per program does not fit.
 */
export function fitCatalogPages<P extends { episodes: CatalogVideo[] }>(programs: P[],
    tie: (video: P["episodes"][number]) => string = video => video.slug): P[] | undefined {
  type V = P["episodes"][number];
  const date = (video: V) => catalogDate(video.premieredOn) ? video.premieredOn : "";
  for (let limit = MAX_PROGRAM_VIDEOS; limit > 0; limit -= 1) {
    const pages = 1 + programs.reduce((sum, program) => sum + 1 + Math.min(program.episodes.length, limit), 0);
    if (pages > MAX_CATALOG_PAGES) continue;
    return programs.map(program => ({ ...program, episodes: [...program.episodes]
      .sort((a, b) => date(b).localeCompare(date(a)) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0))
      .slice(0, limit).sort((a, b) => a.slug.localeCompare(b.slug, "en")) }) as P);
  }
  return undefined;
}

export interface PublicVideo {
  slug: string;
  title: string;
  description: string;
  image?: string;
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
  image?: string;
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

function mapWindow(value: unknown): AssetAvailabilityWindow | null | undefined {
  if (value === null) return null;
  const record = catalogRecord(value);
  if (!record) return undefined;
  const hasStart = Object.prototype.hasOwnProperty.call(record, "start");
  const hasEnd = Object.prototype.hasOwnProperty.call(record, "end");
  // A window needs at least one explicit bound, even if that bound is null.
  if (!hasStart && !hasEnd) return undefined;
  const start = record.start;
  const end = record.end;
  const mapped: AssetAvailabilityWindow = {};
  if (hasStart) {
    if (start !== null && typeof start !== "string") return undefined;
    mapped.start = start;
  }
  if (hasEnd) {
    if (end !== null && typeof end !== "string") return undefined;
    mapped.end = end;
  }
  return mapped;
}

function validCalendarDate(value: string): string | null {
  const trimmed = value.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

function easternDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

type WindowBound =
  | { kind: "open" }
  | { kind: "day"; day: string }
  | { kind: "instant"; ms: number }
  | { kind: "bad" };

// Date-only bounds include the entire New Jersey day. Timestamps keep their instant.
function parseWindowBound(bound: string | null | undefined): WindowBound {
  if (bound === null || bound === undefined) return { kind: "open" };
  const trimmed = bound.trim();
  if (trimmed === "") return { kind: "bad" };
  const dateOnly = validCalendarDate(trimmed);
  if (dateOnly !== null) return { kind: "day", day: dateOnly };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed) ||
      validCalendarDate(trimmed.slice(0, 10)) === null) return { kind: "bad" };
  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) return { kind: "instant", ms: t };
  return { kind: "bad" };
}

export function mediaManagerWindowAt(value: unknown, now: Date): "open" | "before" | "after" | "invalid" {
  const window = mapWindow(value);
  const nowMs = now.getTime();
  if (!window || !Number.isFinite(nowMs)) return "invalid";
  const start = parseWindowBound(window.start);
  const end = parseWindowBound(window.end);
  if (start.kind === "bad" || end.kind === "bad") return "invalid";
  const today = easternDate(nowMs);
  if ((start.kind === "day" && today < start.day) || (start.kind === "instant" && nowMs < start.ms)) return "before";
  if ((end.kind === "day" && today > end.day) || (end.kind === "instant" && nowMs > end.ms)) return "after";
  return "open";
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

export function isCatalogImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 &&
    /^https:\/\/image\.pbs\.org\/(?:contentchannels|video-assets)\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/.test(value) &&
    !/\s/.test(value);
}

/** Validate the observation and, when publishing, keep only currently open windows. */
export function readPublicVideoCatalog(value: unknown, now?: Date): PublicVideoCatalog | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error("Invalid public video catalog snapshot");
  const catalog = catalogRecord(value);
  if (!catalog || typeof catalog.checkedAt !== "string" || !Array.isArray(catalog.programs) ||
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength > MAX_CATALOG_BYTES) throw invalid();
  const checked = new Date(catalog.checkedAt);
  if (!Number.isFinite(checked.getTime()) || checked.toISOString() !== catalog.checkedAt) throw invalid();

  const programSlugs = new Set<string>();
  for (const rawProgram of catalog.programs as unknown[]) {
    const program = catalogRecord(rawProgram);
    if (!program || !catalogSlug(program.slug) || programSlugs.has(program.slug) || !text(program.title) ||
        !text(program.description) || (program.image !== undefined && !isCatalogImage(program.image)) ||
        (program.genre !== null && !text(program.genre)) ||
        !Array.isArray(program.episodes) || program.episodes.length === 0) throw invalid();
    programSlugs.add(program.slug);
    const episodeSlugs = new Set<string>();
    for (const rawEpisode of program.episodes as unknown[]) {
      const episode = catalogRecord(rawEpisode);
      if (!episode || !catalogSlug(episode.slug) || episodeSlugs.has(episode.slug) || !text(episode.title) ||
          !text(episode.description) || (episode.image !== undefined && !isCatalogImage(episode.image)) ||
          (episode.kind !== "episode" && episode.kind !== "special") ||
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
  const snapshot = value as PublicVideoCatalog;
  if (!now) return snapshot;
  // A retained catalog may predate the page limits; publish only what fits.
  const programs = fitCatalogPages(snapshot.programs.flatMap(program => {
    const episodes = program.episodes.filter(episode => mediaManagerWindowAt(episode.window, now) === "open");
    return episodes.length ? [{ ...program, episodes }] : [];
  }));
  if (!programs) throw invalid();
  return { checkedAt: snapshot.checkedAt, programs };
}
