import { contentLink } from "./content-link.ts";
import { cmsImageSourceAttributes } from "./cms-image-variants.ts";
import { renderPostBranding } from "./post-branding.ts";
import { resolveCoverageLabel, type CoverageLabelsBuildData } from "./coverage-labels.ts";
import { CONTENT_SHELF_PRESENTATIONS, escapeHtml, type ContentShelfBlock } from "./content-model.ts";
import { homeLinkAttributes } from "./home-section-render.ts";
import { renderShelfFullText } from "./shelf-full-text";
import { resolveHomeShelf, type HomeEditorialCatalog } from "./home-source-catalog.ts";
import { homeExternalLinkNotice, renderHomeRailArrow } from "./home-rail-render.ts";
import { spotlightImageAttributes } from "./spotlight-image.mjs";
import { formatEditorialDate } from "./editorial-date-format";
import { spotlightCardByline } from "./spotlight-byline.mjs";

/** Render only currently published selected IDs. Missing IDs remain a staff warning, never filler cards. */
export function renderHomeCuratedShelf(block: ContentShelfBlock, catalog: HomeEditorialCatalog, coverageLabels?: CoverageLabelsBuildData): string {
  const resolved = resolveHomeShelf(block, catalog);
  if (!block.visible || resolved.cards.length === 0) return "";
  const columns = block.data.columns ?? 3;
  const identities = { "home-featured": ["feat-h", "featured-rail"], "home-more": ["recent-h", "more-rail"],
    "home-spotlight": ["spot-h", "spotlight-rail"], "home-posts": [`home-${block.id}-heading`, `home-${block.id}-rail`] };
  const [headingId, trackId] = identities[resolved.section];
  const requested = block.data.presentation ?? "rail";
  const presentation = CONTENT_SHELF_PRESENTATIONS.includes(requested) ? requested : "rail";
  const rail = presentation === "rail";
  const textList = presentation === "list";
  const textItems = resolved.cards.map(card => ({
    title: card.title, href: card.href, rel: contentLink(card, card.href).rel, external: contentLink(card, card.href).external ? contentLink(card, card.href).newTab : !card.href.startsWith("/"), description: card.summary,
    metadata: [resolveCoverageLabel(card.coverageLabelId, coverageLabels)?.name, card.sourceLabel, card.opinion ? "Opinion" : undefined,
      card.source === "spotlight_news" ? spotlightCardByline(card) : card.byline,
      formatEditorialDate(card.displayDate)].filter(Boolean).join(" · "),
  }));
  const items = resolved.cards.map(card => {
    const metadata = [card.sourceLabel, card.opinion ? "Opinion" : undefined,
      card.source === "spotlight_news" ? spotlightCardByline(card) : card.byline,
      formatEditorialDate(card.displayDate)].filter(Boolean).join(" · ");
    return `<li data-home-card-id="${escapeHtml(card.id)}"><a class="home-shelf__card" draggable="false"${homeLinkAttributes(contentLink(card, card.href).href, contentLink(card, card.href).external ? contentLink(card, card.href).newTab : !card.href.startsWith("/"), contentLink(card, card.href).rel)}>
      ${!textList && card.image ? `<span class="home-shelf__media"><img src="${escapeHtml(card.image.url)}"${cmsImageSourceAttributes(card.image, rail ? "(max-width: 480px) 75vw, 320px" : `(max-width: 1023px) 50vw, ${Math.ceil(100 / columns)}vw`)} alt="${escapeHtml(card.image.alt)}" width="640" height="360" loading="lazy" draggable="false"${card.source === "spotlight_news" ? spotlightImageAttributes(card.image.url, card.image.fallbackUrl) : ""} /></span>` : ""}
      ${renderPostBranding(false, "card", resolveCoverageLabel(card.coverageLabelId, coverageLabels), false)}
      <span class="home-shelf__title">${escapeHtml(card.title)}</span>
      ${card.summary ? `<span class="home-curated__summary">${escapeHtml(card.summary)}</span>` : ""}
      ${metadata.length ? `<span class="home-curated__metadata">${escapeHtml(metadata)}</span>` : ""}
      ${(contentLink(card, card.href).external ? !contentLink(card, card.href).newTab : card.href.startsWith("/")) ? "" : homeExternalLinkNotice}
    </a></li>`;
  }).join("");
  const listClass = rail ? "rail__track home-curated__rail" : presentation === "grid" ? "home-shelf__grid" : `home-curated__${presentation}`;
  const list = `<ul id="${escapeHtml(trackId)}" class="${listClass}" role="list"${rail ? ` tabindex="0" aria-label="${escapeHtml(block.data.title)} cards"` : ""}>${items}</ul>`;
  return `<section class="home-shelf home-curated home-shelf--${escapeHtml(presentation)} home-shelf--columns-${columns}" data-home-section="${escapeHtml(resolved.section)}" aria-labelledby="${escapeHtml(headingId)}">
    <div class="rail__head home-shelf__head"><h2 id="${escapeHtml(headingId)}">${escapeHtml(block.data.title)}</h2><a${homeLinkAttributes(resolved.browseHref, !resolved.browseHref.startsWith("/"))}>${escapeHtml(block.data.moreLabel)}${resolved.browseHref.startsWith("/") ? "" : homeExternalLinkNotice}</a></div>
    ${rail ? `<div class="rail__frame">${renderHomeRailArrow("prev", trackId, block.data.title)}${list}${renderHomeRailArrow("next", trackId, block.data.title)}</div>` : list}
    ${presentation === "list" ? renderShelfFullText(block.data.title, textItems) : ""}
  </section>`;
}
