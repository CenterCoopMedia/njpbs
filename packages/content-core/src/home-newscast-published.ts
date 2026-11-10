import { HOME_NEWSCAST_SHOW_ID, HOME_NEWSCAST_PROGRAM_HREF, newscastTitleDate, isNewscastTitle,
  type HomeNewscastSource, type HomeNewscastEpisode } from "./home-newscast-source.ts";
import { homeSourceInstant, homeSourceImage, homeSourceText } from "./home-source-curation.ts";
import { isCalendarDay, stationCalendarDay } from "./editorial-dates.ts";
import { extractPartnerPlayerSrc } from "./partner-player.ts";

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key));
}
const emptyReasons: readonly unknown[] = [null, "source_error", "source_empty", "no_eligible_episode", "withdrawn"];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function refuse(): never { throw new Error("The published newscast source is invalid."); }

/** A closed public DTO, never raw provider responses, requests or credentials. */
export function readPublishedHomeNewscast(value: unknown): HomeNewscastSource {
  if (!closed(value, ["source", "showId", "showTitle", "programHref", "pastNewscastsHref", "liveHref", "cutoffAt", "checkedAt", "episode", "emptyReason"]) ||
      value.source !== "pbs_media_manager" || value.showId !== HOME_NEWSCAST_SHOW_ID || value.showTitle !== "NJ PBS News with Rob Nelson" ||
      value.programHref !== HOME_NEWSCAST_PROGRAM_HREF || value.pastNewscastsHref !== HOME_NEWSCAST_PROGRAM_HREF || value.liveHref !== "/live/") refuse();
  const cutoff = homeSourceInstant(value.cutoffAt), day = stationCalendarDay(String(value.cutoffAt));
  const checked = value.checkedAt === null ? null : homeSourceInstant(value.checkedAt);
  if (cutoff === null || day === null || value.checkedAt !== null && (checked === null || checked > cutoff) ||
      !emptyReasons.includes(value.emptyReason) ||
      (value.episode === null) !== (value.emptyReason !== null) || checked === null && (value.episode !== null || value.emptyReason !== "source_error")) refuse();
  let episode: HomeNewscastEpisode | null = null;
  if (value.episode !== null) {
    const item = value.episode;
    const playerKeys = item && typeof item === "object" && Object.hasOwn(item, "playerSrc") ? ["playerSrc"] : [];
    const summaryKeys = item && typeof item === "object" && Object.hasOwn(item, "summary") ? ["summary"] : [];
    if (!closed(item, ["id", "episodeId", "title", "episodeDate", "premieredOn", "sequence", "durationSeconds", "captioned", "href", "poster", "publicWindow", ...playerKeys, ...summaryKeys]) ||
        !uuid(item.id) || !uuid(item.episodeId) || !isNewscastTitle(item.title) || newscastTitleDate(item.title) !== item.episodeDate ||
        item.episodeDate !== null && (!isCalendarDay(item.episodeDate) || item.episodeDate > day) || !isCalendarDay(item.premieredOn) || item.premieredOn > day ||
        !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || !Number.isSafeInteger(item.durationSeconds) || Number(item.durationSeconds) < 1 ||
        item.captioned !== true || typeof item.href !== "string" || item.href.length > 235 || !/^https:\/\/watch\.njpbs\.org\/video\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(item.href) ||
        !closed(item.poster, ["url", "alt"]) || item.poster.alt !== "" ||
        !closed(item.publicWindow, ["startsAt", "endsAt", "country", "platform"]) || item.publicWindow.country !== "US" || item.publicWindow.platform !== "bento") refuse();
    if (playerKeys.length && (typeof item.playerSrc !== "string" || item.playerSrc.length > 500 ||
        extractPartnerPlayerSrc(item.playerSrc) !== item.playerSrc)) refuse();
    if (summaryKeys.length && !homeSourceText(item.summary, 2000)) refuse();
    const poster = homeSourceImage(item.poster);
    if (!poster || new URL(poster.url).origin !== "https://image.pbs.org") refuse();
    const start = item.publicWindow.startsAt === null ? null : homeSourceInstant(item.publicWindow.startsAt);
    const end = item.publicWindow.endsAt === null ? null : homeSourceInstant(item.publicWindow.endsAt);
    if (item.publicWindow.startsAt !== null && (start === null || start > cutoff) ||
        item.publicWindow.endsAt !== null && (end === null || end <= cutoff)) refuse();
    episode = { id: item.id, episodeId: item.episodeId, title: String(item.title),
      ...(summaryKeys.length ? { summary: item.summary as string } : {}), episodeDate: item.episodeDate,
      premieredOn: item.premieredOn, sequence: Number(item.sequence), durationSeconds: Number(item.durationSeconds), captioned: true,
      href: item.href, ...(playerKeys.length ? { playerSrc: item.playerSrc as string } : {}), poster, publicWindow: { startsAt: item.publicWindow.startsAt as string | null,
        endsAt: item.publicWindow.endsAt as string | null, country: "US", platform: "bento" } };
  }
  return { source: "pbs_media_manager", showId: HOME_NEWSCAST_SHOW_ID, showTitle: "NJ PBS News with Rob Nelson",
    programHref: HOME_NEWSCAST_PROGRAM_HREF, pastNewscastsHref: HOME_NEWSCAST_PROGRAM_HREF, liveHref: "/live/",
    cutoffAt: String(value.cutoffAt), checkedAt: value.checkedAt as string | null, episode,
    emptyReason: value.emptyReason as HomeNewscastSource["emptyReason"] };
}

/** Fast Home reuses the frozen episode, rechecking its public window at a forward cutoff.
 * Expiry removes only that episode; a normal complete PBS sync chooses the next latest. */
export function resolvePublishedHomeNewscast(value: unknown, cutoffAt: string): HomeNewscastSource {
  const source = readPublishedHomeNewscast(value), cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || cutoff < homeSourceInstant(source.cutoffAt)!) refuse();
  const end = source.episode?.publicWindow.endsAt;
  return { ...source, cutoffAt, ...(end && homeSourceInstant(end)! <= cutoff
    ? { episode: null, emptyReason: "withdrawn" as const } : {}) };
}

export type HomeNewscastPacket = Omit<HomeNewscastSource, "cutoffAt">;
const packetKeys = ["source", "showId", "showTitle", "programHref", "pastNewscastsHref", "liveHref", "checkedAt", "episode", "emptyReason"];
/** The provider transport has one observation clock. A redundant changing
 * cutoff would turn every unchanged PBS check into a semantic content change. */
export function readHomeNewscastPacket(value: unknown): HomeNewscastPacket {
  if (!closed(value, packetKeys)) refuse();
  const { cutoffAt: _cutoff, ...packet } = readPublishedHomeNewscast({ ...value,
    // With no observed episode, this clock is used only to validate the fixed
    // error envelope; it never leaves this reader or becomes a source receipt.
    cutoffAt: value.checkedAt === null ? "1970-01-01T00:00:00Z" : value.checkedAt });
  return packet;
}
export function createHomeNewscastPacket(source: HomeNewscastSource): HomeNewscastPacket {
  const { cutoffAt: _cutoff, ...packet } = readPublishedHomeNewscast(source);
  return readHomeNewscastPacket(packet);
}
export function resolveHomeNewscastPacket(value: unknown, cutoffAt: string): HomeNewscastSource {
  const packet = readHomeNewscastPacket(value);
  return resolvePublishedHomeNewscast({ ...packet, cutoffAt: packet.checkedAt ?? cutoffAt }, cutoffAt);
}
