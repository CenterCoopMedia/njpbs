"use strict";
const { isDeepStrictEqual } = require("node:util");
const { createHash } = require("node:crypto");
const { electionRaceKey, electionResultsError } = require("./election-results");
const { visibleLayoutBlocks } = require("./content-layout");
const { assertRehearsalTarget } = require("./election-source-rehearsal");
const { ElectionSourceError } = require("./election-result-sources");
const digest = value => createHash("sha256").update(electionRaceKey(value)).digest("hex");
const connectionId = (collection, documentId, blockId) => digest([collection, documentId, blockId]);
class ElectionSourceProjectionError extends Error {
  constructor(message) { super(message); this.name = "ElectionSourceProjectionError"; this.status = 409; }
}
const fail = message => { throw new ElectionSourceProjectionError(message); };

function publicBlock(document, blockId) {
  const visible = visibleLayoutBlocks(document?.published?.blocks ?? []).some(block => block.type === "election_results" && block.id === blockId);
  return visible ? document.published.blocks.find(block => block.id === blockId) : undefined;
}
function assertElectionSourceRefresh(before, after, binding) {
  if (!before?.published || !after?.published || !binding || typeof binding.blockId !== "string") fail("The connected public section is unavailable.");
  const freeze = document => {
    const copy = structuredClone(document);
    delete copy.publishBuildPending; delete copy.publishBuildQueueId;
    const target = publicBlock(copy, binding.blockId);
    if (!target) fail("The connected public section is unavailable.");
    const error = electionResultsError(target.data, true);
    if (error) fail(error);
    target.data = null;
    return copy;
  };
  if (!isDeepStrictEqual(freeze(before), freeze(after))) fail("An election source cannot change other published or working content.");
}
/** Overlay only accepted feed values during a normal, authorized publication. */
async function withElectionSourceProjection({ firestore, transaction, collection, documentId, document }) {
  if (!["cmsPages", "cmsPosts"].includes(collection)) return document;
  const targets = visibleLayoutBlocks(document.blocks ?? []).filter(block => block.type === "election_results");
  if (!targets.length) return document;
  const rows = await Promise.all(targets.map(block => transaction.get(firestore.doc(
    `cmsElectionResultConnections/${connectionId(collection, documentId, block.id)}`))));
  const projections = new Map();
  const approvals = new Map((document.electionResultsApprovals ?? []).map(row => [`${row.blockId}/${row.raceId}`, row]));
  for (const [index, row] of rows.entries()) {
    const value = row.data();
    if (!value) continue;
    try { await assertRehearsalTarget({ firestore, transaction, connection: value, document }); }
    catch (error) {
      if (error instanceof ElectionSourceError && error.code === "rehearsal") fail(error.message);
      throw error;
    }
    const target = targets[index];
    const unchangedDraft = digest(target.data) === value.draftDigest;
    if (value.paused && !unchangedDraft) continue;
    if (!unchangedDraft) fail("Pause this election source before publishing manual changes to its results.");
    const published = publicBlock(document, target.id);
    if (!published) continue;
    // Retain the currently public values through unrelated parent publication,
    // including pause and approve-once holds. A changed paused draft is an
    // explicit manual correction and follows the ordinary approval path.
    const data = published.data;
    if (value.collection !== collection || value.documentId !== documentId || value.blockId !== targets[index].id ||
        digest(data) !== value.boundDigest || electionResultsError(data, true)) fail("The election connection needs repair before publication.");
    projections.set(value.blockId, data);
    for (const race of data.races) approvals.set(`${value.blockId}/${race.id}`, {
      blockId: value.blockId, raceId: race.id, race, digest: digest(race), revision: value.publicationRevision,
      approvedAt: value.lastGoodAt ?? document.published.publishedAt, approvedBy: { uid: "system:election-source", displayName: "Connected election source" },
      status: race.status, statusHistory: [],
    });
  }
  if (!projections.size) return document;
  return { ...document, blocks: document.blocks.map(block => projections.has(block.id)
    ? { ...block, data: structuredClone(projections.get(block.id)) } : block), electionResultsApprovals: [...approvals.values()] };
}
module.exports = { ElectionSourceProjectionError, digest, connectionId, publicBlock, assertElectionSourceRefresh, withElectionSourceProjection };
