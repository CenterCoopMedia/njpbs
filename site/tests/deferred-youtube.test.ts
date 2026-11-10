import { expect, it } from "vitest";
import { deferYoutubeEmbeds } from "../src/lib/deferred-youtube-html";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";

const src = "https://www.youtube-nocookie.com/embed/tqG0Eyoi0EQ";
const frame = `<iframe src="${src}" title="NJ PBS News - YouTube video player" width="640" height="360" allow="autoplay; encrypted-media; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>`;

it("keeps the actual player and attributes while deferring its source and retaining noscript access", () => {
  const html = deferYoutubeEmbeds(`<h2>NJ PBS News</h2><div class="embed__frame">${frame}</div>`);
  expect(html).toContain(frame.replace(`src="${src}"`, `data-deferred-youtube-src="${src}"`));
  expect(html).toContain(`<noscript><style>iframe[data-deferred-youtube-src]{display:none!important}</style>${frame}</noscript>`);
  expect(deferYoutubeEmbeds(html)).toBe(html);
  expect(hasVideoPlayer(html)).toBe(true);
  expect(hasVideoPlayer(`<iframe data-deferred-youtube-src="${src}"></iframe>`)).toBe(true);
});

it("leaves other providers, unsafe sources, existing noscript frames and escaped examples alone", () => {
  for (const value of [frame.replace(src, "https://player.pbs.org/widget/partnerplayer/fixture/"),
    frame.replace(src, "https://www.youtube-nocookie.com.evil.example/embed/tqG0Eyoi0EQ"),
    frame.replace(src, "https://user:password@www.youtube-nocookie.com/embed/tqG0Eyoi0EQ"),
    `<noscript>${frame}</noscript>`, `<script>const example = '${frame}';</script>`,
    `<!-- ${frame} -->`, `<template>${frame}</template>`,
    `<iframe srcdoc="${frame.replaceAll('"', '&quot;')}"></iframe>`,
    frame.replaceAll("<", "&lt;").replaceAll(">", "&gt;")]) {
    expect(deferYoutubeEmbeds(value)).toBe(value);
  }
  expect(deferYoutubeEmbeds(frame.replace(src, `${src}?start=90`))).toContain(`data-deferred-youtube-src="${src}?start=90"`);
});
