// The public routes that make up the current NJ PBS site. The public build and the admin page
// directory consume this same small registry so the CMS starts from pages a viewer can actually
// visit instead of exposing Firestore record kinds as its information architecture.
//
// This is route identity and editorial grouping only. Page copy remains in launch-fallback.ts or
// the pages content collection until its editor family is connected. `family` names the public
// renderer. `editorTemplate` is deliberately separate from `id`: several real pages can share
// one block palette without sharing a Firestore document or overwriting one another (#537).

import type { SectionId } from "./editor-admin";

export type PublicPageFamily = "home" | "service" | "schedule" | "article" | "staff" | "dataHub";
export type PublicPageArea = "watch" | "support" | "station" | "compliance";

export interface PublicPageDefinition {
  id: string;
  title: string;
  path: string;
  family: PublicPageFamily;
  area: PublicPageArea;
  editorTemplate: SectionId;
  aliases?: readonly string[];
}

export const PUBLIC_SITE_ORIGIN = "https://njpbs.org";

export const PUBLIC_PAGES = [
  {
    id: "home",
    title: "Home",
    path: "/",
    family: "home",
    area: "station",
    editorTemplate: "home",
  },
  {
    id: "watch",
    title: "Watch NJ PBS",
    path: "/watch/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding",
  },
  {
    id: "live",
    title: "PBS Livestream",
    path: "/live/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding",
  },
  {
    id: "schedule",
    title: "Schedule",
    path: "/schedule/",
    family: "schedule",
    area: "watch",
    editorTemplate: "programLanding",
  },
  {
    id: "kids",
    title: "Kids",
    path: "/kids/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding",
  },
  {
    id: "support",
    title: "Support NJ PBS",
    path: "/support/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding",
  },
  {
    id: "give",
    title: "Give to NJ PBS",
    path: "/give/",
    aliases: ["/donate/"],
    family: "service",
    area: "support",
    editorTemplate: "programLanding",
  },
  {
    id: "passport",
    title: "NJ PBS Passport",
    path: "/passport/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding",
  },
  {
    id: "about",
    title: "About NJ PBS",
    path: "/about/",
    family: "service",
    area: "station",
    editorTemplate: "programLanding",
  },
  {
    id: "staff",
    title: "Staff",
    path: "/staff/",
    family: "staff",
    area: "station",
    editorTemplate: "genericPage",
  },
  {
    id: "contact",
    title: "Contact NJ PBS",
    path: "/contact/",
    family: "article",
    area: "station",
    editorTemplate: "genericPage",
  },
  {
    id: "faq",
    title: "NJ PBS transition FAQ",
    path: "/faq/",
    family: "article",
    area: "support",
    editorTemplate: "genericPage",
  },
  {
    id: "accessibility",
    title: "Accessibility statement",
    path: "/accessibility/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  {
    id: "closed-captioning",
    title: "Closed captioning",
    path: "/closed-captioning/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  {
    id: "privacy",
    title: "Privacy policy",
    path: "/privacy/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  {
    id: "public-file",
    title: "FCC public inspection files",
    path: "/public-file/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  {
    id: "eeo",
    title: "FCC EEO report",
    path: "/eeo/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  {
    id: "public-meetings",
    title: "Meeting notices",
    path: "/meeting-notices/",
    aliases: ["/public-meetings/"],
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage",
  },
  { id: "data-hub", title: "New Jersey by the Numbers", path: "/data-hub/", family: "dataHub", area: "station", editorTemplate: "genericPage" },
] as const satisfies readonly PublicPageDefinition[];

export type BuiltinPublicPageId = (typeof PUBLIC_PAGES)[number]["id"];
export type PublicPageId = BuiltinPublicPageId | `page-${string}`;

export function isCustomPageId(value: string): value is `page-${string}` {
  return /^page-[a-f0-9]{32}$/.test(value);
}

export const PUBLIC_PAGE_IDS: readonly BuiltinPublicPageId[] = PUBLIC_PAGES.map((page) => page.id);

export function isPublicPageId(value: string): value is PublicPageId {
  return (PUBLIC_PAGE_IDS as readonly string[]).includes(value) || isCustomPageId(value);
}

export function publicPage(id: string): PublicPageDefinition | undefined {
  return PUBLIC_PAGES.find((page) => page.id === id) ?? (isCustomPageId(id) ? {
    id, title: "New page", path: `/${id}/`, family: "article",
    area: "station", editorTemplate: "genericPage",
  } : undefined);
}

export function publicPageUrl(page: Pick<PublicPageDefinition, "path">): string {
  return `${PUBLIC_SITE_ORIGIN}${page.path}`;
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

export function isAvailablePageSlug(pageId: string, slug: unknown): slug is string {
  if (pageId === "data-hub") return slug === "data-hub";
  if (pageId === "home" || typeof slug !== "string" || slug.length > 80 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_PAGE_SLUGS.has(slug)) return false;
  const owner = PUBLIC_PAGES.find(page => page.path === `/${slug}/` ||
    ("aliases" in page && page.aliases.some(alias => alias === `/${slug}/`)));
  return owner === undefined || owner.id === pageId;
}

/** Resolve local addresses from the selected draft or immutable public snapshot. */
export function publicPagePath(id: string, metadata?: { slug?: unknown }): string | undefined {
  const definition = publicPage(id);
  if (!definition) return undefined;
  if (id === "home") return metadata?.slug === undefined ? "/" : undefined;
  if (metadata?.slug === undefined) return isCustomPageId(id) ? undefined : definition.path;
  // Old snapshots keep their saved slug and content while using the renamed route.
  if (id === "public-meetings" && metadata.slug === "public-meetings") return definition.path;
  return isAvailablePageSlug(id, metadata.slug) ? `/${metadata.slug}/` : undefined;
}

export function isPublicPagePath(pageId: string, path: unknown): path is string {
  if (!publicPage(pageId)) return false;
  if (pageId === "home") return path === "/";
  return typeof path === "string" && /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path)
    && isAvailablePageSlug(pageId, path.slice(1, -1));
}

export function publicPageAliases(page: PublicPageDefinition, canonicalPath: string, previousSlugs: readonly string[] = []): string[] {
  return [...new Set([...(page.aliases ?? []),
    ...(canonicalPath !== page.path && !isCustomPageId(page.id) ? [page.path] : []),
    ...previousSlugs.map(slug => `/${slug}/`),
  ])].filter(route => route !== canonicalPath).sort();
}
