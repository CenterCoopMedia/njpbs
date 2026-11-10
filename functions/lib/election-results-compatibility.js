"use strict";
const { isElectionResultsData } = require("./election-results");
const { visibleLayoutBlocks } = require("./content-layout");

function containsVisibleElectionResults(snapshot) {
  return Array.isArray(snapshot?.blocks) && visibleLayoutBlocks(snapshot.blocks).some(block => block.type === "election_results");
}
function requiredElectionResultsVersion(snapshot) {
  const blocks = visibleLayoutBlocks(snapshot?.blocks ?? []).filter(block => block.type === "election_results");
  if (!blocks.length) return 0;
  return blocks.some(block => block.data?.races?.some(race => Object.hasOwn(race, "expectedVoteShare"))) ? 2 : 1;
}
function supportsElectionResults(snapshot, contract, complete = true) {
  const blocks = visibleLayoutBlocks(snapshot?.blocks ?? []).filter(block => block.type === "election_results");
  return !blocks.length || [1, 2].includes(contract?.electionResultsVersion) && blocks.every(block =>
    isElectionResultsData(block.data, complete)) && contract.electionResultsVersion >= requiredElectionResultsVersion(snapshot);
}
function candidateSupportsOwnedElectionResults(state, snapshot, contract) {
  return state?.visible !== true || supportsElectionResults(snapshot, contract);
}
module.exports = { containsVisibleElectionResults, requiredElectionResultsVersion, supportsElectionResults, candidateSupportsOwnedElectionResults };
