import { validatePostsBrowse, type PostsBrowseConfig } from "../../packages/content-core/src/posts-browse.ts";
import type { PostLeadMedia } from "../../packages/content-core/src/post-lead-media.ts";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog.ts";
import type { HomeHeroConfig } from "../../packages/content-core/src/home-hero";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { cmsPreviewExportLoader } from "./lib/cms-preview-export";
import { createCmsPreviewContentSource } from "./lib/cms-preview-content";
import { cmsPagesLoader } from "./lib/cms-loader";
import { cmsPostsLoader } from "./lib/cms-posts-loader";
import { cmsProgramsLoader } from "./lib/cms-programs-loader";
import { cmsRecordCardsLoader } from "./lib/cms-record-cards-loader";
import type { RecordCardPayload } from "./lib/record-card-resolution";
import { cmsEventsLoader } from "./lib/cms-events-loader";
import { cmsAuthorsLoader } from "./lib/cms-authors-loader";
import { publicHomepageBannerLoader } from "./lib/public-homepage-banner";
import { siteNavigationLoader } from "./lib/site-navigation";
import { publicSiteChromeLoader } from "./lib/public-site-chrome";
import { isCoverageLabelsBuildData, type CoverageLabelsBuildData } from "../../packages/content-core/src/coverage-labels.ts";
import { isStoryCtasBuildData, type StoryCtasBuildData } from "../../packages/content-core/src/story-ctas.ts";
import { isNjDecidesBuildData, type NjDecidesBuildData } from "./lib/nj-decides-settings";
import type {
  SiteNavigationColumn,
  SiteNavigationLink,
} from "../../packages/content-core/src/cms-settings.ts";
import { homeSourcesLoader } from "./lib/home-sources-loader";
import { dataHubReportingLoader } from "./lib/data-hub-reporting-loader";
import type { SpotlightReportingSnapshot } from "../../packages/content-core/src/data-hub-reporting-sources.ts";
import type { HomeSourceSnapshot } from "./lib/home-sources";
import type {
  PageBlock,
  RichTextDoc,
} from "../../packages/content-core/src/content-model";
import { safeHref } from "../../packages/content-core/src/content-model";
import {
  isDatasetFigures,
  type DatasetFigures,
} from "../../packages/content-core/src/dataset-figures";

// This configuration owns one immutable preview input, shared by its loaders.
// Ordinary published builds receive null and keep their existing admission path.
const previewContent = createCmsPreviewContentSource();

// Editorial-page metadata shared by navigation and page templates.
const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/pages" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number().default(0),
    // Priority marker for editorial pages.
    priority: z.boolean().default(false),
    // draft pages build but stay out of nav and the public artifact
    draft: z.boolean().default(true),
    noindex: z.boolean().default(false),
    // Section labels that anchor the page's content blocks.
    sections: z.array(z.string()).default([]),
    // a page whose existence is built but whose content is gated on a confirmed
    // fact (a held license, PBS membership, CPB terms, what transfers from WNET)
    conditional: z.boolean().default(false),
    childDirected: z.boolean().optional(),
    // human-readable note: which confirmed fact unlocks this page's real content
    gatedOn: z.string().optional(),
    // Integration slot identifiers supported by this page model.
    slots: z.array(z.string()).default([]),
  }),
});

// The OKF knowledge bundle at the repo root (wiki/). Loaded whole so the build
// can see every concept, but only files with `public: true` frontmatter are
// rendered to /wiki/ (see src/pages/wiki/). Frontmatter is intentionally varied
// across the bundle, so every field is optional; dates are coerced because OKF
// frontmatter writes them unquoted (parsed as YAML dates).
const wiki = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../wiki" }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    public: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    resource: z.string().optional(),
    status: z.string().optional(),
    verified: z.coerce.date().optional(),
    timestamp: z.coerce.date().optional(),
    okf_version: z.string().optional(),
  }),
});

const searchMetadata = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    noindex: z.boolean().optional(),
  })
  .loose();

const socialMetadata = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    imageAssetId: z.string().optional(),
  })
  .loose();

// Real CMS page projection. The loader has already validated each block through
// the canonical content model and template catalog before this schema sees it;
// `z.custom` keeps that proven PageBlock union intact for Astro components.
const cmsPages = defineCollection({
  loader: cmsPreviewExportLoader("cmsPages") ?? cmsPagesLoader(previewContent),
  schema: z.object({
    pageId: z.string(),
    childDirected: z.boolean().optional(),
    previousSlugs: z.array(z.string()).optional(),
    homeCompositionVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    serviceCompositionVersion: z.literal(1).optional(),
    path: z.string(),
    family: z.enum(["home", "service", "schedule", "article", "staff", "dataHub"]),
    template: z.enum(["home", "programLanding", "genericPage"]),
    title: z.string(),
    pageTheme: z.enum(["default", "nj-decides"]).optional(),
    description: z.string(),
    heroBackgroundImage: z.string().optional(),
    heroBackgroundPosition: z.enum(["center", "top", "bottom"]).optional(),
    dataHubCompositionVersion: z.literal(1).optional(),
    dataHubReporting: z.custom<import("../../packages/content-core/src/data-hub-reporting").DataHubReporting>().optional(),
    homeHero: z.custom<HomeHeroConfig>().optional(),
    homeHeroTitle: z.string().optional(),
    homeHeroSubtitle: z.string().optional(),
    contentLinkMode: z.enum(["normal", "custom"]).optional(),
    contentLinkUrl: z.string().optional(),
    contentLinkNewTab: z.boolean().optional(),
    noindex: z.boolean(),
    seo: searchMetadata.optional(),
    social: socialMetadata.optional(),
    blocks: z.array(z.custom<PageBlock>()),
    datasetFigures: z.custom<DatasetFigures>(isDatasetFigures).optional(),
    assets: z.record(
      z.string(),
      z.union([z.object({
        url: z.url(),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/avif",
        ]),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        thumbnails: z.array(z.object({ url: z.url(), width: z.number().int().positive(), height: z.number().int().positive() })).optional(),
      }), z.object({ url: z.url(), mimeType: z.literal("application/pdf") })]),
    ),
    contentMode: z.enum(["published", "draft"]),
    sourceVersion: z.number().int().positive().nullable(),
    publishedAt: z.string().nullable(),
  }),
});

const cmsImage = z.object({
  assetId: z.string(),
  url: z.url(),
  mimeType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
  ]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  credit: z.string().max(300).optional(),
  thumbnails: z.array(z.object({ url: z.url(), width: z.number().int().positive(), height: z.number().int().positive() })).optional(),
});

// Public Posts. The loader has already admitted only published snapshots and
// validated every block through the canonical content model, so this schema
// pins the projected shape rather than re-deriving it. `z.custom` keeps the
// proven PageBlock union intact for the renderer, exactly as cmsPages does.
const cmsPosts = defineCollection({
  loader: cmsPreviewExportLoader("cmsPosts") ?? cmsPostsLoader(previewContent),
  schema: z.object({
    postId: z.string(),
    slug: z.string(),
    previousSlugs: z.array(z.string()),
    locale: z.string(),
    path: z.string(),
    title: z.string(),
    spotlightNews: z.boolean().default(false),
    coverageLabelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
    showInHomeHero: z.boolean().optional(),
    disableStoryCtas: z.boolean().optional(),
    summary: z.string(),
    excerpt: z.string(),
    categories: z.array(z.string()),
    tags: z.array(z.string()),
    credits: z.array(
      z.object({
        name: z.string(),
        slug: z.string().optional(),
        authorId: z.string().optional(),
      }),
    ),
    authorIds: z.array(z.string()),
    displayDate: z.string().nullable(),
    sortInstant: z.number().nullable(),
    updateShown: z.boolean(),
    updatedAt: z.string().nullable(),
    updatedDate: z.string().nullable(),
    heroBackgroundImage: cmsImage.nullable().optional(),
    heroBackgroundPosition: z.enum(["center", "top", "bottom"]).optional(),
    leadMedia: z.custom<PostLeadMedia>().nullable().optional(),
    heroImage: cmsImage.nullable(),
    heroImageAlt: z.string(),
    heroImageDecorative: z.boolean(),
    heroImageCaption: z.string().default(""),
    blocks: z.array(z.custom<PageBlock>()),
    datasetFigures: z.custom<DatasetFigures>(isDatasetFigures).optional(),
    // The projector owns public completeness and explicit private-preview mode,
    // as it does for blocks and leadMedia above. Do not reapply public rules here.
    liveBlog: z.custom<LiveBlogData>().optional(),
    assets: z.record(z.string(), cmsImage),
    contentLinkMode: z.enum(["normal", "custom"]).optional(),
    contentLinkUrl: z.string().optional(),
    contentLinkNewTab: z.boolean().optional(),
    noindex: z.boolean(),
    seo: searchMetadata.optional(),
    social: socialMetadata.optional(),
    sourceVersion: z.number().int().positive(),
    firstPublishedAt: z.string().nullable(),
    publishedAt: z.string(),
  }),
});

// Published Programs with resolved media-library key art.
const cmsPrograms = defineCollection({
  loader: cmsPreviewExportLoader("cmsPrograms") ?? cmsProgramsLoader(previewContent),
  schema: z.object({
    programId: z.string(),
    slug: z.string(),
    previousSlugs: z.array(z.string()),
    locale: z.string(),
    path: z.string(),
    title: z.string(),
    genre: z.string().nullable(),
    description: z.custom<RichTextDoc>(),
    memberOnly: z.boolean(),
    keyArt: cmsImage.nullable(),
    keyArtAlt: z.string(),
    keyArtDecorative: z.boolean(),
    watchUrl: z.string().nullable(),
    assets: z.record(z.string(), cmsImage),
    sourceVersion: z.number().int().positive(),
    publishedAt: z.string(),
  }),
});

const cmsRecordCards = defineCollection({
  loader: cmsPreviewExportLoader("cmsRecordCards") ?? cmsRecordCardsLoader(previewContent),
  schema: z.custom<RecordCardPayload>(),
});

const cmsEvents = defineCollection({
  loader: cmsPreviewExportLoader("cmsEvents") ?? cmsEventsLoader(previewContent),
  schema: z.object({
    eventId: z.string(), slug: z.string(), previousSlugs: z.array(z.string()),
    locale: z.string(), path: z.string(), title: z.string(), startsAt: z.string(),
    endsAt: z.string().nullable(), location: z.string().nullable(),
    venueAddress: z.string().nullable(), onlineUrl: z.string().nullable(),
    description: z.custom<RichTextDoc>(), image: cmsImage.nullable(),
    imageAlt: z.string(), imageDecorative: z.boolean(), registrationUrl: z.string().nullable(),
    registrationLabel: z.string(), isFree: z.boolean(), priceText: z.string().nullable(),
    sourceVersion: z.number().int().positive(), publishedAt: z.string(),
  }),
});

// Public author pages, read from the detached public author snapshots. Every
// field here is public by construction upstream; the schema exists so a shape
// change in the snapshot fails the build instead of rendering blank.
const cmsAuthorsPublic = defineCollection({
  loader: cmsPreviewExportLoader("cmsAuthorsPublic") ?? cmsAuthorsLoader(previewContent),
  schema: z.object({
    authorId: z.string(),
    slug: z.string(),
    previousSlugs: z.array(z.string()),
    path: z.string(),
    displayName: z.string(),
    jobTitle: z.string().nullable(),
    bio: z.string().nullable(),
    photo: z
      .object({
        url: z.url(),
        displayUrl: z.url(),
        mimeType: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        focalX: z.number(),
        focalY: z.number(),
        credit: z.string().nullable(),
      })
      .nullable(),
    links: z.array(
      z.object({
        platform: z.enum(["x", "bluesky", "linkedin"]),
        url: z.url(),
      }),
    ),
    pinnedPostId: z.string().nullable(),
    hiddenPostIds: z.array(z.string()),
    sourceVersion: z.number().int().positive(),
  }),
});

// The fixed public homepage setting is available only through the immutable
// cutoff bundle. The loader does not read mutable Firestore or draft values.
const cmsPublicSettings = defineCollection({
  loader: cmsPreviewExportLoader("cmsPublicSettings") ?? publicHomepageBannerLoader(previewContent),
  schema: z.object({
    settingId: z.literal("public-homepage-banner"),
    enabled: z.boolean(),
    message: z.string(),
    link: z.object({
      label: z.string().min(1),
      href: z.string().min(1),
    }).optional(),
    secondLink: z.object({ label: z.string().min(1), href: z.string().min(1) }).optional(),
    njDecides: z.boolean().optional(),
    liveLabel: z.string().optional(),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    excludedPaths: z.array(z.string()).max(50).optional(),
    sourceVersion: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
  }).superRefine((value, context) => {
    if (value.njDecides !== true && value.message.trim() === "") {
      context.addIssue({
        code: "custom",
        message: "A standard homepage banner requires a message.",
        path: ["message"],
      });
    }
  }),
});

// Published site navigation, present only when the cutoff bundle carries a
// valid snapshot. The layout validates the values again and renders the seed
// when this collection is empty.
const cmsSiteNavigation = defineCollection({
  loader: cmsPreviewExportLoader("cmsSiteNavigation") ?? siteNavigationLoader(previewContent),
  schema: z.object({
    settingId: z.literal("site-navigation"),
    postsBrowse: z.custom<PostsBrowseConfig>(value => validatePostsBrowse(value) === null).optional(),
    header: z.array(z.custom<SiteNavigationLink>()),
    footer: z.array(z.custom<SiteNavigationColumn>()),
    sourceVersion: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
  }),
});

// Published header chrome, present only when the cutoff bundle carries a valid
// snapshot. The layout validates the values again and renders the source
// default when this collection is empty.
const cmsPublicSiteChrome = defineCollection({
  loader: cmsPreviewExportLoader("cmsPublicSiteChrome") ?? publicSiteChromeLoader(previewContent),
  schema: z.union([z.custom<StoryCtasBuildData>(isStoryCtasBuildData), z.custom<CoverageLabelsBuildData>(isCoverageLabelsBuildData), z.custom<NjDecidesBuildData>(isNjDecidesBuildData), z.object({
    settingId: z.literal("public-site-chrome"),
    newsletterEnabled: z.boolean(),
    newsletterLabel: z.string(),
    newsletterHref: z.string(),
    newsletterOpensInNewTab: z.boolean(),
    sourceVersion: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
  })]),
});

const publicHomeSources = defineCollection({
  loader: homeSourcesLoader(),
  schema: z.custom<HomeSourceSnapshot>(),
});

const publicDataHubReporting = defineCollection({
  loader: dataHubReportingLoader(),
  schema: z.custom<SpotlightReportingSnapshot>(),
});

export const collections = {
  pages,
  wiki,
  cmsPages,
  cmsPosts,
  cmsPrograms,
  cmsRecordCards,
  cmsEvents,
  cmsAuthorsPublic,
  cmsPublicSettings,
  cmsSiteNavigation,
  cmsPublicSiteChrome,
  publicHomeSources,
  publicDataHubReporting,
};
