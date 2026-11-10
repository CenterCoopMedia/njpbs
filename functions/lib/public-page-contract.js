"use strict";

// Deployment-safe CommonJS mirror of the page-id -> editor-template contract in
// packages/content-core/src/public-pages.ts. Firebase uploads the functions directory as its
// own source bundle, so it cannot require the TypeScript module outside that boundary. The
// public-page registry test compares this object to every shared-core entry and fails if either
// side changes alone, following the same parity pattern as content-blocks.js.
const PAGE_EDITOR_TEMPLATES = Object.freeze({
  "data-hub": "genericPage",
  home: "home",
  watch: "programLanding",
  live: "programLanding",
  schedule: "programLanding",
  kids: "programLanding",
  support: "programLanding",
  give: "programLanding",
  passport: "programLanding",
  about: "programLanding",
  staff: "genericPage",
  contact: "genericPage",
  faq: "genericPage",
  accessibility: "genericPage",
  "closed-captioning": "genericPage",
  privacy: "genericPage",
  "public-file": "genericPage",
  eeo: "genericPage",
  "public-meetings": "genericPage",
});

// Mirror of each page's `area` in the same shared-core registry. This is the page's
// server-owned content section for scoped grants (#619) -- the editorial desk the page
// belongs to, not its block palette. The parity test compares it entry by entry.
const PAGE_SECTIONS = Object.freeze({
  "data-hub": "station",
  home: "station",
  watch: "watch",
  live: "watch",
  schedule: "watch",
  kids: "watch",
  support: "support",
  give: "support",
  passport: "support",
  about: "station",
  staff: "station",
  contact: "station",
  faq: "support",
  accessibility: "compliance",
  "closed-captioning": "compliance",
  privacy: "compliance",
  "public-file": "compliance",
  eeo: "compliance",
  "public-meetings": "compliance",
});

// Public route and frame identity for the read-only runtime projection. Keep
// this mirror beside the existing template and desk mirrors so one canonical
// page id cannot acquire a different public address at the Functions boundary.
// site/tests/public-pages.test.ts pins every field to public-pages.ts.
const PUBLIC_PAGE_DEFINITIONS = Object.freeze({
  "data-hub": Object.freeze({ path: "/data-hub/", family: "dataHub" }),
  home: Object.freeze({ path: "/", family: "home" }),
  watch: Object.freeze({ path: "/watch/", family: "service" }),
  live: Object.freeze({ path: "/live/", family: "service" }),
  schedule: Object.freeze({ path: "/schedule/", family: "schedule" }),
  kids: Object.freeze({ path: "/kids/", family: "service" }),
  support: Object.freeze({ path: "/support/", family: "service" }),
  give: Object.freeze({ path: "/give/", family: "service", aliases: Object.freeze(["/donate/"]) }),
  passport: Object.freeze({ path: "/passport/", family: "service" }),
  about: Object.freeze({ path: "/about/", family: "service" }),
  staff: Object.freeze({ path: "/staff/", family: "staff" }),
  contact: Object.freeze({ path: "/contact/", family: "article" }),
  faq: Object.freeze({ path: "/faq/", family: "article" }),
  accessibility: Object.freeze({ path: "/accessibility/", family: "article" }),
  "closed-captioning": Object.freeze({ path: "/closed-captioning/", family: "article" }),
  privacy: Object.freeze({ path: "/privacy/", family: "article" }),
  "public-file": Object.freeze({ path: "/public-file/", family: "article" }),
  eeo: Object.freeze({ path: "/eeo/", family: "article" }),
  "public-meetings": Object.freeze({ path: "/meeting-notices/", family: "article", aliases: Object.freeze(["/public-meetings/"]) }),
});

function isCustomPageId(pageId) {
  return typeof pageId === "string" && /^page-[a-f0-9]{32}$/.test(pageId);
}

function editorTemplateForPage(pageId) {
  return Object.prototype.hasOwnProperty.call(PAGE_EDITOR_TEMPLATES, pageId)
    ? PAGE_EDITOR_TEMPLATES[pageId]
    : isCustomPageId(pageId) ? "genericPage" : null;
}

function contentSectionForPage(pageId) {
  return Object.prototype.hasOwnProperty.call(PAGE_SECTIONS, pageId)
    ? PAGE_SECTIONS[pageId]
    : null;
}

function publicPageDefinition(pageId) {
  if (!Object.prototype.hasOwnProperty.call(PUBLIC_PAGE_DEFINITIONS, pageId)) {
    return isCustomPageId(pageId) ? { id: pageId, template: "genericPage",
      section: null, path: `/${pageId}/`, family: "article" } : null;
  }
  return {
    id: pageId,
    template: PAGE_EDITOR_TEMPLATES[pageId],
    section: PAGE_SECTIONS[pageId],
    ...PUBLIC_PAGE_DEFINITIONS[pageId],
  };
}

const RESERVED_PAGE_SLUGS = new Set([
  "index", "posts", "authors", "shows", "coverage", "search", "wiki", "admin", "data-hub",
  "architecture", "design-system", "admin-docs", "api", "assets", "sitemap",
  "robots", "favicon", "404", "new", "edit", "preview", "prototype", "feed", "rss",
  // The legacy edge map intercepts these roots before the public renderer.
  // site/tests/public-pages.test.ts checks this list against the edge classifier.
  "about-teaching-channel-presents", "addiction", "all-programs", "anywhere", "app-support",
  "author", "blog", "blog-post", "broadway-and-beyond", "careers", "classroom-close-up-nj",
  "closed-meetings", "collection", "connect-with-njtv-for-new-jersey-news", "docs",
  "due-process", "eguide", "email-preferences", "events", "funder-spots", "help",
  "how-to-watch", "midtown-men-pledge-special", "neal-shapiro-statement-to-the-community",
  "nj-pbs-is-at-risk", "nj-spotlight-and-njtv-news-join-forces", "njnews", "njtv-benefit",
  "njtv-pressroom", "njvid", "on-the-record", "other", "ournj", "ournj-signup", "overview",
  "pbsoauth", "perspectives", "private-preview", "program-content", "programs",
  "rescuing-the-river", "resources", "search-results", "serving-new-jersey-into-the-future",
  "share-your-story", "shore-week", "statement-from-the-wnet-group",
  "survey-of-media-consumption-habits", "teaching-channel-season-three",
  "teaching-channel-season-two", "uncategorized", "whats-up-at-njtv", "why-sponsor", "x270",
  "x271", "x272", "x273", "x274", "x275", "x276", "x277", "x279", "x78",
  "your-election-2024",
]);

function isAvailablePageSlug(pageId, slug) {
  if (pageId === "data-hub") return slug === "data-hub";
  if (pageId === "home" || typeof slug !== "string" || slug.length > 80 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_PAGE_SLUGS.has(slug)) return false;
  const owner = slug === "donate" ? "give" : slug === "public-meetings" ? "public-meetings" : Object.entries(PUBLIC_PAGE_DEFINITIONS)
    .find(([, page]) => page.path === `/${slug}/`)?.[0];
  return owner === undefined || owner === pageId;
}

function publicPagePath(pageId, metadata) {
  const definition = publicPageDefinition(pageId);
  if (!definition) return null;
  if (pageId === "home") return metadata?.slug === undefined ? "/" : null;
  if (metadata?.slug === undefined) return isCustomPageId(pageId) ? null : definition.path;
  // Old snapshots keep their saved slug and content while using the renamed route.
  if (pageId === "public-meetings" && metadata.slug === "public-meetings") return definition.path;
  return isAvailablePageSlug(pageId, metadata.slug) ? `/${metadata.slug}/` : null;
}

module.exports = {
  isCustomPageId,
  isAvailablePageSlug,
  publicPagePath,
  PAGE_EDITOR_TEMPLATES,
  PAGE_SECTIONS,
  PUBLIC_PAGE_DEFINITIONS,
  editorTemplateForPage,
  contentSectionForPage,
  publicPageDefinition,
};
