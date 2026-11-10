"use strict";

const CONTENT_LINKS_PER_COLLECTION = 500;
function publicContentLinksQuery(firestore, collection) {
  return firestore.collection(collection).where("published.metadata.contentLinkMode", "==", "custom")
    .where("publiclyVisible", "==", true).limit(CONTENT_LINKS_PER_COLLECTION);
}

/** Admission owns capacity. Reads stay bounded and never take the site down
 * because withdrawn snapshots retain their last custom URL. */
async function assertContentLinkCapacityInTransaction({ firestore, transaction, collection, documentId, nextDocument }) {
  if (!["cmsPosts", "cmsPages"].includes(collection) || collection === "cmsPosts" && nextDocument?.type !== "post" ||
      !require("./public-video-references").publiclyVisible(nextDocument) || nextDocument?.published?.metadata?.contentLinkMode !== "custom") return;
  const fields = ["published.metadata.type", "published.metadata.slug", "published.metadata.previousSlugs", "published.metadata.contentLinkMode", "published.metadata.contentLinkUrl", "published.metadata.contentLinkNewTab"];
  const rows = await transaction.get(publicContentLinksQuery(firestore, collection).select(...fields));
  if (rows.size === CONTENT_LINKS_PER_COLLECTION && !rows.docs.some(row => row.id === documentId)) {
    throw Object.assign(new Error(`There are already ${CONTENT_LINKS_PER_COLLECTION} public ${collection === "cmsPosts" ? "Posts" : "Pages"} pointing to custom URLs. Switch an existing item to its normal address or unpublish it before publishing another.`), { status: 409 });
  }
  const { contentLinkDirectoryEntry } = require("./published-chrome-projection");
  const current = rows.docs.find(row => row.id === documentId);
  const nextEntry = contentLinkDirectoryEntry(`${collection}/${documentId}`, nextDocument);
  if (current && JSON.stringify(contentLinkDirectoryEntry(`${collection}/${documentId}`, current.data())) === JSON.stringify(nextEntry)) return;
  const otherCollection = collection === "cmsPosts" ? "cmsPages" : "cmsPosts";
  const other = await transaction.get(publicContentLinksQuery(firestore, otherCollection).select(...fields));
  const entries = [...rows.docs.filter(row => row.id !== documentId).flatMap(row => contentLinkDirectoryEntry(`${collection}/${row.id}`, row.data())),
    ...other.docs.flatMap(row => contentLinkDirectoryEntry(`${otherCollection}/${row.id}`, row.data())),
    ...nextEntry];
  if (!require("./content-link").contentLinkDirectoryFits(entries)) {
    throw Object.assign(new Error("The published link directory has reached its 1 MB size limit. Shorten this custom URL or switch an existing item to its normal address before publishing."), { status: 409 });
  }
}
module.exports = { CONTENT_LINKS_PER_COLLECTION, publicContentLinksQuery, assertContentLinkCapacityInTransaction };
