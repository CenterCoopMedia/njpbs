"use strict";

const { preparePublicReleaseProducerInTransaction } = require("./public-release-producer");

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { assertPublicDeploymentPointer } = require("./public-deployment");
const { readCmsPublicationRuntimeControlInTransaction, assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");
const { publicationTarget } = require("./publication-target");
const { PUBLIC_CONTEXT_PATH, readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const { missingPublicContextConsumers } = require("./public-context-publication");
const { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID } = require("./cms-settings-contract");

const PUBLIC_SETTINGS_IDS = new Set([require("./cms-settings-contract").STORY_CTAS_SETTINGS_ID, require("./cms-settings-contract").COVERAGE_LABELS_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID]);
const REQUIRED_CONSUMERS = ["pages", "posts", "home", "listings", "authors", "feed", "contentApi", "sitemap", "search"];
const PUBLICATION_BUDGET_MS = 5 * 60_000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pairProtocol = require("./public-release-pair");
const pairAdmission = require("./public-release-admission-contract");
const settingsOperationId = (id, sourceVersion) => hash(["settings-publication-v1", id, sourceVersion]).slice(0, 20);
const successorOperationId = identity => hash([identity.originalOperationId, identity.contextRevision, identity.rendererSha]).slice(0, 20);
const queueRef = (firestore, id, version) => firestore.doc(`cmsPublishQueue/${settingsOperationId(id, version)}`);
function refuse(message, diagnosticCode) {
  throw Object.assign(new Error(message), { status: 409, code: "settings_publication_unavailable",
    ...(diagnosticCode ? { diagnosticCode } : {}) });
}

function settingsPublicationReceipt(queue, now = Date.now()) {
  const identity = queue?.settingsPublication;
  if (queue?.transport !== "public-context-no-build-v1" || !identity ||
      !PUBLIC_SETTINGS_IDS.has(identity.id) || !Number.isSafeInteger(identity.sourceVersion) || identity.sourceVersion < 1 ||
      !Number.isSafeInteger(identity.contextRevision) || identity.contextRevision < 1 ||
      identity.contextDigest !== publicContextDigest(identity.contextRevision) || !/^[a-f0-9]{40}$/.test(identity.rendererSha ?? "") ||
      !/^[a-f0-9]{64}$/.test(identity.snapshotDigest ?? "") || !isDeepStrictEqual(identity.requiredConsumers, REQUIRED_CONSUMERS) ||
      queue.runtime?.owner !== "cloudflare" || queue.runtime.release !== identity.rendererSha ||
      queue.publicContext?.contextRevision !== identity.contextRevision || queue.publicContext?.contextDigest !== identity.contextDigest ||
      queue.publicContext?.operationId !== identity.operationId ||
      !/^[A-Za-z0-9]{20}$/.test(identity.operationId ?? "") ||
      identity.originalOperationId !== settingsOperationId(identity.id, identity.sourceVersion) ||
      (identity.operationId !== identity.originalOperationId && identity.operationId !== successorOperationId(identity)) ||
      !["pending", "publishing", "success", "failed", "cancelled"].includes(queue.status)) {
    refuse("This settings publication receipt is invalid.");
  }
  const missingConsumers = missingPublicContextConsumers(queue, identity, REQUIRED_CONSUMERS, ["pages", "posts", "home"]);
  const failed = ["failed", "cancelled"].includes(queue.status);
  const startedAt = queue.settingsRetryAt?.toMillis?.() ?? queue.triggeredAt?.toMillis?.() ?? queue.createdAt?.toMillis?.() ?? now;
  const overdue = missingConsumers.length > 0 && now - startedAt >= PUBLICATION_BUDGET_MS;
  return {
    queueId: identity.operationId, originalOperationId: identity.originalOperationId, transport: queue.transport,
    sourceVersion: identity.sourceVersion, rendererSha: identity.rendererSha,
    contextRevision: identity.contextRevision, contextDigest: identity.contextDigest,
    status: failed ? "failed" : missingConsumers.length ? "pending" : "success", missingConsumers,
    ...(failed || overdue ? { warning: "The site update is taking longer than expected. Retry publication." } : {}),
  };
}

async function readSettingsPublication({ firestore, transaction, id, sourceVersion, settings }) {
  if (!PUBLIC_SETTINGS_IDS.has(id)) return null;
  let ref = queueRef(firestore, id, sourceVersion);
  const snapshot = await (transaction ? transaction.get(ref) : ref.get());
  if (!snapshot.exists) return null;
  let queue = snapshot.data();
  if (queue.transport === pairAdmission.TRANSPORT) {
    const read = async tx => {
      const [admissionRow, queueRow] = await tx.getAll(
        firestore.doc(`${pairAdmission.ADMISSIONS}/operations/${ref.id}`), ref);
      const admission = pairAdmission.parseAdmission(admissionRow.data()), current = queueRow.data();
      pairAdmission.assertQueue(current, admission);
      const operation = current.familyPublication?.operation;
      const pair = pairProtocol.parsePublicReleasePair((await tx.get(firestore.doc(
        require("./public-release-pair-work").publicReleasePairPath(admission.pair.pairId)))).data());
      if (admission.operationId !== ref.id || admission.source.kind !== "settings" || admission.source.action !== "publish" || admission.source.id !== id ||
          admission.source.sourceVersion !== sourceVersion || admission.source.snapshotDigest !== pairProtocol.publicReleaseDigest(settings.published) ||
          admission.pairDigest !== pairProtocol.publicReleaseDigest(pair) ||
          pairProtocol.publicReleaseDigest(admission.pair) !== pairProtocol.publicReleaseDigest(pairProtocol.publicReleasePairReference(pair)) ||
          current.familyPublication?.kind !== "settings" || current.familyPublication.id !== id ||
          !isDeepStrictEqual(operation, { operationId: ref.id, id, sourceVersion, snapshotDigest: admission.source.snapshotDigest,
            pair: admission.pair, contextRevision: admission.contextRevision, requiredConsumers: REQUIRED_CONSUMERS })) {
        refuse("This settings publication was replaced. Reload before publishing.");
      }
      if (["success", "superseded"].includes(current.status)) {
        const receipt = await require("./public-release-terminal").assertPairPublicationTerminalReceiptInTransaction({
          firestore, transaction: tx, operationId: ref.id, admissionDigest: pairProtocol.publicReleaseDigest(admission) });
        if (receipt.outcome !== "success") refuse("This settings publication was replaced. Reload before publishing.");
      }
      const status = current.status === "success" ? "success" : current.status === "failed" ? "failed" : "pending";
      const due = status === "pending" ? (await tx.get(firestore.doc(require("./public-release-admission")
        .publicationPendingPath(admission.pair.pairId, ref.id)))).data() : null;
      const needsHelp = status === "failed" || status === "pending" && (!due || due.nextAttemptAt === null);
      const startedAt = current.settingsRetryAt?.toMillis?.() ?? current.triggeredAt?.toMillis?.() ?? Date.now();
      const warning = status !== "success" && (needsHelp || Date.now() - startedAt >= PUBLICATION_BUDGET_MS);
      return { ref, queue: current, publication: { queueId: ref.id, originalOperationId: ref.id, transport: pairAdmission.TRANSPORT,
        sourceVersion, rendererSha: pair.commitSha, contextRevision: admission.contextRevision,
        contextDigest: publicContextDigest(admission.contextRevision), status,
        missingConsumers: status === "success" ? [] : [...REQUIRED_CONSUMERS],
        ...(warning ? { warning: needsHelp ? "This site update needs help. Ask an administrator."
          : "The site update is taking longer than expected. Retry publication." } : {}) } };
    };
    return transaction ? read(transaction) : firestore.runTransaction(read, { readOnly: true });
  }
  settingsPublicationReceipt(queue);
  if (queue.settingsPublication.originalOperationId !== ref.id) refuse("This settings publication receipt is invalid.");
  if (queue.successorOperationId) {
    if (!/^[A-Za-z0-9]{20}$/.test(queue.successorOperationId)) refuse("This settings publication receipt is invalid.");
    ref = firestore.doc(`cmsPublishQueue/${queue.successorOperationId}`);
    const successor = await (transaction ? transaction.get(ref) : ref.get());
    if (!successor.exists) refuse("This settings publication receipt is unavailable.");
    queue = successor.data();
  }
  if (queue.settingsPublication?.id !== id || queue.settingsPublication?.sourceVersion !== sourceVersion ||
      queue.settingsPublication.snapshotDigest !== hash(settings.published) ||
      queue.settingsPublication.operationId !== ref.id ||
      queue.settingsPublication.originalOperationId !== settingsOperationId(id, sourceVersion)) {
    refuse("This settings publication was replaced. Reload before publishing.");
  }
  return { ref, queue, publication: settingsPublicationReceipt(queue) };
}

async function readPublicationPrerequisites(firestore, transaction, rootSnapshot) {
  const pointer = assertPublicDeploymentPointer((rootSnapshot ?? await transaction.get(firestore.doc("system/publicDeployment"))).data());
  if (pointer.state !== "idle") refuse("A public code release is in progress. Try this publication again shortly.");
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  assertCmsPublicationCloudAdmission(control, { commitSha: pointer.activeCommitSha,
    serializerId: publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production").serializerId });
  const billing = (await transaction.get(firestore.doc("system/billing"))).data();
  if (billing?.disabled === true) refuse("Public publication is paused by the billing control.");
  const revision = await readPublicContextRevisionInTransaction(transaction, firestore);
  return { revision, runtime: { owner: "cloudflare", release: pointer.activeCommitSha } };
}

async function prepareSettingsPublication({ firestore, transaction, id, published, actor }) {
  const root = await transaction.get(firestore.doc("system/publicDeployment"));
  if (root.data()?.schemaVersion === 2) return require("./public-release-family-admission")
    .preparePairSettingsPublication({ firestore, transaction, id, published, actor });
  const { revision, runtime } = await readPublicationPrerequisites(firestore, transaction, root);
  if (!Number.isSafeInteger(revision + 1)) refuse("The public context revision cannot advance.");
  const operationId = settingsOperationId(id, published.sourceVersion);
  const { enqueuePublicContextInTransaction } = require("./public-context-publication");
  const prepared = await enqueuePublicContextInTransaction({ firestore, transaction, operationId,
    runtime, reason: "settings", contextRevision: revision + 1 });
  const identity = { id, sourceVersion: published.sourceVersion, snapshotDigest: hash(published), operationId, originalOperationId: operationId,
    rendererSha: runtime.release, contextRevision: prepared.contextRevision, contextDigest: prepared.contextDigest,
    requiredConsumers: REQUIRED_CONSUMERS };
  const writeReleaseChange = await preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId,
    contextRevision: identity.contextRevision, changes: [{ kind: "settings", id, action: "publish",
      sourceVersion: published.sourceVersion, snapshot: published }] });
  return { publication: settingsPublicationReceipt({ transport: "public-context-no-build-v1", runtime,
    status: "pending", publicContext: identity, settingsPublication: identity }),
    write() {
      writeReleaseChange();
      prepared.write();
      transaction.set(firestore.doc(`cmsPublishQueue/${operationId}`), { settingsPublication: identity,
        triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null }, { merge: true });
    } };
}

async function prepareSettingsRetry({ firestore, transaction, accepted }) {
  if (accepted.queue.transport === pairAdmission.TRANSPORT) {
    // The retained pair owns this original work through selection changes.
    // A settings retry must never create a legacy successor or reset its claim.
    if (!accepted.publication.warning) return { write() {}, publication: accepted.publication };
    const unavailable = () => refuse("This site update needs help. Ask an administrator.");
    if (accepted.queue.status === "failed") unavailable();
    const pendingRef = firestore.doc(require("./public-release-admission").publicationPendingPath(accepted.queue.pair.pairId, accepted.ref.id));
    const [pendingRow, markerRow] = await transaction.getAll(pendingRef, firestore.doc(`${pairAdmission.ADMISSIONS}/pending/${accepted.ref.id}`));
    const pending = pendingRow.data(), marker = markerRow.data();
    if (pending?.schemaVersion !== 2 || pending.operationId !== accepted.ref.id || pending.admissionDigest !== accepted.queue.admissionDigest ||
        !Number.isSafeInteger(pending.nextAttemptAt) || pending.nextAttemptAt < 0 ||
        marker?.schemaVersion !== 2 || marker.operationId !== accepted.ref.id || marker.admissionDigest !== accepted.queue.admissionDigest) unavailable();
    const publication = { ...accepted.publication }; delete publication.warning;
    return { publication, write() {
      transaction.update(pendingRef, { nextAttemptAt: 0 });
      transaction.update(accepted.ref, { settingsRetryAt: FieldValue.serverTimestamp() });
    } };
  }
  if (!accepted.publication.warning) return { write() {}, publication: accepted.publication };
  const { retryPublicContextInTransaction } = require("./public-context-publication");
  const { revision, runtime } = await readPublicationPrerequisites(firestore, transaction);
  const original = accepted.queue.settingsPublication;
  if (revision !== original.contextRevision || runtime.release !== original.rendererSha) {
    const { enqueuePublicContextInTransaction } = require("./public-context-publication");
    const identity = { ...original, contextRevision: revision, contextDigest: publicContextDigest(revision), rendererSha: runtime.release };
    identity.operationId = successorOperationId(identity);
    const prepared = await enqueuePublicContextInTransaction({ firestore, transaction, operationId: identity.operationId,
      runtime, reason: "settings", contextRevision: revision });
    return { publication: settingsPublicationReceipt({ transport: "public-context-no-build-v1", runtime, status: "pending",
      publicContext: identity, settingsPublication: identity }), write() {
      prepared.write();
      transaction.set(firestore.doc(`cmsPublishQueue/${identity.operationId}`), { settingsPublication: identity,
        settingsRetryAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.update(firestore.doc(`cmsPublishQueue/${original.originalOperationId}`), { successorOperationId: identity.operationId });
    } };
  }
  const writeRetry = await retryPublicContextInTransaction({ firestore, transaction,
    operationId: accepted.ref.id, runtime: accepted.queue.runtime }).catch(error => {
    if (error instanceof Error && error.status === undefined && error.code === undefined &&
        error.message === "Public context publication refused") {
      refuse("Another publication is updating the public outputs. Try this site update again shortly.",
        "settings_retry_guard_refused");
    }
    throw error;
  });
  const publication = { ...accepted.publication, status: "pending" };
  delete publication.warning;
  return { publication, write() {
    writeRetry();
    transaction.update(accepted.ref, { settingsRetryAt: FieldValue.serverTimestamp() });
  } };
}

module.exports = { preparePairSettingsPublication: options => require("./public-release-family-admission").preparePairSettingsPublication(options),
  PUBLIC_SETTINGS_IDS, PUBLICATION_BUDGET_MS, REQUIRED_CONSUMERS, settingsOperationId,
  settingsPublicationReceipt, readSettingsPublication, prepareSettingsPublication, prepareSettingsRetry, PUBLIC_CONTEXT_PATH,
  readPublicationPrerequisites };
