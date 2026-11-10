import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewscastBlock } from "../../packages/content-core/src/home-newscast-section";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { createHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published";
import newscastFixture from "../tests/fixtures/home-sources/newscast-documented-schema.json";
import { newsletterSignupUrl } from "../../packages/content-core/src/launch-fallback";
import newsletterCopy from "../tests/fixtures/home-sources/newsletter-public-copy.json";
import assert from "node:assert/strict";
import { PUBLIC_PAGE_HTML_MAX_BYTES } from "../../workers/src/no-build-page-worker";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorPublicPath } from "../../packages/content-core/src/author-profiles";
import { escapeHtml } from "../../packages/content-core/src/content-model";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { createHomeDonorBlock } from "../../packages/content-core/src/home-donor-section";
import type { ContentShelfBlock } from "../../packages/content-core/src/content-model";
import type { HomeHeroConfig } from "../../packages/content-core/src/home-hero";
import homeSelectionFixture from "../tests/fixtures/home-v2-selections.json";
import homeCurrentCatalogFixture from "../tests/fixtures/home-v2-current-catalog.json";
import { readHomeEditorialSourceReceipt, resolveHomeShelf } from "../../packages/content-core/src/home-source-catalog";
import { createHomeEditorialCatalog } from "../src/lib/home-editorial-catalog";
// These probes use fixed publication cutoffs; live feed refreshes must not
// move the provider observation beyond their frozen rendering context.
import committedSpotlight from "../tests/fixtures/spotlight-news-pre-oct14.json";
import {
  PUBLIC_PAGES,
  type PublicPageDefinition,
} from "../../packages/content-core/src/public-pages";
import { projectAuthorSnapshot } from "../src/lib/cms-authors-loader";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { checkPostLeadPreviews } from "./check-post-lead-previews";
import previewSnapshots from "../../functions/lib/preview-snapshot.js";
import { loadHomeSourceSnapshot } from "../src/lib/home-sources-loader";
import {
  createPublicArtifactInventoryReceipt,
  type PublicArtifactSettingsInput,
} from "../src/lib/public-artifact-inventory";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  projectPublicHomepageBannerArtifact,
} from "../src/lib/public-homepage-banner";
import {
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  projectPublicSiteChromeArtifact,
} from "../src/lib/public-site-chrome";
import {
  fixture,
  input,
  now,
  reservation,
} from "../tests/fixtures/cms-preview-content";

const directory = fileURLToPath(new URL("../.compiled-renderer", import.meta.url));
const renderer = await import(pathToFileURL(path.join(directory, "server/entry.mjs")).href);
const homeSources = await loadHomeSourceSnapshot({});
assert.match(renderer.rendererSha, /^[a-f0-9]{40}$/);

type PreviewInput = ReturnType<typeof input>;

const authorId = `au_${"1".repeat(32)}`;
const authorSnapshot = {
  authorId,
  slug: "compiled-reporter",
  previousSlugs: ["compiled-writer"],
  displayName: "Ada Compiled Reporter",
  jobTitle: "Statehouse reporter",
  bio: "Covers the Legislature.",
  photo: null,
  links: {},
  pinnedPostId: null,
  hiddenPostIds: [],
  publishedAt: "2026-09-11T15:00:00.000Z",
  snapshotVersion: 3,
};
const projectedAuthor = projectAuthorSnapshot(authorId, authorSnapshot);
assert.ok(projectedAuthor, "The compiled staff fixture must project a public author");
const publishedAuthor = projectedAuthor;

const bannerSnapshot = {
  schemaVersion: 1,
  values: {
    enabled: true,
    message: "Compiled homepage announcement",
    linkLabel: "Read the compiled update",
    linkHref: "/about/",
  },
  sourceVersion: 7,
  publishedAt: "2026-09-11T15:00:00.000Z",
};
const projectedBanner = projectPublicHomepageBannerArtifact({
  id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  version: 8,
  published: bannerSnapshot,
});
assert.ok(projectedBanner, "The compiled Home fixture must project a public banner");
const publishedBanner = projectedBanner;

const chromeSnapshot = {
  schemaVersion: 1,
  values: {
    newsletterEnabled: true,
    newsletterLabel: "Compiled newsletter action",
    newsletterHref: "https://example.org/compiled-newsletter",
    newsletterOpensInNewTab: true,
  },
  sourceVersion: 9,
  publishedAt: "2026-09-11T15:00:00.000Z",
};
const projectedChrome = projectPublicSiteChromeArtifact({
  id: PUBLIC_SITE_CHROME_SETTINGS_ID,
  version: 10,
  published: chromeSnapshot,
});
assert.ok(projectedChrome.status === "published", "The compiled shell fixture must project header chrome");
const publishedChrome = projectedChrome;

function setExactPublicContext(
  value: PreviewInput,
  options: { author?: boolean; banner?: boolean; chrome?: boolean },
): PreviewInput {
  const authors = options.author ? [publishedAuthor] : [];
  const settings = [
    ...(options.banner ? [publishedBanner.data] : []),
    ...(options.chrome ? [publishedChrome.data] : []),
  ];
  const receiptSettings: PublicArtifactSettingsInput[] = [
    ...(options.banner ? [{
      documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      sourceVersion: publishedBanner.data.sourceVersion,
      publishedSnapshot: publishedBanner.publishedSnapshot,
    } as const] : []),
    ...(options.chrome ? [{
      documentId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      sourceVersion: publishedChrome.data.sourceVersion,
      publishedSnapshot: publishedChrome.publishedSnapshot,
    } as const] : []),
  ];
  Object.assign(value.publicContext, {
    authors,
    settings,
    receipt: createPublicArtifactInventoryReceipt({
      reservation,
      pages: [],
      posts: [],
      programs: [],
      events: [],
      authors: options.author
        ? [{
            documentId: publishedAuthor.authorId,
            sourceVersion: publishedAuthor.sourceVersion,
            canonicalPath: publishedAuthor.path,
            aliases: publishedAuthor.previousSlugs.map(authorPublicPath),
            publishedSnapshot: authorSnapshot,
          }]
        : [],
      settings: receiptSettings,
    }),
  });
  return value;
}

function pageInput(
  page: Pick<PublicPageDefinition, "id" | "editorTemplate">,
  title: string,
  queueId = "Q".repeat(20),
): PreviewInput {
  const value = input("cmsPages", title, queueId);
  Object.assign(value, { pageId: page.id });
  Object.assign(value.snapshot, { id: page.id, template: page.editorTemplate });
  return value;
}

const contentFor = (value: PreviewInput) => {
  Object.assign(value, {
    rendererSha: renderer.rendererSha,
    expiresAtMs: Date.now() + 60_000,
  });
  const f = fixture(value);
  Object.assign(f.request, { rendererSha: renderer.rendererSha });
  return projectCmsPreviewContent(f.bytes, f.request, now);
};

const render = async (value: PreviewInput) => {
  return renderer.render({ content: contentFor(value), homeSources });
};

for (const page of PUBLIC_PAGES) {
  const value = pageInput(page, `Compiled ${page.id}`);
  setExactPublicContext(value, {
    author: page.id === "staff",
    banner: page.id === "home",
    chrome: true,
  });
  const html = await render(value);
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /name="robots"[^>]*noindex/);
  assert.ok(html.includes(`Compiled ${page.id}`), `Missing title for ${page.id}`);
  if (page.id === "home") {
    assert.ok(html.includes(bannerSnapshot.values.message), "Home omitted its published banner");
  }
  if (page.id === "staff") {
    assert.ok(html.includes(publishedAuthor.displayName), "Staff omitted its published author");
    assert.ok(html.includes(publishedAuthor.path), "Staff omitted the author's public route");
  }
  // Both header renderings use the published action, except on Kids pages.
  const { newsletterLabel, newsletterHref } = chromeSnapshot.values;
  const expectedActions = page.id === "kids" ? 0 : 2;
  assert.equal(html.split(newsletterLabel).length - 1, expectedActions, `${page.id} newsletter label count`);
  assert.equal(html.split(newsletterHref).length - 1, expectedActions, `${page.id} newsletter link count`);
  assert.ok(!html.includes("Subscribe to the newsletter"), `${page.id} rendered the default newsletter action`);
  const htmlBytes = Buffer.byteLength(html);
  assert.ok(htmlBytes <= PUBLIC_PAGE_HTML_MAX_BYTES,
    `${page.id} HTML exceeds the public Page limit: ${htmlBytes} > ${PUBLIC_PAGE_HTML_MAX_BYTES}`);
  console.log(JSON.stringify({ page: page.id, htmlBytes, maxHtmlBytes: PUBLIC_PAGE_HTML_MAX_BYTES }));
}

// Exercise saved metadata and the v1 composition through the actual compiled
// apex route. Pure renderer tests cannot detect a dropped route prop or a
// projection that loses the new shelf presentation fields.
const editorialHome = pageInput(
  PUBLIC_PAGES.find(page => page.id === "home")!,
  "Compiled editorial Home",
  "E".repeat(20),
);
const editorialHero: HomeHeroConfig = {
  mode: "manual",
  presentation: "editorial",
  supportingCount: 2,
  supportingHeading: "Compiled supporting stories",
  overflowHeading: "Compiled remaining stories",
  items: Array.from({ length: 10 }, (_, index) => ({
    itemId: `compiled-home-story-${index}`,
    title: index === 0 ? "Compiled editorial lead" : `Compiled editorial story ${index}`,
    summary: index === 0 ? "The saved opening and both editable program shelves use the compiled public components." : "",
    href: `/updates/compiled-home-story-${index}/`,
  })),
};
// Reuse artwork from the existing admitted provider snapshot when available.
// A source selection resolves the trusted published headline as well as artwork.
const editorialLeadSource = homeSources.heroCatalog?.find(card => card.source === "media_manager" && card.image);
if (editorialLeadSource) {
  Object.assign(editorialHero.items![0], {
    source: "media_manager", sourceId: editorialLeadSource.id, href: editorialLeadSource.href,
  });
}
const editorialShelfCases = [
  { section: "home-featured", source: "featured", headingId: "feat-h", trackId: "featured-rail", columns: 3, limit: 6 },
  { section: "home-more", source: "more", headingId: "recent-h", trackId: "more-rail", columns: 4, limit: 3 },
] as const;
const editorialBlocks = homeCompositionDefaults().map(block => {
  if (block.type !== "content_shelf") return block;
  const shelf = editorialShelfCases.find(item => item.section === block.section);
  return { ...block, data: { ...block.data,
    presentation: "grid" as const, columns: shelf?.columns ?? 2, itemLimit: shelf?.limit ?? 4,
  } };
});
Object.assign(editorialHome.snapshot, {
  homeCompositionVersion: 1, homeHero: editorialHero, blocks: editorialBlocks,
});
setExactPublicContext(editorialHome, { banner: true, chrome: true });
const editorialContent = contentFor(editorialHome);
const editorialPage = editorialContent.pages.find(page => page.pageId === "home");
assert.ok(editorialPage, "The saved editorial Home fixture did not project");
assert.equal(editorialPage.homeCompositionVersion, 1);
assert.deepEqual(editorialPage.homeHero, editorialHero);
const nativeBylineInput = input("cmsPosts", "Compiled credited story", "B".repeat(20));
Object.assign(nativeBylineInput.snapshot.published!.metadata, { credits: [
  { kind: "registered", authorId, displayName: "Compiled Post reporter" },
  { kind: "custom", name: "Compiled news service" },
] });
const nativeBylinePost = contentFor(nativeBylineInput).posts[0];
const editorialSources = structuredClone(homeSources);
editorialSources.heroCatalog = [...(editorialSources.heroCatalog ?? []), {
  id: "compiled-feed-story", source: "spotlight", title: "Compiled feed story", summary: "",
  href: editorialHero.items![2].href, categories: [], tags: [], byline: "Compiled feed reporter", bylineSource: "coauthors-plus",
}];
// Preview renders projected frozen Posts, never their later mutable drafts.
const bylineContent = { ...editorialContent, posts: [
  { ...nativeBylinePost, path: editorialHero.items![1].href },
  { ...nativeBylinePost, postId: "overflow-credit", path: editorialHero.items![3].href },
] };
const bylinePage = structuredClone(editorialContent.pages.find(page => page.pageId === "home")!);
Object.assign(bylinePage.homeHero!.items![2], { source: "spotlight", sourceId: "compiled-feed-story" });
bylineContent.pages = [bylinePage];
const editorialHtml = await renderer.render({ content: bylineContent, homeSources: editorialSources });
assert.equal((editorialHtml.match(/By Compiled Post reporter and Compiled news service/g) ?? []).length, 2);
assert.ok(editorialHtml.includes("By Compiled feed reporter"));
const carouselPage = structuredClone(bylinePage);
carouselPage.homeHero!.presentation = "carousel";
const carouselHtml = await renderer.render({ content: { ...bylineContent, pages: [carouselPage] }, homeSources: editorialSources });
assert.ok(carouselHtml.includes("By Compiled feed reporter"), "Carousel must retain source bylines");
const editorialOpening = editorialHtml.match(/<section\b[^>]*\bdata-home-hero-presentation="editorial"[^>]*>[\s\S]*?<\/section>/)?.[0];
assert.ok(editorialOpening, "Compiled Home dropped the saved editorial presentation");
assert.equal((editorialOpening.match(/<h1\b/g) ?? []).length, 1);
assert.ok(editorialOpening.includes(`id="hero-h">${escapeHtml("Compiled editorial lead")}</h1>`));
assert.match(editorialOpening, /id="home-supporting-heading">Compiled supporting stories<\/h2>/);
assert.match(editorialOpening, /id="home-overflow-heading">Compiled remaining stories<\/h2>/);
assert.equal((editorialOpening.match(/<a\b/g) ?? []).length, 10, "Compiled Home lost selected opening stories");
assert.equal((editorialOpening.match(/<li>/g) ?? []).length, 9);
const supportingMarkup = editorialOpening.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
assert.equal((supportingMarkup.match(/<li>/g) ?? []).length, 2, "Compiled Home dropped the supporting-count setting");
const openingHrefs = [...editorialOpening.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(openingHrefs, editorialHero.items!.map(item => escapeHtml(item.href)));
assert.doesNotMatch(editorialOpening, /\s(?:hidden|inert)(?:[\s=>])|data-home-hero-slide\b|aria-roledescription="carousel"|<button\b/);
if (editorialLeadSource?.image) {
  assert.ok(editorialOpening.includes(escapeHtml(editorialLeadSource.image.url)), "Compiled Home lost the resolved lead artwork");
}
for (const shelf of editorialShelfCases) {
  const markup = editorialHtml.match(new RegExp(`<section\\b[^>]*aria-labelledby="${shelf.headingId}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0];
  assert.ok(markup, `Compiled Home omitted ${shelf.section}`);
  assert.ok(markup.includes(`home-shelf--columns-${shelf.columns}`), `Compiled Home dropped ${shelf.section} columns`);
  assert.ok(markup.includes("home-shelf--grid"), `Compiled Home dropped ${shelf.section} grid presentation`);
  assert.ok(markup.includes(`id="${shelf.trackId}"`), `Compiled Home changed ${shelf.section} identity`);
  assert.doesNotMatch(markup, /rail__arrow|rail__track|card--cta|\s(?:hidden|inert)(?:[\s=>])/);
  const actualLinks = [...markup.matchAll(/<a\b[^>]*class="home-shelf__card"[^>]*href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(actualLinks, homeSources.pbs[shelf.source].slice(0, shelf.limit).map(card => escapeHtml(card.href)),
    `Compiled Home changed ${shelf.section} source order or authored limit`);
}
assert.match(editorialHtml, /name="robots"[^>]*noindex/);
assert.ok(editorialHtml.includes(bannerSnapshot.values.message), "Editorial Home omitted the existing announcement owner");
console.log(JSON.stringify({ page: "home-editorial", htmlBytes: Buffer.byteLength(editorialHtml), openingItems: 10, supportingItems: 2, overflowItems: 7 }));

// The same compiled apex reads v2 array order; the hero and chrome are pinned.
const v2Home = structuredClone(editorialHome);

const orderedSections = ["home-more", "home-spotlight", "home-passport-copy", "home-passport-action", "home-featured", "home-start", "home-start-action"];
const v2Blocks = orderedSections.map((section, order) => ({ ...editorialBlocks.find(block => block.section === section)!, order }));
Object.assign(v2Home.snapshot, { homeCompositionVersion: 2, blocks: v2Blocks });
const v2SourceSnapshot = { ...homeSources, publication: homeSelectionFixture.editorial.receipt };
const v2Sources = { ...v2SourceSnapshot,
  editorial: createHomeEditorialCatalog(v2SourceSnapshot, committedSpotlight, [], "2026-10-11T19:30:00.000Z") };
const renderV2 = async (value: PreviewInput) => renderer.render({ content: contentFor(value), homeSources: v2Sources });
const v2Html = await renderV2(v2Home);
const orderedHeadings = ["hero-h", "recent-h", "spot-h", "pass-h", "feat-h", "newsletter-band-heading"];
for (let index = 1; index < orderedHeadings.length; index += 1) {
  assert.ok(v2Html.indexOf(`id="${orderedHeadings[index - 1]}"`) < v2Html.indexOf(`id="${orderedHeadings[index]}"`),
    `Compiled v2 Home lost array order at ${orderedHeadings[index]}`);
}
assert.equal((v2Html.match(/id="newsletter-band-heading"/g) ?? []).length, 1, "v2 keeps the temporary Newsletter band at the retained Start boundary");
assert.ok(v2Html.includes(chromeSnapshot.values.newsletterLabel), "v2 lost shared chrome");
const givingV2 = structuredClone(v2Home);
const givingBlocks = [createHomeDonorBlock("compiled-giving"), ...v2Blocks].map((block, order) => ({ ...block, order }));
Object.assign(givingV2.snapshot, { blocks: givingBlocks });
const givingHtml = await renderV2(givingV2);
assert.equal((givingHtml.match(/data-home-section="home-donor"/g) ?? []).length, 1, "The saved giving plank renders once");
assert.ok(givingHtml.indexOf('id="hero-h"') < givingHtml.indexOf('id="home-compiled-giving-heading"'));
assert.ok(givingHtml.indexOf('id="home-compiled-giving-heading"') < givingHtml.indexOf('id="recent-h"'), "Giving follows saved array order");
assert.ok(givingHtml.includes("Give to NJ PBS through your donor advised fund"));
assert.match(givingHtml, /href="\/support\/">Learn more<\/a>/);
givingBlocks[0].visible = false;
const withdrawnGivingHtml = await renderV2(givingV2);
assert.doesNotMatch(withdrawnGivingHtml, /data-home-section="home-donor"/);
givingBlocks[0].visible = true;
for (const field of ["title", "label"] as const) {
  const incompleteGiving = structuredClone(givingV2);
  const incompleteBlocks = structuredClone(givingBlocks);
  const incompletePlank = incompleteBlocks[0];
  if (incompletePlank.type !== "card_grid") throw new Error("Expected giving plank");
  incompletePlank.data.cards[0][field] = "";
  Object.assign(incompleteGiving.snapshot, { blocks: incompleteBlocks });
  const incompleteGivingHtml = await renderV2(incompleteGiving);
  assert.doesNotMatch(incompleteGivingHtml, /data-home-section="home-donor"/);
  assert.ok(incompleteGivingHtml.includes('id="recent-h"'), "Incomplete giving must not break the rest of the private Home preview");
}
console.log(JSON.stringify({ page: "home-giving", fixedSupportDestination: true, savedArrayOrder: true, withdrawalOmitted: true, incompletePreviewSafe: true }));
if (process.argv.includes("--write-review")) {
  const givingDirectory = path.resolve(directory, "../../scratch/home-giving-proof");
  await mkdir(givingDirectory, { recursive: true });
  await cp(path.join(directory, "client"), givingDirectory, { recursive: true });
  await writeFile(path.join(givingDirectory, "index.html"), givingHtml);
  await writeFile(path.join(givingDirectory, "before.html"), v2Html);
}
const newsletterV2 = structuredClone(v2Home);
const newsletterRecord = { id: "newsletter-approved", kind: "newsletter", href: null, sourceVersion: 1,
  newsletter: { card: { title: newsletterCopy.title, summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl, imageAlt: newsletterCopy.image.alt },
    image: { url: newsletterCopy.image.url } } };
const newsletterSourcesFor = (record: unknown) => ({ ...v2SourceSnapshot, editorial: createHomeEditorialCatalog(v2SourceSnapshot,
  committedSpotlight, [], "2026-10-11T19:30:00.000Z", [], [record]) });
const newsletterSources = newsletterSourcesFor(newsletterRecord);
const newsletterPlank = { ...createHomeNewsletterBlock("newsletter-saved"), order: 0, data: {
  newsletterIds: ["newsletter-approved"], actionLabel: newsletterCopy.actionLabel, selectionReceipt: newsletterSources.editorial.receipt } };
const newsletterBlocks = [newsletterPlank, ...v2Blocks].map((block, order) => ({ ...block, order }));
Object.assign(newsletterV2.snapshot, { blocks: newsletterBlocks });
// Generic private previews carry working library overlays; the Home bar must
// ignore these and use the approved catalog for both art and signup.
const newsletterContent = { ...contentFor(newsletterV2), recordCards: [{ id: "newsletter-approved", kind: "newsletter", href: null, sourceVersion: 99,
  newsletter: { card: { title: "PRIVATE working title", signupUrl: "https://private.example.test/" } } }] as never };
const newsletterHtml = await renderer.render({ content: newsletterContent, homeSources: newsletterSources });
assert.equal((newsletterHtml.match(/data-home-section="home-newsletter"/g) ?? []).length, 1);
assert.doesNotMatch(newsletterHtml, /id="newsletter-band-heading"|PRIVATE working|private\.example/);
assert.ok(newsletterHtml.includes(newsletterCopy.title));
assert.ok(newsletterHtml.includes(escapeHtml(newsletterCopy.signupUrl)));
assert.ok(newsletterHtml.indexOf('id="hero-h"') < newsletterHtml.indexOf('id="newsletter-saved-heading"'));
assert.ok(newsletterHtml.indexOf('id="newsletter-saved-heading"') < newsletterHtml.indexOf('id="recent-h"'));
const meaningfulNewsletterHtml = await renderer.render({ content: newsletterContent, homeSources: newsletterSourcesFor({
  ...newsletterRecord, newsletter: { ...newsletterRecord.newsletter,
    card: { ...newsletterRecord.newsletter.card, imageAlt: 'Approved "Newsletter" artwork' } },
}) });
assert.ok(meaningfulNewsletterHtml.includes('alt="Approved &quot;Newsletter&quot; artwork"'));
const noArtNewsletterHtml = await renderer.render({ content: newsletterContent, homeSources: newsletterSourcesFor({
  ...newsletterRecord, newsletter: { card: newsletterRecord.newsletter.card },
}) });
assert.ok(noArtNewsletterHtml.includes('data-home-section="home-newsletter"'));
assert.match(noArtNewsletterHtml, /class="newsletter-band__backdrop" src="\/brand\/newsletter\/abstract-blue-folds\.webp" alt=""[^>]+loading="lazy" fetchpriority="low"/);
newsletterBlocks[0].visible = false;
Object.assign(newsletterV2.snapshot, { blocks: newsletterBlocks });
const hiddenNewsletterHtml = await renderer.render({ content: contentFor(newsletterV2), homeSources: newsletterSources });
assert.doesNotMatch(hiddenNewsletterHtml, /data-home-section="home-newsletter"|id="newsletter-band-heading"/);
newsletterBlocks[0].visible = true;
const withdrawnNewsletterSources = { ...newsletterSources, editorial: createHomeEditorialCatalog(v2SourceSnapshot,
  committedSpotlight, [], "2026-10-11T19:30:00.000Z", [], []) };
// The renderer consumes the same captured catalog in this private synthetic fixture.
const unavailableNewsletterHtml = await renderer.render({ content: contentFor(newsletterV2), homeSources: withdrawnNewsletterSources });
assert.doesNotMatch(unavailableNewsletterHtml, /data-home-section="home-newsletter"|id="newsletter-band-heading"/);
const incompleteNewsletter = structuredClone(newsletterV2);
const incompleteNewsletterBlocks = structuredClone(newsletterBlocks);
if (incompleteNewsletterBlocks[0].type !== "newsletter_signup") throw new Error("Expected Newsletter bar");
incompleteNewsletterBlocks[0].data.actionLabel = "";
Object.assign(incompleteNewsletter.snapshot, { blocks: incompleteNewsletterBlocks });
const incompleteNewsletterHtml = await renderer.render({ content: contentFor(incompleteNewsletter), homeSources: newsletterSources });
assert.doesNotMatch(incompleteNewsletterHtml, /data-home-section="home-newsletter"|id="newsletter-band-heading"/);
assert.ok(incompleteNewsletterHtml.includes('id="recent-h"'));
const emptyNewsletter = structuredClone(newsletterV2);
const emptyNewsletterBlocks = structuredClone(newsletterBlocks);
if (emptyNewsletterBlocks[0].type !== "newsletter_signup") throw new Error("Expected Newsletter bar");
emptyNewsletterBlocks[0].data = { newsletterIds: [], actionLabel: "Sign up by email" };
Object.assign(emptyNewsletter.snapshot, { blocks: emptyNewsletterBlocks });
const emptyNewsletterContent = contentFor(emptyNewsletter);
const emptyNewsletterPrivateContent = structuredClone(emptyNewsletterContent);
const emptyNewsletterPreview = await renderer.render({ content: emptyNewsletterContent, homeSources: newsletterSources });
assert.ok(emptyNewsletterPreview.includes('data-home-section="home-newsletter"'));
assert.ok(emptyNewsletterPreview.includes('id="newsletter-saved-heading">Get the NJ PBS email newsletter</h2>'));
assert.ok(emptyNewsletterPreview.includes("Station news and programming updates, delivered to your inbox."));
assert.ok(emptyNewsletterPreview.includes('src="/brand/newsletter/abstract-blue-folds.webp"'));
assert.ok(emptyNewsletterPreview.includes(`href="${escapeHtml(newsletterSignupUrl)}"`));
assert.ok(emptyNewsletterPreview.includes("Sign up by email</a>"));
assert.doesNotMatch(emptyNewsletterPreview, /Choose a newsletter for this block|standard newsletter band appears|data-cms-draft-placeholder/);
assert.doesNotMatch(emptyNewsletterPreview, /id="newsletter-band-heading"/);
const emptyNewsletterPublicContent = { ...emptyNewsletterContent,
  pages: emptyNewsletterContent.pages.map(page => ({ ...page, contentMode: "published" as const })) };
const emptyNewsletterPublic = await renderer.render({ content: emptyNewsletterPublicContent, homeSources: newsletterSources });
assert.doesNotMatch(emptyNewsletterPublic, /Choose a newsletter for this block|standard newsletter band appears|data-cms-draft-placeholder|id="newsletter-band-heading"/);
const newsletterBandHtml = (html: string) => html.match(/<section class="newsletter-band"[^>]*>[\s\S]*?<\/section>/g);
assert.deepEqual(newsletterBandHtml(emptyNewsletterPublic), newsletterBandHtml(emptyNewsletterPreview),
  "The empty saved Newsletter band must match public output exactly");

if (process.argv.includes("--write-review")) {
  const newsletterDirectory = path.resolve(directory, "../../scratch/home-newsletter-proof");
  await mkdir(newsletterDirectory, { recursive: true });
  await cp(path.join(directory, "client"), newsletterDirectory, { recursive: true });
  await writeFile(path.join(newsletterDirectory, "index.html"), newsletterHtml);
  await writeFile(path.join(newsletterDirectory, "before.html"), v2Html);
  await writeFile(path.join(newsletterDirectory, "empty-preview.html"), emptyNewsletterPreview);
  await writeFile(path.join(newsletterDirectory, "empty-public.html"), emptyNewsletterPublic);
  await writeFile(path.join(newsletterDirectory, "empty-input.json"), JSON.stringify({ content: emptyNewsletterPrivateContent, homeSources: newsletterSources }));
  await writeFile(path.join(newsletterDirectory, "meaningful.html"), meaningfulNewsletterHtml);
  await writeFile(path.join(newsletterDirectory, "no-art.html"), noArtNewsletterHtml);
}
console.log(JSON.stringify({ page: "home-newsletter", oneBar: true, savedOrder: true, approvedOnly: true, hiddenNoFallback: true, unavailableNoFallback: true, incompleteSafe: true }));

// The automatic section reuses a closed provider packet on the same compiled
// apex and captured private context. No current provider or working library read.
const newscastCutoff = "2026-10-11T19:30:00.000Z";
const newscastPacket = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
  requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: newscastCutoff, complete: true, response: newscastFixture }, newscastCutoff));
const newscastSourcesFor = (packet = newscastPacket) => {
  const snapshot = { ...v2SourceSnapshot, pbs: { ...v2SourceSnapshot.pbs, newscast: packet } };
  return { ...snapshot, editorial: createHomeEditorialCatalog(snapshot, committedSpotlight, [], newscastCutoff) };
};
const newscastSources = newscastSourcesFor();
const newscastV2 = structuredClone(v2Home);
const newscastBlock = createHomeNewscastBlock("compiled-newscast");
const newscastBlocks = [newscastBlock, ...v2Blocks].map((block, order) => ({ ...block, order }));
Object.assign(newscastV2.snapshot, { blocks: newscastBlocks });
const newscastProofs: Record<string, string> = { "before.html": v2Html };
let newscastCases = 0;
const renderNewscast = async (value = newscastV2, sources = newscastSources) => {
  newscastCases++;
  return renderer.render({ content: { ...contentFor(value), recordCards: [{ id: newscastPacket.showId, kind: "program", href: "https://private.example.test/",
    program: { card: { title: "PRIVATE working newscast", description: "PRIVATE working episode" } } }] as never }, homeSources: sources });
};
for (const layout of ["feature", "compact"] as const) {
  const block = newscastBlocks[0];
  if (block.type !== "home_newscast") throw new Error("Expected automatic Newscast");
  block.data.layout = layout;
  const html = await renderNewscast();
  newscastProofs[`${layout}.html`] = html;
  assert.equal((html.match(/data-home-section="home-newscast"/g) ?? []).length, 1);
  assert.ok(html.includes(`home-newscast--${layout}`));
  assert.ok(html.indexOf('id="hero-h"') < html.indexOf('id="compiled-newscast-heading"'));
  assert.ok(html.indexOf('id="compiled-newscast-heading"') < html.indexOf('id="recent-h"'));
  assert.ok(html.includes('<h3 class="home-newscast__title">NJ PBS News with Rob Nelson</h3>'));
  assert.ok(html.includes('<time class="home-newscast__date" datetime="2026-10-09">Oct. 9, 2026</time>'));
  assert.ok(html.includes('href="https://watch.njpbs.org/video/nj-pbs-news-with-rob-nelson-october-9-2026-0oavxo/"'));
  assert.ok(html.includes(chromeSnapshot.values.newsletterLabel));
  const sectionHtml = html.match(/<section\b[^>]*data-home-section="home-newscast"[^>]*>[\s\S]*?<\/section>/)![0];
  assert.doesNotMatch(sectionHtml, /<iframe|private\.example|PRIVATE working/);
  assert.match(sectionHtml, /data-home-newscast-play/);
  assert.match(sectionHtml, /data-player-src="https:\/\/player\.pbs\.org\/partnerplayer\/3114511752\/"/);
  assert.doesNotMatch(html, /data-analytics-consent|googletagmanager\.com|chimpstatic\.com|id="wisepopsjs"/);
  const long = structuredClone(newscastV2);
  const longBlocks = structuredClone(newscastBlocks);
  if (longBlocks[0].type !== "home_newscast") throw new Error("Expected automatic Newscast");
  Object.assign(longBlocks[0].data, { heading: "H".repeat(120), summary: "S".repeat(2000), watchLabel: "W".repeat(120), pastLabel: "P".repeat(120), liveLabel: "L".repeat(120) });
  Object.assign(long.snapshot, { blocks: longBlocks });
  newscastProofs[`${layout}-long.html`] = await renderNewscast(long);
}
newscastBlocks[0].visible = false;
const hiddenNewscast = await renderNewscast();
assert.doesNotMatch(hiddenNewscast, /data-home-section="home-newscast"/);
newscastBlocks[0].visible = true;
const unavailablePacket = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "error" }, newscastCutoff));
const emptyPacket = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
  requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: newscastCutoff, complete: true, response: { data: [], links: { next: null } } }, newscastCutoff));
const expiredPacket = { ...newscastPacket, checkedAt: "2026-10-11T19:00:00.000Z", episode: { ...newscastPacket.episode!,
  publicWindow: { ...newscastPacket.episode!.publicWindow, endsAt: "2026-10-11T19:25:00.000Z" } } };
for (const layout of ["feature", "compact"] as const) {
  if (newscastBlocks[0].type !== "home_newscast") throw new Error("Expected automatic Newscast");
  newscastBlocks[0].data.layout = layout;
for (const [name, sources] of [["unavailable", newscastSourcesFor(unavailablePacket)], ["empty", newscastSourcesFor(emptyPacket)], ["expired", newscastSourcesFor(expiredPacket)]] as const) {
  const html = await renderNewscast(newscastV2, sources);
  const sectionHtml = html.match(/<section\b[^>]*data-home-section="home-newscast"[^>]*>[\s\S]*?<\/section>/)![0];
  assert.match(sectionHtml, /Latest newscast<\/h2>/);
  assert.match(sectionHtml, /Past newscasts<\/a>/); assert.match(sectionHtml, /Watch live<\/a>/);
  assert.doesNotMatch(sectionHtml, /<img|\/video\/|<iframe/);
  assert.match(sectionHtml, name === "expired" ? /no longer available/ : name === "empty" ? /No newscast is available yet/ : /temporarily unavailable/);
  newscastProofs[`${layout}-${name}.html`] = html;
}
}
const incompleteNewscast = structuredClone(newscastV2), incompleteNewscastBlocks = structuredClone(newscastBlocks);
if (incompleteNewscastBlocks[0].type !== "home_newscast") throw new Error("Expected automatic Newscast");
incompleteNewscastBlocks[0].data.heading = "";
Object.assign(incompleteNewscast.snapshot, { blocks: incompleteNewscastBlocks });
const incompleteNewscastHtml = await renderNewscast(incompleteNewscast);
assert.doesNotMatch(incompleteNewscastHtml, /data-home-section="home-newscast"/);
assert.ok(incompleteNewscastHtml.includes('id="recent-h"'));
if (process.argv.includes("--write-review")) {
  const proofDirectory = path.resolve(directory, "../../scratch/home-newscast-proof");
  await mkdir(proofDirectory, { recursive: true });
  await cp(path.join(directory, "client"), proofDirectory, { recursive: true });
  for (const [name, html] of Object.entries(newscastProofs)) await writeFile(path.join(proofDirectory, name), html);
}
console.log(JSON.stringify({ page: "home-newscast", cases: newscastCases, layouts: 2, savedOrder: true, pinnedChrome: true,
  episodeDate: true, deferredPlayer: true, analyticsExcluded: true, withdrawnHeadingAndActions: true, hiddenOmitted: true, incompletePreviewSafe: true }));

const labeledManualV2 = structuredClone(v2Home);
Object.assign(labeledManualV2.snapshot, { blocks: [...v2Blocks, {
  id: "retained-manual-label", section: "home-local-promotions", type: "promotion_playlist",
  order: 7, visible: true, data: { title: "Saved recovery shelf", placement: "before_start", cards: [] },
}] });
const labeledManualHtml = await renderV2(labeledManualV2);
assert.equal((labeledManualHtml.match(/id="newsletter-band-heading"/g) ?? []).length, 1,
  "A retained manual-shelf section label must not become an unsupported named Home region");
const withdrawnV2 = structuredClone(v2Home);
const withdrawnBlocks = structuredClone(v2Blocks);
withdrawnBlocks.find(block => block.section === "home-featured")!.visible = false;
Object.assign(withdrawnV2.snapshot, { blocks: withdrawnBlocks });
const withdrawnHtml = await renderV2(withdrawnV2);
assert.ok(!withdrawnHtml.includes('id="feat-h"'), "Withdrawn v2 shelf must not render");
for (const malformedVersion of [3, "2", null]) {
  const malformed = structuredClone(v2Home);
  Object.assign(malformed.snapshot, { homeCompositionVersion: malformedVersion });
  await assert.rejects(() => renderV2(malformed), /Home composition version/);
}
console.log(JSON.stringify({ page: "home-v2", order: orderedHeadings, withdrawnShelf: "home-featured", rejectedVersions: 3 }));

// #3153: The immutable Home render uses this generation's public Post catalog.
// Saved IDs and their order survive both editorial corrections and withdrawal.
const placedPost: typeof nativeBylinePost = { ...nativeBylinePost, postId: "placed-story", path: "/posts/placed-story/", noindex: false,
  title: "Placed story original headline", summary: "Placed story original summary", sourceVersion: 2,
  heroImage: { assetId: "placed-original", url: "https://media.njpbs.org/cms-media/placed-original/image.webp", mimeType: "image/webp", width: 1200, height: 800 }, heroImageAlt: "Original image" };
const remainingPost = { ...nativeBylinePost, postId: "remaining-story", path: "/posts/remaining-story/", noindex: false,
  title: "Unchanged card headline", summary: "Unchanged card summary" };
function placedGeneration(posts: typeof nativeBylinePost[], generation: number) {
  const sources = structuredClone(homeSources);
  sources.publication = { buildBatchId: `placed-home-${generation}`, generation, commitSha: renderer.rendererSha };
  return { ...sources, editorial: createHomeEditorialCatalog(sources, { cards: [] }, posts, "2026-10-11T12:00:00.000Z") };
}
const originalPlacedSources = placedGeneration([placedPost, remainingPost], 700);
const placedShelf: ContentShelfBlock = { id: "placed-home-shelf", type: "content_shelf", visible: true,
  section: "home-posts", order: 7, data: { source: "station_posts", title: "Placed station stories", itemLimit: 6,
    moreLabel: "More posts", moreHref: "/posts/", selectedIds: [remainingPost.postId, placedPost.postId],
    selectionReceipt: originalPlacedSources.editorial.receipt } };
const placedContent = structuredClone(contentFor(v2Home));
placedContent.pages[0].blocks = [...placedContent.pages[0].blocks, placedShelf];
const savedPlacedHome = structuredClone(placedContent.pages[0]);
const correctedPost: typeof nativeBylinePost = { ...placedPost, sourceVersion: 3, title: "Corrected placed headline", summary: "Corrected placed summary",
  heroImage: { assetId: "placed-corrected", url: "https://media.njpbs.org/cms-media/placed-corrected/image.webp", mimeType: "image/webp", width: 1200, height: 800 }, heroImageAlt: "Corrected image" };
const correctedPosts = [correctedPost, remainingPost];
const correctedSources = placedGeneration(correctedPosts, 701);
const correctedHomeHtml = await renderer.render({ content: { ...placedContent, posts: correctedPosts }, homeSources: correctedSources });
assert.ok(correctedHomeHtml.includes("Corrected placed headline"));
assert.ok(correctedHomeHtml.includes("Corrected placed summary"));
assert.ok(correctedHomeHtml.includes("https://media.njpbs.org/cms-media/placed-corrected/image.webp"));
assert.ok(correctedHomeHtml.indexOf("Unchanged card headline") < correctedHomeHtml.indexOf("Corrected placed headline"));
assert.doesNotMatch(correctedHomeHtml, /Placed story original headline|Placed story original summary|cms-media\/placed-original\/image\.webp/);
assert.deepEqual(placedContent.pages[0], savedPlacedHome);
const pulledSources = placedGeneration([remainingPost], 702);
const pulledHomeHtml = await renderer.render({ content: { ...placedContent, posts: [remainingPost] }, homeSources: pulledSources });
assert.ok(pulledHomeHtml.includes("Unchanged card headline"));
assert.doesNotMatch(pulledHomeHtml, /Corrected placed headline|\/posts\/placed-story\//);
assert.deepEqual(resolveHomeShelf(placedShelf, pulledSources.editorial.catalog).missingIds, ["placed-story"]);
assert.deepEqual(placedContent.pages[0], savedPlacedHome);
console.log(JSON.stringify({ page: "home-placed-post", editedGeneration: 701, withdrawnGeneration: 702, savedSelectionUnchanged: true }));

const boundHeroPage = structuredClone(placedContent.pages[0]);
boundHeroPage.blocks = boundHeroPage.blocks.filter(block => block.id !== placedShelf.id);
// The lead shows summary and image; supporting cards show headlines only.
boundHeroPage.homeHero = { mode: "manual", presentation: "editorial", items: [
  { itemId: "placed-hero", source: "cms_posts", sourceId: placedPost.postId, title: "", summary: "", href: "" },
  { itemId: "remaining-hero", source: "cms_posts", sourceId: remainingPost.postId, title: "", summary: "", href: "" },
] };
const savedBoundHero = structuredClone(boundHeroPage);
const boundHeroHtml = await renderer.render({ content: { ...placedContent, pages: [boundHeroPage], posts: correctedPosts }, homeSources: correctedSources });
const boundHeroMarkup = boundHeroHtml.match(/<section\b[^>]*\bdata-home-hero-presentation="editorial"[^>]*>[\s\S]*?<\/section>/)?.[0];
assert.ok(boundHeroMarkup, "Compiled Home must render the source-bound manual hero");
assert.ok(boundHeroMarkup.includes("Corrected placed headline"), "Bound lead uses the current headline");
assert.ok(boundHeroMarkup.includes("Corrected placed summary"), "Bound lead uses the current summary");
assert.ok(boundHeroMarkup.includes("https://media.njpbs.org/cms-media/placed-corrected/image.webp"), "Bound lead uses the current image");
assert.ok(boundHeroMarkup.indexOf("Corrected placed headline") < boundHeroMarkup.indexOf("Unchanged card headline"), "Bound hero preserves the saved order");
assert.deepEqual(boundHeroPage, savedBoundHero);
const overriddenHeroPage = structuredClone(boundHeroPage);
Object.assign(overriddenHeroPage.homeHero!.items![0], { title: "Home-only headline", summary: "Home-only summary",
  imageAssetId: "home-only-art", alt: "Home-only image description" });
overriddenHeroPage.assets["home-only-art"] = { url: "https://media.njpbs.org/cms-media/home-only-art/image.webp", mimeType: "image/webp", width: 1200, height: 800 };
const savedOverriddenHero = structuredClone(overriddenHeroPage);
const overriddenHeroHtml = await renderer.render({ content: { ...placedContent, pages: [overriddenHeroPage], posts: correctedPosts }, homeSources: correctedSources });
const overriddenHeroMarkup = overriddenHeroHtml.match(/<section\b[^>]*\bdata-home-hero-presentation="editorial"[^>]*>[\s\S]*?<\/section>/)?.[0];
assert.ok(overriddenHeroMarkup, "Compiled Home must preserve the manual hero presentation");
assert.ok(overriddenHeroMarkup.includes("Home-only headline"), "Bound lead keeps its headline override");
assert.ok(overriddenHeroMarkup.includes("Home-only summary"), "Bound lead keeps its summary override");
assert.ok(overriddenHeroMarkup.includes("https://media.njpbs.org/cms-media/home-only-art/image.webp"), "Bound lead keeps its image override");
assert.doesNotMatch(overriddenHeroMarkup, /Corrected placed headline|Corrected placed summary|cms-media\/placed-corrected\/image\.webp/);
const pulledHeroHtml = await renderer.render({ content: { ...placedContent, pages: [overriddenHeroPage], posts: [remainingPost] }, homeSources: pulledSources });
assert.ok(pulledHeroHtml.includes("Unchanged card headline"));
assert.doesNotMatch(pulledHeroHtml, /Home-only headline|Home-only summary|cms-media\/home-only-art\/image\.webp|\/posts\/placed-story\//);
assert.deepEqual(overriddenHeroPage, savedOverriddenHero);
console.log(JSON.stringify({ page: "home-bound-manual-hero", blankFieldsFollowSource: true, setFieldsOverride: true, withdrawalDropsBoundCard: true }));

if (process.argv.includes("--write-review")) {
  // The compiled package has already been sealed. Put review-only HTML and a
  // copy of its browser assets in ignored scratch; never mutate that manifest's
  // file set or add fixture routes to either the private or public application.
  const reviewDirectory = path.resolve(directory, "../../scratch/compiled-renderer-review");
  await mkdir(reviewDirectory, { recursive: true });
  await cp(path.join(directory, "client"), reviewDirectory, { recursive: true });
  const reviewHtml = path.join(reviewDirectory, "home-editorial.html");
  await writeFile(reviewHtml, editorialHtml, "utf8");
  await writeFile(path.join(reviewDirectory, "home-editorial.json"), `${JSON.stringify({
    scope: "Private compiled renderer fixture; not a production page",
    rendererSha: renderer.rendererSha,
    homeCompositionVersion: 1,
    openingItems: 10,
    supportingItems: 2,
    overflowItems: 7,
    shelves: editorialShelfCases,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "compiled-renderer-review-written", htmlPath: reviewHtml }));
}

const [a, b] = await Promise.all([
  render(input("cmsPosts", "Post Alpha", "A".repeat(20))),
  render(input("cmsPosts", "Post Beta", "B".repeat(20))),
]);
assert.ok(a.includes("Post Alpha") && !a.includes("Post Beta"));
assert.ok(b.includes("Post Beta") && !b.includes("Post Alpha"));

const richText = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
for (const kind of ["program", "event"] as const) {
  const value = input("cmsPosts", `Compiled private ${kind}`, kind === "program" ? "G".repeat(20) : "E".repeat(20));
  const assetId = `${kind}-art`;
  const url = `https://media.njpbs.org/cms-media/${assetId}/image.webp`;
  const snapshot = previewSnapshots.createPostPreviewSnapshot(value.pageId, {
    type: kind, status: "draft", version: 7, title: `Compiled private ${kind}`, slug: `private-${kind}`,
    description: richText(`Only this ${kind} draft`), startsAt: "2026-09-12T18:00:00.000Z",
    ...(kind === "program" ? { keyArtAssetId: assetId, keyArtAlt: "Private Program artwork" }
      : { imageAssetId: assetId, imageAlt: "Private Event artwork" }),
  }, now.getTime());
  Object.assign(value, { snapshot, assets: [{ id: assetId, url, mimeType: "image/webp", width: 640, height: 360 }] });
  const html = await render(value);
  assert.ok(html.includes(`Compiled private ${kind}`));
  assert.ok(html.includes(`Only this ${kind} draft`));
  assert.ok(html.includes(url));
  assert.match(html, /name="robots"[^>]*noindex/);
}
const mediaAssets = [
  { id: "asset-image", url: "https://media.njpbs.org/cms-media/asset-image/image.webp",
    mimeType: "image/webp", width: 640, height: 360 },
  { id: "asset-gallery", url: "https://media.njpbs.org/cms-media/asset-gallery/image.gif",
    mimeType: "image/gif", width: 640, height: 360 },
  { id: "asset-card", url: "https://media.njpbs.org/cms-media/asset-card/image.jpg",
    mimeType: "image/jpeg", width: 640, height: 360 },
];
const postPresentations = [
  {
    name: "standard",
    queueId: "S".repeat(20),
    tags: ["New Jersey"],
    blocks: [{ id: "body", type: "prose", order: 0, visible: true,
      data: { content: richText("Compiled standard story") } }],
    assertions: ["Compiled standard story"],
  },
  {
    name: "special-report",
    queueId: "R".repeat(20),
    tags: ["New Jersey", "format:special-report"],
    blocks: [{ id: "chapters", type: "prose", order: 0, visible: true,
      data: { content: { type: "doc", content: ["The river", "The towns"].map(text =>
        ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] })) } } }],
    assertions: ["The river", "The towns"],
  },
  {
    name: "multimedia",
    queueId: "M".repeat(20),
    tags: ["New Jersey", "format:multimedia"],
    blocks: [
      { id: "image", type: "image", order: 0, visible: true,
        data: { assetId: "asset-image", alt: "A reporter at work", caption: "NJ PBS" } },
      { id: "gallery", type: "image_gallery", order: 1, visible: true,
        data: { presentation: "carousel", images: [
          { itemId: "gallery-one", assetId: "asset-gallery", alt: "The river at dusk" },
        ] } },
      { id: "cards", type: "card_grid", order: 2, visible: true,
        data: { cards: [{ itemId: "card-one", label: "Watch", title: "River report",
          body: richText("See the full report."), imageAssetId: "asset-card", href: "/watch/" }] } },
    ],
    assets: mediaAssets,
    assertions: [
      'data-block-type="image"',
      'data-block-type="image_gallery"',
      'data-block-type="card_grid"',
      'data-asset-id="asset-image"',
      'data-asset-id="asset-gallery"',
      'data-asset-id="asset-card"',
      "https://media.njpbs.org/cms-media/asset-image/image.webp",
      "https://media.njpbs.org/cms-media/asset-gallery/image.gif",
      "https://media.njpbs.org/cms-media/asset-card/image.jpg",
    ],
  },
  {
    name: "interactive",
    queueId: "I".repeat(20),
    tags: ["New Jersey", "format:interactive"],
    blocks: [{ id: "table", type: "data_table", order: 0, visible: true,
      data: { title: "County population", csv: "County,Population\nEssex,854917",
        source: "U.S. Census Bureau", sourceHref: "https://www.census.gov/" } }],
    assertions: ['data-block-type="data_table"', "County population", "Essex", "854917"],
  },
] as const;

for (const postCase of postPresentations) {
  const value = input("cmsPosts", `Compiled ${postCase.name}`, postCase.queueId);
  const postId = `post-${postCase.name}`;
  Object.assign(value, { pageId: postId, assets: "assets" in postCase ? postCase.assets : [] });
  Object.assign(value.snapshot, { id: postId });
  const published = (value.snapshot as { published: Record<string, unknown> }).published;
  Object.assign(published, { blocks: postCase.blocks });
  Object.assign(published.metadata as Record<string, unknown>, {
    slug: `compiled-${postCase.name}`,
    tags: postCase.tags,
  });
  const html = await render(value);
  const markedPresentation = html.match(/data-post-presentation="([^"]+)"/)?.[1] ?? "standard";
  assert.equal(markedPresentation, postCase.name);
  for (const expected of postCase.assertions) {
    assert.ok(html.includes(expected), `Compiled ${postCase.name} omitted ${expected}`);
  }
  if (postCase.name === "multimedia") {
    assert.ok(!html.includes("/_image?"), "Compiled media used a runtime image proxy");
  }
}

const creditedPost = input("cmsPosts", "Compiled credited Post", "K".repeat(20));
const leadPreviewCases = await checkPostLeadPreviews(render);
Object.assign(creditedPost, { pageId: "post-credited" });
Object.assign(creditedPost.snapshot, { id: "post-credited" });
const creditedPublished = (creditedPost.snapshot as { published: Record<string, unknown> }).published;
Object.assign(creditedPublished.metadata as Record<string, unknown>, {
  slug: "compiled-credited-post",
  credits: [{
    kind: "registered",
    authorId: publishedAuthor.authorId,
    displayName: publishedAuthor.displayName,
    slug: "compiled-writer",
  }],
});
setExactPublicContext(creditedPost, { author: true });
const creditedHtml = await render(creditedPost);
assert.ok(creditedHtml.includes(publishedAuthor.displayName));
assert.ok(creditedHtml.includes(publishedAuthor.path));

const customId = `page-${"c".repeat(32)}`;
const custom = pageInput(
  { id: customId, editorTemplate: "genericPage" },
  "Compiled custom page",
  "C".repeat(20),
);
Object.assign(custom.snapshot, { slug: "compiled-community-page" });
const customHtml = await render(custom);
assert.ok(customHtml.includes("Compiled custom page"));
assert.ok(customHtml.includes("https://njpbs.org/compiled-community-page/"));

const renamed = pageInput(
  PUBLIC_PAGES.find(page => page.id === "contact")!,
  "Compiled renamed contact",
  "N".repeat(20),
);
Object.assign(renamed.snapshot, { slug: "compiled-contact" });
const renamedHtml = await render(renamed);
assert.ok(renamedHtml.includes("Compiled renamed contact"));
assert.ok(renamedHtml.includes("https://njpbs.org/compiled-contact/"));

const renamedSchedule = pageInput(
  PUBLIC_PAGES.find(page => page.id === "schedule")!,
  "Compiled renamed schedule",
  "L".repeat(20),
);
Object.assign(renamedSchedule.snapshot, { slug: "compiled-schedule" });
const renamedScheduleHtml = await render(renamedSchedule);
assert.ok(renamedScheduleHtml.includes("Compiled renamed schedule"));
assert.ok(renamedScheduleHtml.includes("https://njpbs.org/compiled-schedule/"));
assert.ok(renamedScheduleHtml.includes("data-native-schedule"));
assert.ok(renamedScheduleHtml.includes("TV schedule"));

const renamedStaff = pageInput(
  PUBLIC_PAGES.find(page => page.id === "staff")!,
  "Compiled renamed staff",
  "T".repeat(20),
);
Object.assign(renamedStaff.snapshot, { slug: "compiled-staff" });
setExactPublicContext(renamedStaff, { author: true });
const renamedStaffHtml = await render(renamedStaff);
assert.ok(renamedStaffHtml.includes("Compiled renamed staff"));
assert.ok(renamedStaffHtml.includes("https://njpbs.org/compiled-staff/"));
assert.ok(renamedStaffHtml.includes(publishedAuthor.displayName));
assert.ok(renamedStaffHtml.includes(publishedAuthor.path));

const [homeAlpha, homeBeta] = await Promise.all([
  render(pageInput(PUBLIC_PAGES[0], "Compiled Home Alpha", "H".repeat(20))),
  render(pageInput(PUBLIC_PAGES[0], "Compiled Home Beta", "J".repeat(20))),
]);
assert.ok(homeAlpha.includes("Compiled Home Alpha") && !homeAlpha.includes("Compiled Home Beta"));
assert.ok(homeBeta.includes("Compiled Home Beta") && !homeBeta.includes("Compiled Home Alpha"));

const directContent = contentFor(pageInput(
  PUBLIC_PAGES.find(page => page.id === "contact")!,
  "Compiled direct guard",
  "D".repeat(20),
));

// The saved ID/order fixture uses a newer current catalog: one corrected Post,
// one withdrawn selection, and the captured provider pools. Both readers use
// the admitted array and shared public components; no copied cards enter it.
const selectedHome = pageInput(PUBLIC_PAGES.find(page => page.id === "home")!, "Saved selection Home", "S".repeat(20));
Object.assign(selectedHome.snapshot, structuredClone(homeSelectionFixture.home));
setExactPublicContext(selectedHome, { banner: true, chrome: true });
const sourcePublication = { buildBatchId: selectedHome.publicContext.receipt.buildBatchId,
  generation: selectedHome.publicContext.receipt.generation, commitSha: selectedHome.publicContext.receipt.commitSha };
const selectionSources = { ...homeSources, publication: sourcePublication,
  editorial: readHomeEditorialSourceReceipt({ ...homeCurrentCatalogFixture,
    receipt: { ...homeCurrentCatalogFixture.receipt, ...sourcePublication } }) };
Object.assign(selectedHome.publicContext, { homeSources: selectionSources });
const selectedContent = contentFor(selectedHome);
assert.deepEqual(selectedContent.pages.find(page => page.pageId === "home")!.blocks, homeSelectionFixture.home.blocks);
assert.deepEqual(selectedContent.homeSources, selectionSources);
const selectedHtml = await renderer.render({ content: selectedContent, homeSources: selectedContent.homeSources });
const sectionIds = [...selectedHtml.matchAll(/data-home-section="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(sectionIds, ["home-featured", "home-more", "home-spotlight", "home-posts"]);
const postSection = selectedHtml.match(/<section\b[^>]*data-home-section="home-posts"[^>]*>[\s\S]*?<\/section>/)?.[0];
assert.ok(postSection);
assert.deepEqual([...postSection.matchAll(/data-home-card-id="([^"]+)"/g)].map(match => match[1]), ["1208e81a5470be941e3fb392eac674ae"]);
assert.ok(postSection.includes("Corrected published headline"));
assert.ok(postSection.includes("Corrected published summary"));
assert.ok(!postSection.includes("NJ PBS announces six staff appointments"));
for (const [section, ids] of [
  ["home-featured", ["https://watch.njpbs.org/show/from-that-small-island-the-story-of-the-irish-feature-film/", "https://watch.njpbs.org/show/painting-community/"]],
  ["home-more", homeSelectionFixture.home.blocks.find(block => block.section === "home-more")!.data.selectedIds!],
  ["home-spotlight", homeSelectionFixture.home.blocks.find(block => block.section === "home-spotlight")!.data.selectedIds!],
] as const) {
  const markup = selectedHtml.match(new RegExp(`<section\\b[^>]*data-home-section="${section}"[^>]*>[\\s\\S]*?<\\/section>`))![0];
  assert.deepEqual([...markup.matchAll(/data-home-card-id="([^"]+)"/g)].map(match => match[1]), ids);
}
const selectionCaptureDirectory = path.resolve(directory, "../../scratch/home-selection-proof");
await mkdir(selectionCaptureDirectory, { recursive: true });
await writeFile(path.join(selectionCaptureDirectory, "index.html"), selectedHtml);
await cp(path.join(directory, "client"), selectionCaptureDirectory, { recursive: true });
const directRender = (target: Record<string, unknown>) => renderer.render({
  content: { ...directContent, target: { ...directContent.target, ...target } },
  homeSources,
});
const wrongSha = renderer.rendererSha === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40);
await assert.rejects(() => directRender({ rendererSha: wrongSha }), /exact private content target/);
await assert.rejects(() => directRender({ expiresAtMs: Date.now() - 1 }), /exact private content target/);
await assert.rejects(() => directRender({ pagePath: "/contact/../about/" }), /not canonical/);

console.log(JSON.stringify({
  event: "compiled-renderer-probe-passed",
  cases: PUBLIC_PAGES.length + 1 + 2 + postPresentations.length + 1 + 4 + 2 + newscastCases,
  rejectedCases: 3,
  leadPreviewCases: leadPreviewCases.length,
}));
