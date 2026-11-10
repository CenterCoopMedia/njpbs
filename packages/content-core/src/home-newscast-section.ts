import { escapeHtml, parseBlocks, type HomeNewscastBlock } from "./content-model.ts";
import { HOME_NEWSCAST_PROGRAM_HREF, newscastTitleDate } from "./home-newscast-source.ts";
import type { HomeEditorialCatalog } from "./home-source-catalog.ts";
import { resolvePublishedHomeNewscast } from "./home-newscast-published.ts";
import { homeSourceImage } from "./home-source-curation.ts";
import { formatEditorialDate } from "./editorial-date-format.ts";

import { HOME_NEWSCAST_DEFAULTS, isHomeNewscastData } from "./home-newscast-data.ts";
export { HOME_NEWSCAST_DEFAULTS, isHomeNewscastData, type HomeNewscastData } from "./home-newscast-data.ts";

export function createHomeNewscastBlock(id: string): HomeNewscastBlock {
  return { id, type: "home_newscast", section: "home-newscast", order: 0, visible: true, data: { ...HOME_NEWSCAST_DEFAULTS } };
}
/** Keep editor copy intact unless its known date suffix repeats the admitted episode day. */
export function homeNewscastTitle(title: string, episodeDate: string | null): string {
  return episodeDate !== null && newscastTitleDate(title) === episodeDate ? title.slice(0, title.lastIndexOf(" | ")) : title;
}
function posterSources(url: string, layout: "feature" | "compact"): string {
  // Keep the retained URL's strict admission; only these fixed public transforms are added.
  if (!homeSourceImage({ url, alt: "" }) || new URL(url).origin !== "https://image.pbs.org") {
    throw new Error("Invalid Home newscast poster.");
  }
  const resized = (width: number) => {
    const image = new URL(url);
    image.search = `?format=webp&resize=${width}x${width * 9 / 16}`;
    return escapeHtml(image.href);
  };
  // Match .wrap gutters, the feature's 3:2 grid/gap and the compact card border.
  const sizes = layout === "compact"
    ? "min(36rem, 100vw - clamp(2rem, 6vw, 3rem) - 2px)"
    : "(max-width: 760px) calc(100vw - clamp(2rem, 6vw, 3rem)), calc((min(100vw - 3rem, 84rem) - 1.5rem) * 0.6)";
  return `src="${resized(800)}" srcset="${[400, 800, 1200].map(width => `${resized(width)} ${width}w`).join(", ")}" sizes="${sizes}"`;
}
/** Shared public/component preview markup; destinations and episode fields are source-owned. */
export function renderHomeNewscast(block: HomeNewscastBlock, catalog?: HomeEditorialCatalog,
  { complete = true }: { complete?: boolean } = {}): string {
  if (!parseBlocks([block], { complete: false }).ok || block.section !== "home-newscast" ||
      !isHomeNewscastData(block.data, complete && block.visible)) throw new Error("Invalid Home newscast section.");
  if (!block.visible || !isHomeNewscastData(block.data, true)) return "";
  const data = block.data, source = catalog?.services?.newscast
    ? resolvePublishedHomeNewscast(catalog.services.newscast, catalog.cutoffAt) : undefined, episode = source?.episode;
  const headingId = `${block.id}-heading`, id = escapeHtml(headingId);
  const unavailable = source?.emptyReason === "withdrawn" ? "This newscast is no longer available."
    : !source || source.emptyReason === "source_error" ? "The latest newscast is temporarily unavailable."
    : "No newscast is available yet.";
  const actions = `<div class="home-newscast__actions"><a href="${HOME_NEWSCAST_PROGRAM_HREF}">${escapeHtml(data.pastLabel)}</a><a href="/live/">${escapeHtml(data.liveLabel)}</a></div>`;
  const playback = episode?.playerSrc ? ` data-home-newscast-play data-player-src="${escapeHtml(episode.playerSrc)}" data-episode-title="${escapeHtml(episode.title)}"` : "";
  return `<section class="home-newscast wrap home-newscast--${data.layout}" data-home-section="home-newscast"${episode?.playerSrc ? " data-home-newscast-player" : ""} aria-labelledby="${id}">
    <h2 id="${id}">${escapeHtml(data.heading)}</h2>
    ${data.summary.trim() ? `<p class="home-newscast__summary">${escapeHtml(data.summary)}</p>` : ""}
    ${episode ? `<div class="home-newscast__episode">
      <a class="home-newscast__poster-link" href="${escapeHtml(episode.href)}" aria-label="Play ${escapeHtml(episode.title)}"${playback}>
        <span class="home-newscast__media"><img class="home-newscast__poster" ${posterSources(episode.poster.url, data.layout)} alt="" width="1280" height="720" loading="lazy" decoding="async" />
          <span class="home-newscast__play btn btn--primary" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d="m8 5 11 7-11 7Z" /></svg></span>
        </span>
      </a>
      <div class="home-newscast__copy">
        <h3 class="home-newscast__title">${escapeHtml(homeNewscastTitle(episode.title, episode.episodeDate))}</h3>
        ${episode.episodeDate ? `<time class="home-newscast__date" datetime="${escapeHtml(episode.episodeDate)}">${escapeHtml(formatEditorialDate(episode.episodeDate)!)}</time>` : ""}
        ${episode.summary ? `<p class="home-newscast__description">${escapeHtml(episode.summary)}</p>` : ""}
        <a class="btn btn--primary" href="${escapeHtml(episode.href)}" data-home-newscast-watch${playback}>${escapeHtml(data.watchLabel)}</a>
        ${actions}
        <a class="home-newscast__fallback" href="${escapeHtml(episode.href)}" data-home-newscast-fallback hidden>Open episode page</a>
      </div></div>`
      : `<p class="home-newscast__empty" role="status">${unavailable}</p>${actions}`}
  </section>`;
}
