"use strict";

const { readNoBuildFamilyAdmission, admitsNoBuildPage } = require("./no-build-family-admission");
const { validateNoBuildPageSnapshot } = require("./no-build-page-contract");
const { projectPublicPageDocument, publicAssetRequirementsForDocument, PublicContentProjectionError, legacyBlockOnlySnapshot } = require("./public-content-projection");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { mediaReplacementRef } = require("./media-replacement");
const { pagePublicationTarget } = require("./no-build-page-target");

/** Selected snapshots in each exact environment use the same strict reader.
 * A malformed selected snapshot cannot escape through an older read. */
async function readSelectedNoBuildPageProjection({ firestore, pageId, now = new Date(), env = process.env, target }) {
  // This optional lane precedes the legacy reader, including demo/local
  // callers. Explicit native readers still require an exact deployment.
  if (!target && !["njpbs-site", "njpbs-site-dev"].includes(firestore?.projectId)) return null;
  target = pagePublicationTarget({ firestore, target, environment: env.CMS_DEPLOYMENT_ENVIRONMENT });
  return firestore.runTransaction(async transaction => {
    const admission = await readNoBuildFamilyAdmission({ firestore, transaction, env });
    if (!admitsNoBuildPage(admission, pageId)) return null;
    return readNoBuildPageProjectionInTransaction({ firestore, transaction, pageId, now });
  }, { readOnly: true });
}

async function readNoBuildPageProjectionInTransaction({ firestore, transaction, pageId, now = new Date(), document, releaseSelector }) {
    const snapshot = document === undefined ? await transaction.get(firestore.doc(`cmsPages/${pageId}`)) : null;
    document = document === undefined ? (snapshot.exists ? snapshot.data() : null) : document;
    // A legacy block-only snapshot has never owned this reader's Page body.
    // Preserve the shared projector's unmanaged result until canonical republish.
    if (document?.published && !legacyBlockOnlySnapshot(document.published)) {
      validateNoBuildPageSnapshot({ pageId, snapshot: document.published });
    }
    const requirements = publicAssetRequirementsForDocument({ pageId, document, now });
    const { assetIds, documentAssetIds, imageAssetIds } = requirements;
    const refs = assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`),
      firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id)]);
    const media = refs.length ? await transaction.getAll(...refs) : [];
    let uploadedMediaReady = false;
    if (assetIds.some((_id, index) => media[index * 3]?.data()?.source === "upload")) {
      if (releaseSelector !== undefined) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({
        firestore, transaction, selector: releaseSelector });
      else {
        const root = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
        if (root?.schemaVersion === 2) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector: root });
        else assertMediaLifecycleDeploymentFence(root);
      }
      uploadedMediaReady = true;
    }
    const assets = new Map(assetIds.map((assetId, index) => {
      if (media[index * 3 + 2]?.exists) throw new PublicContentProjectionError("Page media replacement is pending");
      return [assetId, assertPublishedAssetProjection({ assetId, owner: "published Page",
        privateSnapshot: media[index * 3], publicSnapshot: media[index * 3 + 1], uploadedMediaReady,
        requiresPdf: documentAssetIds.includes(assetId), requiresImage: imageAssetIds.includes(assetId) })];
    }));
    return projectPublicPageDocument({ pageId, document, assets, now });
}

module.exports = { readSelectedNoBuildPageProjection, readNoBuildPageProjectionInTransaction };
