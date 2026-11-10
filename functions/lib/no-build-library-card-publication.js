"use strict";

const { preparePublicReleaseProducerInTransaction } = require("./public-release-producer");

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { prepareLibraryCardContextInTransaction } = require("./library-card-context");
const { shapeJoinedRecord } = require("./joined-records");
const { readPublicationPrerequisites, REQUIRED_CONSUMERS, PUBLICATION_BUDGET_MS } = require("./settings-publication");
const { enqueuePublicContextInTransaction, retryPublicContextInTransaction, missingPublicContextConsumers, TRANSPORT } = require("./public-context-publication");
const { publicContextDigest, bumpPublicContextRevision } = require("./public-context-revision");

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isLibraryCard = document => ["sponsor", "newsletter"].includes(document?.type);
const operationIdFor = (id, version, action) => hash(["library-card-publication-v1", id, version, action]).slice(0, 20);
const successorIdFor = identity => hash([identity.originalOperationId, identity.contextRevision, identity.rendererSha]).slice(0, 20);
function refuse(message) { throw Object.assign(new Error(message), { status: 409, code: "library_card_publication_unavailable" }); }
// Working workflow/version fields do not change an approved public card.
const cardDigest = record => hash(record?.approvedLibraryVersion ?? null);

function libraryCardReceipt(queue, now = Date.now()) {
  const identity = queue?.libraryCardPublication;
  if (queue?.transport !== TRANSPORT || !identity || !isLibraryCard({ type: identity.kind }) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(identity.recordId ?? "") ||
      !Number.isSafeInteger(identity.sourceVersion) || identity.sourceVersion < 2 ||
      !["approve", "unpublish", "archive"].includes(identity.action) ||
      identity.withdrawal !== (identity.action !== "approve") ||
      identity.originalOperationId !== operationIdFor(identity.recordId, identity.sourceVersion, identity.action) ||
      identity.operationId !== identity.originalOperationId && identity.operationId !== successorIdFor(identity) ||
      !Number.isSafeInteger(identity.contextRevision) || identity.contextRevision < 1 ||
      identity.contextDigest !== publicContextDigest(identity.contextRevision) ||
      !/^[a-f0-9]{64}$/.test(identity.cardDigest ?? "") || !/^[a-f0-9]{40}$/.test(identity.rendererSha ?? "") ||
      !["pending", "publishing", "success", "failed", "cancelled"].includes(queue.status) ||
      queue.runtime?.owner !== "cloudflare" || queue.runtime.release !== identity.rendererSha ||
      queue.publicContext?.operationId !== identity.operationId || queue.publicContext.contextRevision !== identity.contextRevision ||
      queue.publicContext.contextDigest !== identity.contextDigest) refuse("The library card publication receipt is invalid.");
  const missingConsumers = missingPublicContextConsumers(queue, identity, REQUIRED_CONSUMERS, ["pages", "posts", "home"]);
  const failed = ["failed", "cancelled"].includes(queue.status);
  const started = queue.cardRetryAt?.toMillis?.() ?? queue.createdAt?.toMillis?.() ?? now;
  return { queueId: identity.operationId, transport: TRANSPORT, sourceVersion: identity.sourceVersion,
    action: identity.action, withdrawal: identity.withdrawal, status: failed ? "failed" : missingConsumers.length ? "pending" : "success",
    missingConsumers, ...(failed || missingConsumers.length && now - started >= PUBLICATION_BUDGET_MS
      ? { warning: "The card update is taking longer than expected. Use Retry card update." } : {}) };
}

async function readLibraryCardPublication({ firestore, transaction, operationId, document }) {
  if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) return null;
  const read = ref => transaction ? transaction.get(ref) : ref.get();
  let ref = firestore.doc(`cmsPublishQueue/${operationId}`);
  let row = await read(ref);
  if (!row.exists || !row.data().libraryCardPublication) return null;
  let queue = row.data();
  libraryCardReceipt(queue);
  if (queue.libraryCardPublication.originalOperationId !== operationId) refuse("The library card operation changed.");
  if (queue.successorOperationId) {
    if (!/^[A-Za-z0-9]{20}$/.test(queue.successorOperationId)) refuse("The library card successor is invalid.");
    ref = firestore.doc(`cmsPublishQueue/${queue.successorOperationId}`);
    row = await read(ref);
    if (!row.exists) refuse("The library card successor is unavailable.");
    queue = row.data();
  }
  const receipt = libraryCardReceipt(queue);
  const identity = queue.libraryCardPublication;
  if (identity.operationId !== ref.id || identity.originalOperationId !== operationId) refuse("The library card operation changed.");
  const stored = document ?? (await read(firestore.doc(`cmsPosts/${identity.recordId}`))).data();
  const history = await read(firestore.collection("cmsVersionHistory").where("collection", "==", "cmsPosts")
    .where("documentId", "==", identity.recordId));
  const events = history.docs.map(row => row.data());
  const laterApproval = events.some(row => row.action === "approve" && row.after?.version > identity.sourceVersion);
  if (stored?.type !== identity.kind || laterApproval ||
      cardDigest(shapeJoinedRecord(identity.recordId, stored, events)) !== identity.cardDigest) {
    throw Object.assign(new Error("This card publication was replaced. Reload before publishing."),
      { status: 409, code: "library_card_publication_replaced" });
  }
  return { ref, queue, publication: receipt };
}

async function prepareLibraryCardPublication(input) {
  const projection = await prepareLibraryCardContextInTransaction(input);
  if (!projection) return null;
  const { firestore, transaction, actor } = input;
  const { revision, runtime } = await readPublicationPrerequisites(firestore, transaction);
  const operation = projection.operation;
  const operationId = operationIdFor(operation.recordId, operation.sourceVersion, operation.action);
  const context = await enqueuePublicContextInTransaction({ firestore, transaction, operationId, runtime,
    reason: "context", contextRevision: revision + 1 });
  const identity = { ...operation, operationId, originalOperationId: operationId, cardDigest: cardDigest(projection.record),
    rendererSha: runtime.release, contextRevision: context.contextRevision, contextDigest: context.contextDigest };
  const writeReleaseChange = await preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId,
    contextRevision: identity.contextRevision, changes: [{ kind: "library", id: operation.recordId,
      action: operation.withdrawal ? "withdraw" : "publish", sourceVersion: operation.sourceVersion,
      snapshot: projection.record?.approvedLibraryVersion ?? null }] });
  return { publication: { status: "queued", queueId: operationId, transport: TRANSPORT, cardPublication: true }, write() {
    writeReleaseChange();
    context.write();
    transaction.set(firestore.doc(`cmsPublishQueue/${operationId}`), { libraryCardPublication: identity,
      triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null }, { merge: true });
    bumpPublicContextRevision(transaction, firestore, { withdrawal: operation.withdrawal });
  } };
}

async function prepareLibraryCardRetry({ firestore, transaction, accepted }) {
  if (!accepted.publication.warning) return { publication: { status: "queued", queueId: accepted.ref.id,
    transport: TRANSPORT, cardPublication: true }, write() {} };
  const { revision, runtime } = await readPublicationPrerequisites(firestore, transaction);
  const original = accepted.queue.libraryCardPublication;
  if (revision !== original.contextRevision || runtime.release !== original.rendererSha) {
    const identity = { ...original, contextRevision: revision, contextDigest: publicContextDigest(revision), rendererSha: runtime.release };
    identity.operationId = successorIdFor(identity);
    const context = await enqueuePublicContextInTransaction({ firestore, transaction, operationId: identity.operationId,
      runtime, reason: "context", contextRevision: revision });
    return { publication: { status: "queued", queueId: identity.operationId, transport: TRANSPORT, cardPublication: true }, write() {
      context.write();
      transaction.set(firestore.doc(`cmsPublishQueue/${identity.operationId}`), { libraryCardPublication: identity,
        cardRetryAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.update(firestore.doc(`cmsPublishQueue/${original.originalOperationId}`), { successorOperationId: identity.operationId });
    } };
  }
  const needsRetry = accepted.publication.status !== "success" && Boolean(accepted.publication.warning);
  const write = needsRetry ? await retryPublicContextInTransaction({ firestore, transaction, operationId: accepted.ref.id, runtime }).catch(error => {
    if (error instanceof Error && error.status === undefined && error.code === undefined && error.message === "Public context publication refused") {
      refuse("Another publication is updating the public outputs. Try this card update again shortly.");
    }
    throw error;
  }) : () => {};
  return { publication: { status: "queued", queueId: accepted.ref.id, transport: TRANSPORT, cardPublication: true }, write() {
    write();
    if (needsRetry) transaction.update(accepted.ref, { cardRetryAt: FieldValue.serverTimestamp() });
  } };
}

async function libraryCardMetadata({ firestore, stored }) {
  if (!isLibraryCard(stored)) return null;
  const history = await firestore.collection("cmsVersionHistory").where("collection", "==", "cmsPosts").where("documentId", "==", stored.id).get();
  const record = shapeJoinedRecord(stored.id, stored, history.docs.map(row => row.data()));
  const events = history.docs.map(row => row.data());
  const approvalVersion = events.reduce((version, row) => row.action === "approve"
    ? Math.max(version, row.after?.version ?? 0) : version, 0);
  const candidates = events.filter(row => row.after?.version >= approvalVersion && ["approve", "archive", "unpublish"].includes(row.action))
    .sort((a, b) => b.after.version - a.after.version);
  let accepted = null;
  // Archive after Unpublish changes no public card and creates no new queue.
  // Keep the accepted removal visible until its consumers finish.
  for (const event of candidates) {
    accepted = await readLibraryCardPublication({ firestore,
      operationId: operationIdFor(stored.id, event.after.version, event.action), document: stored });
    if (accepted) break;
  }
  const receipt = accepted?.publication;
  const approved = record?.approvedLibraryVersion;
  const version = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return { workingVersion: version(stored.version), contentVersion: version(stored.contentVersion ?? stored.version),
    workingStatus: typeof stored.status === "string" ? stored.status : "draft",
    publishedSourceVersion: receipt?.sourceVersion ?? approved?.version ?? null,
    publicSourceVersion: receipt?.status === "success" ? receipt.withdrawal ? null : receipt.sourceVersion : approved?.version ?? null,
    publiclyVisible: Boolean(approved), publicUpdatePending: Boolean(receipt && receipt.status !== "success"),
    publicBuildQueueId: receipt?.queueId ?? null, queueStatus: receipt?.status ?? null,
    canResumeReservation: false, libraryCardPublication: receipt ?? null };
}

module.exports = { isLibraryCard, operationIdFor, libraryCardReceipt, readLibraryCardPublication,
  prepareLibraryCardPublication, prepareLibraryCardRetry, libraryCardMetadata };
