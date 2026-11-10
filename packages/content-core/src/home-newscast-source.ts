import { isCalendarDay, stationCalendarDay } from "./editorial-dates.ts";
import { homeSourceImage, homeSourceInstant, homeSourceObject, homeSourceText, type HomeSourceImage } from "./home-source-curation.ts";
import { extractPartnerPlayerSrc } from "./partner-player.ts";

// Joe approved this exact provider/series through the coordinator on October 11, 2026.
export const HOME_NEWSCAST_SHOW_ID = "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5";
export const HOME_NEWSCAST_PROGRAM_HREF = "https://watch.njpbs.org/show/nj-pbs-news-with-rob-nelson/";
export const HOME_NEWSCAST_ASSETS_URL = `https://media.services.pbs.org/api/v1/assets/?show-id=${HOME_NEWSCAST_SHOW_ID}&type=full_length&parent-type=episode&available=public&country=US&platform-slug=bento&sort=-premiered_on`;

export interface HomeNewscastEpisode {
  id: string;
  episodeId: string;
  title: string;
  summary?: string;
  /** A title-owned air date, or null when the editor supplies an undated title. */
  episodeDate: string | null;
  /** Preserve the provider's calendar date; do not fabricate a premiere clock time. */
  premieredOn: string;
  sequence: number;
  durationSeconds: number;
  captioned: true;
  href: string;
  /** Provider-owned player code, absent in snapshots retained before playback support. */
  playerSrc?: string;
  poster: HomeSourceImage;
  publicWindow: { startsAt: string | null; endsAt: string | null; country: "US"; platform: "bento" };
}
export interface HomeNewscastSource {
  source: "pbs_media_manager";
  showId: typeof HOME_NEWSCAST_SHOW_ID;
  showTitle: "NJ PBS News with Rob Nelson";
  programHref: typeof HOME_NEWSCAST_PROGRAM_HREF;
  pastNewscastsHref: typeof HOME_NEWSCAST_PROGRAM_HREF;
  liveHref: "/live/";
  cutoffAt: string;
  checkedAt: string | null;
  episode: HomeNewscastEpisode | null;
  emptyReason: "source_error" | "source_empty" | "no_eligible_episode" | "withdrawn" | null;
}
export type HomeNewscastSnapshot = { status: "error" } | {
  status: "ready"; source: "pbs_media_manager"; requestUrl: string; checkedAt: string;
  /** The caller must collect every page before automatic selection can be authoritative. */
  complete: boolean; response: unknown;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Episode-title authority, confirmed by Joe; upload/premiere dates never fill a missing episode date. */
export function newscastTitleDate(value: unknown): string | null {
  if (!homeSourceText(value, 300)) return null;
  const match = /^NJ PBS News with Rob Nelson \| ([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]) + 1;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return isCalendarDay(date) ? date : null;
}

/** The approved show title, with either a valid full date or no date suffix. */
export function isNewscastTitle(value: unknown): value is string {
  return value === "NJ PBS News with Rob Nelson" || newscastTitleDate(value) !== null;
}

function eligibleEpisode(value: unknown, cutoff: number, cutoffDay: string): HomeNewscastEpisode | null {
  if (!homeSourceObject(value) || value.type !== "asset" || typeof value.id !== "string" || !UUID.test(value.id) ||
    !homeSourceObject(value.attributes)) return null;
  const asset = value.attributes;
  const parent = homeSourceObject(asset.parent_tree) ? asset.parent_tree : {};
  const episode = homeSourceObject(parent.attributes) ? parent.attributes : {};
  const season = homeSourceObject(episode.season) && homeSourceObject(episode.season.attributes) ? episode.season.attributes : {};
  const show = homeSourceObject(season.show) ? season.show : {};
  // The existing Media Manager catalog accepts both numeric and numeric-string ordinals.
  const sequence = typeof episode.ordinal === "number" ? episode.ordinal
    : typeof episode.ordinal === "string" && episode.ordinal.trim() ? Number(episode.ordinal.trim()) : NaN;
  if (asset.object_type !== "full_length" || parent.type !== "episode" || typeof parent.id !== "string" || !UUID.test(parent.id) ||
    show.type !== "show" || show.id !== HOME_NEWSCAST_SHOW_ID || !isNewscastTitle(asset.title) || !isNewscastTitle(episode.title) ||
    typeof asset.slug !== "string" || asset.slug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.slug) ||
    !Number.isSafeInteger(asset.duration) || Number(asset.duration) <= 0 || asset.has_captions !== true ||
    !Number.isSafeInteger(sequence) || sequence < 1 || !isCalendarDay(asset.premiered_on)) return null;
  const episodeDate = newscastTitleDate(episode.title);
  const assetDate = newscastTitleDate(asset.title);
  if (episodeDate !== null && episodeDate > cutoffDay || asset.premiered_on > cutoffDay || assetDate !== episodeDate) return null;
  const availability = homeSourceObject(asset.availabilities) && homeSourceObject(asset.availabilities.public)
    ? asset.availabilities.public : null;
  if (!availability || !Array.isArray(availability.countries) ||
    !(availability.countries.some(country => homeSourceObject(country) && country.code === "US") ||
      availability.countries.length === 0 && availability.geo_profile === null) ||
    !Array.isArray(asset.platforms) || !asset.platforms.some(platform => homeSourceObject(platform) &&
      (platform.slug === "bento" || platform.slug === "allplatforms"))) return null;
  const start = availability.start === null ? null : homeSourceInstant(availability.start);
  const end = availability.end === null ? null : homeSourceInstant(availability.end);
  if (availability.start !== null && (start === null || start > cutoff) ||
    availability.end !== null && (end === null || end <= cutoff)) return null;
  const images = Array.isArray(asset.images) ? asset.images : [];
  const mezzanine = images.find(image => homeSourceObject(image) && image.profile === "asset-mezzanine-16x9");
  const poster = homeSourceObject(mezzanine) ? homeSourceImage({ url: mezzanine.image, alt: "" }) : undefined;
  if (!poster || new URL(poster.url, "https://njpbs.org").origin !== "https://image.pbs.org") return null;
  const playerSrc = typeof asset.player_code === "string" ? extractPartnerPlayerSrc(asset.player_code) : null;
  return { id: value.id, episodeId: parent.id, title: asset.title,
    ...(homeSourceText(asset.description_short, 2000) ? { summary: asset.description_short } : {}),
    episodeDate, premieredOn: asset.premiered_on,
    sequence, durationSeconds: Number(asset.duration), captioned: true,
    href: `https://watch.njpbs.org/video/${asset.slug}/`, ...(playerSrc ? { playerSrc } : {}), poster,
    publicWindow: { startsAt: availability.start as string | null, endsAt: availability.end as string | null, country: "US", platform: "bento" } };
}

/** Pure selection from a complete published-asset response at the immutable publication cutoff. */
export function adaptLatestHomeNewscast(snapshot: HomeNewscastSnapshot, cutoffAt: string, previousAssetId?: string): HomeNewscastSource {
  const cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || previousAssetId !== undefined && !UUID.test(previousAssetId)) throw new Error("Newscast cutoff or prior asset is invalid.");
  const result: HomeNewscastSource = { source: "pbs_media_manager", showId: HOME_NEWSCAST_SHOW_ID,
    showTitle: "NJ PBS News with Rob Nelson", programHref: HOME_NEWSCAST_PROGRAM_HREF,
    pastNewscastsHref: HOME_NEWSCAST_PROGRAM_HREF, liveHref: "/live/", cutoffAt, checkedAt: null,
    episode: null, emptyReason: "source_error" };
  if (snapshot.status === "error") return result;
  const checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || snapshot.source !== "pbs_media_manager" || snapshot.requestUrl !== HOME_NEWSCAST_ASSETS_URL ||
    checked === null || checked > cutoff) throw new Error("Keep the approved newscast source and valid receipt.");
  const response = snapshot.response;
  if (!snapshot.complete || !homeSourceObject(response) || !Array.isArray(response.data) ||
    !homeSourceObject(response.links) || response.links.next !== null) return result;
  const cutoffDay = stationCalendarDay(cutoffAt)!;
  const admitted = response.data.flatMap(value => {
    const episode = eligibleEpisode(value, cutoff, cutoffDay);
    return episode ? [episode] : [];
  });
  const counts = new Map<string, number>();
  for (const episode of admitted) counts.set(episode.id, (counts.get(episode.id) ?? 0) + 1);
  const eligible = admitted.filter(episode => counts.get(episode.id) === 1);
  // Premiere metadata can be a day later than broadcast. Use it only to order
  // undated episodes, never to fabricate their displayed air date.
  eligible.sort((a, b) => {
    const aDay = a.episodeDate ?? a.premieredOn, bDay = b.episodeDate ?? b.premieredOn;
    return aDay === bDay ? b.sequence - a.sequence || a.id.localeCompare(b.id) : aDay > bDay ? -1 : 1;
  });
  const episode = eligible[0] ?? null;
  return { ...result, checkedAt: snapshot.checkedAt, episode,
    emptyReason: episode ? null : previousAssetId ? "withdrawn" : response.data.length ? "no_eligible_episode" : "source_empty" };
}
