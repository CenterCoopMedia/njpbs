"use strict";
const { projectPublishedCmsSettings, SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } = require("./cms-settings-contract");
const { PUBLIC_PAGE_DEFINITIONS } = require("./public-page-contract");
const { selectedAssets, publicPageNavigationIdentity } = require("./public-content-projection");
const { projectPairedAsset } = require("./joined-records");
const { assertPublishedMediaReadiness } = require("./public-deployment-pointer");
const PUBLIC_CHROME_SETTINGS_IDS = Object.freeze([SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, require("./cms-settings-contract").COVERAGE_LABELS_SETTINGS_ID,
  require("./cms-settings-contract").STORY_CTAS_SETTINGS_ID]);
/** Pure projection over raw public read records. Both the live reader and
 * frozen replay use this owner; it has no database, SDK or transport handle. */
function publishedChromeSettings(records, { strictBanner = false } = {}) {
  const settings = [];
  for (const id of PUBLIC_CHROME_SETTINGS_IDS) {
    const document = records.get(`cmsSettings/${id}`);
    if (!document) continue;
    let published;
    try { published = projectPublishedCmsSettings({ documentId: id, document }); }
    catch (error) { if (id === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID && strictBanner) throw error; continue; }
    if (published) settings.push({ id, version: published.sourceVersion, published });
  }
  return settings;
}
function publishedChromeBrandAssetIds(settings) {
  const brand = settings.find(setting => setting.id === NJ_DECIDES_SETTINGS_ID);
  return brand ? [...new Set([brand.published.values.logoAssetId, brand.published.values.backgroundAssetId].filter(Boolean))] : [];
}
function publishedChromePageIds(settings) {
  const navigation = settings.find(setting => setting.id === SITE_NAVIGATION_SETTINGS_ID)?.published.values;
  const links = navigation ? [...navigation.header, ...navigation.footer.flatMap(column => column.links)] : [];
  return [...new Set([...Object.keys(PUBLIC_PAGE_DEFINITIONS),
    ...links.filter(link => link.target.type === "page").map(link => link.target.pageId)])].sort();
}
function contentLinkDirectoryEntry(path, document) {
  const metadata = document.published?.metadata;
  if (metadata?.contentLinkMode !== "custom" || require("./content-link").contentLinkError(metadata)) return [];
  const normalPath = path.startsWith("cmsPosts/") ? metadata.type === "post" ? `/posts/${metadata.slug}/` : null
      : require("./public-page-contract").publicPagePath(path.slice("cmsPages/".length), metadata);
  return normalPath ? [{ path: normalPath, contentLinkMode: "custom", contentLinkUrl: metadata.contentLinkUrl,
      contentLinkNewTab: metadata.contentLinkNewTab !== false, previousSlugs: metadata.previousSlugs ?? [] }] : [];
}
function projectPublishedContentLinks(records, now) {
  return [...records].flatMap(([path, document]) => {
    if (!/^cms(?:Posts|Pages)\//.test(path) || document.deleted || document.publiclyVisible === false ||
        document.publiclyVisible !== true && document.status !== "published") return [];
    const instant = require("./publish-instant").parsePublishInstant(document.status === "published" ? document.publishAt : document.published?.publishedAt);
    if (instant === null || instant > now.getTime()) return [];
    const metadata = document.published?.metadata;
    if (metadata?.contentLinkMode !== "custom" || require("./content-link").contentLinkError(metadata) ||
        typeof document.published.publishedAt !== "string" || !Number.isFinite(Date.parse(document.published.publishedAt)) || Date.parse(document.published.publishedAt) > now.getTime()) return [];
    return contentLinkDirectoryEntry(path, document);
  });
}
function projectPublishedChromeRecords(records, now, options) {
  const settings = publishedChromeSettings(records, options), brand = settings.find(setting => setting.id === NJ_DECIDES_SETTINGS_ID);
  const snapshot = path => ({ exists: records.has(path), data: () => records.get(path) });
  if (brand) {
    const ids = publishedChromeBrandAssetIds(settings);
    brand.assets = {};
    let uploadedMediaReady = false;
    if (ids.some(id => records.get(`media_assets/${id}`)?.source === "upload")) {
      try {
        const root = records.get("system/publicDeployment");
        if (root?.schemaVersion === 2) require("./public-release-pair-media").parsePairMedia(
          records.get("system/publicDeployment/pairMedia/current"), require("./public-release-pair").parseStoredPublicReleaseSelector(root));
        else assertPublishedMediaReadiness(root);
        uploadedMediaReady = true;
      }
      catch { /* Unavailable branding media uses the bundled identity. */ }
    }
    for (const id of ids) {
      try {
        const image = projectPairedAsset({ assetId: id, privateSnapshot: snapshot(`media_assets/${id}`),
          publicSnapshot: snapshot(`media_assets_public/${id}`), uploadedMediaReady });
        Object.assign(brand.assets, selectedAssets({ assetIds: [id] }, new Map([[id, image]])));
      } catch { /* A branding image cannot remove a readable route. */ }
    }
  }
  const pageIds = new Set(publishedChromePageIds(settings));
  const pages = [...records].filter(([path]) => path.startsWith("cmsPages/")).map(([path, document]) => ({ pageId: path.slice("cmsPages/".length), document }));
  // Match the live reader's default document-id order and two-row news query.
  const news = pages.filter(page => page.document?.published?.metadata?.slug === "in-the-news")
    .sort((a, b) => a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0).slice(0, 2);
  const candidates = new Map([...pages.filter(page => pageIds.has(page.pageId)), ...news].map(page => [page.pageId, page]));
  const navigationPages = [...candidates.values()].flatMap(page => {
    const identity = publicPageNavigationIdentity({ ...page, now });
    return identity ? [identity] : [];
  }).sort((a, b) => a.pageId.localeCompare(b.pageId));
  if (new Set(navigationPages.map(page => page.path)).size !== navigationPages.length) {
    throw Object.assign(new Error("Published content is unavailable"), { readerCode: "reader_ambiguous_route" });
  }
  const contentLinks = projectPublishedContentLinks(records, now);
  const coverageLabels = settings.find(setting => setting.id === "coverage-labels");
  return { ...(contentLinks.length ? { contentLinks } : {}), settings: settings.filter(setting => setting.id !== "coverage-labels"), navigationPages,
    ...(coverageLabels ? { coverageLabels } : {}) };
}
module.exports = { PUBLIC_CHROME_SETTINGS_IDS, publishedChromeSettings, publishedChromeBrandAssetIds,
  publishedChromePageIds, projectPublishedChromeRecords, contentLinkDirectoryEntry };
