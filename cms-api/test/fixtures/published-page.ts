import type { PublicPageProjection } from "../../src/index";

// Shared published Page fixture from public-content-rpc.test.ts.
export const LIVE: Extract<PublicPageProjection, { state: "live" }> = {
  apiVersion: 1,
  state: "live",
  page: {
    pageId: "contact",
    path: "/contact/",
    family: "article",
    template: "genericPage",
    title: "Published title",
    description: "Published description",
    homeHeroTitle: "Watch what matters",
    homeHeroSubtitle: "Stories from across New Jersey.",
    noindex: false,
    blocks: [],
    assets: {},
    contentMode: "published",
    sourceVersion: 7,
    publishedAt: "2026-08-25T12:00:00.000Z",
  },
};
