import { cmsImageSourceAttributes } from "./cms-image-variants.ts";
import { contentLink } from "./content-link.ts";
import { resolveCoverageLabel, type CoverageLabelsBuildData } from "./coverage-labels.ts";
// Shared static Home opening. Callers supply already admitted, resolved public
// cards (or the exact saved preview context); this layer never selects or fetches.
import { escapeHtml } from "./content-model";
import { formatEditorialDate } from "./editorial-date-format";
import { homeHeroHref, type HomeHeroCard, type HomeHeroConfig } from "./home-hero";
import { homeLinkAttributes } from "./home-section-render";
import { renderPostBranding } from "./post-branding.ts";
import { spotlightFallbackImage, spotlightImageAttributes } from "./spotlight-image.mjs";

export type HomeEditorialHeroOptions = Pick<HomeHeroConfig,
  "supportingCount" | "leadHeading" | "supportingHeading" | "overflowHeading"> & {
  coverageLabels?: CoverageLabelsBuildData;
  fallbackImage?: HomeHeroCard["image"];
  fallbackPosition?: "center" | "top" | "bottom";
};

const DEFAULT_IMAGE: NonNullable<HomeHeroCard["image"]> & { width: number; height: number } = {
  url: "/brand/home/new-jersey-blue.webp", width: 1774, height: 887,
};
const externalNotice = '<span class="sr-only"> (opens in new tab)</span>';

function external(href: string): boolean {
  return /^https?:\/\//.test(href) && new URL(href).hostname !== "njpbs.org";
}

function heading(value: string | undefined, fallback: string): string {
  return escapeHtml(value?.trim() || fallback);
}

function dimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function headline(card: HomeHeroCard, supporting = false, coverageLabels?: CoverageLabelsBuildData): string {
  const outside = card.contentLinkMode === "custom" ? contentLink(card, card.href).newTab : external(card.href);
  const date = formatEditorialDate(card.displayDate);
  const image = supporting && card.image && homeHeroHref(card.image.url) && !spotlightFallbackImage(card.image.url) ? card.image : undefined;
  return `<li><a class="home-editorial__headline${image ? " home-editorial__headline--image" : ""}"${homeLinkAttributes(card.href, outside, contentLink(card, card.href).rel)}>
    ${image ? `<span class="home-editorial__headline-media" aria-hidden="true"><img src="${escapeHtml(image.url)}"${cmsImageSourceAttributes(image, "(max-width: 1023px) calc(100vw - 48px), 30vw")} alt="" width="${dimension(image.width, 640)}" height="${dimension(image.height, 360)}" loading="lazy" decoding="async" fetchpriority="low" draggable="false" data-home-story-image /></span>` : ""}
    ${renderPostBranding(card.spotlightNews, "card", resolveCoverageLabel(card.coverageLabelId, coverageLabels), false)}
    ${date ? `<time class="home-editorial__date" datetime="${escapeHtml(card.displayDate!)}">${escapeHtml(date)}</time>` : ""}
    <h3>${escapeHtml(card.title)}</h3>
    ${card.byline ? `<span class="home-editorial__byline">By ${escapeHtml(card.byline)}</span>` : ""}
    <span class="home-editorial__action">${escapeHtml(card.actionLabel?.trim() || "Read the story")} <span aria-hidden="true">→</span></span>${outside ? externalNotice : ""}
  </a></li>`;
}

/** All resolved selections stay visible: lead, bounded supports, then overflow. */
export function renderHomeEditorialHero(
  items: readonly HomeHeroCard[],
  options: HomeEditorialHeroOptions = {},
): string {
  const cards = items.filter(card => card.title.trim() && homeHeroHref(card.href));
  const lead = cards[0];
  if (!lead) return "";
  const count = [1, 2, 3].includes(options.supportingCount ?? 3) ? options.supportingCount ?? 3 : 3;
  const supports = cards.slice(1, count + 1);
  const overflow = cards.slice(count + 1);
  const fallback = options.fallbackImage && homeHeroHref(options.fallbackImage.url)
    ? options.fallbackImage : DEFAULT_IMAGE;
  const hasImage = Boolean(lead.image && homeHeroHref(lead.image.url));
  const image = hasImage ? lead.image! : fallback;
  const configuredPosition = ["center", "top", "bottom"].includes(options.fallbackPosition ?? "center")
    ? options.fallbackPosition ?? "center" : "center";
  const fallbackPosition = options.fallbackImage && fallback === options.fallbackImage
    ? configuredPosition : "right";
  const position = hasImage ? "center" : fallbackPosition;
  const date = formatEditorialDate(lead.displayDate);
  const outside = lead.contentLinkMode === "custom" ? contentLink(lead, lead.href).newTab : external(lead.href);
  return `<section class="home-editorial${supports.length ? "" : " home-editorial--solo"}" aria-labelledby="hero-h" data-home-hero data-home-hero-presentation="editorial">
    <div class="home-editorial__opening">
      ${supports.length ? `<p class="home-editorial__label">${heading(options.leadHeading, "Top story")}</p>` : ""}
      <article class="home-editorial__lead">
        <a class="home-editorial__lead-link"${homeLinkAttributes(lead.href, outside, contentLink(lead, lead.href).rel)}>
          <span class="home-editorial__media"><img src="${escapeHtml(image.url)}"${cmsImageSourceAttributes(image, "(max-width: 1023px) calc(100vw - 48px), 65vw")} alt="${escapeHtml(hasImage ? image.alt ?? "" : "")}" width="${dimension(image.width, DEFAULT_IMAGE.width)}" height="${dimension(image.height, DEFAULT_IMAGE.height)}" loading="eager" fetchpriority="high" decoding="async" draggable="false" data-home-hero-image data-fallback-src="${escapeHtml(image.fallbackUrl ?? fallback.url)}" data-fallback-position="${fallbackPosition}"${spotlightImageAttributes(image.url, image.fallbackUrl)} style="object-position: ${position};" /></span>
          <div class="home-editorial__copy">
            ${renderPostBranding(lead.spotlightNews, "headline", resolveCoverageLabel(lead.coverageLabelId, options.coverageLabels), false)}
            ${date ? `<time class="home-editorial__date" datetime="${escapeHtml(lead.displayDate!)}">${escapeHtml(date)}</time>` : ""}
            <h1 id="hero-h">${escapeHtml(lead.title)}</h1>
            ${lead.byline ? `<p class="home-editorial__byline">By ${escapeHtml(lead.byline)}</p>` : ""}
            ${lead.summary ? `<p class="home-editorial__summary">${escapeHtml(lead.summary)}</p>` : ""}
            <span class="home-editorial__action">${escapeHtml(lead.actionLabel?.trim() || "Read the story")} <span aria-hidden="true">→</span></span>${outside ? externalNotice : ""}
          </div>
        </a>
      </article>
      ${supports.length ? `<aside class="home-editorial__support" aria-labelledby="home-supporting-heading">
        <h2 id="home-supporting-heading">${heading(options.supportingHeading, "Latest stories")}</h2>
        <ul class="home-editorial__headlines" role="list">${supports.map(card => headline(card, true, options.coverageLabels)).join("")}</ul>
      </aside>` : ""}
    </div>
    ${overflow.length ? `<div class="home-editorial__overflow" aria-labelledby="home-overflow-heading">
      <h2 id="home-overflow-heading">${heading(options.overflowHeading, "More stories")}</h2>
      <ul class="home-editorial__headlines home-editorial__headlines--overflow" role="list">${overflow.map(card => headline(card, false, options.coverageLabels)).join("")}</ul>
    </div>` : ""}
  </section>`;
}
