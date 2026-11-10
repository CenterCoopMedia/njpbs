import { escapeHtml } from "./content-model.ts";
import type { StoryCredit } from "./story-credits.ts";
import type { LiveBlogData } from "./live-blog.ts";

/** Already-public author projections only; never pass staff directory records. */
export interface LiveBlogReporter {
  authorId: string;
  displayName: string;
  jobTitle?: string | null;
  bio?: string | null;
  path: string;
  photo?: { displayUrl?: string; url: string; width?: number; height?: number; focalX?: number; focalY?: number } | null;
}

// The existing official white PBS head on its blue disc (auth-pbs-mark.svg).
const pbsMark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="269.24 0 214.88 214.88" aria-hidden="true"><circle cx="376.68" cy="107.44" r="107.44" fill="#2638c4"/><g fill="#fff"><path d="M454.92,108.49,443,110.91V133c0,7.4-6.09,13.31-14,13.31h-6.1V171.9H403.31V146.27h6.1c7.88,0,14-5.91,14-13.31V110.91l11.92-2.42a4,4,0,0,0,2.72-5.72L406.75,43h19.62l31.28,59.79A4,4,0,0,1,454.92,108.49Z"/><path d="M414.73,102.77,383.46,43H351.09c-29.43,0-54.43,24.09-53.73,53.52.52,22,14.69,38.41,34.38,44.6v30.8H380V146.27h6.09c7.88,0,14-5.91,14-13.31V110.91L412,108.49A4,4,0,0,0,414.73,102.77ZM374,99.35a12.28,12.28,0,1,1,12.28-12.28A12.28,12.28,0,0,1,374,99.35Z"/></g></svg>';

export const liveBlogCloseIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
export const liveBlogLinkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m10 13 4-4m-5-1 2-2a4 4 0 0 1 6 6l-2 2m-6-4-2 2a4 4 0 0 0 6 6l2-2"/></svg>';
export const liveBlogThreadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/></svg>';

/** Separate namespace: a follow-up id may itself end in "copy-link". */
export const liveBlogCopyId = (anchor: string) => `live-blog-copy-${anchor.length}-${anchor}`;

export function liveBlogReporterBio(value: string | null | undefined): string {
  const text = value?.trim().replace(/\s+/gu, " ") ?? "";
  let sentence = text;
  for (const match of text.matchAll(/[.!?](?:[”’"')\]]*)(?=\s|$)/gu)) {
    const token = text.slice(0, match.index + 1).match(/([\p{L}.]+)$/u)?.[1] ?? "";
    if (match[0].startsWith(".") && /^(?:(?:\p{L}\.)+|(?:Dr|Mr|Mrs|Ms|Jr|Sr|St|Gov|Sen|Rep|Lt|No)\.)$/iu.test(token)) continue;
    sentence = text.slice(0, match.index + match[0].length); break;
  }
  const points = Array.from(sentence);
  return points.length > 140 ? `${points.slice(0, 139).join("").trimEnd()}…` : sentence;
}

export function renderLiveBlogReporters(credits: readonly StoryCredit[], ownerId: string, options: {
  reporters?: readonly LiveBlogReporter[];
  presentation: Required<NonNullable<LiveBlogData["presentation"]>>;
  updateCounts: ReadonlyMap<string, number>;
}): string {
  if (!credits.length) return '<p class="live-blog__byline">Draft byline not provided</p>';
  return `<div class="live-blog__reporters">${credits.map((credit, index) => {
    const profile = credit.kind === "registered" ? options.reporters?.find(author => author.authorId === credit.authorId) : undefined;
    const name = profile?.displayName ?? (credit.kind === "registered" ? credit.displayName ?? "Reporter" : credit.name);
    const identity = `<strong class="live-blog__reporter-name">${escapeHtml(name)}</strong>${profile?.jobTitle ? `<span class="live-blog__reporter-title">${escapeHtml(profile.jobTitle)}</span>` : ""}`;
    const initials = name.trim().split(/\s+/u).filter(Boolean).map(word => Array.from(word)[0]).filter(Boolean);
    const face = !profile ? pbsMark : profile.photo
      ? `<img class="live-blog__face" src="${escapeHtml(profile.photo.displayUrl ?? profile.photo.url)}"${profile.photo.width && profile.photo.height ? ` width="${profile.photo.width}" height="${profile.photo.height}"` : ""} alt="" loading="lazy" decoding="async" style="object-position:${profile.photo.focalX ?? 50}% ${profile.photo.focalY ?? 50}%">`
      : `<span class="live-blog__face live-blog__initials" aria-hidden="true">${escapeHtml((initials.length > 1 ? [initials[0], initials.at(-1)] : initials).join("").toLocaleUpperCase("en-US"))}</span>`;
    const portrait = `<span class="live-blog__portrait">${face}${profile ? `<span class="live-blog__mark">${pbsMark}</span>` : ""}</span>`;
    const card = options.presentation.reporterCards && profile;
    const content = options.presentation.reporterPhotos ? portrait : identity;
    const cardId = `live-blog-reporter-${ownerId.length}-${ownerId}-${index}`;
    const trigger = card ? `<button id="${cardId}-trigger" type="button" class="live-blog__reporter-trigger${options.presentation.reporterPhotos ? "" : " live-blog__reporter-trigger--text"}" aria-label="About ${escapeHtml(name)}" aria-controls="${cardId}" aria-expanded="false">${content}</button><a class="live-blog__reporter-fallback" href="${escapeHtml(profile.path)}" aria-label="${escapeHtml(name)}’s author page">${content}</a>` : content;
    const count = profile ? options.updateCounts.get(profile.authorId) ?? 0 : 0;
    const bio = liveBlogReporterBio(profile?.bio);
    return `<div class="live-blog__reporter${card ? " live-blog__reporter--card" : ""}">${trigger}${options.presentation.reporterPhotos ? `<span class="live-blog__reporter-identity">${identity}</span>` : ""}${card ? `<div class="live-blog__reporter-card" id="${cardId}" role="dialog" aria-label="About ${escapeHtml(name)}" hidden><div class="live-blog__card-header">${options.presentation.reporterPhotos ? `<span class="live-blog__card-portrait">${face}</span>` : ""}<span class="live-blog__card-identity">${identity}</span><button id="${cardId}-close" class="live-blog__icon-control live-blog__card-close" type="button" aria-label="Close reporter details">${liveBlogCloseIcon}</button></div>${bio ? `<p class="live-blog__card-bio">${escapeHtml(bio)}</p>` : ""}<p class="live-blog__card-count">${count} update${count === 1 ? "" : "s"} in this live blog</p><a id="${cardId}-author" href="${escapeHtml(profile.path)}">More from ${escapeHtml(name)}</a></div>` : ""}</div>`;
  }).join("")}</div>`;
}
