import { renderTownLookup } from "./town-lookup-render.ts";
import { lazyImageLoading, type ImageLoadingPlacement, type PageImageLoading } from "./image-loading";
import { DATA_HUB_SECTIONS, type DataHubSectionData } from "./data-hub-composition.ts";
import { renderDataFigure } from "./data-figure-render.ts";
import { renderCountyComparison } from "./county-comparison-render.ts";
import { renderElectionResults } from "./election-results-render.ts";
import type { DataFigureData, DatasetPublicProjection } from "./data-figure.ts";
import { renderCoverageList, renderLinkCard } from "./coverage-list";
import { renderDataTable } from "./data-table-render";
import { renderBioCard } from "./bio-render.ts";
import { renderVideoBlock } from "./video-block.ts";
import { renderRailArrowIcon } from "./home-rail-render";
// The shared block renderer: a validated `PageBlock` -> its canonical rendered
// markup. This is the single source of truth for how a block looks, so the CMS
// editor's inline (WYSIWYG) surface and the public page render agree by sharing one
// renderer instead of each hand-rolling its own (the editor<->site parity gap).
//
// Like content-model.ts, this module is dependency-free pure logic: block data in,
// escaped static HTML out. It has no editing concern -- the editor layers editing
// affordances on top of this markup; it never rewrites it. All text is escaped and
// all rich text goes through renderRichText (href allow-list, mark escaping), so a
// stored block cannot smuggle markup or a `javascript:` link into a page.
//
// It sits beside content-model.ts in packages/content-core, and the site and the
// admin both import this one file, so "they agree" is a property of the build
// rather than something a sync check has to keep true.
//
// All catalog types have a canonical render. The switch has no `default`, so adding a
// tenth block type to the union makes this function fall through to an undefined return
// and fails to compile until the new type is handled here.

import {
  AP_MAP_HEIGHTS,
  AP_MAP_MOBILE_HEIGHT_LIMITS,
  EMBED_ASPECT_RATIO_LIMITS,
  EMBED_HEIGHT_LIMITS,
  EMBED_WIDTH_LIMITS,
  escapeHtml,
  galleryPresentation,
  isRichTextDoc,
  renderRichText,
  richTextRendersEmpty,
  safeHref,
} from "./content-model";
import type {
  EmbedData,
  ImageBlockData,
  ImageData,
  PageBlock,
  PromotionPlaylistBlock,
  RichTextNode,
  TopicShelfData,
  VideoPlaylistData,
} from "./content-model";
import {
  formatShelfDuration,
  resolveTopicShelf,
  resolveVideoPlaylist,
  type ResolvedShelf,
} from "./dynamic-shelf-resolve";
import type {
  ShelfSnapshot,
  StoryShelfItem,
  VideoShelfItem,
} from "./dynamic-shelves";
import { APPROVED_VIDEO_LIBRARY, RELATED_STORY_INDEX } from "./shelf-catalog";
import type { NewsletterCardData } from "./newsletter-card-data";

// The heading-rank helpers live in heading-outline.ts, a leaf the admin's editor state can
// import without pulling in this renderer (and, through it, the shelf resolver and the
// committed catalogs). Re-exported here because this is where the site and the editor have
// always reached for them.
export { clampHeadingLevel, generatedHeadingLevelAt } from "./heading-outline";

import { clampHeadingLevel } from "./heading-outline";
import { HTML_FRAME_HEIGHT_MESSAGE, HTML_FRAME_MEASURE_MESSAGE } from "./html-frame-controls";
import { apResultsLayoutSrc, embedPlayer, xVideoLink } from "./embed-player.ts";
export { embedPlayer, xVideoLink, youtubePlayerSrc } from "./embed-player.ts";

// Reports the frame document's content height to the page that installed
// html-frame-controls. A change that only mirrors the frame's own viewport change is
// viewport-unit content following the frame, so it is not reported; reporting it
// would grow the frame in a loop.
const HTML_FRAME_RESIZE_SCRIPT = `<script>(function(){var lastHeight=0,lastViewport=innerHeight;function post(force){var height=Math.ceil(document.documentElement.getBoundingClientRect().height),viewport=innerHeight,mirrored=lastHeight>0&&viewport!==lastViewport&&height-lastHeight===viewport-lastViewport;lastHeight=height;lastViewport=viewport;if(force===true||!mirrored)parent.postMessage({${HTML_FRAME_HEIGHT_MESSAGE}:height},"*")}addEventListener("message",function(event){if(event.source===parent&&event.data?.${HTML_FRAME_MEASURE_MESSAGE}===true)post(true)});if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post()})();</script>`;

/**
 * Custom HTML renders as the whole document of a sandboxed frame. Without
 * allow-same-origin the frame has an opaque origin, so its scripts cannot read or
 * change the page, its storage, or its cookies. Popups inherit the sandbox,
 * including its restriction on navigating the containing page.
 */
export function renderHtmlBlock(data: { html: string; title?: string }): string {
  const title = data.title?.trim() || "Embedded content";
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>html{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif}</style></head><body>${data.html}${HTML_FRAME_RESIZE_SCRIPT}</body></html>`;
  return `<div class="html-frame"><iframe class="html-frame__frame" data-html-frame title="${escapeHtml(title)}" sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escapeHtml(document)}" loading="lazy"></iframe></div>`;
}

interface EmbedPlayerDimensions {
  width: number;
  height: number;
  aspectRatio: string;
  maxWidth?: number;
}

function validEmbedDimension(
  value: unknown,
  limits: { readonly min: number; readonly max: number },
): value is number {
  return Number.isInteger(value)
    && Number(value) >= limits.min
    && Number(value) <= limits.max;
}

function validEmbedAspectRatio(width: number, height: number): boolean {
  const ratio = width / height;
  return ratio >= EMBED_ASPECT_RATIO_LIMITS.min
    && ratio <= EMBED_ASPECT_RATIO_LIMITS.max;
}

function iframeIntegerAttribute(attributes: string, name: "width" | "height"): number {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+)(?=\\s|$))`,
    "i",
  ).exec(attributes);
  return Number(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function pastedPlayerDimensions(value: string): { width: number; height: number } | null {
  const attributes = /<iframe\b([^>]*)>/i.exec(value)?.[1];
  if (!attributes) return null;
  const width = iframeIntegerAttribute(attributes, "width");
  const height = iframeIntegerAttribute(attributes, "height");
  return validEmbedDimension(width, EMBED_WIDTH_LIMITS)
    && validEmbedDimension(height, EMBED_HEIGHT_LIMITS)
    && validEmbedAspectRatio(width, height)
    ? { width, height }
    : null;
}

function embedPlayerDimensions(data: EmbedData, vertical: boolean): EmbedPlayerDimensions | null {
  const pasted = pastedPlayerDimensions(data.url);
  const manualWidth = validEmbedDimension(data.width, EMBED_WIDTH_LIMITS) ? data.width : undefined;
  const manualHeight = validEmbedDimension(data.height, EMBED_HEIGHT_LIMITS) ? data.height : undefined;
  if (manualWidth === undefined && manualHeight === undefined && pasted === null) {
    return vertical ? { width: 360, height: 640, aspectRatio: "9 / 16", maxWidth: 360 } : null;
  }

  const manualRatioIsValid = manualWidth !== undefined && manualHeight !== undefined
    && validEmbedAspectRatio(manualWidth, manualHeight);
  const effectiveHeight = manualWidth !== undefined && manualHeight !== undefined && !manualRatioIsValid
    ? undefined
    : manualHeight;
  const ratioWidth = manualRatioIsValid
    ? manualWidth
    : pasted?.width ?? (vertical ? 9 : 16);
  const ratioHeight = manualRatioIsValid
    ? manualHeight
    : pasted?.height ?? (vertical ? 16 : 9);
  const requestedWidth = manualWidth ?? (effectiveHeight === undefined
    ? ratioWidth
    : effectiveHeight * ratioWidth / ratioHeight);
  const requestedHeight = effectiveHeight ?? (manualWidth === undefined
    ? ratioHeight
    : manualWidth * ratioHeight / ratioWidth);
  const width = Math.round(requestedWidth);
  const height = Math.round(requestedHeight);
  return {
    width,
    height,
    aspectRatio: `${ratioWidth} / ${ratioHeight}`,
    ...(manualWidth !== undefined || manualHeight !== undefined ? { maxWidth: width } : {}),
  };
}

// The CSS class for a CTA button's variant. Exported so the editor's inline preview
// (InlineBlockSurface) shares this exact variant->class mapping instead of hand-rolling
// its own copy that could drift from the renderer. `secondary` is the only distinct
// variant; anything else, including an undefined variant, is the primary button.
export function ctaVariantClass(variant: "primary" | "secondary" | undefined): string {
  return variant === "secondary" ? "btn--ghost" : "btn--primary";
}

import { DOCUMENT_PUBLISHERS, newestNoticeDocuments, noticeAddedDate, isNoticeAddedAt } from "./document-list";

export interface ResolvedRenderAsset {
  credit?: string;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  srcset?: string;
  sizes?: string;
  sources?: readonly {
    type: string;
    srcset: string;
  }[];
}

export type RenderAssetPlacement = "content" | "grid";

export interface RenderBlockOptions {
  resolveDataHubSection?: (data: DataHubSectionData, headingLevel: number) => string;
  resolveDataFigure?: (blockId: string, data: DataFigureData) => DatasetPublicProjection | null;
  /** Current library credit is visible only on Post images. */
  showImageCredits?: boolean;
  /** Bio snapshots are article-only; generic page and feed consumers omit them. */
  allowBios?: boolean;
  sponsors?: readonly SponsorRenderData[];
  resolveNewsletter?: (id: string) => NewsletterCardData | null;
  resolveAsset?: (
    assetId: string,
    placement: RenderAssetPlacement,
  ) => ResolvedRenderAsset | null;
  /**
   * Rank for card titles and FAQ questions after the page assembler considers
   * preceding authored headings. Defaults to h2 for isolated block previews.
   */
  generatedHeadingLevel?: number;
  /** Optional id assignment for authored headings inside a prose block. */
  richTextHeadingId?: (text: string, level: number) => string | undefined;
  /** Preserve a page frame's rule that external rich-text links open in a new tab. */
  externalLinksNewTab?: boolean;
  /** Private draft previews: hold an unpublished video's space with a placeholder. */
  videoPlaceholder?: boolean;
  /** Lead media never requests autoplay, including in pasted PBS player URLs. */
  disableVideoAutoplay?: boolean;
  /**
   * The committed snapshots the dynamic blocks (#1046) query. They default to the
   * catalogs in shelf-catalog.ts, which is what makes the editor preview and the public
   * build resolve the same items without either side passing anything: the parity is in
   * the import graph. The overrides exist so tests can hold the renderer to a fixture
   * and so a future build step can hand in a freshly synced snapshot.
   */
  storyShelfSnapshot?: ShelfSnapshot<StoryShelfItem>;
  videoLibrarySnapshot?: ShelfSnapshot<VideoShelfItem>;
  /**
   * The instant the rights window and the staleness report are judged against. Defaults
   * to now. A build that wants byte-identical output across a day passes one.
   */
  shelfNow?: string;
}

export interface SponsorRenderData {
  sponsorId: string;
  name: string;
  href: string | null;
  logoUrl: string | null;
  logoAlt: string;
  logoDecorative: boolean;
}

/**
 * Render one resolved image descriptor. The descriptor can contain Astro's
 * build-local responsive outputs, but this pure renderer owns the final escaped
 * markup for both ordinary CMS blocks and fixed public-page frames.
 */
export function renderResolvedImage(
  assetId: string,
  alt: string,
  resolved: ResolvedRenderAsset,
  options: { className?: string; draggable?: boolean; imageLoading?: PageImageLoading; placement?: ImageLoadingPlacement } = {},
): string {
  const width =
    Number.isInteger(resolved.width) && (resolved.width ?? 0) > 0
      ? ` width="${resolved.width}"`
      : "";
  const height =
    Number.isInteger(resolved.height) && (resolved.height ?? 0) > 0
      ? ` height="${resolved.height}"`
      : "";
  const srcset = resolved.srcset?.trim()
    ? ` srcset="${escapeHtml(resolved.srcset)}"`
    : "";
  const sizes = resolved.sizes?.trim()
    ? ` sizes="${escapeHtml(resolved.sizes)}"`
    : "";
  const className = options.className?.trim()
    ? ` class="${escapeHtml(options.className)}"`
    : "";
  const loading = options.imageLoading?.(resolved, options.placement ?? "content") ?? lazyImageLoading;
  const priority = loading.fetchpriority === "high" ? ' fetchpriority="high"' : "";
  const image = `<img${className}${options.draggable === false ? ' draggable="false"' : ""} data-asset-id="${escapeHtml(assetId)}" src="${escapeHtml(resolved.url)}"${srcset}${sizes}${width}${height} loading="${loading.loading}"${priority} decoding="async" alt="${escapeHtml(alt)}">`;
  const sources = (resolved.sources ?? [])
    .filter(
      (source) =>
        source.type.trim() !== "" && source.srcset.trim() !== "",
    )
    .map(
      (source) =>
        `<source type="${escapeHtml(source.type)}" srcset="${escapeHtml(source.srcset)}"${sizes}>`,
    )
    .join("");
  return sources ? `<picture>${sources}${image}</picture>` : image;
}

function renderImageFigure(
  image: ImageData,
  options: RenderBlockOptions,
  placement: RenderAssetPlacement,
  link?: Pick<ImageBlockData, "href" | "newTab">,
): string {
  const resolved = options.resolveAsset?.(image.assetId, placement) ?? null;
  const imageMarkup = resolved
    ? renderResolvedImage(image.assetId, image.alt, resolved)
    : `<img data-asset-id="${escapeHtml(image.assetId)}" alt="${escapeHtml(image.alt)}">`;
  // A caption of spaces is not a caption: it renders an empty figcaption and reads as
  // nothing. Treated as absent here for the same reason the embed label below falls back
  // to its url, so one blank-text rule covers the file. Kept in the ternary rather than
  // behind a Boolean() so the narrowing survives and escapeHtml cannot be handed undefined.
  const captionText = image.caption && image.caption.trim() ? image.caption : "";
  const credit = options.showImageCredits && resolved?.credit?.trim() ? resolved.credit : "";
  const caption = captionText || credit
    ? `<figcaption>${escapeHtml(captionText)}${credit ? `<span class="cms-image-credit">${escapeHtml(credit)}</span>` : ""}</figcaption>`
    : "";
  // A decorative image carries no information, so an empty alt silences the img and hiding
  // the wrapper stops assistive tech announcing an unnamed figure around it. A caption is
  // the exception: it is text the reader is meant to get, so a captioned figure stays
  // exposed and only the image inside it goes quiet. Without the blank check above, spaces
  // left in the caption box would hold the figure open around nothing a reader can hear.
  const hidden = image.altDecorative === true && !captionText && !credit ? ' aria-hidden="true"' : "";
  const figure = `<figure${hidden}>${imageMarkup}${caption}</figure>`;
  // The link wraps the whole figure, so the alt text and caption both name it. A
  // decorative image has no name to give, so the parser refuses that pair and the
  // renderer drops a link that reaches it anyway.
  const href = link && image.altDecorative !== true ? safeHref(link.href) : null;
  if (href === null) return figure;
  const newTab = link?.newTab === true;
  const target = newTab ? ' target="_blank" rel="noopener"' : "";
  const notice = newTab ? '<span class="sr-only"> (opens in new tab)</span>' : "";
  return `<a class="image-link" href="${escapeHtml(href)}"${target}>${figure}${notice}</a>`;
}

const EXTERNAL_LINK_ATTRIBUTES = ' target="_blank" rel="noopener"';
const EXTERNAL_LINK_NOTICE = '<span class="sr-only"> (opens in new tab)</span>';

/** A page frame that opens external links in a new tab applies that to its buttons and cards too. */
function opensExternalInNewTab(href: string | null, options: RenderBlockOptions): boolean {
  return options.externalLinksNewTab === true && href !== null && /^https?:\/\//i.test(href);
}

/** One shelf presentation for Home, page bodies, Posts, and the editor. */
export function renderCustomShelf(block: PromotionPlaylistBlock, options: RenderBlockOptions = {}): string {
  if (!block.visible || block.data.cards.length === 0) return "";
  const headingLevel = clampHeadingLevel(options.generatedHeadingLevel ?? 2);
  const presentation = block.data.presentation === "grid" || block.data.presentation === "list"
    ? block.data.presentation : "rail";
  const columns = block.data.columns === 2 || block.data.columns === 4 ? block.data.columns : 3;
  const headingId = `shelf-heading-${encodeURIComponent(block.id)}`;
  const trackId = `shelf-track-${encodeURIComponent(block.id)}`;
  const title = escapeHtml(block.data.title);
  const cards = block.data.cards.map(card => {
    const asset = options.resolveAsset?.(card.imageAssetId, "grid");
    const image = asset ? renderResolvedImage(card.imageAssetId, card.altDecorative ? "" : card.alt, asset, { className: "custom-shelf__image", draggable: false }) : "";
    const content = `${image}<span class="custom-shelf__copy"><span class="custom-shelf__title">${escapeHtml(card.title)}</span><span class="custom-shelf__summary">${escapeHtml(card.summary)}</span></span>`;
    const href = safeHref(card.href);
    const link = href === null ? content : `<a class="custom-shelf__card" draggable="false" href="${escapeHtml(href)}">${content}</a>`;
    return `<li class="custom-shelf__item">${link}</li>`;
  }).join("");
  const controls = presentation === "rail"
    ? `<div class="custom-shelf__controls" hidden><button type="button" data-shelf-direction="-1" aria-controls="${trackId}" aria-label="Scroll ${title} left"><span aria-hidden="true">${renderRailArrowIcon("prev")}</span></button><button type="button" data-shelf-direction="1" aria-controls="${trackId}" aria-label="Scroll ${title} right"><span aria-hidden="true">${renderRailArrowIcon("next")}</span></button></div>`
    : "";
  return `<section class="custom-shelf custom-shelf--${presentation} custom-shelf--columns-${columns}" aria-labelledby="${headingId}"><header class="custom-shelf__head"><h${headingLevel} id="${headingId}">${title}</h${headingLevel}>${controls}</header><ul class="custom-shelf__track" id="${trackId}"${presentation === "rail" ? ` tabindex="0" aria-label="${title} items"` : ""}>${cards}</ul></section>`;
}

// The frame both dynamic blocks share: one heading, one list, and the same empty state,
// so a topic shelf and a video playlist read as siblings on the page and an editor who
// learns one has learned the other. `kind` is the only thing that differs in the frame,
// and it carries into the markup as a class and a data attribute so the two can be
// styled and inspected apart.
function renderShelfFrame(
  kind: "topic-shelf" | "video-playlist",
  title: string,
  headingLevel: number,
  topic: string,
  resolved: ResolvedShelf<unknown>,
  body: string,
): string {
  const heading = `<h${headingLevel} class="${kind}__title">${escapeHtml(title)}</h${headingLevel}>`;
  return (
    `<section class="${kind} dynamic-shelf" data-shelf-kind="${kind}"` +
    ` data-shelf-topic="${escapeHtml(topic)}" data-shelf-count="${resolved.items.length}">` +
    `<header class="${kind}__head">${heading}</header>${body}</section>`
  );
}

// The empty state is designed rather than absent (#1046). A shelf that resolves to
// nothing still renders its heading and says, in a reader's words, that there is nothing
// here yet -- so the page never shows a bare heading over a hole, and an editor looking
// at the preview learns the shelf is empty before it publishes rather than after.
function renderShelfEmptyState(kind: string, message: string): string {
  return `<p class="shelf-empty ${kind}__empty">${escapeHtml(message)}</p>`;
}

function renderTopicShelf(
  data: TopicShelfData,
  headingLevel: number,
  options: RenderBlockOptions,
): string {
  const resolved = resolveTopicShelf(
    data,
    options.storyShelfSnapshot ?? RELATED_STORY_INDEX,
    { now: options.shelfNow },
  );
  if (resolved.empty) {
    // Reader-facing wording. The editor is told WHY a shelf came back empty, on the
    // block's own surface; a visitor is told only what is true for them, because the
    // state of an approved source list is not public-page copy.
    const message = "There are no related stories to show right now.";
    return renderShelfFrame(
      "topic-shelf",
      data.title,
      headingLevel,
      data.topic,
      resolved,
      renderShelfEmptyState("topic-shelf", message),
    );
  }
  const cards = resolved.items
    .map((item) => {
      // Every link here comes from the approved index and has already been through the
      // renderer's own safeHref in the resolver's eligibility check, so an item that
      // reaches this point always has a usable destination.
      const href = safeHref(item.href) ?? "";
      const summary = item.summary?.trim()
        ? `<span class="shelf-card__summary">${escapeHtml(item.summary)}</span>`
        : "";
      return (
        `<li class="shelf-card shelf-card--story"><a class="shelf-card__link" href="${escapeHtml(href)}">` +
        `<span class="shelf-card__kicker">${escapeHtml(item.sourceLabel)}</span>` +
        `<span class="shelf-card__title">${escapeHtml(item.title)}</span>${summary}</a></li>`
      );
    })
    .join("");
  return renderShelfFrame(
    "topic-shelf",
    data.title,
    headingLevel,
    data.topic,
    resolved,
    `<ul class="shelf-track">${cards}</ul>`,
  );
}

function renderVideoPlaylist(
  data: VideoPlaylistData,
  headingLevel: number,
  options: RenderBlockOptions,
): string {
  const resolved = resolveVideoPlaylist(
    data,
    options.videoLibrarySnapshot ?? APPROVED_VIDEO_LIBRARY,
    { now: options.shelfNow },
  );
  if (resolved.empty) {
    const message = "There are no videos to show right now.";
    return renderShelfFrame(
      "video-playlist",
      data.title,
      headingLevel,
      data.topic,
      resolved,
      renderShelfEmptyState("video-playlist", message),
    );
  }
  const cards = resolved.items
    .map((item) => {
      const href = safeHref(item.href) ?? "";
      // Runtime, captions, and the member gate are stated on the card rather than left
      // for the viewer to discover after a click: a Passport-gated video that looks
      // public is the surprise this metadata exists to prevent.
      const meta = [
        formatShelfDuration(item.durationSeconds),
        "Captioned",
        item.access === "passport_members" ? "Passport members" : "Free to watch",
      ]
        .filter((part) => part !== "")
        .map((part) => `<span class="shelf-card__fact">${escapeHtml(part)}</span>`)
        .join("");
      const thumbnail =
        `<span class="shelf-card__media"><img src="${escapeHtml(item.thumbnail.url)}"` +
        ` alt="${escapeHtml(item.thumbnail.alt)}" loading="lazy" decoding="async" width="640" height="360"></span>`;
      return (
        `<li class="shelf-card shelf-card--video"><a class="shelf-card__link" href="${escapeHtml(href)}">` +
        `${thumbnail}<span class="shelf-card__title">${escapeHtml(item.title)}</span>` +
        `<span class="shelf-card__meta">${meta}</span></a></li>`
      );
    })
    .join("");
  return renderShelfFrame(
    "video-playlist",
    data.title,
    headingLevel,
    data.topic,
    resolved,
    `<ul class="shelf-track">${cards}</ul>`,
  );
}

/**
 * Render one validated block to escaped, static HTML. Pure and side-effect free. The
 * result is the block's semantic markup only -- no editor controls or state, which are
 * layered on top by the admin surface.
 *
 * Visibility is not consulted here: this renders how a block *looks*, not whether a
 * page includes it. A caller that assembles a public page filters on `visible`; the
 * editor renders every block so a hidden one still shows with its visibility control.
 */
export function renderBlock(
  block: PageBlock,
  options: RenderBlockOptions = {},
): string {
  const generatedHeadingLevel = clampHeadingLevel(
    options.generatedHeadingLevel ?? 2,
  );
  const nestedRichTextOptions = {
    externalLinksNewTab: options.externalLinksNewTab,
    headingLevelOffset: generatedHeadingLevel - 1,
    minimumHeadingLevel: Math.min(6, generatedHeadingLevel + 1),
  };
  switch (block.type) {
    case "data_hub_section": {
      const data = { ...block.data, heading: block.data.heading.trim(), introduction: block.data.introduction.trim() };
      if (options.resolveDataHubSection) return options.resolveDataHubSection(data, generatedHeadingLevel);
      const heading = data.heading || DATA_HUB_SECTIONS[data.sectionId];
      const introduction = data.introduction;
      return `<section data-data-hub-section="${escapeHtml(block.data.sectionId)}"><h${generatedHeadingLevel}>${escapeHtml(heading)}</h${generatedHeadingLevel}>${introduction ? `<p>${escapeHtml(introduction)}</p>` : ""}</section>`;
    }
    case "document_list": {
      const rows = newestNoticeDocuments(block.data.documents).flatMap(item => {
        const asset = options.resolveAsset?.(item.assetId, "content");
        const href = asset?.mimeType === "application/pdf" ? safeHref(asset.url) : null;
        if (!href || !/^https:\/\//i.test(href) || !item.title.trim() || !isNoticeAddedAt(item.addedAt)) return [];
        const publisher = item.publisher ? DOCUMENT_PUBLISHERS[item.publisher] : "";
        const metadata = `${publisher ? `${escapeHtml(publisher)} · ` : ""}Added <time datetime="${escapeHtml(item.addedAt)}">${noticeAddedDate(item.addedAt)}</time>`;
        return [`<li class="document-list__item"><a class="document-list__link" href="${escapeHtml(href)}"><span class="document-list__copy"><span class="document-list__title">${escapeHtml(item.title)}</span><span class="document-list__meta">${metadata}</span></span><span class="document-list__format">PDF</span></a></li>`];
      });
      return rows.length ? `<ul class="document-list" role="list" aria-label="Meeting notices, newest first">${rows.join("")}</ul>`
        : '<p class="document-list__empty">No meeting notices have been posted here yet.</p>';
    }
    case "row":
      // The page assembler owns columns. Linear consumers such as RSS omit the
      // structural wrapper and still render every following child once.
      return "";
    case "prose":
      return renderRichText(block.data.content, {
        externalLinksNewTab: options.externalLinksNewTab,
        headingId: options.richTextHeadingId,
      });
    case "headline": {
      const level = clampHeadingLevel(block.data.level);
      return `<h${level}>${escapeHtml(block.data.text)}</h${level}>`;
    }
    case "divider":
      return "<hr>";
    case "record_card":
      // The public Astro assembler resolves this against the build's card export.
      return "";
    case "bio_card": {
      if (!options.allowBios) return "";
      const image = block.data.image;
      const resolved = image?.assetId ? options.resolveAsset?.(image.assetId, "grid") : null;
      return renderBioCard(block.data, image && resolved
        ? renderResolvedImage(image.assetId, image.altDecorative ? "" : image.alt, resolved)
        : "");
    }
    case "image":
      return renderImageFigure(block.data, options, "content", block.data);
    case "video":
      return renderVideoBlock(block.data, { placeholder: options.videoPlaceholder === true });
    case "cta_row": {
      const ctas = block.data.ctas.map((cta) => {
        const variantClass = ctaVariantClass(cta.variant);
        const href = safeHref(cta.href);
        const newTab = opensExternalInNewTab(href, options);
        const hrefAttr = href === null ? "" : ` href="${escapeHtml(href)}"${newTab ? EXTERNAL_LINK_ATTRIBUTES : ""}`;
        return `<a class="btn ${variantClass}"${hrefAttr}>${escapeHtml(cta.label)}${newTab ? EXTERNAL_LINK_NOTICE : ""}</a>`;
      });
      return `<div class="cta-row">${ctas.join("")}</div>`;
    }
    case "image_gallery": {
      const figures = block.data.images
        .map((image) => renderImageFigure(image, options, "grid"))
        .join("");
      // The carousel is a scroll container, so it has to be operable by keyboard: a person who
      // cannot use a pointer must still be able to reach the images past the first. That is what
      // the tabindex is for, and it is the same treatment the home page rails already carry --
      // without it this mode would be an accessibility regression rather than a layout choice.
      // The group is named because a bare focusable div announces nothing on arrival.
      if (galleryPresentation(block.data) === "carousel") {
        const hint =
          '<p class="image-gallery__hint">Scroll horizontally to see all images</p>';
        return `<div class="image-gallery-shell image-gallery-shell--carousel">${hint}<div class="image-gallery image-gallery--carousel" role="group" aria-label="Image gallery, scroll horizontally to view all images" tabindex="0">${figures}</div></div>`;
      }
      return `<div class="image-gallery">${figures}</div>`;
    }
    case "card_grid": {
      const cards = block.data.cards.map((card) => {
        // The card's own title and link carry its meaning, so the thumbnail is always
        // decorative, whatever the editor chose for it elsewhere. It says so through the
        // same flag an authored image uses, which is what hides the figure.
        // Blank-text rule again: an asset id of spaces resolves to nothing, so it would
        // build a figure around an img with no source rather than no figure at all.
        const assetId = card.imageAssetId?.trim() ? card.imageAssetId : "";
        const image = assetId
          ? renderImageFigure(
              { assetId, alt: "", altDecorative: true },
              options,
              "grid",
            )
          : "";
        const href = safeHref(card.href);
        const title = escapeHtml(card.title);
        const newTab = opensExternalInNewTab(href, options);
        const label = card.label?.trim()
          ? `<span class="card-grid__label">${escapeHtml(card.label)}</span>`
          : "";
        // The page assembler derives this rank from preceding authored headings. A
        // first card stays directly beneath the page h1, while one inside an authored
        // section nests a level deeper without storing layout context in the block.
        const heading = href === null
          ? `<h${generatedHeadingLevel} class="card-grid__title">${title}</h${generatedHeadingLevel}>`
          : `<h${generatedHeadingLevel} class="card-grid__title"><a href="${escapeHtml(href)}"${newTab ? EXTERNAL_LINK_ATTRIBUTES : ""}>${title}${newTab ? EXTERNAL_LINK_NOTICE : ""}</a></h${generatedHeadingLevel}>`;
        // The editor seeds every optional body with an empty paragraph (emptyRichTextDoc),
        // which is truthy, so a title-only card would bake an empty `<p></p>` and its
        // spacing. Omit a body that renders to nothing visible -- but keep one that carries
        // a rule or break (richTextRendersEmpty, not the text-only richTextIsEmpty).
        const body = card.body && !richTextRendersEmpty(card.body)
          ? renderRichText(card.body, nestedRichTextOptions)
          : "";
        return `<article class="card-grid__card">${image}${label}${heading}${body}</article>`;
      });
      return `<div class="card-grid">${cards.join("")}</div>`;
    }
    case "link_card":
      return renderLinkCard(block.data, generatedHeadingLevel);
    case "faq_item":
      // FAQ questions follow the same page-derived outline rank as card titles.
      return `<div class="faq-item"><h${generatedHeadingLevel} class="faq-item__question">${escapeHtml(block.data.question)}</h${generatedHeadingLevel}>${renderRichText(block.data.answer, nestedRichTextOptions)}</div>`;
    case "coverage_list":
      return renderCoverageList(block.data, generatedHeadingLevel);
    case "content_shelf": {
      // The CMS owns the finite shelf settings, while PBS Media Manager or the
      // Spotlight RSS feed owns the cards. Render an honest empty mount point so
      // preview and future page assembly can hydrate source-owned items without
      // persisting a stale copy of today's programs or headlines in the page.
      const href = safeHref(block.data.moreHref);
      const hrefAttr = href === null ? "" : ` href="${escapeHtml(href)}"`;
      const presentation = block.data.presentation === undefined ? "" : ` data-presentation="${escapeHtml(block.data.presentation)}"`;
      const columns = block.data.columns === undefined ? "" : ` data-columns="${block.data.columns}"`;
      return `<section class="content-shelf" data-content-source="${escapeHtml(block.data.source)}" data-item-limit="${block.data.itemLimit}"${presentation}${columns}><header class="content-shelf__head"><h${generatedHeadingLevel}>${escapeHtml(block.data.title)}</h${generatedHeadingLevel}><a${hrefAttr}>${escapeHtml(block.data.moreLabel)}</a></header><div class="content-shelf__items" data-derived-items></div></section>`;
    }
    case "promotion_playlist":
      return renderCustomShelf(block, options);
    case "sponsor_strip": {
      const sponsors = new Map((options.sponsors ?? []).map(sponsor => [sponsor.sponsorId, sponsor]));
      const items = block.data.sponsorIds.flatMap(id => {
        const sponsor = sponsors.get(id);
        if (!sponsor) return [];
        const href = safeHref(sponsor.href);
        const logo = sponsor.logoUrl
          ? `<img src="${escapeHtml(sponsor.logoUrl)}" alt="${escapeHtml(sponsor.logoDecorative ? "" : sponsor.logoAlt)}" loading="lazy" decoding="async">`
          : "";
        const name = sponsor.logoDecorative || !logo || !sponsor.logoAlt.trim() ? `<span>${escapeHtml(sponsor.name)}</span>` : "";
        const content = `${logo}${name}`;
        return [`<li>${href ? `<a href="${escapeHtml(href)}" rel="sponsored noopener">${content}</a>` : content}</li>`];
      });
      if (items.length === 0) return "";
      const heading = block.data.heading?.trim()
        ? `<h${generatedHeadingLevel}>${escapeHtml(block.data.heading)}</h${generatedHeadingLevel}>` : "";
      return `<section class="sponsor-strip sponsor-strip--${block.data.layout}" aria-label="${escapeHtml(block.data.heading?.trim() || "Sponsors")}">${heading}<ul>${items.join("")}</ul></section>`;
    }
    case "home_newscast":
      throw new Error("Newscast requires the sealed Home renderer.");
    case "newsletter_signup": {
      const cards = block.data.newsletterIds.flatMap(id => {
        const record = options.resolveNewsletter?.(id);
        if (!record?.signupUrl) return [];
        const image = record.imageAssetId && options.resolveAsset
          ? options.resolveAsset(record.imageAssetId, "grid")
          : null;
        const imageHtml = image && record.imageAssetId
          ? renderResolvedImage(record.imageAssetId, record.imageAlt ?? "", image, { className: "newsletter-signup__image" })
          : "";
        return [`<article class="newsletter-signup__card">${imageHtml}<div class="newsletter-signup__copy"><h${Math.min(6, generatedHeadingLevel + (block.data.heading?.trim() ? 1 : 0))}>${escapeHtml(record.title)}</h${Math.min(6, generatedHeadingLevel + (block.data.heading?.trim() ? 1 : 0))}>${record.frequency ? `<p class="newsletter-signup__frequency">${escapeHtml(record.frequency)}</p>` : ""}${record.summary ? `<p>${escapeHtml(record.summary)}</p>` : ""}<a class="btn btn--primary" href="${escapeHtml(record.signupUrl)}" rel="noopener noreferrer">Sign up for ${escapeHtml(record.title)}</a></div></article>`];
      });
      if (!cards.length) return "";
      return `<section class="newsletter-signup">${block.data.heading?.trim() ? `<h${generatedHeadingLevel}>${escapeHtml(block.data.heading.trim())}</h${generatedHeadingLevel}>` : ""}${block.data.intro?.trim() ? `<p>${escapeHtml(block.data.intro.trim())}</p>` : ""}<div class="newsletter-signup__grid">${cards.join("")}</div></section>`;
    }
    case "topic_shelf":
      return renderTopicShelf(block.data, generatedHeadingLevel, options);
    case "video_playlist":
      return renderVideoPlaylist(block.data, generatedHeadingLevel, options);
    case "town_lookup":
      return renderTownLookup(block.id, block.data, generatedHeadingLevel);
    case "data_table":
      return renderDataTable(block.data);
    case "data_figure":
      return renderDataFigure(block.id, block.data, options.resolveDataFigure?.(block.id, block.data), generatedHeadingLevel);
    case "county_comparison":
      return renderCountyComparison(block.id, block.data, generatedHeadingLevel);
    case "election_results":
      return renderElectionResults(block.id, block.data, generatedHeadingLevel, candidate => {
        const photo = candidate.photo;
        const asset = photo ? options.resolveAsset?.(photo.assetId, "grid") : null;
        return photo && asset ? renderResolvedImage(photo.assetId, photo.alt, asset) : "";
      });
    case "html":
      return renderHtmlBlock(block.data);
    case "embed": {
      const apLayout = apResultsLayoutSrc(block.data.url);
      if (apLayout) {
        const title = block.data.heading?.trim() || "New Jersey election results";
        const height = AP_MAP_HEIGHTS[block.data.mapSize ?? "medium"] ?? AP_MAP_HEIGHTS.medium;
        const mobileHeight = validEmbedDimension(block.data.mobileHeight, AP_MAP_MOBILE_HEIGHT_LIMITS) ? block.data.mobileHeight : height;
        const width = block.data.mapWidth === "wide" ? "wide" : "content";
        const caption = block.data.caption?.trim() ? `<p>${escapeHtml(block.data.caption.trim())}</p>` : "";
        return `<section class="election-results election-map election-map--${width}" aria-label="${escapeHtml(title)}"><h${generatedHeadingLevel} class="election-results__title">${escapeHtml(title)}</h${generatedHeadingLevel}><div class="election-map__viewport"><iframe class="election-map__frame" src="${escapeHtml(apLayout)}" title="${escapeHtml(title)}" width="100%" height="${height}" style="--ap-map-mobile-height:${mobileHeight}px" referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div><footer class="election-results__footer">${caption}<p>Source: AP</p></footer></section>`;
      }
      const player = embedPlayer(block.data.url, options.disableVideoAutoplay !== true);
      if (player !== null) {
        const dimensions = embedPlayerDimensions(block.data, player.vertical === true);
        // A caption becomes the player's heading. A caption of "LIVE" adds the red live light.
        const caption = block.data.caption?.trim() ?? "";
        const live = /^live$/i.test(caption)
          ? '<span class="embed__live-light" aria-hidden="true"></span>'
          : "";
        const heading = caption
          ? `<h${generatedHeadingLevel} class="embed__heading">${live}${escapeHtml(caption)}</h${generatedHeadingLevel}>`
          : "";
        const title = caption ? `${caption} - ${player.title}` : player.title;
        const frameStyle = dimensions
          ? ` style="--embed-aspect-ratio:${dimensions.aspectRatio}${dimensions.maxWidth === undefined ? "" : `;--embed-max-width:${dimensions.maxWidth}px`}"`
          : "";
        const sizeAttributes = dimensions
          ? ` width="${dimensions.width}" height="${dimensions.height}"`
          : "";
        return `<div class="embed embed--video">${heading}<div class="embed__frame"${frameStyle}><iframe src="${escapeHtml(player.src)}" title="${escapeHtml(title)}"${sizeAttributes} allow="${player.allow}" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe></div></div>`;
      }
      // X's official widgets require page scripts, which draft previews prohibit.
      const xLink = xVideoLink(block.data.url);
      if (xLink) return renderLinkCard({ url: xLink, title: block.data.caption?.trim() || "Watch video on X", source: "X / Twitter" }, generatedHeadingLevel);
      const href = safeHref(block.data.url);
      // A whitespace-only caption is not a usable link label: it would give the link no
      // accessible name. Use only a safe url as the automatic label.
      const caption = block.data.caption;
      const label = escapeHtml(caption && caption.trim() ? caption : (href ?? ""));
      const content = href === null ? label : `<a href="${escapeHtml(href)}">${label}</a>`;
      return `<div class="embed">${content}</div>`;
    }
  }
}
