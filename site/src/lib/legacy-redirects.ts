// Legacy njpbs.org URL classifier.
//
// WNET ran njpbs.org before the 2026-06-29 transfer to MSU. Roughly 3,500 legacy
// HTML paths are still indexed and backlinked, and they now 404 against the Astro
// site. A 404 reads as "may return", so Google retries it for months and burns crawl
// budget; a 410 Gone is permanent and drops out fast. This module decides, for one
// inbound path, whether it is a retired legacy URL (410), a hand-picked move (301), or
// something the origin should serve untouched.
//
// Pure and dependency-free on purpose. It is the tested source of truth (tests in
// site/tests/legacy-redirects.test.ts, under the repo's Vitest gate), and it runs
// unchanged at the edge: site/snippets/legacy-redirects/snippet.js imports classify
// from here and the deploy bundles that entrypoint into a Cloudflare Snippet.
// It reads the request path only; it never touches the network.
//
// Safe default: pass through. The classifier acts only on shapes it recognizes as
// legacy. A new top-level slug, static assets, the sitemap, and /give all return null
// and reach the origin unchanged.
//
// One exception needs care: the held-back families (/about, /kids, /schedule, ...) 410
// their children, because every such child is a legacy URL today; the content model is
// flat, one top-level slug per page. If a nested live route is ever added under one of
// them, add it to LIVE_EXACT, or pass a build-generated route set as opts.live; step 2
// then passes it through before the held-back rule can 410 it. That keeps the escape
// hatch explicit and testable rather than silently masking a new page.

/** The decision for one path. null means "pass through to the origin". */
export type LegacyDecision =
  | { action: "gone" }
  | { action: "redirect"; location: string }
  | null;

export interface ClassifyOptions {
  /** Override the hand-picked 301 map (default REDIRECTS_301). */
  redirects?: Record<string, string>;
  /**
   * Override the known-live route set (default LIVE_EXACT). Pass a build-generated set
   * at deploy so a nested live route under a held-back family passes through instead of
   * being 410'd.
   */
  live?: Set<string>;
}

// The live page routes plus the schedule PDF,
// normalized without a trailing slash. Listed as an explicit safety net: even if a
// rule below would match, a known-live route is never intercepted.
export const LIVE_EXACT: Set<string> = new Set([
  "/",
  "/about",
  "/accessibility",
  "/closed-captioning",
  "/contact",
  "/coverage",
  "/eeo",
  "/faq",
  "/give",
  "/kids",
  "/live",
  "/passport",
  "/privacy",
  "/public-file",
  "/meeting-notices",
  "/schedule",
  // The 14-day schedule PDF is the served child under /schedule.
  "/schedule/downloads/nj-pbs-schedule.pdf",
  "/support",
  "/watch",
]);

// Current public namespaces pass through before legacy shape rules.
// /shows redirects to /programs for its root and slug paths.
export const PROTECTED_NEW_PREFIXES: string[] = [
  "/posts",
  "/authors",
  "/shows",
  "/programs",
  "/events",
  "/wiki",
];

// Retired WNET namespaces still answered Gone at the root and below.
export const PURE_LEGACY_FAMILIES: string[] = [
  "/njtv-pressroom",
  "/pbsoauth",
];

// New-site routes that sit under an otherwise-legacy namespace and must pass through.
// Reserve the callback route before matching its otherwise-retired namespace.
// Passing an unavailable handler through yields a recoverable 404; a 410 would
// incorrectly mark the callback permanently retired.

export const RESERVED_EXACT: Set<string> = new Set([
  "/pbsoauth/callback",
]);

// The tail sweep: smaller pure-legacy WNET/WordPress namespaces, each with two or more
// indexed paths in the Wayback CDX inventory and no equivalent on the new site (its full
// live surface is the 18 routes in LIVE_EXACT, confirmed against the current sitemap).
// Gone at the root and below, like PURE_LEGACY_FAMILIES; kept as a separate list because
// the exclusions below apply to the entire group.
// Three groups:
//   - WordPress internals: /uncategorized (71 paths), /author archives (12), /blog-post
//     (60), /blog (2).
//   - Discontinued NJTV/WNET content sections: /perspectives opinion blog (57),
//     /whats-up-at-njtv (11, the pre-rebrand brand name), /njnews 2011-2012 news posts
//     (5), /program-content (14), /addiction 2017 microsite (10), /collection (the
//     discontinued "in your neighborhood" franchise, 8).
//   - The static NJPBSIS "positive behavior support in schools" microsite (.htm/.html
//     pages): /overview (11), /resources (4), /other (3), /about_us (3, the microsite's
//     own about, distinct from the live /about), /problem_solving (7),
//     /intervention_resources (7), /school_wide_pbs (6), /for_families (4),
//     /njpbsis_schools (4), /pbsis_initiative (3), /resources_for_parents (2).
//
// Three families in the tail are deliberately left to pass through, not 410'd:
//   - /podcast and /podcasts: NJ PBS still produces these series (Off Exit, Hazard NJ,
//     Jazz in Jersey), so live episode and series routes are plausible future additions;
//     a 410 would be premature.
//   - /images: an asset path (.jpg/.png/.gif), not a content namespace, so 410 Gone is the
//     wrong answer and could reply to a real asset request with Gone.
// All three follow the module's safe default. Fold one in here only after its status settles.
export const LEGACY_TAIL_FAMILIES: string[] = [
  "/uncategorized",
  "/author",
  "/blog-post",
  "/blog",
  "/perspectives",
  "/whats-up-at-njtv",
  "/njnews",
  "/program-content",
  "/addiction",
  "/collection",
  "/overview",
  "/resources",
  "/other",
  "/about_us",
  "/problem_solving",
  "/intervention_resources",
  "/school_wide_pbs",
  "/for_families",
  "/njpbsis_schools",
  "/pbsis_initiative",
  "/resources_for_parents",
];

// Held-back families whose bare path IS a live route (returned untouched at step 2)
// but whose legacy children are Gone. The new site has no live children under any of
// them: every content page is a flat top-level slug, and /schedule emits only its
// bare page, so /about/*, /kids/*, /live/*, /passport/*, /support/* and /schedule/*
// children 410. A genuine move for one of them belongs in REDIRECTS_301, checked first.
export const HELD_BACK_FAMILIES: string[] = [
  "/about",
  "/kids",
  "/live",
  "/passport",
  "/support",
  "/schedule",
];

// Hand-picked 301s: legacy path -> live destination. Add an entry only when the
// destination is a real live route that answers the same question;
// a 301 to an unrelated family root (e.g. /support/passport-faqs/... -> /support/) is a
// soft-404 to Google, so 410 is the more honest answer for a deep child with no home.
// The meeting-notices rename retains the former page route. See the runbook.
export const REDIRECTS_301: Record<string, string> = {
  "/all-programs": "/watch/",
  "/anywhere": "/watch/",
  "/app-support": "/contact/",
  "/closed-meetings": "/meeting-notices/",
  "/public-meetings": "/meeting-notices/",
  "/eguide": "/schedule/",
  "/help": "/contact/",
  "/how-to-watch": "/watch/",
  "/index.htm": "/",
  "/index.html": "/",
};

// Exact retired pages left after the family and shape rules. Each path had a pre-transfer
// HTML 200 in the legacy CDX inventory, has no current route with the same
// subject and user intent, and is specific enough that its 410 cannot shadow an unknown
// future namespace. This list includes retired WNET/NJTV pages, time-bound campaigns and
// programs, obsolete forms and integrations, and the remaining NJ PBSIS microsite pages.
// Asset namespaces stay out: /images and /stylesheets pass through. /podcast and /podcasts
// also stay out because NJ PBS still makes those series and may restore local routes.
export const LEGACY_SINGLETONS_410: Set<string> = new Set([
  "/about-teaching-channel-presents",
  "/accessibility_statement.html",
  "/api/ajax/ajax-hp-load-on-demand",
  "/broadway-and-beyond",
  "/careers",
  "/classroom-close-up-nj",
  "/coachs_network/index.htm",
  "/connect-with-njtv-for-new-jersey-news",
  "/docs",
  "/documentary/treblinkas-last-witness",
  "/due-process",
  "/email-preferences",
  "/email-preferences/confirmation",
  "/footers/pbsis-footer.html",
  "/funder-spots",
  "/leadershipforum/leadershipforum.html",
  "/links/index.htm",
  "/midtown-men-pledge-special",
  "/neal-shapiro-statement-to-the-community",
  "/newsletters/index.htm",
  "/nj-pbs-is-at-risk",
  "/nj-spotlight-and-njtv-news-join-forces",
  "/nj_success/index.htm",
  "/njtv-benefit",
  "/njvid",
  "/on-the-record",
  "/ournj",
  "/ournj-signup",
  "/private-preview",
  "/rescuing-the-river",
  "/search-results",
  "/search.htm",
  "/serving-new-jersey-into-the-future",
  "/sfmc-proxy/njpbs_preference",
  "/share-your-story",
  "/shore-week",
  "/sitemap.htm",
  "/statement-from-the-wnet-group",
  "/survey-of-media-consumption-habits",
  "/teaching-channel-season-three",
  "/teaching-channel-season-two",
  "/upcoming_events/index.htm",
  "/whats_new/index.htm",
  "/why-sponsor",
  "/x270",
  "/x271",
  "/x272",
  "/x273",
  "/x274",
  "/x275",
  "/x276",
  "/x277",
  "/x279",
  "/x78",
  "/your-election-2024",
]);

/** Normalize a path for matching: lowercase, collapse slashes, drop a trailing slash. */
function normalize(pathname: string): string {
  let p = (pathname || "/").toLowerCase().replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

function segments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

function underPrefix(segs: string[], prefix: string): boolean {
  return "/" + segs[0] === prefix;
}

/**
 * Classify one inbound path.
 * @param pathname the request path (no query string).
 * @param opts optional overrides for the redirect map and the live-route set.
 */
export function classify(pathname: string, opts: ClassifyOptions = {}): LegacyDecision {
  const redirects = opts.redirects || REDIRECTS_301;
  const live = opts.live || LIVE_EXACT;
  const p = normalize(pathname);
  const segs = segments(p);

  // 1. Hand-picked 301s win over everything.
  if (Object.prototype.hasOwnProperty.call(redirects, p)) {
    return { action: "redirect", location: redirects[p] };
  }

  // Redirect the former PDF namespace to the same filenames after the route rename.
  if (p.startsWith("/public-meetings/") && p.endsWith(".pdf")) {
    return { action: "redirect", location: pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "").replace(/^\/public-meetings\//i, "/meeting-notices/") };
  }

  // The former Program base redirects permanently. A retired slug then follows
  // its noindex stub under /programs/ to the current canonical page.
  if (p === "/shows") return { action: "redirect", location: "/programs/" };
  if (segs.length === 2 && segs[0] === "shows" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segs[1])) {
    return { action: "redirect", location: `/programs/${segs[1]}/` };
  }

  // 2. Known-live and reserved new-site routes are never touched. The live set is the
  //    escape hatch for a nested live route under a held-back family: the content model is
  //    flat today, but if a page like /about/leadership is ever added, listing it here (or
  //    passing a build-generated set via opts.live) passes it through before the held-back
  //    rule (step 7) can 410 it. Compare both slash forms so a build-generated set whose
  //    entries keep Astro's directory-format trailing slash still matches the normalized
  //    path. RESERVED_EXACT holds a new-site route that sits under an otherwise-legacy
  //    namespace (the PMSSO callback under the dead /pbsoauth namespace).
  if (live.has(p) || live.has(p + "/")) return null;
  if (RESERVED_EXACT.has(p)) return null;

  // 3. New-site namespaces with no legacy equivalent reach the origin, so a shape rule
  //    below never turns one into a 410.
  for (const prefix of PROTECTED_NEW_PREFIXES) {
    if (segs.length >= 2 && underPrefix(segs, prefix)) return null;
  }

  // 4. Exact residual legacy pages are Gone. A known-live route listed at step 2 still
  //    wins if a later site change deliberately reuses one of these paths.
  if (LEGACY_SINGLETONS_410.has(p)) return { action: "gone" };

  // 5. Retired families are Gone at the root and below.
  //    LEGACY_TAIL_FAMILIES are the same shape: smaller retired namespaces swept in from
  //    the CDX inventory (see their comment for the three families held back from this list).
  if (
    segs.length >= 1 &&
    (PURE_LEGACY_FAMILIES.includes("/" + segs[0]) ||
      LEGACY_TAIL_FAMILIES.includes("/" + segs[0]))
  ) {
    return { action: "gone" };
  }

  // 6. WordPress oEmbed endpoints (any *.../embed) are Gone.
  if (segs.length >= 2 && segs[segs.length - 1] === "embed") {
    return { action: "gone" };
  }

  // 7. Pagination stubs /page/<n> are Gone.
  if (segs.length === 2 && segs[0] === "page" && /^\d+$/.test(segs[1])) {
    return { action: "gone" };
  }

  // 8. Held-back family children (depth >= 2) are Gone; the bare path is a live route
  //    returned at step 2. /schedule is here: the static build serves only bare
  //    /schedule/, so /schedule/<child> is a legacy path, not a served route.
  if (segs.length >= 2 && HELD_BACK_FAMILIES.includes("/" + segs[0])) {
    return { action: "gone" };
  }

  // 9. Everything else reaches the origin unchanged.
  return null;
}
