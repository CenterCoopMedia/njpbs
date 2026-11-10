// Pure Home rail markup for the public page and the editor. Feed selection and
// publication identity belong to the caller, not to the rendering layer.
import { escapeHtml, type ContentShelfData } from "./content-model";
import { renderShelfFullText } from "./shelf-full-text";
import { homeLinkAttributes } from "./home-section-render";
import { spotlightStoryImage, spotlightImageAttributes } from "./spotlight-image.mjs";
import { homeSourceImage } from "./home-source-curation.ts";

export interface HomeProgramRailCard {
  title: string;
  description: string;
  href: string;
  image?: string;
  external?: boolean;
  index: number;
}

export interface HomeNewsCard {
  title: string;
  href: string;
  category: string;
  dateLabel?: string;
  image: string;
  fallbackImage?: string;
}

export interface HomeProgramCard {
  title: string;
  description: string;
  href: string;
  image?: string;
}

export interface HomeSourceSnapshot {
  editorial?: import("./home-source-catalog").HomeEditorialSourceReceipt;
  heroCatalog?: import("./home-hero").HomeHeroCatalogItem[];
  schemaVersion: 1;
  publication: { buildBatchId: string; generation: number; commitSha: string } | null;
  pbs: {
    newscast?: import("./home-newscast-published.ts").HomeNewscastPacket;
    source: "media-manager" | "manual";
    checkedAt: string | null;
    featured: HomeProgramCard[];
    more: HomeProgramCard[];
  };
  spotlight: {
    source: "spotlight-rss";
    checkedAt: string | null;
    cards: HomeNewsCard[];
  };
}

const externalNotice = '<span class="sr-only"> (opens in new tab)</span>';
export { externalNotice as homeExternalLinkNotice };

type HomeShelfSettings = Pick<ContentShelfData, "title" | "moreLabel" | "presentation" | "columns">;

function gridColumns(value: ContentShelfData["columns"]): 2 | 3 | 4 {
  return value === 2 || value === 4 ? value : 3;
}

function programGridCard(card: HomeProgramRailCard): string {
  const image = homeSourceImage({ url: card.image, alt: "" })?.url;
  const index = Number.isSafeInteger(card.index) ? ((card.index % 8) + 8) % 8 : 0;
  const artwork = image
    ? `<span class="home-shelf__media" aria-hidden="true"><img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="640" height="360" draggable="false" /></span>`
    : `<span class="home-shelf__media" aria-hidden="true" style="background:var(--tile-gradient-${index})"></span>`;
  return `<li><a class="home-shelf__card" draggable="false"${homeLinkAttributes(card.href, card.external)}>${artwork}<span class="home-shelf__title">${escapeHtml(card.title)}</span>${card.external ? externalNotice : ""}</a></li>`;
}

function gridSection(
  id: string,
  headingId: string,
  title: string,
  moreLabel: string,
  moreHref: string,
  external: boolean,
  cards: string,
  columns: ContentShelfData["columns"],
): string {
  return `<section class="home-shelf home-shelf--grid home-shelf--columns-${gridColumns(columns)}" aria-labelledby="${headingId}">
    <div class="rail__head home-shelf__head"><h2 id="${headingId}">${escapeHtml(title)}</h2><a${homeLinkAttributes(moreHref, external)}>${escapeHtml(moreLabel)}${external ? externalNotice : ""}</a></div>
    <ul class="home-shelf__grid" id="${id}" role="list">${cards}</ul>
  </section>`;
}

// Independent straight-edged chevrons, mirrored within a fixed 208 by 396 box.
// Each arm has a 60-unit horizontal thickness.
const PATHS = {
  prev: "M148 0H208L60 198L208 396H148L0 198Z",
  next: "M0 0H60L208 198L60 396H0L148 198Z",
} as const;

export function renderRailArrowIcon(direction: "prev" | "next"): string {
  return `<svg viewBox="0 0 208 396" focusable="false"><path d="${PATHS[direction]}"></path></svg>`;
}

export function renderHomeRailArrow(direction: "prev" | "next", id: string, label: string): string {
  const side = direction === "prev" ? "left" : "right";
  return `<button class="rail__arrow rail__arrow--${direction}" type="button" data-rail-${direction}="${escapeHtml(id)}" aria-label="Scroll ${escapeHtml(label)} ${side}"><span aria-hidden="true">${renderRailArrowIcon(direction)}</span></button>`;
}

function programCard(card: HomeProgramRailCard): string {
  const image = homeSourceImage({ url: card.image, alt: "" })?.url;
  // Only a bounded integer enters CSS; the eight existing brand tiles remain
  // the fallback when the selected card has no artwork.
  const index = Number.isSafeInteger(card.index) ? ((card.index % 8) + 8) % 8 : 0;
  const title = escapeHtml(card.title);
  const artwork = image
    ? `<img class="card__image" src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="640" height="360" draggable="false" /><span class="card__title card__title--below">${title}</span>`
    : `<span class="card__art" style="background:var(--tile-gradient-${index})"><span class="card__title">${title}</span></span>`;
  // Native dragging cancels card clicks on a small pointer slip. Keep both the
  // anchor and image non-draggable while the rail itself scrolls normally.
  return `<a class="card" draggable="false"${homeLinkAttributes(card.href, card.external)}>${artwork}<span class="card__meta">${escapeHtml(card.description)}</span>${card.external ? externalNotice : ""}</a>`;
}

export function renderHomeProgramRail(
  kind: "featured" | "more",
  cards: readonly HomeProgramRailCard[],
  watchHref: string,
  external = true,
  settings?: HomeShelfSettings,
): string {
  const featured = kind === "featured";
  const headingId = featured ? "feat-h" : "recent-h";
  if (settings?.presentation === "grid") {
    return gridSection(`${kind}-rail`, headingId, settings.title, settings.moreLabel,
      watchHref, external, cards.map(programGridCard).join(""), settings.columns);
  }
  const heading = settings ? escapeHtml(settings.title) : featured ? "Featured on NJ PBS" : "More to watch";
  const moreLabel = escapeHtml(settings?.moreLabel ?? "Browse all");
  const id = `${kind}-rail`;
  const groupLabel = featured ? "Featured programs" : "Recently added";
  const link = homeLinkAttributes(watchHref, external);
  const notice = external ? externalNotice : "";
  return `<section class="rail" aria-labelledby="${headingId}">
    <div class="rail__head"><h2 id="${headingId}">${heading}</h2><a${link}>${moreLabel}${notice}</a></div>
    <div class="rail__frame">
      ${renderHomeRailArrow("prev", id, `${kind} programs`)}
      <div class="rail__track${featured ? " rail__track--lg" : ""}" id="${id}" role="group" aria-label="${groupLabel}" tabindex="0">
        ${cards.map(programCard).join("")}
        <a class="card card--cta" draggable="false"${link}><span class="card__cta-art" aria-hidden="true"></span><span class="card__title card__title--below">${moreLabel}</span>${notice}</a>
      </div>
      ${renderHomeRailArrow("next", id, `${kind} programs`)}
    </div>
    ${renderShelfFullText(settings?.title ?? (featured ? "Featured on NJ PBS" : "More to watch"), cards)}
  </section>`;
}

function newsCard(card: HomeNewsCard): string {
  const image = spotlightStoryImage(card);
  return `<a class="spotlight-card" draggable="false"${homeLinkAttributes(card.href, true)}>
    <span class="spotlight-card__media" aria-hidden="true"><img class="spotlight-card__image" src="${escapeHtml(image.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="640" height="360" draggable="false"${spotlightImageAttributes(image.url, image.fallbackUrl)} /></span>
    <span class="spotlight-card__kicker">${escapeHtml(card.category)}</span>
    <span class="spotlight-card__title">${escapeHtml(card.title)}</span>
    <span class="spotlight-card__meta">${escapeHtml(card.dateLabel ?? "Latest coverage")}</span>${externalNotice}
  </a>`;
}

export function renderHomeNewsRail(cards: readonly HomeNewsCard[], settings?: HomeShelfSettings): string {
  if (settings?.presentation === "grid") {
    const items = cards.map(card => {
      const image = spotlightStoryImage(card);
      const artwork = `<span class="home-shelf__media" aria-hidden="true"><img src="${escapeHtml(image.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="640" height="360" draggable="false"${spotlightImageAttributes(image.url, image.fallbackUrl)} /></span>`;
      return `<li><a class="home-shelf__card" draggable="false"${homeLinkAttributes(card.href, true)}>${artwork}<span class="home-shelf__meta">${escapeHtml(card.category)}</span><span class="home-shelf__title">${escapeHtml(card.title)}</span>${card.dateLabel ? `<span class="home-shelf__meta">${escapeHtml(card.dateLabel)}</span>` : ""}${externalNotice}</a></li>`;
    }).join("");
    return gridSection("spotlight-rail", "spot-h", settings.title, settings.moreLabel,
      "https://www.njspotlightnews.org/", true, items, settings.columns);
  }
  // Headlines still leave the NJ PBS site. This is not a local news archive.
  const link = homeLinkAttributes("https://www.njspotlightnews.org/", true);
  const title = escapeHtml(settings?.title ?? "NJ Spotlight News");
  const moreLabel = escapeHtml(settings?.moreLabel ?? "More news");
  return `<section class="spotlight rail" aria-labelledby="spot-h">
    <div class="rail__head"><h2 id="spot-h">${title}</h2><a${link}>${moreLabel}${externalNotice}</a></div>
    <div class="rail__frame">
      ${renderHomeRailArrow("prev", "spotlight-rail", "NJ Spotlight News")}
      <div class="rail__track spotlight__track" id="spotlight-rail" role="group" aria-label="NJ Spotlight News headlines" tabindex="0">
        ${cards.map(newsCard).join("")}
        <a class="spotlight-card spotlight-card--cta" draggable="false"${link}><span class="spotlight-card__media spotlight-card__media--cta" aria-hidden="true"></span><span class="spotlight-card__kicker">NJ Spotlight News</span><span class="spotlight-card__title">${moreLabel}</span><span class="spotlight-card__meta">Open the full site</span>${externalNotice}</a>
      </div>
      ${renderHomeRailArrow("next", "spotlight-rail", "NJ Spotlight News")}
    </div>
    ${renderShelfFullText(settings?.title ?? "NJ Spotlight News", cards.map(card => ({ ...card, external: true, metadata: [card.category, card.dateLabel ?? "Latest coverage"].filter(Boolean).join(" · ") })))}
  </section>`;
}
