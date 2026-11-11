"use strict";
const { serviceCompositionError } = require("./service-composition");

const { parseHomeHero } = require("./home-hero");

// Pure public-page projector for the private runtime read boundary. It selects
// only the immutable published snapshot and its validated public media records.
// Draft fields, actors, workflow metadata, and unknown document siblings never
// enter the returned union.

const { parseBlocks } = require("./content-blocks");
const { isCountyComparisonData } = require("./county-comparison");
const { visibleLayoutBlocks } = require("./content-layout");
const { validateKnownMetadata, isPageTheme, isPlainObject } = require("./content-metadata");
const { validateSection } = require("./editor-section-contract");
const { collectPublishedMediaUsage } = require("./media-usage");
const { parsePublishInstant } = require("./publish-instant");
const { publicPageDefinition, publicPagePath } = require("./public-page-contract");
const { homeCompositionError } = require("./home-composition-contract");

const publicAssetHosts = require("./public-asset-hosts.json");

const API_VERSION = 1;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

class PublicContentProjectionError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "PublicContentProjectionError";
    this.status = status;
  }
}

function fail(message, status) {
  throw new PublicContentProjectionError(message, status);
}

function unmanaged(pageId) {
  return { apiVersion: API_VERSION, state: "unmanaged", pageId };
}

function legacyBlockOnlySnapshot(snapshot) {
  return (
    isPlainObject(snapshot) &&
    snapshot.metadata === undefined &&
    snapshot.sourceVersion === undefined
  );
}

function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function selectedMetadata(value) {
  if (!isPlainObject(value)) fail("Published metadata must be an object");
  const pageTheme = isPageTheme(value.pageTheme) ? value.pageTheme : undefined;
  // A malformed historical optional theme falls back to the standard design.
  // Other malformed metadata remains a hard public-projection error.
  const metadataForRender = value.pageTheme === undefined || pageTheme !== undefined
    ? value
    : { ...value, pageTheme: undefined };
  const metadataError = validateKnownMetadata(metadataForRender, {
    descriptionIsString: true,
  });
  if (metadataError) fail(`Published metadata is invalid: ${metadataError}`);
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail("Published metadata title must be a non-empty string");
  }
  const seo = value.seo;
  const social = value.social;
  return {
    title: value.title,
    ...Object.fromEntries(["contentLinkMode", "contentLinkUrl", "contentLinkNewTab"].filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    ...(value.childDirected !== undefined ? { childDirected: value.childDirected } : {}),
    ...(pageTheme !== undefined ? { pageTheme } : {}),
    ...(value.dataHubCompositionVersion === 1 ? { dataHubCompositionVersion: 1 } : {}),
    ...(value.dataHubReporting !== undefined ? { dataHubReporting: require("./data-hub-reporting").parseDataHubReporting(value.dataHubReporting) } : {}),
    ...(value.homeHero !== undefined ? { homeHero: parseHomeHero(value.homeHero) } : {}),
    ...(value.heroBackgroundImage !== undefined ? { heroBackgroundImage: value.heroBackgroundImage } : {}),
    ...(value.heroBackgroundPosition ? { heroBackgroundPosition: value.heroBackgroundPosition } : {}),
    description: optionalString(value.description, "description") ?? "",
    ...(value.homeHeroTitle !== undefined
      ? { homeHeroTitle: optionalString(value.homeHeroTitle, "homeHeroTitle") }
      : {}),
    ...(value.homeHeroSubtitle !== undefined
      ? {
          homeHeroSubtitle: optionalString(
            value.homeHeroSubtitle,
            "homeHeroSubtitle",
          ),
        }
      : {}),
    ...(isPlainObject(seo)
      ? {
          seo: {
            ...(seo.title !== undefined ? { title: seo.title } : {}),
            ...(seo.description !== undefined
              ? { description: seo.description }
              : {}),
            ...(seo.noindex !== undefined ? { noindex: seo.noindex } : {}),
          },
        }
      : {}),
    ...(isPlainObject(social)
      ? {
          social: {
            ...(social.title !== undefined ? { title: social.title } : {}),
            ...(social.description !== undefined
              ? { description: social.description }
              : {}),
            ...(social.imageAssetId !== undefined
              ? { imageAssetId: social.imageAssetId }
              : {}),
          },
        }
      : {}),
  };
}

function selectedImageData(data) {
  return {
    ...(data.itemId !== undefined ? { itemId: data.itemId } : {}),
    assetId: data.assetId,
    alt: data.alt,
    ...(data.altDecorative !== undefined
      ? { altDecorative: data.altDecorative }
      : {}),
    ...(data.caption !== undefined ? { caption: data.caption } : {}),
  };
}

function selectedBlock(block) {
  let data;
  switch (block.type) {
    case "county_comparison":
      if (!isCountyComparisonData(block.data)) fail("Published county comparison is invalid");
      data = {
        datasetVersion: block.data.datasetVersion,
        heading: block.data.heading,
        intro: block.data.intro,
        source: block.data.source,
      };
      break;
    case "data_hub_section":
    case "data_figure":
      data = structuredClone(block.data);
      break;
    case "row":
      data = { columns: [...block.data.columns] };
      break;
    case "headline":
      data = {
        text: block.data.text,
        ...(block.data.level !== undefined ? { level: block.data.level } : {}),
      };
      break;
    case "prose":
      data = { content: structuredClone(block.data.content) };
      break;
    case "image":
      data = {
        ...selectedImageData(block.data),
        ...(block.data.href !== undefined ? { href: block.data.href } : {}),
        ...(block.data.newTab !== undefined ? { newTab: block.data.newTab } : {}),
      };
      break;
    case "video":
      // `public` exists here only when the publish transaction stamped it (#2751).
      data = {
        sourceId: block.data.sourceId,
        assetId: block.data.assetId,
        title: block.data.title,
        ...(block.data.caption !== undefined ? { caption: block.data.caption } : {}),
        ...(block.data.public !== undefined ? { public: { ...block.data.public } } : {}),
      };
      break;
    case "image_gallery":
      data = {
        images: block.data.images.map(selectedImageData),
        ...(block.data.presentation !== undefined
          ? { presentation: block.data.presentation }
          : {}),
      };
      break;
    case "document_list":
      data = {
        documents: block.data.documents.map((document) => ({
          itemId: document.itemId,
          assetId: document.assetId,
          title: document.title,
          ...(document.publisher !== undefined ? { publisher: document.publisher } : {}),
          addedAt: document.addedAt,
        })),
      };
      break;
    case "support_appeal":
      data = {
        heading: block.data.heading, copy: block.data.copy,
        buttonLabel: block.data.buttonLabel, href: block.data.href, style: block.data.style,
      };
      break;
    case "cta_row":
      data = {
        ctas: block.data.ctas.map((cta) => ({
          label: cta.label,
          href: cta.href,
          ...(cta.variant !== undefined ? { variant: cta.variant } : {}),
        })),
      };
      break;
    case "card_grid":
      data = {
        cards: block.data.cards.map((card) => ({
          ...(card.itemId !== undefined ? { itemId: card.itemId } : {}),
          ...(card.label !== undefined ? { label: card.label } : {}),
          title: card.title,
          ...(card.body !== undefined
            ? { body: structuredClone(card.body) }
            : {}),
          ...(card.imageAssetId !== undefined
            ? { imageAssetId: card.imageAssetId }
            : {}),
          ...(card.href !== undefined ? { href: card.href } : {}),
        })),
      };
      break;
    case "link_card":
      data = {
        title: block.data.title,
        url: block.data.url,
        ...(block.data.source !== undefined ? { source: block.data.source } : {}),
        ...(block.data.date !== undefined ? { date: block.data.date } : {}),
        ...(block.data.summary !== undefined ? { summary: block.data.summary } : {}),
      };
      break;
    case "faq_item":
      data = {
        question: block.data.question,
        answer: structuredClone(block.data.answer),
      };
      break;
    case "coverage_list":
      data = {
        entries: block.data.entries.map((entry) => ({
          title: entry.title,
          outlet: entry.outlet,
          date: entry.date,
          url: entry.url,
        })),
      };
      break;
    case "data_table":
      data = { title: block.data.title, csv: block.data.csv, source: block.data.source, sourceHref: block.data.sourceHref };
      break;
    case "town_lookup":
      data = { heading: block.data.heading, introduction: block.data.introduction, sourceLine: block.data.sourceLine };
      break;
    case "election_results":
      if (!require("./election-results").isElectionResultsData(block.data, true)) fail("Published election results are invalid");
      data = structuredClone(block.data);
      break;
    case "bio_card":
      data = {
        profileId: block.data.profileId,
        kind: block.data.kind,
        name: block.data.name,
        role: block.data.role,
        ...(block.data.party !== undefined ? { party: block.data.party } : {}),
        ...(block.data.area !== undefined ? { area: block.data.area } : {}),
        summary: block.data.summary,
        sourceUrl: block.data.sourceUrl,
        sourceLabel: block.data.sourceLabel,
        asOf: block.data.asOf,
        ...(block.data.image !== undefined ? { image: selectedImageData(block.data.image) } : {}),
      };
      break;
    case "embed":
      data = {
        url: block.data.url,
        ...(block.data.host !== undefined ? { host: block.data.host } : {}),
        ...(block.data.caption !== undefined
          ? { caption: block.data.caption }
          : {}),
        ...(block.data.width !== undefined ? { width: block.data.width } : {}),
        ...(block.data.height !== undefined ? { height: block.data.height } : {}),
        ...(block.data.heading !== undefined ? { heading: block.data.heading } : {}),
        ...(block.data.mapSize !== undefined ? { mapSize: block.data.mapSize } : {}),
        ...(block.data.mobileHeight !== undefined ? { mobileHeight: block.data.mobileHeight } : {}),
        ...(block.data.mapWidth !== undefined ? { mapWidth: block.data.mapWidth } : {}),
      };
      break;
    case "html":
      data = {
        html: block.data.html,
        ...(block.data.title !== undefined ? { title: block.data.title } : {}),
      };
      break;
    case "content_shelf":
      data = {
        title: block.data.title,
        source: block.data.source,
        itemLimit: block.data.itemLimit,
        moreLabel: block.data.moreLabel,
        moreHref: block.data.moreHref,
        ...(block.data.presentation === undefined ? {} : { presentation: block.data.presentation }),
        ...(block.data.columns === undefined ? {} : { columns: block.data.columns }),
        ...(block.data.selectedIds === undefined ? {} : { selectedIds: [...block.data.selectedIds] }),
        ...(block.data.selectionReceipt === undefined ? {} : { selectionReceipt: { ...block.data.selectionReceipt } }),
      };
      break;
    case "promotion_playlist":
      data = {
        title: block.data.title,
        placement: block.data.placement,
        ...(block.data.presentation !== undefined
          ? { presentation: block.data.presentation }
          : {}),
        ...(block.data.columns !== undefined
          ? { columns: block.data.columns }
          : {}),
        cards: block.data.cards.map((card) => ({ ...card })),
      };
      break;
    case "topic_shelf":
      data = {
        title: block.data.title,
        topic: block.data.topic,
        source: block.data.source,
        itemLimit: block.data.itemLimit,
        sort: block.data.sort,
        ...(block.data.pinned !== undefined
          ? { pinned: block.data.pinned.map(({ id }) => ({ id })) }
          : {}),
      };
      break;
    case "video_playlist":
      data = {
        title: block.data.title,
        topic: block.data.topic,
        library: block.data.library,
        itemLimit: block.data.itemLimit,
        sort: block.data.sort,
        ...(block.data.pinned !== undefined
          ? { pinned: block.data.pinned.map(({ id }) => ({ id })) }
          : {}),
      };
      break;
    case "record_card":
      data = {
        recordKind: block.data.recordKind,
        recordId: block.data.recordId,
        ...(block.data.variant !== undefined ? { variant: block.data.variant } : {}),
      };
      break;
    case "sponsor_strip":
      data = {
        heading: block.data.heading,
        sponsorIds: [...block.data.sponsorIds],
        layout: block.data.layout,
      };
      break;
    case "home_newscast":
      data = {
        showId: block.data.showId, heading: block.data.heading, summary: block.data.summary,
        layout: block.data.layout, watchLabel: block.data.watchLabel,
        pastLabel: block.data.pastLabel, liveLabel: block.data.liveLabel,
      };
      break;
    case "newsletter_signup":
      data = {
        newsletterIds: [...block.data.newsletterIds],
        heading: block.data.heading,
        intro: block.data.intro,
        ...(block.data.actionLabel !== undefined ? { actionLabel: block.data.actionLabel } : {}),
        ...(block.data.selectionReceipt !== undefined ? { selectionReceipt: { ...block.data.selectionReceipt } } : {}),
      };
      break;
    case "divider":
      data = {};
      break;
    default:
      fail(`Published blocks have an unsupported type ${String(block.type)}`);
  }
  return {
    id: block.id,
    type: block.type,
    ...(block.section !== undefined ? { section: block.section } : {}),
    ...(block.layout !== undefined
      ? { layout: { rowId: block.layout.rowId, column: block.layout.column } }
      : {}),
    order: block.order,
    visible: block.visible,
    data: { ...data, ...(block.data.backgroundImageAssetId !== undefined
      ? { backgroundImageAssetId: block.data.backgroundImageAssetId } : {}) },
  };
}

function visibleBlocks(value, template, pageId, homeVersion) {
  const parsed = parseBlocks(value, { pageId });
  if (!parsed.ok) fail(`Published blocks are invalid: ${parsed.error}`);
  const homeError = homeCompositionError(pageId, homeVersion, parsed.blocks);
  if (homeError) fail(homeError);
  const sectionError = validateSection(template, parsed.blocks);
  if (sectionError) {
    fail(`Published blocks are invalid for ${template}: ${sectionError.detail}`);
  }
  const visible = visibleLayoutBlocks(parsed.blocks);
  const visibleIds = new Set(visible.map(block => block.id));
  const hasRows = parsed.blocks.some(block => block.type === "row");
  // Withdrawn v2 identities remain explicit for downstream admission. Their
  // copy is not rendered, and removing them must not release their source lock.
  const projected = homeVersion === 2
    ? parsed.blocks.filter(block => visibleIds.has(block.id) || (block.section !== undefined && block.type !== "promotion_playlist"))
    : visible.sort((left, right) => left.order - right.order);
  return projected.map((block, index) => selectedBlock(homeVersion === 2 && hasRows ? { ...block, order: index } : block));
}

function admitted(document, snapshot, now) {
  const visible =
    document.publiclyVisible === true ||
    (document.publiclyVisible === undefined && document.status === "published");
  if (!visible || document.deleted) return false;
  const rawInstant =
    document.status !== "published" ? snapshot.publishedAt : document.publishAt;
  const instant = parsePublishInstant(rawInstant);
  if (instant === null) fail("Published content has an invalid admission time");
  return instant <= now.getTime();
}

function approvedMediaUrl(value, hosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  if (hosts.media.includes(url.hostname)) {
    return url.pathname.startsWith("/cms-media/") && url.pathname.length > 11;
  }
  return (
    hosts.brand.includes(url.hostname) &&
    url.pathname.startsWith("/brand/") &&
    url.pathname.length > 7
  );
}

function selectedAssets(usage, available) {
  const hosts = publicAssetHosts[process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development"
    ? "development" : "production"];
  const { assetIds } = usage;
  const documentAssetIds = new Set(usage.documentAssetIds ?? []);
  const imageAssetIds = new Set(usage.imageAssetIds ?? assetIds);
  const output = {};
  for (const assetId of assetIds) {
    const asset = available.get(assetId);
    if (!isPlainObject(asset)) fail(`Public media asset ${assetId} is missing`);
    if (!approvedMediaUrl(asset.url, hosts)) {
      fail(`Public media asset ${assetId} has an invalid URL`);
    }
    if (documentAssetIds.has(assetId)) {
      if (!hosts.media.includes(new URL(asset.url).hostname)) {
        fail(`Public PDF asset ${assetId} has an invalid URL`);
      }
      if (asset.mimeType !== "application/pdf" || imageAssetIds.has(assetId)) {
        fail(`Public media asset ${assetId} must be a PDF used only in document slots`);
      }
      output[assetId] = { url: asset.url, mimeType: asset.mimeType };
      continue;
    }
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(asset.mimeType)) {
      fail(`Public media asset ${assetId} has an invalid media type`);
    }
    if (
      !Number.isSafeInteger(asset.width) ||
      asset.width <= 0 ||
      !Number.isSafeInteger(asset.height) ||
      asset.height <= 0
    ) {
      fail(`Public media asset ${assetId} has invalid dimensions`);
    }
    if (asset.credit !== undefined && (typeof asset.credit !== "string" || asset.credit.length > 300)) {
      fail(`Public media asset ${assetId} has invalid credit`);
    }
    const thumbnails = require("./cms-image-variants").cmsImageThumbnails(asset);
    output[assetId] = {
      ...(asset.credit?.trim() ? { credit: asset.credit.trim() } : {}),
      ...(thumbnails.length ? { thumbnails } : {}),
      url: asset.url,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    };
  }
  return output;
}

function preparePublicPage({ pageId, document, now }) {
  const definition = publicPageDefinition(pageId);
  if (!definition) fail(`Unknown public page ${String(pageId)}`, 404);
  if (document === null || document === undefined) {
    return { result: unmanaged(pageId), assetIds: [] };
  }
  if (!isPlainObject(document)) fail("Public page document must be an object");
  if (document.published === undefined || document.published === null) {
    const declaredVisible =
      document.publiclyVisible === true ||
      (document.publiclyVisible === undefined && document.status === "published");
    const publishInstant = parsePublishInstant(document.publishAt);
    if (
      declaredVisible &&
      !document.deleted &&
      document.status === "published" &&
      publishInstant !== null &&
      publishInstant <= now.getTime()
    ) {
      fail(`Public page ${pageId} is published without an immutable snapshot`);
    }
    return { result: unmanaged(pageId), assetIds: [] };
  }
  if (legacyBlockOnlySnapshot(document.published)) {
    return { result: unmanaged(pageId), assetIds: [] };
  }
  if (!isPlainObject(document.published)) {
    fail("Published snapshot must be an object");
  }
  const snapshot = document.published;
  require("./dataset-dependencies").validateFrozenDatasetFigures(snapshot);
  if (
    document.template !== undefined &&
    document.template !== definition.template
  ) {
    fail(`Public page ${pageId} has the wrong editor template`);
  }
  if (!Number.isSafeInteger(snapshot.sourceVersion) || snapshot.sourceVersion < 1) {
    fail("Published snapshot has an invalid source version");
  }
  const publishedInstant = parsePublishInstant(snapshot.publishedAt);
  if (publishedInstant === null) fail("Published snapshot has an invalid publish time");
  const metadata = selectedMetadata(snapshot.metadata);
  const serviceError = serviceCompositionError(pageId, snapshot.metadata.serviceCompositionVersion);
  if (serviceError) fail(serviceError);
  const homeVersion = snapshot.metadata.homeCompositionVersion;
  const blocks = visibleBlocks(snapshot.blocks, definition.template, pageId, homeVersion);
  let usage;
  try {
    usage = collectPublishedMediaUsage({
      collection: "cmsPages",
      snapshot,
    });
  } catch (error) {
    fail(
      `Published snapshot has invalid media references: ${
        error instanceof Error ? error.message : "unknown media error"
      }`,
    );
  }
  if (!admitted(document, snapshot, now)) {
    return {
      result: { apiVersion: API_VERSION, state: "withdrawn", pageId },
      assetIds: [],
    };
  }
  return {
    result: {
      apiVersion: API_VERSION,
      state: "live",
      page: {
        pageId,
        ...([1, 2].includes(homeVersion) ? { homeCompositionVersion: homeVersion } : {}),
        ...(snapshot.metadata.serviceCompositionVersion === 1 ? { serviceCompositionVersion: 1 } : {}),
        path: publicPagePath(pageId, snapshot.metadata) ?? fail("Published page has an invalid URL"),
        family: definition.family,
        template: definition.template,
        title: metadata.title,
        ...Object.fromEntries(["contentLinkMode", "contentLinkUrl", "contentLinkNewTab"].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])),
        ...(metadata.childDirected !== undefined ? { childDirected: metadata.childDirected } : {}),
        ...(metadata.pageTheme !== undefined ? { pageTheme: metadata.pageTheme } : {}),
        ...(metadata.dataHubCompositionVersion === 1 ? { dataHubCompositionVersion: 1 } : {}),
        ...(metadata.dataHubReporting !== undefined ? { dataHubReporting: metadata.dataHubReporting } : {}),
        ...(metadata.homeHero !== undefined ? { homeHero: metadata.homeHero } : {}),
        ...(metadata.heroBackgroundImage !== undefined ? { heroBackgroundImage: metadata.heroBackgroundImage } : {}),
        ...(metadata.heroBackgroundPosition ? { heroBackgroundPosition: metadata.heroBackgroundPosition } : {}),
        description: metadata.description,
        ...(metadata.homeHeroTitle !== undefined
          ? { homeHeroTitle: metadata.homeHeroTitle }
          : {}),
        ...(metadata.homeHeroSubtitle !== undefined
          ? { homeHeroSubtitle: metadata.homeHeroSubtitle }
          : {}),
        noindex: metadata.seo?.noindex ?? false,
        ...(metadata.seo ? { seo: metadata.seo } : {}),
        ...(metadata.social ? { social: metadata.social } : {}),
        blocks,
        ...(snapshot.datasetFigures ? { datasetFigures: structuredClone(snapshot.datasetFigures) } : {}),
        assets: null,
        contentMode: "published",
        sourceVersion: snapshot.sourceVersion,
        publishedAt: new Date(publishedInstant).toISOString(),
      },
    },
    ...usage,
  };
}

// Navigation needs only admitted identities, never Page bodies or working values.
function publicPageNavigationIdentity({ pageId, document, now }) {
  if (!publicPageDefinition(pageId) || !isPlainObject(document?.published) ||
      legacyBlockOnlySnapshot(document.published) || !admitted(document, document.published, now)) return null;
  const { result } = preparePublicPage({ pageId, document, now });
  return result.state === "live" ? { pageId, path: result.page.path } : null;
}

function publicAssetRequirementsForDocument({ pageId, document, now }) {
  const { assetIds, documentAssetIds = [], imageAssetIds = assetIds } =
    preparePublicPage({ pageId, document, now });
  return { assetIds, documentAssetIds, imageAssetIds };
}

function publicAssetIdsForDocument(input) {
  return publicAssetRequirementsForDocument(input).assetIds;
}

function projectPublicPageDocument({ pageId, document, assets, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("Public projection clock is invalid");
  }
  if (!(assets instanceof Map)) fail("Public projection assets must be a map");
  const prepared = preparePublicPage({ pageId, document, now });
  if (prepared.result.state !== "live") return prepared.result;
  return {
    ...prepared.result,
    page: {
      ...prepared.result.page,
      assets: selectedAssets(prepared, assets),
    },
  };
}

module.exports = {
  API_VERSION,
  PublicContentProjectionError,
  legacyBlockOnlySnapshot,
  projectPublicPageDocument,
  publicPageNavigationIdentity,
  publicAssetIdsForDocument,
  publicAssetRequirementsForDocument,
  selectedBlock,
  selectedAssets,
};
