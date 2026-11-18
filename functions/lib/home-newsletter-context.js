"use strict";

const { shapeJoinedRecord, joinedAssetIds, pairedAssetPaths, projectPairedAsset } = require("./joined-records");
const { PublishedMediaSafetyError } = require("./published-media-safety");
const { assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { mediaReplacementRef } = require("./media-replacement");
const { selectedAssets } = require("./public-content-projection");
const { newsletterCardData, projectHomeNewsletterRecord } = require("./home-retained-sources");

async function getAll(transaction, references) {
  const rows = [];
  for (let index = 0; index < references.length; index += 100) {
    rows.push(...await transaction.getAll(...references.slice(index, index + 100)));
  }
  return rows;
}

/** A complete bounded approved picker pool, including unselected records.
 * Approval history supplies every public field. Working saves never do.
 * Unavailable optional art is omitted; its private or mismatched bytes never enter Home. */
async function readHomeNewslettersInTransaction({ firestore, transaction, recordIds, pointer, now = new Date() }) {
  try {
    return await readRoster({ firestore, transaction, recordIds, pointer, now });
  } catch {
    // This optional service must never make the rest of Home unavailable.
    // Do not log database messages or private approval/history documents.
    return { status: "error" };
  }
}
async function readRoster({ firestore, transaction, recordIds, pointer, now }) {
  const candidates = await transaction.get(firestore.collection("cmsPosts").where("type", "==", "newsletter").limit(1001));
  // Saturation cannot certify a complete pool. Omit only this service rather
  // than letting accumulated library records make the public Home fail.
  if (candidates.size >= 1001) return { status: "error" };
  // These are the approval reader's unconditional refusals. Working copy is
  // never an eligibility shortcut: reopened drafts can retain an approval.
  const eligibleCandidates = candidates.docs.filter(row => {
    const data = row.data();
    return !data.deleted && data.status !== "archived" && Number.isSafeInteger(data.version) && data.version > 0;
  }).sort((a, b) => Number(recordIds.includes(b.id)) - Number(recordIds.includes(a.id)) || a.id.localeCompare(b.id));
  const records = [];
  for (let index = 0; index < eligibleCandidates.length && records.length < 200;) {
    // Parallel waves preserve the small-library read fan-out while allowing
    // a full eligible window to stop before reading the remaining histories.
    const wave = eligibleCandidates.slice(index, index + Math.ceil((200 - records.length) / 10) * 10);
    const batches = [];
    for (let offset = 0; offset < wave.length; offset += 10) batches.push(wave.slice(offset, offset + 10));
    const histories = await Promise.all(batches.map(batch => transaction.get(firestore.collection("cmsVersionHistory")
      .where("collection", "==", "cmsPosts").where("documentId", "in", batch.map(row => row.id)).limit(1001))));
    // History saturation cannot certify an approval or a revocation. Refuse
    // the service instead of accepting an arbitrarily truncated history.
    if (histories.some(history => history.size >= 1001)) return { status: "error" };
    const byId = new Map(wave.map(row => [row.id, []]));
    for (const entry of histories.flatMap(history => history.docs)) {
      const data = entry.data();
      if (byId.has(data.documentId)) byId.get(data.documentId).push(data);
    }
    for (const row of wave) {
      const record = shapeJoinedRecord(row.id, row.data(), byId.get(row.id));
      const card = record && newsletterCardData(record.approvedLibraryVersion);
      if (card && projectHomeNewsletterRecord({ id: row.id, kind: "newsletter", href: null,
        sourceVersion: record.approvedLibraryVersion.version, newsletter: { card } }, now.toISOString(), now.toISOString())) records.push(record);
    }
    index += wave.length;
  }
  records.splice(200);
  const ids = joinedAssetIds(records);
  const media = await getAll(transaction, pairedAssetPaths(ids).map(path => firestore.doc(path)));
  const locks = await getAll(transaction, ids.map(id => mediaReplacementRef(firestore, id)));
  let uploadedMediaReady = false;
  if (media.some((row, index) => index % 2 === 0 && row.data()?.source === "upload")) try {
    if (pointer?.schemaVersion === 2) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector: pointer });
    else assertMediaLifecycleDeploymentFence(pointer);
    uploadedMediaReady = true;
  } catch (error) {
    // Unqualified optional art is absent. A transport failure makes the
    // optional service unavailable instead of sealing a partial normal roster.
    if (pointer?.schemaVersion === 2 && !(error instanceof require("./public-release-pair").PublicReleaseProtocolError)) throw error;
  }
  const assets = new Map();
  for (const [index, id] of ids.entries()) {
    if (locks[index].exists) continue;
    try {
      assets.set(id, projectPairedAsset({ assetId: id, privateSnapshot: media[index * 2],
        publicSnapshot: media[index * 2 + 1], uploadedMediaReady }));
    } catch (error) {
      if (!(error instanceof PublishedMediaSafetyError)) throw error;
    }
  }
  const safe = selectedAssets({ assetIds: [...assets.keys()] }, assets);
  return { joinedRecords: records, assets: [...assets.keys()].map(id => ({ id, ...safe[id] })) };
}

module.exports = { readHomeNewslettersInTransaction };
