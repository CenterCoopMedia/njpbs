"use strict";

const p = require("./public-release-pair");
const runtime = require("./cms-publication-runtime-control");
const lineage = require("./public-release-switch-lineage");
const HISTORY = "system/publicReleaseSwitches/entries";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const codeSelector = selector => { const code = { ...selector }; delete code.contentHead; return code; };
function refuse() { throw new p.PublicReleaseProtocolError(); }
function parseHistory(value) {
  p.exact(value, ["schemaVersion", "operationId", "selector", "pins"]);
  const selector = p.parsePublicReleaseSelector(value.selector), pins = runtime.parseCmsPublicationRuntimeControl(value.pins);
  if (value.schemaVersion !== 2 || value.operationId !== selector.switchOperationId ||
      [pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== selector.activeCommitSha)) refuse();
  return selector;
}

/** Schedule's original qualified CODE generation is separate from the new
 * selector epoch. A mismatched generation is allowed only for an actual
 * guarded return to the immediately retained pair. This reads history in the
 * caller's same SDK/historical-source transaction and grants no write. */
async function pageContextCodeGeneration({ firestore, transaction, pointer, context }) {
  if (pointer.schemaVersion !== 2 || !context.schedule) return pointer.activeGeneration;
  const receipt = context.schedule.receipt, generation = receipt?.code?.generation;
  if (receipt?.schemaVersion !== 1 || receipt.code.commitSha !== pointer.activeCommitSha || !p.positive(generation)) refuse();
  if (generation === pointer.activeGeneration) return pointer.activeGeneration;
  const selector = p.parseStoredPublicReleaseSelector(pointer);
  if (generation >= selector.activeGeneration || selector.epoch < 2) refuse();
  const [current, prior] = await transaction.getAll(
    firestore.doc(`${HISTORY}/${selector.switchOperationId}`),
    firestore.doc(lineage.publicReleaseSwitchLineagePath(selector.switchOperationId)));
  if (!current.exists || !prior.exists) refuse();
  const selected = parseHistory(current.data());
  if (!same(codeSelector(selected), codeSelector(selector))) refuse();
  const retained = lineage.parsePublicReleaseSwitchLineage(prior.data(), selected).previousSelector;
  if (generation > retained.activeGeneration || !same(retained.selectedPair, selector.recoveryPair) ||
      !same(retained.recoveryPair, selector.selectedPair)) refuse();
  return generation;
}
module.exports = { pageContextCodeGeneration };
