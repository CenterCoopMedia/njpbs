"use strict";
// Worker-safe admission codecs and read-only retained-original authority.
// Keep producer, source mutation and Firebase SDK imports in the Node owner.
const p = require("./public-release-pair");
const inputs = require("./public-release-pair-input");
const log = require("./public-release-change-log");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const ADMISSIONS = "system/publicReleaseAdmissions";
const CONTRACTS = "system/publicReleaseAdmissionContracts/entries";
const TRANSPORT = "release-pair-publication-v2";
const ZERO = "0".repeat(64);
const FAMILY = { post: "posts", page: "pages", settings: "settings", provider: "context" };
function refuse() { throw new p.PublicReleaseProtocolError(); }
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const id = value => { if (!isPublicDeploymentIdentifier(value)) refuse(); return value; };
function parseAdmissionHead(value) {
  p.exact(value, ["schemaVersion", "sequence", "pendingCount", "pendingDigest"]);
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isSafeInteger(value.pendingCount) || value.pendingCount < 0 || value.pendingCount > value.sequence ||
      !p.digest(value.pendingDigest) || value.pendingCount === 0 && value.pendingDigest !== ZERO) refuse();
  return p.freeze({ ...value });
}
const initialAdmissionHead = () => parseAdmissionHead({ schemaVersion: 2, sequence: 0, pendingCount: 0, pendingDigest: ZERO });
function togglePendingDigest(left, right) {
  if (![left, right].every(p.digest)) refuse();
  const bytes = Buffer.from(right, "hex");
  return Buffer.from(left, "hex").map((byte, index) => byte ^ bytes[index]).toString("hex");
}
function parsePublicationSource(value) {
  p.exact(value, ["kind", "id", "family", "action", "sourceVersion", "snapshotDigest", "requiredFeatures"]);
  if (![...Object.keys(FAMILY), "record"].includes(value.kind) ||
      (value.kind === "record" ? !["programs", "events"].includes(value.family) : FAMILY[value.kind] !== value.family) ||
      !["publish", "withdraw", "dependency"].includes(value.action) || !p.positive(value.sourceVersion) || !p.digest(value.snapshotDigest) ||
      !Array.isArray(value.requiredFeatures) || value.requiredFeatures.length > 32 ||
      value.requiredFeatures.some((feature, index) => (!/^[A-Za-z][A-Za-z0-9-]{0,63}:1$/.test(feature) && feature !== "electionResultsVersion:2") || index > 0 && feature <= value.requiredFeatures[index - 1])) refuse();
  id(value.id); return p.freeze({ ...value, requiredFeatures: [...value.requiredFeatures] });
}
const ownerPath = source => `${ADMISSIONS}/owners/${p.publicReleaseDigest({ kind: source.kind, id: source.id })}`;
function parseAdmission(value) {
  p.exact(value, ["schemaVersion", "operationId", "source", "pair", "pairDigest", "epoch", "changeSequence", "contextRevision", "admissionSequence", "admittedContractDigest"]);
  const source = parsePublicationSource(value.source), pair = p.parsePublicReleasePairReference(value.pair);
  id(value.operationId);
  if (value.schemaVersion !== 2 || ![value.epoch, value.changeSequence, value.contextRevision, value.admissionSequence].every(p.positive) ||
      ![value.pairDigest, value.admittedContractDigest].every(p.digest)) refuse();
  return p.freeze({ ...value, source, pair });
}
function assertQueue(queue, admission) {
  if (queue?.schemaVersion !== 2 || queue.transport !== TRANSPORT || queue.operationId !== admission.operationId ||
      queue.admissionDigest !== p.publicReleaseDigest(admission) || !same(queue.pair, admission.pair) ||
      !["pending", "publishing", "success", "superseded", "failed"].includes(queue.status)) refuse();
}
/** Read-only authority for an exact already accepted operation after the
 * selector moved. Never authorizes a new admission or a different scope. */
async function assertRetainedPairAdmissionInTransaction({ firestore, transaction, pair, scope: rawScope }) {
  const scope = inputs.parsePublicReleasePairInputScope(rawScope);
  if (scope.kind !== "accepted") refuse();
  const [row, queueRow, pendingRow] = await transaction.getAll(firestore.doc(`${ADMISSIONS}/operations/${scope.sourceOperationId}`),
    firestore.doc(`cmsPublishQueue/${scope.sourceOperationId}`), firestore.doc(`${ADMISSIONS}/pending/${scope.sourceOperationId}`));
  const admission = parseAdmission(row.data()); assertQueue(queueRow.data(), admission);
  if (admission.pairDigest !== p.publicReleaseDigest(pair) || !same(admission.pair, p.publicReleasePairReference(pair)) ||
      admission.source.sourceVersion !== scope.sourceVersion || admission.source.snapshotDigest !== scope.snapshotDigest ||
      admission.changeSequence !== scope.contextSequence || !["pending", "publishing", "failed"].includes(queueRow.data().status) ||
      pendingRow.data()?.admissionDigest !== p.publicReleaseDigest(admission)) refuse();
  const entry = log.parsePublicReleaseChange((await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(admission.changeSequence).padStart(16, "0")}`))).data());
  if (entry.operationId !== admission.operationId || !same(entry.pair, admission.pair) || entry.contextRevision !== admission.contextRevision ||
      entry.changes.length !== 1 || !same(entry.changes[0], { kind: admission.source.kind, id: admission.source.id,
        action: admission.source.action, sourceVersion: admission.source.sourceVersion, snapshotDigest: admission.source.snapshotDigest })) refuse();
  return admission;
}
module.exports = { ADMISSIONS, CONTRACTS, TRANSPORT, FAMILY, initialAdmissionHead, parseAdmissionHead, togglePendingDigest,
  parsePublicationSource, parseAdmission, ownerPath, assertQueue, assertRetainedPairAdmissionInTransaction };
