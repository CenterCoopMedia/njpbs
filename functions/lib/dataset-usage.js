"use strict";
const { createHash } = require("node:crypto");
const { validDatasetId, DatasetError } = require("./datasets");
const { digest, figureBlocks, validateFrozenDatasetFigures } = require("./dataset-dependencies");
const { editorialSnapshotDigest } = require("./dataset-refresh-identity");
const electionLineage = require("./election-source-lineage");
const useId = ({ collection, documentId, blockId }) => createHash("sha256").update(`${collection}/${documentId}/${blockId}`).digest("hex");
/** Draft saves never replace these rows. The content transaction owns all writes. */
async function prepareDatasetUsageWrites({ firestore, transaction, collection, documentId, snapshot, visible = true, withdrawalPending = false, previousSnapshot, operationId, editorialLineage }) {
  if (!["cmsPages", "cmsPosts"].includes(collection) || !validDatasetId(documentId)) return () => {};
  if (snapshot) validateFrozenDatasetFigures(snapshot);
  if (!figureBlocks(snapshot).length && !figureBlocks(previousSnapshot).length) return () => {};
  if (!operationId && visible && figureBlocks(snapshot).length) {
    const path = collection === "cmsPages" ? `system/publicDeployment/noBuildPageOwners/${documentId}` : `system/publicDeployment/noBuildPostOwners/${documentId}`;
    operationId = (await transaction.get(firestore.doc(path))).data()?.operationId;
  }
  if (visible && figureBlocks(snapshot).length && !/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) throw new DatasetError("Data figures require an exact compiled publication operation.", 409);
  const ownerSnapshotDigest = digest(snapshot);
  let editorialDigest = editorialSnapshotDigest(snapshot);
  if (electionLineage.hasElectionResults(snapshot)) {
    const document = (await transaction.get(firestore.doc(`${collection}/${documentId}`))).data();
    const projected = { ...document, published: snapshot };
    editorialDigest = editorialLineage ? electionLineage.lineageDigest(projected, editorialLineage)
      : await electionLineage.readElectionEditorialDigest({ firestore, transaction, collection, documentId, document: projected });
  }
  const prior = await transaction.get(firestore.collection("cmsDatasetUses").where("collection", "==", collection).where("documentId", "==", documentId).limit(201));
  if (prior.size > 200) throw new DatasetError("This content has too many dataset uses.", 409);
  const rows = new Map();
  if (visible && snapshot) for (const block of figureBlocks(snapshot)) {
    const binding = snapshot.datasetFigures.figures.find(item => item.blockId === block.id);
    if (binding.withdrawn) {
      if (withdrawalPending) {
        const priorUse = prior.docs.find(row => row.id === useId({ collection, documentId, blockId: block.id }));
        if (priorUse && priorUse.data().datasetId === binding.datasetId) rows.set(priorUse.id, { ...priorUse.data(),
          state: "withdrawal_pending", operationId, ownerSnapshotDigest, editorialSnapshotDigest: editorialDigest,
          snapshotDigest: digest(snapshot), datasetFiguresDigest: digest(snapshot.datasetFigures) });
      }
      continue;
    }
    const identity = { collection, documentId, blockId: block.id };
    rows.set(useId(identity), { schemaVersion: 1, ...identity, datasetId: binding.datasetId,
      ownerTitle: typeof snapshot.metadata?.title === "string" ? snapshot.metadata.title.slice(0, 300) : "Published content",
      publicPath: collection === "cmsPosts" ? `/posts/${snapshot.metadata.slug}/` : require("./public-page-contract").publicPagePath(documentId, snapshot.metadata),
      operationId, ownerSnapshotDigest, editorialSnapshotDigest: editorialDigest,
      releasePolicy: block.data.version.mode, releaseId: binding.releaseId, revision: binding.revision,
      approvedDigest: binding.digest, sourceVersion: snapshot.sourceVersion, snapshotDigest: digest(snapshot),
      datasetFiguresDigest: digest(snapshot.datasetFigures), state: "published" });
  }
  // Bound the fan-out at admission, including uses on other owners. Concurrent
  // publishers conflict on each dataset record read and versioned usage counter.
  const datasetIds = [...new Set([...rows.values()].map(row => row.datasetId).concat(prior.docs.map(row => row.data().datasetId)))];
  const counts = [];
  for (const id of datasetIds) {
    const ref = firestore.doc(`cmsDatasets/${id}`);
    const record = (await transaction.get(ref)).data();
    if (!record && rows.size) throw new DatasetError("The dataset is unavailable.", 409);
    const existing = await transaction.get(firestore.collection("cmsDatasetUses").where("datasetId", "==", id).limit(501));
    const count = existing.size - prior.docs.filter(row => row.data().datasetId === id).length + [...rows.values()].filter(row => row.datasetId === id).length;
    if (count > 500) throw new DatasetError("This dataset exceeds 500 published uses.", 409);
    if (record) counts.push({ ref, count, revision: (record.usageRevision ?? 0) + 1 });
  }
  return () => {
    for (const row of prior.docs) if (!rows.has(row.id)) transaction.delete(row.ref);
    for (const [id, row] of rows) transaction.set(firestore.doc(`cmsDatasetUses/${id}`), row);
    for (const count of counts) transaction.update(count.ref, { publishedUseCount: count.count, usageRevision: count.revision });
  };
}
module.exports = { useId, prepareDatasetUsageWrites };
