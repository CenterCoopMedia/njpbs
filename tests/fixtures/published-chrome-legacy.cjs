"use strict";
// Frozen pre-extraction reader for byte-parity regressions only.
const { projectPublishedCmsSettings, SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } = require("../../functions/lib/cms-settings-contract");
const { PUBLIC_PAGE_DEFINITIONS } = require("../../functions/lib/public-page-contract");
const { selectedAssets, publicPageNavigationIdentity } = require("../../functions/lib/public-content-projection");
const { pairedAssetPaths, projectPairedAsset } = require("../../functions/lib/joined-records");
const { assertPublishedMediaReadiness } = require("../../functions/lib/public-deployment");
const readerFailure = code => Object.assign(new Error("Published content is unavailable"), { readerCode: code });
async function readPublishedChrome(firestore, tx, now, { strictBanner = false } = {}) {
  const snapshots = await tx.getAll(...[SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID]
    .map(id => firestore.doc(`cmsSettings/${id}`)));
  const settings = [];
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const document = snapshot.data();
    // Match the publisher: Missing, unpublished or invalid settings use the seed.
    let published;
    try { published = projectPublishedCmsSettings({ documentId: snapshot.id, document }); }
    catch (error) {
      // Preserve Home's strict legacy contract without allowing an invalid
      // optional announcement to remove every other readable public route.
      if (snapshot.id === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID && strictBanner) throw error;
      continue;
    }
    if (published) settings.push({ id: snapshot.id, version: published.sourceVersion, published });
  }
  const brand = settings.find(setting => setting.id === NJ_DECIDES_SETTINGS_ID);
  if (brand) {
    const ids = [...new Set([brand.published.values.logoAssetId, brand.published.values.backgroundAssetId].filter(Boolean))];
    brand.assets = {};
    if (ids.length) {
      const media = await tx.getAll(...pairedAssetPaths(ids).map(path => firestore.doc(path)));
      let uploadedMediaReady = false;
      if (media.some((row, index) => index % 2 === 0 && row.data()?.source === "upload")) {
        const deployment = await tx.get(firestore.doc("system/publicDeployment"));
        try { assertPublishedMediaReadiness(deployment.data()); uploadedMediaReady = true; }
        catch { /* Unavailable branding media uses the bundled identity. */ }
      }
      for (const [index, id] of ids.entries()) {
        try {
          const image = projectPairedAsset({ assetId: id, privateSnapshot: media[index * 2], publicSnapshot: media[index * 2 + 1], uploadedMediaReady });
          Object.assign(brand.assets, selectedAssets({ assetIds: [id] }, new Map([[id, image]])));
        } catch { /* An image must not remove an otherwise readable Page or Post. */ }
      }
    }
  }
  const navigation = settings.find(setting => setting.id === SITE_NAVIGATION_SETTINGS_ID)?.published.values;
  const links = navigation ? [...navigation.header, ...navigation.footer.flatMap(column => column.links)] : [];
  const pageIds = new Set([...Object.keys(PUBLIC_PAGE_DEFINITIONS),
    ...links.filter(link => link.target.type === "page").map(link => link.target.pageId)]);
  // The seed also contains this route target. Its owner is a custom Page id.
  const [pages, news] = await Promise.all([
    tx.getAll(...[...pageIds].sort().map(id => firestore.doc(`cmsPages/${id}`))),
    tx.get(firestore.collection("cmsPages").where("published.metadata.slug", "==", "in-the-news").limit(2)),
  ]);
  const candidates = new Map([...pages, ...news.docs].map(page => [page.id, page]));
  const navigationPages = [...candidates.values()].filter(page => page.exists).flatMap(page => {
    const identity = publicPageNavigationIdentity({ pageId: page.id, document: page.data(), now });
    return identity ? [identity] : [];
  }).sort((a, b) => a.pageId.localeCompare(b.pageId));
  if (new Set(navigationPages.map(page => page.path)).size !== navigationPages.length) {
    throw readerFailure("reader_ambiguous_route");
  }
  return { settings, navigationPages };
}

module.exports = { readPublishedChrome };
