"use strict";

const { PAGE_CAPABILITY_PATH, candidateNoBuildPageContract, listNoBuildPageOwners,
  assertPageOwnerSnapshot, pageRouteRef, refuse } = require("./no-build-page-ownership");

function pageTerminalOwnerSeal(rendererSha) {
  // #3282 supplies the complete serving, verified confirmation and retry owner.
  // Renderer metadata alone must not activate acceptance of durable Page work.
  try {
    const serving = require("./no-build-page-serving");
    const recovery = require("./no-build-page-recovery");
    if (typeof serving.readNoBuildPageDecision !== "function" || recovery.TRANSPORT !== "page-no-build-v1" ||
        typeof recovery.readPublicPageReceipt !== "function" || typeof recovery.recoverNoBuildPageDetail !== "function") throw new Error();
    return { schemaVersion: 1, transport: "page-no-build-v1", rendererSha };
  } catch { return null; }
}

/** Code candidates must preserve every accepted Page, including retained aliases
 * and withdrawn routes. Recheck both before taking the lease and before settling. */
async function assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate }) {
  await require("./page-reader-compatibility").assertCandidatePageReaders({ firestore, transaction, candidate });
  const recordContract = await require("./no-build-record-capability").assertRecordCandidateInTransaction({ firestore, transaction, candidate });
  const contract = candidateNoBuildPageContract(candidate.noBuildPage);
  if (contract && contract.rendererSha !== candidate.commitSha) refuse("The Page renderer does not match its candidate.");
  const owners = await listNoBuildPageOwners({ firestore, transaction });
  if (owners.length && !contract) refuse("The public candidate does not preserve owned build-free Page routes.");
  for (const { state } of owners) {
    if (state.pageId === "data-hub" && contract?.dataHubReportingVersion !== 1) refuse("The candidate must preserve the Data Hub publication gate.");
    if (!require("./data-figure-compatibility").candidateSupportsOwnedDataFigures(state, contract)) {
      refuse("The public candidate does not preserve published data figures.");
    }
    for (const path of state.ownedPaths) {
      const route = (await transaction.get(pageRouteRef(firestore, path))).data();
      if (route?.schemaVersion !== 1 || route.pageId !== state.pageId || route.path !== path) refuse();
    }
    const document = (await transaction.get(firestore.doc(`cmsPages/${state.pageId}`))).data();
    if (!require("./election-results-compatibility").candidateSupportsOwnedElectionResults(state, document?.published, contract)) {
      refuse("The public candidate does not preserve published election results.");
    }
    assertPageOwnerSnapshot(state, document);
    if (document?.published?.metadata?.dataHubCompositionVersion === 1 && contract?.dataHubCompositionVersion !== 1) {
      refuse("The candidate must preserve the Data Hub Page composition.");
    }
  }
  return { contract, recordContract };
}
function writeNoBuildPageCandidateActivation(transaction, firestore, { contract, recordContract }, candidate) {
  require("./no-build-record-capability").writeRecordCandidateActivation(transaction, firestore, recordContract, candidate);
  if (!contract) return;
  const terminalOwner = pageTerminalOwnerSeal(candidate.commitSha);
  transaction.set(firestore.doc(PAGE_CAPABILITY_PATH), { schemaVersion: 1,
    rendererSha: candidate.commitSha, servingEnabled: contract.enabled, generation: candidate.generation,
    ...(contract.dataHubReportingVersion === 1 ? { dataHubReportingVersion: 1 } : {}),
    ...(contract.dataHubCompositionVersion === 1 ? { dataHubCompositionVersion: 1 } : {}),
    ...(contract.dataFigureVersion === 1 ? { dataFigureVersion: 1 } : {}),
    ...([1, 2].includes(contract.electionResultsVersion) ? { electionResultsVersion: contract.electionResultsVersion } : {}),
    ...(terminalOwner ? { terminalOwner } : {}) });
}
module.exports = { assertNoBuildPageCandidateInTransaction, writeNoBuildPageCandidateActivation };
