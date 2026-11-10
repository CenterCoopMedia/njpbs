import { escapeHtml } from "./safe-href.ts";
import { safeHref } from "./safe-href.ts";
import { embedPlayer, xVideoLink } from "./embed-player.ts";
import { renderBlock } from "./content-render.ts";
import { isPostLeadMedia, leadMediaTitle, type PostLeadMedia } from "./post-lead-media.ts";

type VideoMedia = Exclude<PostLeadMedia, { kind: "image" }>;
export interface PostMediaPlayerOptions {
  preview?: boolean;
  id?: string;
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  lazyPoster?: boolean;
  poster?: { url: string; width: number; height: number } | null;
}
/** Shared Post lead/entry player. Provider players are activated by an explicit Play. */
export function renderPostMediaPlayer(value: VideoMedia, options: PostMediaPlayerOptions = {}): string {
  if (!isPostLeadMedia(value, !options.preview)) return "";
  const title = leadMediaTitle(value);
  const name = escapeHtml(title);
  const player = value.kind !== "library-video" ? embedPlayer(value.data.url, false) : null;
  const href = value.kind !== "library-video" ? xVideoLink(value.data.url) ?? safeHref(value.data.url) : null;
  const envelope = { id: options.id ?? "lead", order: 0, visible: true };
  const markup = value.kind === "library-video"
    ? renderBlock({ ...envelope, type: "video", data: { ...value.data, title } }, { videoPlaceholder: options.preview })
    : renderBlock({ ...envelope, type: "embed", data: { ...value.data, caption: title } },
      { disableVideoAutoplay: true, generatedHeadingLevel: options.headingLevel ?? 2 });
  const poster = options.poster ? `<img src="${escapeHtml(options.poster.url)}" width="${options.poster.width}" height="${options.poster.height}" alt="" decoding="async"${options.lazyPoster ? ' loading="lazy"' : ""}>` : "";
  const label = `<span class="post-lead-player__label"><span aria-hidden="true">▶</span> ${player ? "Play" : "Watch"} ${name}</span>`;
  const content = value.kind === "library-video" ? markup : player
    ? `<button type="button" class="post-lead-player__play" data-lead-play aria-label="Play ${name}">${poster}${label}</button><template data-lead-template>${markup}</template><noscript><a href="${escapeHtml(player.src)}">Watch ${name}</a></noscript>`
    : `<a class="post-lead-player__play"${href ? ` href="${escapeHtml(href)}"` : ""}>${poster}${label}</a>`;
  const caption = value.kind !== "library-video" && value.data.caption?.trim() && value.data.caption.trim() !== title
    ? `<p class="post-lead-player__caption">${escapeHtml(value.data.caption)}</p>` : "";
  return `<section class="post-lead-player" data-post-lead-player aria-label="${name}">${content}${caption}</section>`;
}
