/**
 * Pure transform from Media Manager JSON:API records to static page models.
 * The caller fetches Show -> Season -> Episode -> Asset and Show -> Special ->
 * Asset records before calling buildProgram. This module performs no I/O,
 * clock reads or credential handling.
 *
 * A special belongs directly to a show and has its own assets rather than
 * episodes. A show may contain only specials, so both source paths are retained.
 */

import { extractPartnerPlayerSrc } from "../../../packages/content-core/src/partner-player";

// --- Raw Media Manager input (JSON:API) --------------------------------------

/** A JSON:API resource object: the shape every Media Manager record arrives in. */
export interface MediaManagerRecord<A> {
  id: string;
  type: string;
  attributes: A;
}

export interface ShowAttributes {
  title?: string;
  slug?: string;
  description_short?: string;
  description_long?: string;
  /** Media Manager exposes a primary genre object on a show. */
  genre?: { title?: string; slug?: string } | null;
}

export interface SeasonAttributes {
  /** Season number within the show (1-based); Media Manager may send it as a string. */
  ordinal?: number | string | null;
  title?: string;
}

export interface EpisodeAttributes {
  title?: string;
  slug?: string;
  description_short?: string;
  description_long?: string;
  /** ISO date the episode premiered, e.g. "2026-01-14"; may be absent. */
  premiered_on?: string | null;
  /** Ordinal within the season (1-based); Media Manager may send it as a string. */
  ordinal?: number | string | null;
}

/** A special has an episode's text fields but no ordinal, since it has no season. */
export interface SpecialAttributes {
  title?: string;
  slug?: string;
  description_short?: string;
  description_long?: string;
  premiered_on?: string | null;
}

/** One availability window; either bound may be open (null). */
export interface AssetAvailabilityWindow {
  start?: string | null;
  end?: string | null;
}

export interface AssetCaptionTrack {
  url?: string;
  /** 2-char language code, e.g. "en"; the primary-language file may omit it. */
  language?: string;
  profile?: string;
  primary?: boolean;
}

export interface AssetAttributes {
  /** Media Manager asset object type, e.g. "full_length", "clip", "preview". */
  object_type?: string;
  title?: string;
  /**
   * Availability windows keyed by audience. National content exposes `public`
   * and `all_members`; local/station content adds `station_members`. The public
   * build gates on the presence of a `public` window (see isPubliclyAvailable).
   */
  availabilities?: {
    public?: AssetAvailabilityWindow | null;
    all_members?: AssetAvailabilityWindow | null;
    station_members?: AssetAvailabilityWindow | null;
  } | null;
  /**
   * Caption tracks. Media Manager exposes `captions_language` (all uploaded
   * languages, each `{profile, url, language, primary}`) and `captions` (the
   * primary caption). The authoritative closed-captioning API page is a stub, so
   * the exact live shape is not fully pinned down; captionRefs reads
   * captions_language first, falls back to captions, and tolerates a single
   * object or an array for either.
   */
  captions_language?: AssetCaptionTrack[] | AssetCaptionTrack | null;
  captions?: AssetCaptionTrack[] | AssetCaptionTrack | null;
  /**
   * Transcript `.txt` auto-generated from the captions. Documented as a singular
   * `transcript`; some notes show a `transcripts` array, so both are accepted.
   */
  transcript?: { url?: string } | string | null;
  transcripts?: Array<{ url?: string }> | { url?: string } | null;
  /**
   * The Partner Player embed HTML the video API returns once the asset is
   * published. extractPartnerPlayerSrc pulls the player.pbs.org src out of it to
   * bake into the page.
   */
  player_code?: string | null;
}

/** An episode plus the assets fetched under it (`/assets/?parent-type=episode`). */
export interface RawEpisode {
  episode: MediaManagerRecord<EpisodeAttributes>;
  assets: MediaManagerRecord<AssetAttributes>[];
}

/** A season plus the episodes fetched under it. */
export interface RawSeason {
  season: MediaManagerRecord<SeasonAttributes>;
  episodes: RawEpisode[];
}

/**
 * A special plus its own assets, fetched per special from
 * `/specials/{special_id}/assets/`. Do not use `/assets/?show-id=...&parent-type=special`
 * here: it returns the assets of every special in the show in one list.
 */
export interface RawSpecial {
  special: MediaManagerRecord<SpecialAttributes>;
  assets: MediaManagerRecord<AssetAttributes>[];
}

/** A show plus its seasons and specials: what the credentialed adapter assembles per show. */
export interface RawShow {
  show: MediaManagerRecord<ShowAttributes>;
  seasons: RawSeason[];
  /** Optional so a season-only fixture or caller stays valid. */
  specials?: RawSpecial[];
}

// --- Static-page view model (output) -----------------------------------------

export interface CaptionRef {
  url: string;
  /** 2-char language code from the caption file, or null when it is unlabeled. */
  language: string | null;
}

export interface TranscriptRef {
// Keep transcript text out of the search index: this model carries only a URL
// reference, never an inline transcript body.
  url: string;
}

export interface EpisodePlayback {
  /** Partner Player iframe src for public playback, or null if none is bakeable. */
  partnerPlayerSrc: string | null;
  /** True only when a public caption file is actually present, not assumed. */
  hasCaptions: boolean;
  captions: CaptionRef[];
  transcripts: TranscriptRef[];
}

export interface CatalogEpisode {
  id: string;
  slug: string;
  title: string;
  description: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  premieredOn: string | null;
  playback: EpisodePlayback;
}

export interface CatalogProgram {
  id: string;
  slug: string;
  title: string;
  description: string;
  genre: string | null;
  episodes: CatalogEpisode[];
}

// --- Partner Player ----------------------------------------------------------

/**
 * Extract PBS player code and rebuild the Partner Player URL from a checked
 * host and ID. Retain approved numeric playback times and boolean flags.
 * Return null when the code does not contain a supported player URL.
 */
export { extractPartnerPlayerSrc } from "../../../packages/content-core/src/partner-player";

// --- Asset selection ---------------------------------------------------------

/**
 * True when the asset carries a `public` availability window. The public build
 * calls Media Manager with `available=public`, so responses are already scoped;
 * this is the defensive second check that keeps member-gated assets out of the
 * static output even if the query scope ever regresses. It deliberately does not
 * do start/end clock math: per-viewer window math is Media Manager's job at
 * runtime, and a build-time transform stays deterministic without it.
 */
export function isPubliclyAvailable(asset: MediaManagerRecord<AssetAttributes>): boolean {
  const pub = asset.attributes.availabilities?.public;
  return pub !== undefined && pub !== null;
}

/**
 * Pick the public, full-length asset for an episode: the one a static page bakes
 * a player and caption references from. Returns null when the episode has no
 * public full-length asset (a clips-only or member-only episode is skipped).
 */
export function selectPublicFullLengthAsset(
  assets: MediaManagerRecord<AssetAttributes>[],
): MediaManagerRecord<AssetAttributes> | null {
  return (
    assets.find(
      (asset) =>
        asset.attributes.object_type === "full_length" && isPubliclyAvailable(asset),
    ) ?? null
  );
}

// --- Playback + caption references -------------------------------------------

/** Normalize a Media Manager field that may arrive as a single object or an array. */
function toArray<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function captionRefs(asset: MediaManagerRecord<AssetAttributes>): CaptionRef[] {
  const byLanguage = toArray(asset.attributes.captions_language);
  const tracks = byLanguage.length > 0 ? byLanguage : toArray(asset.attributes.captions);
  return tracks
    .filter((track): track is AssetCaptionTrack & { url: string } =>
      typeof track?.url === "string" && track.url.trim().length > 0,
    )
    .map((track) => ({
      url: track.url,
      language:
        typeof track.language === "string" && track.language.trim()
          ? track.language.trim()
          : null,
    }));
}

function transcriptRefs(asset: MediaManagerRecord<AssetAttributes>): TranscriptRef[] {
  const raw = [
    ...toArray(asset.attributes.transcript),
    ...toArray(asset.attributes.transcripts),
  ];
  return raw
    .map((item) => (typeof item === "string" ? { url: item } : item))
    .filter((item): item is { url: string } =>
      typeof item?.url === "string" && item.url.trim().length > 0,
    )
    .map((item) => ({ url: item.url }));
}

/**
 * Assemble the playback block for an episode from its selected public asset. When
 * no public asset exists, playback is empty and hasCaptions is false rather than
 * unknown, so a page never claims captions it cannot show. The player src is
 * rebuilt from the PBS host and ID with checked playback times and flags.
 * Caption presence is verified from the actual caption files, not assumed
 * from the pipeline existing.
 */
export function episodePlayback(
  asset: MediaManagerRecord<AssetAttributes> | null,
): EpisodePlayback {
  if (!asset) {
    return { partnerPlayerSrc: null, hasCaptions: false, captions: [], transcripts: [] };
  }
  // The asset is trusted to be public already: selectPublicFullLengthAsset gates
  // that upstream, so this does not re-check availability. The adapter must keep
  // that ordering when it wires buildProgram to live payloads.
  const captions = captionRefs(asset);
  return {
    partnerPlayerSrc: extractPartnerPlayerSrc(asset.attributes.player_code),
    hasCaptions: captions.length > 0,
    captions,
    transcripts: transcriptRefs(asset),
  };
}

// --- Program assembly --------------------------------------------------------

function firstText(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Coerce a Media Manager ordinal to a number. Real payloads send ordinals as
 * either a number or a numeric string, so a plain type check would drop the
 * string case to null and lose the numbering. Non-integers and unparseable
 * values become null.
 */
function toOrdinal(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function toEpisode(raw: RawEpisode, seasonNumber: number | null): CatalogEpisode | null {
  const attrs = raw.episode.attributes;
  const title = firstText(attrs.title);
  const slug = firstText(attrs.slug);
  if (!title || !slug) return null;
  return {
    id: raw.episode.id,
    slug,
    title,
    description:
      firstText(attrs.description_short, attrs.description_long) ??
      "Available through PBS video.",
    seasonNumber,
    episodeNumber: toOrdinal(attrs.ordinal),
    premieredOn: firstText(attrs.premiered_on) ?? null,
    playback: episodePlayback(selectPublicFullLengthAsset(raw.assets)),
  };
}

/**
 * Build a program's static-page view model from a show, its seasons, and its
 * specials. Season episodes come first, then specials as seasonless episodes
 * (seasonNumber and episodeNumber null). Items missing a title or slug are
 * dropped (they cannot be routed or rendered). The result carries only what the
 * static build serves; per-viewer and member-gated data is out of scope by
 * construction, because only public full-length assets are selected upstream.
 */
export function buildProgram(raw: RawShow): CatalogProgram {
  const attrs = raw.show.attributes;
  const episodes: CatalogEpisode[] = [];
  for (const rawSeason of raw.seasons) {
    const seasonNumber = toOrdinal(rawSeason.season.attributes.ordinal);
    for (const rawEpisode of rawSeason.episodes) {
      const episode = toEpisode(rawEpisode, seasonNumber);
      if (episode) episodes.push(episode);
    }
  }
  for (const rawSpecial of raw.specials ?? []) {
    // Episodes and specials share one slug space in Media Manager, so a special
    // can use the same watch route as an episode without a collision.
    const special = toEpisode({ episode: rawSpecial.special, assets: rawSpecial.assets }, null);
    if (special) episodes.push(special);
  }
  return {
    id: raw.show.id,
    slug: firstText(attrs.slug) ?? raw.show.id,
    title: firstText(attrs.title) ?? "Untitled program",
    description:
      firstText(attrs.description_short, attrs.description_long) ??
      "Available through PBS video.",
    genre: firstText(attrs.genre?.title) ?? null,
    episodes,
  };
}
