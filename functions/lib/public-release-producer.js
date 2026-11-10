"use strict";

const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const { publicReleasePairPath } = require("./public-release-pair-work");
const { readPublicContextRevisionInTransaction } = require("./public-context-revision");

const PUBLIC_RELEASE_CHANGE_LOG_CONTROL = "system/publicReleaseChangeLog";
const noop = () => {};
function refuse() { throw new protocol.PublicReleaseProtocolError(); }
// The source owner supplies public projections only, never a working document,
// environment, provider credentials or a Firestore SDK object.
const { publicReleaseSnapshotJson } = require("./public-release-source-body");
const hash = value => createHash("sha256").update(value).digest("hex");
const memberKey = (kind, id) => hash(JSON.stringify([kind, id]));
function publicReleaseMemberPath(operationId, kind, id) {
  if (!require("./public-deployment-pointer").isPublicDeploymentIdentifier(operationId)) refuse();
  return `${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${operationId}/members/${memberKey(kind, id)}`;
}
function publicReleaseProducerOperation(kind, id, version, snapshot) {
  // Identity hashing must not impose an evidence limit on an unenrolled legacy path.
  return hash(publicReleaseSnapshotJson({ kind, id, version, snapshot }, Infinity));
}

/** Read before any writes. The returned closure commits the outbox and public
 * evidence with the caller's mutation. There is no enrollment/write endpoint.
 * Only the coordinator may install the server-only enrollment control. */
async function preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId, changes,
  contextRevision, revisionDelta = 1, activation, pairActivation }) {
  if (!Array.isArray(changes) || changes.length === 0) return noop;
  const bootstrap = require("./public-release-bootstrap-admission");
  const [row, bootstrapRow] = await transaction.getAll(firestore.doc(PUBLIC_RELEASE_CHANGE_LOG_CONTROL),
    firestore.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH));
  bootstrap.assertBootstrapAdmissionOpen(bootstrapRow.data());
  if (!row.exists || row.data()?.enabled === false) return noop;
  const control = row.data();
  protocol.exact(control, ["schemaVersion", "enabled", "pair", "head", "logEpoch", ...(Object.hasOwn(control, "activation") ? ["activation"] : [])]);
  if (Object.hasOwn(control, "activation")) {
    protocol.exact(control.activation, ["buildBatchId", "pair"]);
    if (!require("./public-deployment-pointer").isPublicDeploymentIdentifier(control.activation.buildBatchId)) refuse();
    protocol.parsePublicReleasePairReference(control.activation.pair);
  }
  if (control.schemaVersion !== 2 || control.enabled !== true ||
      !require("./public-deployment-pointer").isPublicDeploymentIdentifier(control.logEpoch)) refuse();
  const pair = protocol.parsePublicReleasePairReference(control.pair);
  const anchor = log.parsePublicReleaseChangeHead(control.head);
  const [pairRow, pointerRow, headRow] = await transaction.getAll(
    firestore.doc(publicReleasePairPath(pair.pairId)), firestore.doc("system/publicDeployment"),
    firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH));
  if (protocol.publicReleaseDigest(protocol.publicReleasePairReference(protocol.parsePublicReleasePair(pairRow.data()))) !==
      protocol.publicReleaseDigest(pair)) refuse();
  const pointer = pointerRow.data()?.schemaVersion === 2
    ? protocol.parseStoredPublicReleaseSelector(pointerRow.data())
    : protocol.parseVersionedPublicDeployment(pointerRow.data());
  // Admission belongs to the mutation owner. In particular, withdrawals and
  // exact-lease settlement can commit while the legacy pointer is busy.
  if (pointer.activeCommitSha !== pair.commitSha ||
      pointer.schemaVersion === 2 && protocol.publicReleaseDigest(pointer.selectedPair) !== protocol.publicReleaseDigest(pair)) refuse();
  let nextPair = null, activationCodeReference = null;
  if (activation && pairActivation) refuse();
  if (pairActivation) {
    if (pointer.schemaVersion !== 2 || activation) refuse();
    const resolved = await require("./public-release-pair-code-reference").assertPairCodeReferenceInTransaction({
      firestore, transaction, reference: pairActivation.codeReference });
    nextPair = protocol.publicReleasePairReference(resolved.pair);
    if (pairActivation.commitSha !== nextPair.commitSha) refuse();
    activationCodeReference = resolved.reference;
  }
  if (activation) {
    if (!control.activation || control.activation.buildBatchId !== activation.buildBatchId ||
        control.activation.pair.commitSha !== activation.commitSha ||
        !["deploying", "reconciling"].includes(pointer.state) || pointer.candidateBuildBatchId !== activation.buildBatchId ||
        pointer.candidateCommitSha !== activation.commitSha) refuse();
    const next = await transaction.get(firestore.doc(publicReleasePairPath(control.activation.pair.pairId)));
    nextPair = protocol.publicReleasePairReference(protocol.parsePublicReleasePair(next.data()));
    if (protocol.publicReleaseDigest(nextPair) !== protocol.publicReleaseDigest(control.activation.pair)) refuse();
    const [candidateRow, codeRow] = await transaction.getAll(
      require("./public-deployment-coordinator").publicWorkerCandidateRef(firestore, activation.buildBatchId),
      firestore.doc(`cmsPreviewPublicContexts/${activation.buildBatchId}`));
    const candidate = candidateRow.data(), manifest = codeRow.data();
    protocol.exact(manifest, ["schemaVersion", "buildBatchId", "artifactReceiptDigest", "sha256", "byteLength", "key"]);
    if (!candidate || candidate.buildBatchId !== activation.buildBatchId || candidate.commitSha !== activation.commitSha ||
        candidate.generation !== pointer.candidateGeneration || manifest.schemaVersion !== 1 || manifest.buildBatchId !== activation.buildBatchId ||
        manifest.artifactReceiptDigest !== candidate.artifactReceiptDigest || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
        !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 || manifest.byteLength > 16 * 1024 * 1024 ||
        manifest.key !== `public-context/${activation.buildBatchId}/${manifest.sha256}.json`) refuse();
    const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: candidate.buildBatchId, generation: candidate.generation,
      commitSha: candidate.commitSha, artifactDigest: candidate.artifactDigest, artifactReceiptDigest: candidate.artifactReceiptDigest,
      mediaManifestDigest: candidate.mediaManifestDigest };
    if (["artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"].some(key => !/^[a-f0-9]{64}$/.test(publication[key] ?? ""))) refuse();
    activationCodeReference = { publication, manifest };
  }
  const head = log.parsePublicReleaseChangeHead(headRow.data());
  const baseline = require("./public-release-change-baseline").parsePublicReleaseChangeBaseline(
    (await transaction.get(firestore.doc(`system/publicReleaseChanges/baselines/${control.logEpoch}`))).data());
  if (baseline.logEpoch !== control.logEpoch || baseline.baselineCursor.baselineDigest !== head.baselineDigest ||
      baseline.baselineCursor.sequence > head.sequence) refuse();
  if (head.baselineDigest !== anchor.baselineDigest || head.sequence < anchor.sequence) refuse();
  if (head.sequence === anchor.sequence) {
    if (head.lastDigest !== anchor.lastDigest) refuse();
  } else if (anchor.sequence > 0) {
    const row = await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(anchor.sequence).padStart(16, "0")}`));
    if (log.parsePublicReleaseChange(row.data()).entryDigest !== anchor.lastDigest) refuse();
  }
  const members = changes.map(({ snapshot, sourceDocuments, mediaSource, ...change }) => {
    if (pairActivation && change.kind === "provider" && change.id === "public-code") {
      snapshot = { ...snapshot, codeReference: activationCodeReference };
      sourceDocuments = [...(sourceDocuments ?? []), { path: "system/publicReleaseHistoricalCode", data: { reference: activationCodeReference, pair: nextPair } }];
    } else if (activationCodeReference && change.kind === "provider" && change.id === "public-code") {
      snapshot = { ...snapshot, codeReference: activationCodeReference };
      sourceDocuments = [...(sourceDocuments ?? []), { path: "system/publicReleaseHistoricalCode", data: { reference: activationCodeReference, pair: nextPair } },
        { path: `cmsPreviewPublicContexts/${activation.buildBatchId}`, data: activationCodeReference.manifest }];
    }
    const json = publicReleaseSnapshotJson(snapshot);
    const body = require("./public-release-source-body").makePublicReleaseSourceBody({ ...change, snapshot, sourceDocuments, mediaSource });
    return { ...change, snapshotDigest: hash(json), json, contentDigest: body.contentDigest, bodyJson: body.json };
  });
  const writeBodies = await require("./public-release-source-body").preparePublicReleaseSourceBodies({ firestore, transaction,
    values: members.map(value => ({ contentDigest: value.contentDigest, json: value.bodyJson })) });
  const refs = members.map(change => firestore.doc(publicReleaseMemberPath(operationId, change.kind, change.id)));
  const existing = await transaction.getAll(...refs);
  const revision = contextRevision ?? (await readPublicContextRevisionInTransaction(transaction, firestore)) + revisionDelta;
  const prepared = await log.preparePublicReleaseChangeInTransaction({ firestore, transaction, input: {
    operationId, pair, contextRevision: revision,
    changes: members.map(change => ({ kind: change.kind, id: change.id, action: change.action,
      sourceVersion: change.sourceVersion, snapshotDigest: change.snapshotDigest })),
  } });
  const evidence = members.map(value => ({ schemaVersion: 2, operationId, contentDigest: value.contentDigest,
    sequence: prepared.entry.sequence, entryDigest: prepared.entry.entryDigest,
    change: { kind: value.kind, id: value.id, action: value.action, sourceVersion: value.sourceVersion, snapshotDigest: value.snapshotDigest }, json: value.json }));
  existing.forEach((row, index) => {
    if (row.exists && protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest(evidence[index]) ||
        prepared.idempotent && !row.exists) refuse();
  });
  return () => {
    prepared.write();
    writeBodies();
    if (!prepared.idempotent) transaction.create(firestore.doc(`system/publicReleaseChanges/captures/${operationId}`), {
      schemaVersion: 2, operationId, sequence: prepared.entry.sequence, entryDigest: prepared.entry.entryDigest,
      logEpoch: control.logEpoch, status: "pending", attempts: 0, packs: {},
      retention: { minimumDays: 30, allEnrolledPairsMustPass: true, deletion: "audited-operator-only" },
    });
    if (nextPair) transaction.set(firestore.doc(PUBLIC_RELEASE_CHANGE_LOG_CONTROL), {
      schemaVersion: 2, enabled: true, pair: nextPair, ...(control.logEpoch ? { logEpoch: control.logEpoch } : {}), head: { schemaVersion: 2, baselineDigest: head.baselineDigest,
        sequence: prepared.entry.sequence, lastDigest: prepared.entry.entryDigest },
    });
    evidence.forEach((value, index) => { if (!existing[index].exists) transaction.create(refs[index], value); });
  };
}

function publicContentChange(collection, id, document, visible = true, owner) {
  const snapshot = document.published;
  const kind = collection === "cmsPages" ? "page" : snapshot?.metadata?.type === "post" ? "post" : "record";
  const change = { kind, id, action: visible ? "publish" : "withdraw", sourceVersion: snapshot.sourceVersion, snapshot };
  if (owner) {
    const body = require("./public-release-source-body").makePublicReleaseSourceBody(change);
    change.sourceDocuments = [...JSON.parse(body.json).documents, { path: owner.path, data: require("./public-release-source-body").publicReleaseAuthorityProjection(owner.data) }];
  }
  return change;
}
async function preparePublicMediaChangeInTransaction({ firestore, transaction, id, version, before = null, after = null, mediaSource }) {
  if (publicReleaseSnapshotJson(before) === publicReleaseSnapshotJson(after)) return noop;
  const operationId = publicReleaseProducerOperation("media", id, version, after);
  return preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId, changes: [{ kind: "media", id,
    action: after === null ? "withdraw" : "dependency", sourceVersion: version, snapshot: after, mediaSource }] });
}

module.exports = { PUBLIC_RELEASE_CHANGE_LOG_CONTROL, publicReleaseSnapshotJson, publicReleaseMemberPath,
  publicReleaseProducerOperation, preparePublicReleaseProducerInTransaction, preparePublicMediaChangeInTransaction, publicContentChange };
