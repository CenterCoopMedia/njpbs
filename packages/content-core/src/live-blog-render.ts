import { escapeHtml, renderRichText, richTextIsEmpty } from "./content-model.ts";
import { formatEditorialDate } from "./editorial-date-format.ts";
import type { PostLeadMedia } from "./post-lead-media.ts";
import { assertLiveBlogData, isLiveBlogId, orderedLiveBlogUpdates, resolveLiveBlogPresentation } from "./live-blog.ts";
import { parsePublishInstant } from "./publish-instant.ts";
import { STATION_TIME_ZONE, zonedParts } from "./station-time.ts";
import { renderLiveBlogReporters, liveBlogCopyId, liveBlogLinkIcon, type LiveBlogReporter } from "./live-blog-reporters-render.ts";
import { renderLiveBlogFollowUps } from "./live-blog-follow-ups-render.ts";
import type { StoryCredit } from "./story-credits.ts";
import { liveBlogManifest } from "./live-blog-manifest";

function stationDay(value: string): string {
  const parts = zonedParts(parsePublishInstant(value)!, STATION_TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function time(value: string, compact = false, previous?: string): string {
  const instant = parsePublishInstant(value)!;
  const parts = zonedParts(instant, STATION_TIME_ZONE);
  const date = formatEditorialDate(`${parts.year}-${parts.month}-${parts.day}`)!;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: STATION_TIME_ZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(instant));
  const full = `${date}, ${clock}`;
  if (!compact) return `<time datetime="${escapeHtml(value)}">${escapeHtml(full)}</time>`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: STATION_TIME_ZONE, weekday: "short" }).format(new Date(instant));
  const day = stationDay(value);
  const showDay = !previous || day !== stationDay(previous);
  const dayLabel = `${weekday}., ${date.replace(/, \d{4}$/, "")} · `;
  return `<time datetime="${escapeHtml(value)}" data-live-blog-day="${day}" aria-label="${escapeHtml(full)}"><span aria-hidden="true"><span data-live-blog-day-label${showDay ? "" : " hidden"}>${escapeHtml(dayLabel)}</span><span class="live-blog__clock">${escapeHtml(clock)}</span></span><span class="live-blog__sr-only">${escapeHtml(full)}</span></time>`;
}

export interface LiveBlogRenderOptions {
  /** Stable parent Post id; also separates anchors when rendering multiple blogs. */
  id: string;
  /** Frozen render cutoff supplied by the publisher; no ambient clock reads. */
  asOf: string;
  /** Trusted private-preview context only; public output always stays strict. */
  preview?: boolean;
  /** Existing Post media renderer and immutable asset resolver. */
  renderMedia?: (media: PostLeadMedia, entryId: string) => string;
  /** Existing scoped election kit, supplied by the Post shell with its settings. */
  renderBranding?: () => string;
  renderCredits?: (credits: StoryCredit[], ownerId: string) => string;
  reporters?: readonly LiveBlogReporter[];
  /** Public Post URL supplied by the shell, including inside private previews. */
  canonicalUrl?: string;
}

/**
 * The Post shell owns h1, summary and metadata. The full archive is readable
 * without scripts; an optional client control reveals older entries in batches.
 */
export function renderLiveBlog(value: unknown, options: LiveBlogRenderOptions): string {
  assertLiveBlogData(value, { complete: !options.preview });
  const cutoff = parsePublishInstant(options.asOf);
  if (!isLiveBlogId(options.id) || cutoff === null || parsePublishInstant(value.updatedAt)! > cutoff) {
    throw new Error("Live blog rendering needs a stable Post id and a cutoff at or after its published revision.");
  }
  // Length-prefix parent and update ids; title/entry namespaces cannot overlap.
  const prefix = `live-blog-${options.id.length}-${options.id}`;
  const entryId = (id: string) => `${prefix}-entry-${id.length}-${id}`;
  const titleId = (id: string) => `${prefix}-title-${id.length}-${id}`;
  const updates = orderedLiveBlogUpdates(value);
  const presentation = resolveLiveBlogPresentation(value);
  const updateCounts = new Map<string, number>();
  for (const update of updates) {
    if (update.withdrawal !== undefined) continue;
    for (const credit of update.credits) if (credit.kind === "registered") {
      updateCounts.set(credit.authorId, (updateCounts.get(credit.authorId) ?? 0) + 1);
    }
  }
  const renderCredits = options.renderCredits ?? ((credits: StoryCredit[], ownerId: string) => renderLiveBlogReporters(credits, ownerId, { reporters: options.reporters, presentation, updateCounts }));
  const state = { ongoing: "Coverage ongoing", paused: "Coverage paused", ended: "Coverage ended" }[value.coverageState];
  const keyUpdates = updates.filter((entry) => entry.keyUpdate);
  const keyLinks = keyUpdates.length === 0 ? "" : `<nav class="live-blog__keys" aria-label="Key updates"><h3>Key updates</h3><ul>${keyUpdates.map((entry) => `<li><a href="#${entryId(entry.id)}">${escapeHtml(entry.headline.trim() || "Draft update")}</a></li>`).join("")}</ul></nav>`;
  const entries = updates.map((entry, index) => {
    const id = entryId(entry.id);
    if (entry.media && !options.renderMedia) throw new Error("Entry media needs the existing Post media renderer.");
    const media = entry.media ? `<div class="live-blog__media">${options.renderMedia!(entry.media, id)}</div>` : "";
    const updated = parsePublishInstant(entry.updatedAt)! > parsePublishInstant(entry.publishedAt)!
      ? `<p class="live-blog__metadata">Updated ${time(entry.updatedAt)}</p>` : "";
    const correction = entry.correction === undefined ? ""
      : `<p class="live-blog__correction"><strong>Correction:</strong> ${escapeHtml(entry.correction)}</p>`;
    const withdrawal = entry.withdrawal === undefined ? ""
      : `<p class="live-blog__correction"><strong>Withdrawn:</strong> ${escapeHtml(entry.withdrawal)}</p>`;
    const keyMark = entry.keyUpdate ? '<span class="live-blog__key-mark">Key update</span>' : "";
    const permalink = `<a id="${liveBlogCopyId(id)}" class="live-blog__permalink" href="#${id}" aria-label="Link to this update: ${escapeHtml(entry.headline.trim() || "Draft update")}">${liveBlogLinkIcon}<span class="live-blog__sr-only">Link to this update</span></a>`;
    return `<li><article class="live-blog__entry" id="${id}" data-live-blog-entry="${escapeHtml(entry.id)}" aria-labelledby="${titleId(entry.id)}" tabindex="-1"><header class="live-blog__stamp">${renderCredits(entry.credits, id)}<p class="live-blog__metadata">${time(entry.publishedAt, true, updates[index - 1]?.publishedAt)}</p>${keyMark}</header><div class="live-blog__content"><div class="live-blog__reporting"><h3 class="live-blog__headline" id="${titleId(entry.id)}">${escapeHtml(entry.headline.trim() || "Draft update")}</h3><div class="live-blog__body">${options.preview && richTextIsEmpty(entry.body) && entry.withdrawal === undefined ? "<p>Draft body not provided.</p>" : renderRichText(entry.body, { minimumHeadingLevel: 4 })}</div>${media}${updated}${correction}${withdrawal}</div>${renderLiveBlogFollowUps(entry.followUps, { anchor: id, renderTime: (value, previous) => time(value, true, previous), parentPublishedAt: entry.publishedAt, renderCredits, permalink, placeholder: entry.withdrawal === undefined })}</div></article></li>`;
  }).join("");
  const feed = `${entries ? "<p data-live-blog-order>Newest updates first.</p>" : `<p data-live-blog-empty>${value.coverageState === "ended" ? "No updates were published." : "No updates have been published yet."}</p>`}<ol id="${prefix}-updates" class="live-blog__updates" role="list">${entries}</ol>`;
  const refresh = options.preview ? "" : `<script type="application/json" data-live-blog-manifest>${JSON.stringify(liveBlogManifest(options.id, value)).replaceAll("<", "\\u003c")}</script><div class="live-blog__refresh" data-live-blog-refresh hidden><button type="button" data-live-blog-load aria-controls="${prefix}-updates"></button></div><p class="live-blog__update-status" data-live-blog-announcement role="status" aria-live="polite" aria-atomic="true"></p>`;
  const branding = value.branding === "nj-decides-2026" ? `<div data-live-blog-branding>${options.renderBranding?.() ?? '<p class="live-blog__branding">NJ Decides 2026</p>'}</div>` : "";
  return `<section class="live-blog" data-live-blog data-live-blog-reporter-photos="${presentation.reporterPhotos}" data-live-blog-reporter-cards="${presentation.reporterCards}" data-live-blog-playful="${presentation.playful}"${options.canonicalUrl ? ` data-live-blog-canonical="${escapeHtml(options.canonicalUrl)}"` : ""} aria-labelledby="${prefix}-heading">${branding}<h2 id="${prefix}-heading">Live updates</h2><p class="live-blog__state">${state}</p><p class="live-blog__metadata">Last published change: ${time(value.updatedAt)}</p>${refresh}${keyLinks}${feed}<div class="live-blog__pagination" data-live-blog-pagination hidden><p class="live-blog__metadata" data-live-blog-count></p><button type="button" data-live-blog-older aria-controls="${prefix}-updates">Show older updates</button></div></section>`;
}
