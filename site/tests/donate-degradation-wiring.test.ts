import { createHomeNewsletterBlock, renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewscastBlock, renderHomeNewscast } from "../../packages/content-core/src/home-newscast-section";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import newscastProvider from "./fixtures/home-sources/newscast-documented-schema.json";
import homeNewsletterCatalogFixture from "./fixtures/home-v2-selections.json";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import { readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
// Inventory donation render boundaries and require every direct target and
// transitive CMS link sink to remain covered. A source/count change requires an
// explicit inventory update; fallback coverage must match the actual renderers.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseBlocks,
  renderRichText,
  type RichTextDoc,
} from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { HOME_PASSPORT_CONTENT, renderHomePassport, renderHomeStart } from "../../packages/content-core/src/home-section-render";
import { adaptHomePassport } from "../../packages/content-core/src/home-newsletter-source";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import { renderPostMediaPlayer } from "../../packages/content-core/src/post-media-player";
import { LIVE_BLOG_SPECIMEN } from "./fixtures/live-blog";
import { createHomeDonorBlock, renderHomeDonor } from "../../packages/content-core/src/home-donor-section";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { renderHomeProgramRail, renderHomeNewsRail } from "../../packages/content-core/src/home-rail-render";
import { projectCmsServicePage } from "../../packages/content-core/src/cms-service-page";
import { renderServiceActions, renderServiceCards, renderServiceCopy, renderServiceNotice } from "../../packages/content-core/src/cms-service-render";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import { resolveSiteNavigation } from "../../packages/content-core/src/site-navigation";
import { donateUrl, launchFallbackPages } from "../src/data/launch-fallback";
import { figureProjection } from "./fixtures/shadow-posts/block-catalog";
import { electionRace } from "../../tests/fixtures/election-results";
import { renderNjDecidesBand } from "../../packages/content-core/src/nj-decides-render";
import { COUNTY_COMPARISON_DEFAULTS } from "../../packages/content-core/src/county-comparison";
import { resolveDonateCta } from "../src/lib/donate-degradation";
import { SURFACES_WITH_FALLBACK } from "../src/lib/pbs-outage-survivability";

// Built where used, not at module top level: under the happy-dom test env a
// top-level import.meta.url is not yet a file: URL (see schedule-degradation-wiring).
const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const discoverSourceFiles = (
  relativeRoot: string,
  cwdCandidates: ReadonlyArray<string>,
) => {
  const rootUrl = new URL(relativeRoot, import.meta.url);
  // happy-dom exposes Vite's /@fs/ URL rather than a file: URL. Normalize that
  // test-runner form while keeping ordinary Node/Vitest file URLs cwd-independent.
  const urlRoot =
    rootUrl.protocol === "file:"
      ? fileURLToPath(rootUrl)
      : rootUrl.pathname.replace(/^\/@fs/, "");
  const root = [urlRoot, ...cwdCandidates].find((candidate) =>
    existsSync(candidate),
  );
  if (!root) {
    throw new Error(
      `Could not locate ${relativeRoot} for donate-link discovery`,
    );
  }
  const extensions = new Set([".astro", ".json", ".md", ".ts"]);
  const files: Array<{ path: string; source: string }> = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (extensions.has(extname(entry.name))) {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };

  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const discoverSiteSourceFiles = () =>
  [...discoverSourceFiles("../src/", [
    join(process.cwd(), "src"),
    join(process.cwd(), "site", "src"),
  ]), ...discoverContentCoreSourceFiles()
    .filter(file => ["launch-fallback.ts", "cms-service-page.ts", "cms-service-render.ts", "site-navigation.ts"].includes(file.path))
    .map(file => ({ ...file, path: `shared/${file.path}` }))];

const discoverContentCoreSourceFiles = () =>
  discoverSourceFiles("../../packages/content-core/src/", [
    join(process.cwd(), "../packages/content-core/src"),
    join(process.cwd(), "packages/content-core/src"),
  ]);

const countMatches = (source: string, binding: RegExp) =>
  source.match(binding)?.length ?? 0;

const inventoryReferences = (
  files: ReadonlyArray<{ path: string; source: string }>,
  binding: RegExp,
) =>
  Object.fromEntries(
    files
      .map((file) => [file.path, countMatches(file.source, binding)] as const)
      .filter(([, count]) => count > 0),
  );

const DONATION_CARRIER_BINDING =
  /\b(?:donateHref|giveHref|launchUtilityLinks|launchFallbackPages|launchFallbackRoutePages|fallbackPages|footerCols|cmsServicePage)\b/g;
const PUBLIC_SUBPAGE_DONATION_CARRIER_BINDING =
  /\b(?:details|detail|card)\b|\bpage\.(?:primaryAction|secondaryAction)\b/g;
const FALLBACK_ROUTE_DONATION_CARRIER_BINDING =
  /\bframe\b|\bpage\.(?:primaryAction|secondaryAction)\b/g;

const inventoryDonationCarriers = (
  files: ReadonlyArray<{ path: string; source: string }>,
) =>
  Object.fromEntries(
    files
      .map((file) => {
        const globalCarriers = countMatches(
          file.source,
          DONATION_CARRIER_BINDING,
        );
        const publicSubpageCarriers =
          file.path === "components/PublicSubpage.astro"
            ? countMatches(file.source, PUBLIC_SUBPAGE_DONATION_CARRIER_BINDING)
            : 0;
        const fallbackRouteCarriers =
          ["pages/[...slug].astro", "shared/cms-service-page.ts"].includes(file.path)
            ? countMatches(file.source, FALLBACK_ROUTE_DONATION_CARRIER_BINDING)
            : 0;
        return [
          file.path,
          globalCarriers + publicSubpageCarriers + fallbackRouteCarriers,
        ] as const;
      })
      .filter(([, count]) => count > 0),
  );

/**
 * Every source that turns the donation URL into a visitor-visible link. Each
 * entry names the complete landmark chain for one site: both the direct target
 * binding and the renderer that emits it where those are separate expressions.
 *
 * Header and footer stay separate even though they currently share `donateHref`.
 * Likewise, the page actions and donation cards name their actual render
 * expressions rather than relying only on the data objects that feed them.
 */
const unwiredRenderSites: ReadonlyArray<{
  name: string;
  source: string;
  landmarks: ReadonlyArray<{
    name: string;
    binding: RegExp;
    occurrences: number;
  }>;
}> = [
  {
    name: "shell header donate button (PublicSiteLayout)",
    source: "../src/layouts/PublicSiteLayout.astro",
    landmarks: [
      {
        name: "direct public target",
        binding: /const donateHref = donateUrl;/g,
        occurrences: 1,
      },
      {
        name: "header anchor",
        binding: /class="donate"\s+href=\{donateHref\}/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "shell footer donate link (PublicSiteLayout)",
    source: "../src/layouts/PublicSiteLayout.astro",
    landmarks: [
      {
        name: "direct public target",
        binding: /const donateHref = donateUrl;/g,
        occurrences: 1,
      },
      {
        name: "Support-column link resolved from the site navigation donate target",
        binding: /\bresolveSiteNavigation\(/g,
        occurrences: 1,
      },
      {
        name: "shared footer link anchors",
        binding: /href=\{l\.href\}/g,
        occurrences: 2,
      },
    ],
  },
  {
    name: "home hero give CTA (CinematicHomePage)",
    source: "../src/components/CinematicHomePage.astro",
    landmarks: [
      {
        name: "direct public target",
        binding: /const giveHref = donateUrl;/g,
        occurrences: 1,
      },
      {
        name: "shared hero target forwarding",
        binding: /giveHref=\{giveHref\}/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "home hero give anchor (HomeHero)",
    source: "../src/components/HomeHero.astro",
    landmarks: [{ name: "fallback donation anchor", binding: /class="btn btn--ghost"\s+href=\{giveHref\}/g, occurrences: 1 }],
  },
  {
    name: "donation-page primary action buttons (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "primary-action anchors",
        binding: /href=\{page\.primaryAction\.href\}/g,
        occurrences: 2,
      },
    ],
  },
  {
    name: "donation-capable secondary action buttons (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "secondary-action anchors",
        binding: /href=\{page\.secondaryAction\.href\}/g,
        occurrences: 2,
      },
    ],
  },
  {
    name: "donation-capable static section action links (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "section-action anchor",
        binding: /href=\{action\.href\}/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "support/donate/default donation card targets (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "primary-action card targets",
        binding: /href: page\.primaryAction\.href,/g,
        occurrences: 3,
      },
    ],
  },
  {
    name: "give/passport donation card targets (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "direct card targets",
        binding: /href: donateUrl,/g,
        occurrences: 2,
      },
    ],
  },
  {
    name: "donation-capable static card renderer (PublicSubpage)",
    source: "../src/components/PublicSubpage.astro",
    landmarks: [
      {
        name: "shared card anchor",
        binding: /href=\{card\.href\}/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "shared CMS service action and card links",
    source: "../../packages/content-core/src/cms-service-render.ts",
    landmarks: [
      { name: "validated link target", binding: /const href = safeHref\(action\.href\);/g, occurrences: 1 },
      { name: "shared anchor", binding: /<a href="\$\{escapeHtml\(href\)\}"/g, occurrences: 1 },
    ],
  },
  {
    name: "FAQ donation portal link",
    source: "../src/content/pages/faq.md",
    landmarks: [
      {
        name: "rendered PBS donation anchor",
        binding: /<a href="https:\/\/www\.pbs\.org\/donation\/\?[^"]+"/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS rich-text link renderer",
    source: "../../packages/content-core/src/content-model.ts",
    landmarks: [
      {
        name: "dynamic rich-text target",
        binding: /const href = safeHref\(mark\.attrs\?\.href\);/g,
        occurrences: 1,
      },
      {
        name: "rich-text anchor",
        binding:
          /html = href\s+\? `<a href="\$\{escapeHtml\(href\)\}"\$\{legacyHostOptIn\}\$\{externalAttributes\}>\$\{html\}\$\{externalNotice\}<\/a>`\s+: html;/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS button renderer",
    source: "../../packages/content-core/src/content-render.ts",
    landmarks: [
      {
        name: "dynamic button target",
        binding: /const href = safeHref\(cta\.href\);/g,
        occurrences: 1,
      },
      {
        name: "button anchor",
        binding: /return `<a class="btn \$\{variantClass\}"\$\{hrefAttr\}>/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS card renderer",
    source: "../../packages/content-core/src/content-render.ts",
    landmarks: [
      {
        name: "dynamic card target",
        binding: /case "card_grid": \{[\s\S]*?const href = safeHref\(card\.href\);/g,
        occurrences: 1,
      },
      {
        name: "card anchor",
        binding: /<a href="\$\{escapeHtml\(href\)\}"\$\{newTab \? EXTERNAL_LINK_ATTRIBUTES : ""\}>\$\{title\}\$\{newTab \? EXTERNAL_LINK_NOTICE : ""\}<\/a>/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS custom-shelf card renderer",
    source: "../../packages/content-core/src/content-render.ts",
    landmarks: [
      {
        name: "dynamic custom-shelf card target",
        binding: /export function renderCustomShelf[\s\S]*?const href = safeHref\(card\.href\);/g,
        occurrences: 1,
      },
      {
        name: "custom-shelf card anchor",
        binding: /class="custom-shelf__card" draggable="false" href="\$\{escapeHtml\(href\)\}"/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS embed-link renderer",
    source: "../../packages/content-core/src/content-render.ts",
    landmarks: [
      {
        name: "dynamic embed target",
        binding: /const href = safeHref\(block\.data\.url\);/g,
        occurrences: 1,
      },
      {
        name: "embed anchor",
        binding: /`<a href="\$\{escapeHtml\(href\)\}">\$\{label\}<\/a>`/g,
        occurrences: 1,
      },
    ],
  },
  {
    name: "CMS bio card source renderer",
    source: "../../packages/content-core/src/bio-render.ts",
    landmarks: [
      { name: "validated public bio data", binding: /if \(!isBioCardData\(data, true\)\) return "";/g, occurrences: 1 },
      { name: "source anchor", binding: /<a href="\$\{escapeHtml\(data\.sourceUrl\)\}">/g, occurrences: 1 },
    ],
  },
  {
    name: "CMS data-table source renderer",
    source: "../../packages/content-core/src/data-table-render.ts",
    landmarks: [
      {
        name: "dynamic source target",
        binding: /const href = data\.sourceHref\.trim\(\) \? safeHref\(data\.sourceHref\) : null;/g,
        occurrences: 1,
      },
      {
        name: "source anchor",
        binding: /<a href="\$\{escapeHtml\(href\)\}">\$\{escapeHtml\(data\.source\)\}<\/a>/g,
        occurrences: 1,
      },
    ],
  },
];

/** Derive donation action slots from both page actions so added donation
 * destinations join the inventory automatically. */
const donatePageActionSlots = Object.values(launchFallbackPages)
  .flatMap((page) => [
    ...(page.primaryAction.href === donateUrl ? [`${page.slug}:primary`] : []),
    ...(page.secondaryAction?.href === donateUrl
      ? [`${page.slug}:secondary`]
      : []),
  ])
  .sort();

/** The donate action slots known when this guard was written, sorted for a stable compare. */
const expectedDonatePageActionSlots = [
  "donate:primary",
  "give:primary",
  "passport:primary",
  "support:primary",
];

/**
 * Conservative source inventory: any new static reference to the configured
 * donation target fails until it is classified above. Counts include imports and
 * explanatory policy comments on purpose; accepting a little review noise keeps
 * a new render source from bypassing the worklist merely because it lives in a
 * file the hand-written landmark list did not know about.
 */
const expectedDonateUrlIdentifierReferences: Readonly<Record<string, number>> =
  {
    "components/CinematicHomePage.astro": 2,
    "components/PublicSubpage.astro": 3,
    "shared/launch-fallback.ts": 6,
    "shared/site-navigation.ts": 2,
    "layouts/PublicSiteLayout.astro": 2,
    "lib/analytics-consent.ts": 2,
    "lib/donate-degradation.ts": 1,
  };

const expectedLiteralDonationReferences: Readonly<Record<string, number>> = {
  "content/pages/faq.md": 1,
  "shared/launch-fallback.ts": 1,
};

const expectedDonationCarrierReferences: Readonly<Record<string, number>> = {
  "components/CinematicHomePage.astro": 3,
  "components/HomeHero.astro": 3,
  "components/PublicSubpage.astro": 55,
  "shared/launch-fallback.ts": 4,
  "layouts/PublicSiteLayout.astro": 4,
  "shared/cms-service-page.ts": 5,
  // The public context frame resolves the same launch fallback through three additional bindings.
  "pages/[...slug].astro": 18,
};

// safe-href.ts is where the sanitizer itself now lives; content-model.ts re-exports it
// and checks the manually entered links in a publishable promotion playlist.
// dynamic-shelf-resolve.ts calls it in the eligibility check that decides whether a catalog
// item may become a card, which is the only reason a shelf link ever reaches the page --
// a shelf destination comes from the approved catalog, never from a field an editor
// types, so neither dynamic block is a place a stored donation target can appear.
// cms-settings.ts checks stored site navigation links on save, and site-navigation.ts
// checks every resolved navigation href again before the layout renders it. The
// footer Donate link resolves from the typed donate launch target there.
// Coverage labels add one stored-link validation boundary; their optional page
// link uses the same safe href admission before the shared pill renderer.
const expectedCmsSafeHrefReferences: Readonly<Record<string, number>> = {
  "cms-service-page.ts": 2,
  "cms-service-render.ts": 1,
  "cms-settings.ts": 4,
  "content-model.ts": 5,
  "content-render.ts": 11,
  "coverage-list.ts": 1,
  "data-table-render.ts": 1,
  "data-table.ts": 1,
  "dynamic-shelf-resolve.ts": 2,
  "home-hero.ts": 1,
  "home-published-sources.ts": 1,
  // Feed artwork uses homeSourceImage/spotlightStoryImage. Rail destinations
  // still pass through the home-section-render link boundary below.
  "home-section-render.ts": 2,
  // Brand artwork checks image URLs; the band renderer owns its clickable CTA.
  "nj-decides-brand.ts": 1,
  "nj-decides-render.ts": 1,
  "post-interactive.ts": 1,
  // Lead URL admission is validated here; the shared lead/entry player owns the link.
  "post-lead-media.ts": 1,
  "post-media.ts": 1,
  "post-media-player.ts": 1,
  "safe-href.ts": 2,
  "site-navigation.ts": 1,
};

const expectedCmsRichTextRendererReferences: Readonly<Record<string, number>> =
  {
    "cms-service-page.ts": 5,
    "content-model.ts": 1,
    "content-render.ts": 4,
    "home-newsletter-source.ts": 1,
    "home-section-render.ts": 1,
    "live-blog-follow-ups-render.ts": 1,
    "live-blog-render.ts": 1,
  };

const expectedCmsAnchorEmitters: Readonly<Record<string, number>> = {
  "bio-render.ts": 1,
  "cms-service-render.ts": 1,
  "content-model.ts": 1,
  "content-render.ts": 11,
  // Row fragments and reviewed DOE/GIS sources only; executable exemption below.
  "county-comparison-render.ts": 3,
  "coverage-list.ts": 1,
  "data-table-render.ts": 1,
  "data-figure-render.ts": 1,
  // Three existing constructors (race jumps, source and AP) plus the reviewed
  // candidate-link helper, whose URLs come only from the fixed 2026 roster map.
  "election-results-render.ts": 4,
  "home-editorial-render.ts": 2,
  "home-curated-render.ts": 1,
  // Fixed local Support navigation, not a donation-form sink. The executable
  // exemption below rejects a stored donation target in both render modes.
  "home-donor-section.ts": 1,
  "home-newsletter-section.ts": 2,
  // Closed PBS episode/program + local Live destinations; executable refusal below.
  "home-newscast-section.ts": 5,
  "home-rail-render.ts": 6,
  "home-section-render.ts": 2,
  // Follow-up permalinks also target validated local fragment ids.
  "live-blog-follow-ups-render.ts": 1,
  // Key-update and permalink links target the entry's own fragment id; never a stored destination.
  "live-blog-render.ts": 2,
  // Published author routes only: card link and no-script portrait fallback.
  "live-blog-reporters-render.ts": 2,
  "live-player-render.ts": 3,
  "nj-decides-render.ts": 1,
  "post-media-player.ts": 2,
  "schedule-now-next-render.ts": 4,
  // Reviewed election/GIS source links only; editable copy cannot set an href.
  "town-lookup-render.ts": 3,
};

const donationRichText: RichTextDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Donate",
          marks: [{ type: "link", attrs: { href: donateUrl } }],
        },
      ],
    },
  ],
};

const renderCmsBlock = (type: string, data: Record<string, unknown>, options: Parameters<typeof renderBlock>[1] = {}) => {
  const parsed = parseBlocks([
    { id: "donate-worklist", type, order: 0, visible: true, data },
  ]);
  if (!parsed.ok) {
    throw new Error(`Invalid donate worklist fixture: ${parsed.error}`);
  }
  return renderBlock(parsed.blocks[0], options);
};

const donationHeroCard = { id: "donate", title: "Donate", summary: "", href: donateUrl };
const ordinaryHeroCard = { id: "story", title: "A story", summary: "", href: "/about/" };
const donationGridSettings = { title: "Support", moreLabel: "Donate", presentation: "grid", columns: 3 } as const;

const cmsDonationFixtures = [
  {
    name: "NJ Decides band call to action",
    render: () => renderNjDecidesBand({ links: [{ label: "Donate", href: donateUrl }] }),
  },
  {
    name: "Home published Newsletter signup link",
    render: () => renderHomeNewsletter({ ...createHomeNewsletterBlock("donation-newsletter"), data: {
      newsletterIds: ["approved-donation-link"], actionLabel: "Sign up by email", selectionReceipt: homeNewsletterCatalogFixture.editorial.receipt,
    } }, readHomeEditorialCatalog({ ...homeNewsletterCatalogFixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot([{
      id: "approved-donation-link", kind: "newsletter", href: null, sourceVersion: 1,
      newsletter: { card: { title: "Approved Newsletter boundary", signupUrl: donateUrl } },
    }], homeNewsletterCatalogFixture.editorial.catalog.cutoffAt, homeNewsletterCatalogFixture.editorial.catalog.cutoffAt) } })),
  },
  {
    name: "Live blog entry rich text",
    render: () => renderLiveBlog({ ...LIVE_BLOG_SPECIMEN, updates: [{ ...LIVE_BLOG_SPECIMEN.updates[0], body: donationRichText }] },
      { id: "donation-live-blog", asOf: LIVE_BLOG_SPECIMEN.updatedAt }),
  },
  {
    name: "Live blog follow-up rich text",
    render: () => renderLiveBlog({ ...LIVE_BLOG_SPECIMEN, updates: [{ ...LIVE_BLOG_SPECIMEN.updates[0], followUps: [{
      id: "donation-follow-up", body: donationRichText, credits: LIVE_BLOG_SPECIMEN.updates[0].credits,
      publishedAt: LIVE_BLOG_SPECIMEN.updates[0].publishedAt, updatedAt: LIVE_BLOG_SPECIMEN.updates[0].updatedAt,
    }] }] }, { id: "donation-live-blog-follow-up", asOf: LIVE_BLOG_SPECIMEN.updatedAt }),
  },
  {
    name: "Post lead or entry linked-video player",
    render: () => renderPostMediaPlayer({ kind: "linked-video", data: { url: donateUrl, title: "Donate" } }),
  },
  {
    name: "Live blog entry linked-video attachment",
    render: () => renderLiveBlog({ ...LIVE_BLOG_SPECIMEN, updates: [{ ...LIVE_BLOG_SPECIMEN.updates[0],
      media: { kind: "linked-video", data: { url: donateUrl, title: "Donate" } } }] },
    { id: "donation-live-blog-media", asOf: LIVE_BLOG_SPECIMEN.updatedAt,
      renderMedia: media => media.kind === "image" ? "" : renderPostMediaPlayer(media) }),
  },
  {
    name: "Home Passport source rich text",
    render: () => adaptHomePassport({ ...HOME_PASSPORT_CONTENT, body: donationRichText }).content!.bodyHtml,
  },
  {
    name: "Home editorial lead link",
    render: () => renderHomeEditorialHero([donationHeroCard]),
  },
  {
    name: "Home editorial supporting link",
    render: () => renderHomeEditorialHero([ordinaryHeroCard, donationHeroCard]),
  },
  {
    name: "Home editorial overflow link",
    render: () => renderHomeEditorialHero([ordinaryHeroCard, { ...ordinaryHeroCard, id: "second" }, donationHeroCard], { supportingCount: 1 }),
  },
  {
    name: "Home program grid card link",
    render: () => renderHomeProgramRail("featured", [{ title: "Donate", description: "", href: donateUrl, index: 0 }], "/watch/", true, donationGridSettings),
  },
  {
    name: "Home program grid heading link",
    render: () => renderHomeProgramRail("more", [], donateUrl, true, donationGridSettings),
  },
  {
    name: "Home news grid card link",
    render: () => renderHomeNewsRail([{ title: "Donate", href: donateUrl, category: "", image: "/news.webp" }], donationGridSettings),
  },
  {
    name: "PDF notice asset link",
    blockType: "document_list",
    render: () => renderCmsBlock("document_list", {
      documents: [{ itemId: "notice", assetId: "notice-pdf", title: "Donate", addedAt: "2026-10-07T12:00:00.000Z" }],
    }, { resolveAsset: () => ({ url: donateUrl, mimeType: "application/pdf" }) }),
  },
  {
    name: "bio card source link",
    blockType: "bio_card",
    render: () => renderCmsBlock("bio_card", {
      profileId: "example-person", kind: "person", name: "Example Person", role: "State senator",
      summary: "Previously served on the local council.", sourceUrl: donateUrl,
      sourceLabel: "Source", asOf: "2026-10-03",
    }, { allowBios: true }),
  },
  {
    name: "sponsor strip website link",
    blockType: "sponsor_strip",
    render: () => renderCmsBlock("sponsor_strip", { sponsorIds: ["donate-sponsor"], layout: "row" }, {
      sponsors: [{ sponsorId: "donate-sponsor", name: "Donate", href: donateUrl, logoUrl: null, logoAlt: "", logoDecorative: false }],
    }),
  },
  {
    name: "newsletter provider signup link",
    blockType: "newsletter_signup",
    render: () => renderCmsBlock("newsletter_signup", { newsletterIds: ["donate-newsletter"] }, {
      resolveNewsletter: () => ({ title: "Donate", signupUrl: donateUrl }),
    }),
  },
  ...["give", "about"].flatMap(pageId => {
    const seed = pageCompositionSeed(pageId as "give" | "about")!;
    const blocks = seed.blocks.map(block => block.type === "cta_row"
      ? { ...block, data: { ...block.data, ctas: block.data.ctas.map(cta => ({ ...cta, href: donateUrl })) } }
      : block.type === "card_grid"
        ? { ...block, data: { ...block.data, cards: block.data.cards.map(card => ({ ...card, href: donateUrl, body: donationRichText })) } }
        : block.type === "prose" ? { ...block, data: { content: donationRichText } } : block);
    const frame = launchFallbackPages[pageId];
    const service = projectCmsServicePage({ frame, title: frame.title, description: frame.description, blocks, assets: {} });
    return [
      { name: `${pageId} shared service actions`, render: () => renderServiceActions(service) },
      ...(pageId === "give" ? [{ name: "give shared service cards", render: () => renderServiceCards(service) }] : []),
      { name: `${pageId} shared service rich text and sections`, render: () => renderServiceCopy(service) },
      ...(pageId === "give" ? [{ name: "giving notice links", render: () => renderServiceNotice(service) }] : []),
    ];
  }),
  {
    name: "Home program card link",
    render: () => renderHomeProgramRail("featured", [{ title: "Donate", description: "", href: donateUrl, index: 0 }], "/watch/"),
  },
  {
    name: "Home rail heading and final action links",
    render: () => renderHomeProgramRail("more", [], donateUrl),
  },
  {
    name: "Home news card link",
    render: () => renderHomeNewsRail([{ title: "Donate", href: donateUrl, category: "", image: "/news.webp" }]),
  },
  {
    name: "Home pathway link",
    render: () => renderHomeStart([{ show: "Donate", href: donateUrl }], "/schedule/"),
  },
  {
    name: "Home section action",
    render: () => renderHomeStart([], donateUrl),
  },
  {
    name: "Home Passport action",
    render: () => renderHomePassport(HOME_PASSPORT_CONTENT, donateUrl),
  },
  {
    name: "Home Passport body link",
    render: () => renderHomePassport({ ...HOME_PASSPORT_CONTENT, body: donationRichText }, "/passport/"),
  },
  {
    name: "rich-text link",
    render: () => renderRichText(donationRichText),
  },
  {
    name: "prose link",
    blockType: "prose",
    render: () => renderCmsBlock("prose", { content: donationRichText }),
  },
  {
    name: "button link",
    blockType: "cta_row",
    render: () =>
      renderCmsBlock("cta_row", {
        ctas: [{ label: "Donate", href: donateUrl }],
      }),
  },
  {
    name: "Post support appeal button link",
    blockType: "support_appeal",
    render: () => renderCmsBlock("support_appeal", {
      heading: "Support NJ PBS", copy: "Independent local reporting.",
      buttonLabel: "Donate", href: donateUrl, style: "blue",
    }),
  },
  {
    name: "card title link",
    blockType: "card_grid",
    render: () =>
      renderCmsBlock("card_grid", {
        cards: [{ title: "Donate", href: donateUrl }],
      }),
  },
  {
    name: "card body link",
    blockType: "card_grid",
    render: () =>
      renderCmsBlock("card_grid", {
        cards: [{ title: "Donate", body: donationRichText }],
      }),
  },
  {
    name: "manual content shelf card link",
    blockType: "promotion_playlist",
    render: () =>
      renderCmsBlock("promotion_playlist", {
        title: "Support NJ PBS",
        presentation: "rail",
        columns: 2,
        placement: "before_featured",
        cards: [
          {
            itemId: "donate",
            title: "Donate",
            summary: "Support NJ PBS",
            imageAssetId: "donate-image",
            alt: "NJ PBS",
            href: donateUrl,
          },
        ],
      }),
  },
  {
    name: "FAQ answer link",
    blockType: "faq_item",
    render: () =>
      renderCmsBlock("faq_item", {
        question: "How can I donate?",
        answer: donationRichText,
      }),
  },
  {
    name: "embed link",
    blockType: "embed",
    render: () =>
      renderCmsBlock("embed", {
        url: donateUrl,
        caption: "Donate",
      }),
  },
  {
    name: "content shelf more link",
    blockType: "content_shelf",
    render: () =>
      renderCmsBlock("content_shelf", {
        title: "Support NJ PBS",
        source: "pbs_featured",
        itemLimit: 4,
        moreLabel: "Donate",
        moreHref: donateUrl,
      }),
  },
  {
    name: "data table source link",
    blockType: "data_table",
    render: () =>
      renderCmsBlock("data_table", {
        title: "Giving by county",
        csv: "County,Donations\nEssex,100",
        source: "Donate",
        sourceHref: donateUrl,
      }),
  },
  {
    name: "data figure source and comparison links",
    blockType: "data_figure",
    render: () => renderCmsBlock("data_figure", {
      datasetId: "jobs-rate", version: { mode: "pinned", releaseId: "september-2026" }, display: "expanded",
    }, { resolveDataFigure: () => ({ ...figureProjection, release: { ...figureProjection.release,
      source: { ...figureProjection.release.source, url: donateUrl } } }) }),
  },
  {
    name: "election results source link",
    blockType: "election_results",
    render: () => renderCmsBlock("election_results", {
      races: [electionRace({ sourceUrl: donateUrl })],
    }),
  },
  {
    name: "election results AP call credit link",
    blockType: "election_results",
    render: () => renderCmsBlock("election_results", {
      races: [electionRace({ status: "called", sourceKind: "ap", calledCandidateId: "ellis", apCallUrl: donateUrl })],
    }),
  },
  {
    name: "coverage article link",
    blockType: "coverage_list",
    render: () =>
      renderCmsBlock("coverage_list", {
        entries: [{ title: "Donate", outlet: "NJ PBS", date: "2026-09-17", url: donateUrl }],
      }),
  },
  {
    name: "link card destination",
    blockType: "link_card",
    render: () => renderCmsBlock("link_card", { title: "Donate", url: donateUrl }),
  },
  {
    name: "image link",
    blockType: "image",
    render: () => renderCmsBlock("image", { assetId: "donate-art", alt: "Donate", href: donateUrl }),
  },
] as const;

const discoverCmsLinkCapableBlockTypes = () => {
  const source = readSource(
    "../../packages/content-core/src/content-render.ts",
  );
  const cases = source.matchAll(
    /    case "([^"]+)":([\s\S]*?)(?=\n    case "|\n  }\n})/g,
  );
  return [...cases]
    .filter(([, , body]) =>
      /\bsafeHref\s*\(|\brenderImageFigure\s*\([^;]*,\s*block\.data\)|\brenderRichText\s*\(|\brenderCustomShelf\s*\(|\brenderDataTable\s*\(|\brenderDataFigure\s*\(|\brenderElectionResults\s*\(|\brenderBioCard\s*\(|\brenderCoverageList\s*\(|\brenderLinkCard\s*\(|<a(?:\s|>)/.test(body),
    )
    .map(([, type]) => type)
    .sort();
};

describe("donate degradation wiring worklist (#189)", () => {
  it("pins every unwired direct-donation render site to exact source landmarks", () => {
    for (const site of unwiredRenderSites) {
      const source = readSource(site.source);
      for (const landmark of site.landmarks) {
        const found = countMatches(source, landmark.binding);
        expect(
          found,
          `${site.name} / ${landmark.name}: expected ${landmark.occurrences} unwired ` +
            `landmark(s), found ${found}. If this site was wired to resolveDonateCta, ` +
            "update its worklist entry in the same change.",
        ).toBe(landmark.occurrences);
      }
    }
  });

  it("discovers every static donation-target reference under site/src", () => {
    const files = discoverSiteSourceFiles();
    expect(inventoryReferences(files, /\bdonateUrl\b/g)).toEqual(
      expectedDonateUrlIdentifierReferences,
    );
    expect(
      inventoryReferences(files, /https:\/\/www\.pbs\.org\/donation\//g),
    ).toEqual(expectedLiteralDonationReferences);
    expect(inventoryDonationCarriers(files)).toEqual(
      expectedDonationCarrierReferences,
    );
  });

  it("detects added render sinks that reuse every derived donation carrier", () => {
    // A new anchor can reuse one of these carriers without adding another
    // donateUrl token. Mutation-check each carrier so no transitive path can
    // widen silently, including the CMS service-page object derived from
    // launchFallbackPages.
    const files = discoverSiteSourceFiles();
    const mutations = [
      {
        carrier: "donateHref",
        path: "layouts/PublicSiteLayout.astro",
        sink: "<a href={donateHref}>Donate again</a>",
      },
      {
        carrier: "giveHref",
        path: "components/CinematicHomePage.astro",
        sink: "<a href={giveHref}>Give again</a>",
      },
      {
        carrier: "launchUtilityLinks",
        path: "pages/index.astro",
        sink: "<a href={launchUtilityLinks[0].href}>Donate again</a>",
      },
      {
        carrier: "launchFallbackPages",
        path: "pages/[...slug].astro",
        sink: "<a href={launchFallbackPages.give.primaryAction.href}>Donate again</a>",
      },
      {
        carrier: "launchFallbackRoutePages",
        path: "pages/[...slug].astro",
        sink: '<a href={launchFallbackRoutePages.find((page) => page.slug === "give")?.primaryAction.href}>Donate again</a>',
      },
      {
        carrier: "fallbackPages",
        path: "pages/[...slug].astro",
        sink: "<a href={fallbackPages[0].props.page.primaryAction.href}>Donate again</a>",
      },
      {
        carrier: "route page",
        path: "pages/[...slug].astro",
        sink: "{page && <a href={page.primaryAction.href}>Donate again</a>}",
      },
      {
        carrier: "CMS service frame",
        path: "pages/[...slug].astro",
        sink: "{frame && <a href={frame.primaryAction.href}>Donate again</a>}",
      },
      {
        carrier: "footerCols",
        path: "layouts/PublicSiteLayout.astro",
        sink: "<a href={footerCols[0].links[0].href}>Donate again</a>",
      },
      {
        carrier: "cmsServicePage",
        path: "pages/[...slug].astro",
        sink: "{cmsServicePage && <a href={cmsServicePage.primaryAction.href}>Donate again</a>}",
      },
      {
        carrier: "details",
        path: "components/PublicSubpage.astro",
        sink: "<a href={details.give.cards[0].href}>Donate again</a>",
      },
      {
        carrier: "detail",
        path: "components/PublicSubpage.astro",
        sink: "<a href={detail.cards[0].href}>Donate again</a>",
      },
      {
        carrier: "card",
        path: "components/PublicSubpage.astro",
        sink: "<a href={card.href}>Donate again</a>",
      },
      {
        carrier: "page.primaryAction",
        path: "components/PublicSubpage.astro",
        sink: "<a href={page.primaryAction.href}>Donate again</a>",
      },
      {
        carrier: "page.secondaryAction",
        path: "components/PublicSubpage.astro",
        sink: "<a href={page.secondaryAction?.href}>Donate again</a>",
      },
    ] as const;

    for (const mutation of mutations) {
      const widened = files.map((file) =>
        file.path === mutation.path
          ? { ...file, source: `${file.source}\n${mutation.sink}\n` }
          : file,
      );
      expect(
        inventoryDonationCarriers(widened),
        `${mutation.carrier}: added render sink did not change the carrier inventory`,
      ).not.toEqual(expectedDonationCarrierReferences);
    }
  });

  it("discovers every donation-capable CMS link boundary", () => {
    // CMS destinations are stored outside site/src, so no repository donation
    // literal proves which core renderers can emit one. Inventory both the href
    // sanitizer and the shared rich-text entry points, plus every raw anchor
    // emitter. A new link-capable block must join this executable worklist.
    const files = discoverContentCoreSourceFiles();
    expect(inventoryReferences(files, /\bsafeHref\s*\(/g)).toEqual(
      expectedCmsSafeHrefReferences,
    );
    expect(inventoryReferences(files, /\brenderRichText\s*\(/g)).toEqual(
      expectedCmsRichTextRendererReferences,
    );
    expect(inventoryReferences(files, /<a(?:\s|>)/g)).toEqual(
      expectedCmsAnchorEmitters,
    );
  });

  it("renders a stored PBS donation target through every CMS link path while unwired", () => {
    // These are dynamic boundary proofs, not only source landmarks. When the
    // outage policy is wired, each fixture must stop emitting this target and
    // its worklist entry can be removed in the same change.
    const escapedDonateUrl = donateUrl.replaceAll("&", "&amp;");

    for (const fixture of cmsDonationFixtures) {
      expect(
        fixture.render(),
        `${fixture.name}: stored donation target no longer reaches the renderer`,
      ).toContain(`href="${escapedDonateUrl}"`);
    }
  });

  it("exempts Home giving only while its single action is fixed to the local Support page", () => {
    const giving = createHomeDonorBlock("support-boundary");
    const html = renderHomeDonor(giving);
    expect(html).toContain('href="/support/"');
    expect(html).not.toContain(donateUrl);
    expect(html.match(/<a(?:\s|>)/g)).toHaveLength(1);
    giving.data.cards[0].href = donateUrl;
    expect(() => renderHomeDonor(giving)).toThrow(/support/);
    giving.data.cards[0].title = "";
    giving.data.cards[0].label = "";
    expect(() => renderHomeDonor(giving, { complete: false })).toThrow(/support/);
  });

  it("exempts county comparison only while staff text cannot change its closed official destinations", () => {
    const text = `<a href="${donateUrl}">Donate</a>`;
    const data = { ...COUNTY_COMPARISON_DEFAULTS, heading: text, intro: text, source: text };
    const html = renderCmsBlock("county_comparison", data);
    const links = [...html.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
    // 21 native county-row links, six official election PDFs and one GIS source.
    expect(links).toHaveLength(28);
    const fragments = links.filter(href => href.startsWith("#county-donate-worklist-senate-"));
    expect(fragments).toHaveLength(21);
    const sources = links.filter(href => !href.startsWith("#"));
    expect(sources).toHaveLength(7);
    for (const href of sources) {
      const url = new URL(href);
      expect(url.protocol).toBe("https:");
      expect(["nj.gov", "maps.nj.gov"]).toContain(url.hostname);
    }
    expect(links).not.toContain(donateUrl);
    expect(html).toContain("&lt;a href=");
    for (const field of ["href", "url", "sourceHref"]) {
      expect(parseBlocks([{ id: "county-boundary", type: "county_comparison", order: 0, visible: true,
        data: { ...data, [field]: donateUrl } }]).ok).toBe(false);
    }
  });

  it("exempts town lookup only while every link remains a reviewed election or GIS source", () => {
    const data = { heading: donateUrl, introduction: donateUrl, sourceLine: donateUrl };
    const block = { id: "town-lookup", type: "town_lookup" as const, order: 0, visible: true, data };
    const parsed = parseBlocks([block]);
    expect(parsed.ok).toBe(true);
    const html = renderBlock(block);
    const links = [...html.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]);
    // Six election/turnout headings, one map source and one analysis source.
    expect(links).toHaveLength(8);
    for (const href of links) {
      expect(["datawrapper.dwcdn.net", "maps.nj.gov", "www.njspotlightnews.org"]).toContain(new URL(href).hostname);
    }
    expect(links).not.toContain(donateUrl);
    expect(parseBlocks([{ ...block, data: { ...data, sourceHref: donateUrl } }]).ok).toBe(false);
  });

  it("exempts Newscast only while poster, Watch, recovery and Past/Live retain their closed destinations", () => {
    const cutoffAt = homeNewsletterCatalogFixture.editorial.catalog.cutoffAt;
    const newscast = adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
      checkedAt: cutoffAt, complete: true, response: newscastProvider }, cutoffAt);
    const catalog = readHomeEditorialCatalog({ ...homeNewsletterCatalogFixture.editorial.catalog,
      services: { newsletters: { status: "error" }, newscast } });
    const block = createHomeNewscastBlock("newscast-boundary");
    const html = renderHomeNewscast(block, catalog);
    expect(html.match(/<a(?:\s|>)/g)).toHaveLength(5);
    expect(html).not.toContain(donateUrl);
    const invalid = { ...catalog, services: { ...catalog.services!, newscast: { ...newscast, episode: { ...newscast.episode!, href: donateUrl } } } };
    expect(() => renderHomeNewscast(block, invalid)).toThrow(/newscast source is invalid/);
    expect(() => renderHomeNewscast(block, invalid, { complete: false })).toThrow(/newscast source is invalid/);
  });
  it("has a dynamic donation fixture for every link-capable CMS block type", () => {
    const fixtureBlockTypes = [
      ...new Set(
        cmsDonationFixtures.flatMap((fixture) =>
          "blockType" in fixture ? [fixture.blockType] : [],
        ),
      ),
    ].sort();

    expect(fixtureBlockTypes).toEqual(discoverCmsLinkCapableBlockTypes());
  });

  it("names every static page action that targets the PBS donation form", () => {
    // Derived from both action slots. A future secondary Donate action changes
    // this set even though it still flows through a shared renderer.
    expect(donatePageActionSlots).toEqual(expectedDonatePageActionSlots);
    for (const slot of donatePageActionSlots) {
      const [slug, kind] = slot.split(":");
      const page = Object.values(launchFallbackPages).find(
        (candidate) => candidate.slug === slug,
      );
      const action =
        kind === "secondary" ? page?.secondaryAction : page?.primaryAction;
      expect(
        action?.external,
        `${slot}: donate action is not an external link`,
      ).toBe(true);
    }
  });

  it("detects a partially wired repeated primary-action renderer", () => {
    // Mutation-check the exact-count guard: wiring only one of PublicSubpage's
    // two primary-action anchors must not let the worklist stay green.
    const source = readSource("../src/components/PublicSubpage.astro");
    const partiallyWired = source.replace(
      "href={page.primaryAction.href}",
      "href={resolvedPrimaryAction.href}",
    );
    const remaining =
      partiallyWired.match(/href=\{page\.primaryAction\.href\}/g)?.length ?? 0;
    expect(remaining).toBe(1);
    expect(remaining).not.toBe(2);
  });

  it("resolves the Support column's Donate link to the direct donation target", () => {
    // The footer landmark above only proves the layout calls the resolver. This
    // pins the link that call produces from the default navigation.
    const navigation = resolveSiteNavigation(DEFAULT_SITE_NAVIGATION, { postsIndexEnabled: true });
    const support = navigation.footer.find((column) => column.heading === "Support");
    expect(support?.links.find((link) => link.id === "donate")).toMatchObject({
      label: "Donate",
      href: donateUrl,
      opensInNewTab: true,
    });
  });

  it("keeps donateTransaction out of survivability coverage while the renders are unwired", () => {
    // The honesty invariant. Listing the surface as covered without wiring these
    // renders would let assessOutage report an all-clear a visitor cannot see.
    expect(SURFACES_WITH_FALLBACK).not.toContain("donateTransaction");
  });

  it("resolves the donation policy for reachable and failed upstream states", () => {
    // Keep source coverage and the closed policy outcomes tested together.
    expect(resolveDonateCta({ kind: "reachable" }).render.mode).toBe("donate");

    const transient = resolveDonateCta({ kind: "outage", status: "timeout" });
    expect(transient.render.mode).toBe("unavailable");
    expect(transient.retryable).toBe(true);

    const forbidden = resolveDonateCta({ kind: "outage", status: "forbidden" });
    expect(forbidden.render.mode).toBe("unavailable");
    expect(forbidden.retryable).toBe(false);
  });
});
