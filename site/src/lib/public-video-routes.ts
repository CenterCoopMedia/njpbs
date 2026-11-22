import type { PublicVideo } from "./public-video-catalog";
import { videoCatalogPath } from "../../../packages/content-core/src/video-catalog-path";
export { videoCatalogPath } from "../../../packages/content-core/src/video-catalog-path";

export function videoProgramPath(slug: string): string {
  return `${videoCatalogPath}${slug}/`;
}

export function videoEpisodePath(program: string, episode: string): string {
  return `${videoProgramPath(program)}${episode}/`;
}

export function videoSeason({ kind, seasonTitle, seasonNumber }: PublicVideo): string | null {
  if (kind === "special") return null;
  if (seasonNumber === null) return seasonTitle;
  return seasonTitle && seasonTitle.toLowerCase() !== `season ${seasonNumber}`
    ? `Season ${seasonNumber} — ${seasonTitle}` : `Season ${seasonNumber}`;
}

export function videoGroups(episodes: PublicVideo[]) {
  const groups = new Map<string, { label: string; order: number; episodes: PublicVideo[] }>();
  for (const episode of episodes) {
    const label = episode.kind === "special" ? "Specials" : videoSeason(episode) ?? "Episodes";
    const key = JSON.stringify([episode.kind, episode.seasonNumber, label]);
    const order = episode.kind === "special" ? -1 : episode.seasonNumber ?? 0;
    const group = groups.get(key) ?? { label, order, episodes: [] };
    group.episodes.push(episode);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.order - a.order || a.label.localeCompare(b.label, "en")).map(group => ({
    label: group.label,
    episodes: group.episodes.sort((a, b) => (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0) ||
      (b.premieredOn ?? "").localeCompare(a.premieredOn ?? "", "en") || a.title.localeCompare(b.title, "en")),
  }));
}
