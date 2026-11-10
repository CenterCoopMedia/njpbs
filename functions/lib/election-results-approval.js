"use strict";

const { createHash } = require("node:crypto");
const { visibleLayoutBlocks } = require("./content-layout");
const { electionResultsError, electionRaceKey } = require("./election-results");

const digest = race => createHash("sha256").update(electionRaceKey(race)).digest("hex");
const identity = (blockId, raceId) => `${blockId}/${raceId}`;

function visibleRaces(document) {
  return visibleLayoutBlocks(document.blocks ?? []).filter(block => block.type === "election_results");
}

/** Called only by the existing authorized Approve transaction. History is private. */
function approveElectionResults(document, actor, approvedAt) {
  const prior = new Map((document.electionResultsApprovals ?? []).map(approval =>
    [identity(approval.blockId, approval.raceId), approval]));
  for (const block of visibleRaces(document)) {
    const error = electionResultsError(block.data, true);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    for (const race of block.data.races) {
      if (Date.parse(race.asOf) > Date.parse(approvedAt)) throw Object.assign(new Error("The source's as-of time cannot be in the future."), { status: 400 });
      const key = identity(block.id, race.id);
      const previous = prior.get(key);
      const nextDigest = digest(race);
      if (previous?.digest === nextDigest) continue;
      const entry = { revision: (previous?.revision ?? 0) + 1, status: race.status, approvedAt,
        approvedBy: { uid: actor.uid, displayName: actor.displayName } };
      const statusHistory = previous?.statusHistory ?? [];
      prior.set(key, { ...entry, blockId: block.id, raceId: race.id, digest: nextDigest, race: structuredClone(race),
        statusHistory: previous?.status === race.status ? statusHistory : [...statusHistory, entry] });
    }
  }
  return [...prior.values()];
}

/** Preview can show a draft; public capture accepts only the exact approved revision. */
function approvedElectionBlocks(document, { preview = false } = {}) {
  if (!(document.blocks ?? []).some(block => block.type === "election_results")) return document.blocks ?? [];
  const approvals = new Map((document.electionResultsApprovals ?? []).map(approval =>
    [identity(approval.blockId, approval.raceId), approval]));
  const visibleIds = new Set(visibleRaces(document).map(block => block.id));
  return (document.blocks ?? []).flatMap(block => {
    if (block.type !== "election_results") return [block];
    // Hidden draft results do not enter a public snapshot or its reader payload.
    if (!preview && !visibleIds.has(block.id)) return [];
    const error = preview ? electionResultsError(block.data, false) : electionResultsError(block.data, true);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    if (preview) return [block];
    const races = block.data.races.map(race => {
      const approval = approvals.get(identity(block.id, race.id));
      if (!approval || approval.digest !== digest(race) || approval.digest !== digest(approval.race)) {
        throw Object.assign(new Error(`Request review and approve the changed results for ${race.office}: ${race.district} before publishing.`), { status: 400 });
      }
      return structuredClone(approval.race);
    });
    return [{ ...block, data: { races } }];
  }).map((block, order) => ({ ...block, order }));
}

module.exports = { approveElectionResults, approvedElectionBlocks };
