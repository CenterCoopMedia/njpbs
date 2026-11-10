"use strict";

const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { PUBLIC_RELEASE_PROTOCOL, PublicReleaseProtocolError, parsePublicReleasePairReference,
  publicReleaseDigest, exact, digest, positive, freeze } = require("./public-release-pair");

// Enrollment and source ownership are separate from the contiguous log protocol.
const PUBLIC_RELEASE_CHANGES_PATH = "system/publicReleaseChanges";
const KINDS = new Set(["post", "page", "record", "settings", "library", "media", "author", "provider", "schedule", "dataHub"]);
function refuse() { throw new PublicReleaseProtocolError(); }
function sequenceId(sequence) {
  if (!positive(sequence)) refuse();
  return String(sequence).padStart(16, "0");
}
function parsePublicReleaseChangeInput(value) {
  exact(value, ["operationId", "pair", "contextRevision", "changes"]);
  const pair = parsePublicReleasePairReference(value.pair);
  if (!isPublicDeploymentIdentifier(value.operationId) || !positive(value.contextRevision) ||
      !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 100) refuse();
  const identities = new Set();
  const changes = value.changes.map(change => {
    exact(change, ["kind", "id", "action", "sourceVersion", "snapshotDigest"]);
    if (!KINDS.has(change.kind) || !isPublicDeploymentIdentifier(change.id) ||
        !["publish", "withdraw", "dependency"].includes(change.action) ||
        !positive(change.sourceVersion) || !digest(change.snapshotDigest)) refuse();
    const key = `${change.kind}:${change.id}`;
    if (identities.has(key)) refuse();
    identities.add(key);
    return { ...change };
  }).sort((left, right) => {
    const a = `${left.kind}:${left.id}`, b = `${right.kind}:${right.id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return freeze({ operationId: value.operationId, pair, contextRevision: value.contextRevision, changes });
}
function parsePublicReleaseChangeHead(value) {
  exact(value, ["schemaVersion", "sequence", "baselineDigest", "lastDigest"]);
  if (value.schemaVersion !== PUBLIC_RELEASE_PROTOCOL || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !digest(value.baselineDigest) || !digest(value.lastDigest) ||
      value.sequence === 0 && value.lastDigest !== value.baselineDigest) refuse();
  return Object.freeze({ ...value });
}
function initialPublicReleaseChangeHead(baselineDigest) {
  return parsePublicReleaseChangeHead({ schemaVersion: PUBLIC_RELEASE_PROTOCOL, sequence: 0,
    baselineDigest, lastDigest: baselineDigest });
}
function parsePublicReleaseChange(value) {
  exact(value, ["schemaVersion", "sequence", "previousDigest", "entryDigest", "operationId", "pair", "contextRevision", "changes"]);
  const input = parsePublicReleaseChangeInput({ operationId: value.operationId, pair: value.pair,
    contextRevision: value.contextRevision, changes: value.changes });
  const core = { schemaVersion: value.schemaVersion, sequence: value.sequence, previousDigest: value.previousDigest, ...input };
  if (value.schemaVersion !== PUBLIC_RELEASE_PROTOCOL || !positive(value.sequence) || !digest(value.previousDigest) ||
      !digest(value.entryDigest) || publicReleaseDigest(core) !== value.entryDigest) refuse();
  return freeze({ ...core, entryDigest: value.entryDigest });
}

/** Call from the owning public mutation's transaction after all source reads.
 * The caller must commit its source/snapshot/context change in that SAME
 * transaction, and reuse operationId on retry. Missing bootstrap is an error.
 * There is intentionally no standalone append endpoint or enable operation.
 */
async function preparePublicReleaseChangeInTransaction({ firestore, transaction, input }) {
  const parsed = parsePublicReleaseChangeInput(input);
  const headRef = firestore.doc(PUBLIC_RELEASE_CHANGES_PATH);
  const operationRef = headRef.collection("operations").doc(parsed.operationId);
  const [headRow, operationRow] = await transaction.getAll(headRef, operationRef);
  const head = parsePublicReleaseChangeHead(headRow.data());
  if (head.sequence > 0) {
    const tailRow = await transaction.get(headRef.collection("entries").doc(sequenceId(head.sequence)));
    const tail = parsePublicReleaseChange(tailRow.data());
    if (tail.sequence !== head.sequence || tail.entryDigest !== head.lastDigest ||
        tail.sequence === 1 && tail.previousDigest !== head.baselineDigest) refuse();
  }
  const inputDigest = publicReleaseDigest(parsed);
  if (operationRow.exists) {
    const operation = operationRow.data();
    exact(operation, ["schemaVersion", "sequence", "entryDigest", "inputDigest"]);
    if (operation.schemaVersion !== PUBLIC_RELEASE_PROTOCOL || !positive(operation.sequence) || operation.sequence > head.sequence ||
        !digest(operation.entryDigest) || operation.inputDigest !== inputDigest) refuse();
    const row = await transaction.get(headRef.collection("entries").doc(sequenceId(operation.sequence)));
    const entry = parsePublicReleaseChange(row.data());
    if (entry.entryDigest !== operation.entryDigest || entry.sequence !== operation.sequence ||
        publicReleaseDigest(parsePublicReleaseChangeInput({ operationId: entry.operationId, pair: entry.pair,
          contextRevision: entry.contextRevision, changes: entry.changes })) !== inputDigest) refuse();
    return { idempotent: true, entry, write() {} };
  }
  const sequence = head.sequence + 1;
  const core = { schemaVersion: PUBLIC_RELEASE_PROTOCOL, sequence, previousDigest: head.lastDigest, ...parsed };
  const entry = parsePublicReleaseChange({ ...core, entryDigest: publicReleaseDigest(core) });
  // Create-only identities plus a head CAS serialize transactions and make
  // aborted mutations leave neither an event nor a sequence gap.
  return { idempotent: false, entry, write() {
    transaction.create(headRef.collection("entries").doc(sequenceId(sequence)), entry);
    transaction.create(operationRef, { schemaVersion: PUBLIC_RELEASE_PROTOCOL, sequence, entryDigest: entry.entryDigest, inputDigest });
    transaction.set(headRef, { ...head, sequence, lastDigest: entry.entryDigest });
  } };
}
async function appendPublicReleaseChangeInTransaction(options) {
  const prepared = await preparePublicReleaseChangeInTransaction(options);
  prepared.write();
  return { idempotent: prepared.idempotent, entry: prepared.entry };
}

/** Verify a contiguous page starting at a caller's already verified cursor.
 * Largest-id queries alone are never a complete watermark. Empty pages make
 * no progress; callers must compare their final cursor with the durable head.
 */
function verifyPublicReleaseChangePage({ sequence, lastDigest }, values) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !digest(lastDigest) || !Array.isArray(values) || values.length > 100) refuse();
  for (const value of values) {
    const entry = parsePublicReleaseChange(value);
    if (entry.sequence !== sequence + 1 || entry.previousDigest !== lastDigest) refuse();
    sequence = entry.sequence;
    lastDigest = entry.entryDigest;
  }
  return Object.freeze({ sequence, lastDigest });
}

module.exports = { PUBLIC_RELEASE_CHANGES_PATH, initialPublicReleaseChangeHead, parsePublicReleaseChangeInput,
  parsePublicReleaseChangeHead, parsePublicReleaseChange, preparePublicReleaseChangeInTransaction,
  appendPublicReleaseChangeInTransaction, verifyPublicReleaseChangePage };
