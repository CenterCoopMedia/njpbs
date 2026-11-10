import { escapeHtml, renderRichText } from "./content-model.ts";
import type { LiveBlogFollowUp } from "./live-blog.ts";
import { storyCreditsByline, type StoryCredit } from "./story-credits.ts";
import { liveBlogCopyId, liveBlogLinkIcon, liveBlogThreadIcon } from "./live-blog-reporters-render.ts";

/** The parent renderer supplies the same frozen credit and time presentation. */
export function renderLiveBlogFollowUps(items: LiveBlogFollowUp[] | undefined, options: {
  anchor: string; renderTime: (value: string, previous?: string) => string; renderCredits?: (credits: StoryCredit[], ownerId: string) => string;
  parentPublishedAt?: string;
  /** Parent copy control shares the disclosure row, ahead of its thread. */
  permalink?: string;
  /** Stable insertion slot for the first follow-up on an existing parent. */
  placeholder?: boolean;
}): string {
  if (!items?.length) return options.permalink ? `${options.placeholder ? '<div class="live-blog-follow-ups">' : ""}<div class="live-blog__footer">${options.permalink}</div>${options.placeholder ? "</div>" : ""}` : "";
  const listId = `${options.anchor}-follow-ups`;
  return `<noscript><style>.live-blog-follow-ups__list[hidden]{display:block!important}.live-blog-follow-ups__toggle{display:none!important}</style></noscript><section class="live-blog-follow-ups" aria-label="Follow-ups"><div class="live-blog__footer"><button type="button" class="live-blog-follow-ups__toggle" aria-expanded="false" aria-controls="${listId}" aria-label="${items.length} follow-up${items.length === 1 ? "" : "s"}">${liveBlogThreadIcon}<span>${items.length}</span></button>${options.permalink ?? ""}</div><ol id="${listId}" class="live-blog-follow-ups__list" role="list" hidden>${items.map((item, index) => {
    const id = `${options.anchor}-follow-up-${item.id}`;
    const credits = options.renderCredits?.(item.credits, id) ?? `<p class="live-blog__metadata">By ${escapeHtml(storyCreditsByline(item.credits))}</p>`;
    const body = item.withdrawal === undefined ? renderRichText(item.body, { minimumHeadingLevel: 4 })
      : `<p class="live-blog__correction"><strong>Withdrawn:</strong> ${escapeHtml(item.withdrawal)}</p>`;
    const correction = item.correction === undefined ? "" : `<p class="live-blog__correction"><strong>Correction:</strong> ${escapeHtml(item.correction)}</p>`;
    const updated = item.updatedAt === item.publishedAt ? "" : `<p class="live-blog__metadata">Updated ${options.renderTime(item.updatedAt, item.publishedAt)}</p>`;
    return `<li><article class="live-blog-follow-up" id="${id}" data-live-blog-follow-up-updated-at="${escapeHtml(item.updatedAt)}" tabindex="-1" aria-label="Follow-up"><header class="live-blog-follow-up__header">${credits}<p class="live-blog__metadata">${options.renderTime(item.publishedAt, index === 0 ? options.parentPublishedAt : items[index - 1].publishedAt)}</p><a id="${liveBlogCopyId(id)}" class="live-blog-follow-up__permalink" href="#${id}" aria-label="Link to this follow-up">${liveBlogLinkIcon}<span class="live-blog__sr-only">Link to this follow-up</span></a></header><div class="live-blog-follow-up__body">${body}${updated}${correction}</div></article></li>`;
  }).join("")}</ol></section>`;
}
