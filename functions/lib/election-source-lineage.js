"use strict";
const { digest } = require("./dataset-dependencies");
const { editorialSnapshotDigest } = require("./dataset-refresh-identity");
const COLLECTION = "cmsElectionResultEditorialOwners";
const hasElectionResults = snapshot => snapshot?.blocks?.some(block => block.type === "election_results") === true;
const lineageRef = (firestore, collection, documentId) => firestore.doc(`${COLLECTION}/${digest([collection, documentId])}`);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Only an exact current server-written chain may stand for its original digest. */
function lineageDigest(document, lineage) {
  const current = editorialSnapshotDigest(document?.published);
  return lineage?.schemaVersion === 1 && Number.isSafeInteger(document?.version) && document.version > 0 &&
    lineage.workingVersion === document.version && lineage.sourceVersion === document.published?.sourceVersion &&
    lineage.editorialDigest === current && hash(lineage.baselineDigest) ? lineage.baselineDigest : current;
}
async function readElectionEditorialDigest({ firestore, transaction, collection, documentId, document }) {
  if (!hasElectionResults(document?.published)) return editorialSnapshotDigest(document?.published);
  const lineage = (await transaction.get(lineageRef(firestore, collection, documentId))).data();
  return lineageDigest(document, lineage);
}
/** Call only after the strict election-only diff assertion, before any writes. */
async function prepareElectionLineage({ firestore, transaction, collection, documentId, before, after }) {
  const ref = lineageRef(firestore, collection, documentId);
  const previous = (await transaction.get(ref)).data();
  const lineage = { schemaVersion: 1, workingVersion: before.version, sourceVersion: before.published.sourceVersion,
    baselineDigest: lineageDigest(before, previous), editorialDigest: editorialSnapshotDigest(after.published) };
  return { lineage, write: () => transaction.set(ref, lineage) };
}
module.exports = { COLLECTION, hasElectionResults, lineageRef, lineageDigest, readElectionEditorialDigest, prepareElectionLineage };
