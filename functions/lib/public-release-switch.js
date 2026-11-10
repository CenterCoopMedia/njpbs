"use strict";

// Inert schema-two operator boundary. No handler, provider API, protocol
// bootstrap or production entrypoint imports this writer.
const { FieldValue } = require("firebase-admin/firestore");
const p = require("./public-release-pair");
const lineage = require("./public-release-switch-lineage");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { publicReleasePairPath, assertPublicReleasePairDatabase } = require("./public-release-pair-work");
const { parsePublicReleaseChangeHead } = require("./public-release-change-log");
const { parseCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { RELEASE_WRITER_FENCE_PATH, parseReleaseWriterFence } = require("./public-release-writer-fence");
const { publicationTarget } = require("./publication-target");
const { parsePairMedia } = require("./public-release-pair-media");
const ROOT = "system/publicDeployment";
const WITNESSES = `${ROOT}/switchWitnesses`;
const ATTEMPTS = `${ROOT}/switchAttempts`;
const RECEIPTS = `${ROOT}/switchReceipts`;
const ADMISSIONS = "system/publicReleaseAdmissions";
const MEDIA = `${ROOT}/pairMedia/current`;
const CAPABILITY_PATHS = Object.freeze({ posts: `${ROOT}/noBuildPosts/capability`,
  pages: `${ROOT}/noBuildPages/capability`, records: `${ROOT}/noBuildRecords/capability` });
const REQUIRED_VALIDATORS = Object.freeze(["system/publicDeployment/contexts/public", "system/publicReleaseChanges",
  "system/publicReleaseChangeLog", "system/noBuildPostAdmission", "system/publicDeployment/noBuildRecordFamilies/current",
  MEDIA, ADMISSIONS, "system/billing"]);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function equal(a, b) { return p.publicReleaseDigest(a) === p.publicReleaseDigest(b); }
function id(value) { if (!isPublicDeploymentIdentifier(value)) refuse(); return value; }
const switchChangeOperationId = operationId => p.publicReleaseDigest({ kind: "public-release-switch", operationId });
function contentHead(value, pairId) {
  p.exact(value, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
  if (value.pairId !== pairId || !p.digest(value.manifestDigest) || !Number.isSafeInteger(value.contextSequence) || value.contextSequence < 0) refuse();
  id(value.viewId); return { ...value };
}
function parseSwitchAttempt(value) {
  p.exact(value, ["schemaVersion", "operationId", "expectedSelectorDigest", "oldPair", "newPair", "witnessDigest"]);
  if (value.schemaVersion !== 2 || ![value.expectedSelectorDigest, value.witnessDigest].every(p.digest)) refuse();
  id(value.operationId);
  const oldPair = p.parsePublicReleasePair(value.oldPair), newPair = p.parsePublicReleasePair(value.newPair);
  if (oldPair.pairId === newPair.pairId || oldPair.environment !== newPair.environment) refuse();
  return p.freeze({ ...value, oldPair, newPair });
}
/** The qualification owner produces these immutable records after full byte,
 * replay and deployed-reader checks. Digests are references, never caller flags.
 * There is deliberately no API here to manufacture a qualification receipt. */
function parseSwitchQualification(value, pair) {
  p.exact(value, ["schemaVersion", "pairDigest", "contentHead", "cursor", "validatorDigest", "capabilities", "controlsDigest",
    "coverageDigest", "acceptedWorkDigest", "admittedContractDigest", "readerReceiptDigest", "providerReadbackDigest"]);
  if (value.schemaVersion !== 2 || value.pairDigest !== p.publicReleaseDigest(pair) ||
      value.readerReceiptDigest !== pair.readerReceiptDigest ||
      ![value.validatorDigest, value.coverageDigest, value.acceptedWorkDigest, value.admittedContractDigest, value.providerReadbackDigest].every(p.digest)) refuse();
  const head = contentHead(value.contentHead, pair.pairId), cursor = parsePublicReleaseChangeHead(value.cursor);
  if (head.contextSequence !== cursor.sequence) refuse();
  validateCapabilities(value.capabilities, pair);
  if (p.publicReleaseDigest(value.capabilities) !== value.controlsDigest) refuse();
  return p.freeze({ ...value, contentHead: head, cursor });
}
/** ReaderCapabilities is the layer-three immutable pair identity. Concrete
 * publication controls have their own digest and never replace that meaning. */
function publicationControlsForReaderSeals(seals, pair) {
  const capabilities = seals?.capabilities, deployment = seals?.deployment;
  if (seals?.schemaVersion !== 1 || seals.status !== "verified" ||
      p.publicReleaseDigest(capabilities) !== pair.capabilityDigest || p.publicReleaseDigest(deployment) !== pair.readerReceiptDigest ||
      capabilities.rendererSha !== pair.commitSha || deployment.commitSha !== pair.commitSha) refuse();
  const rendererSha = pair.commitSha;
  const controls = {
    posts: { schemaVersion: 2, rendererSha, servingEnabled: true, ...capabilities.post },
    pages: { schemaVersion: 1, rendererSha, servingEnabled: true, ...capabilities.page,
      terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha } },
    records: { schemaVersion: 1, rendererSha, servingEnabled: true, families: [...capabilities.record.families],
      terminalOwner: { ...capabilities.record.terminalOwner } },
  };
  validateCapabilities(controls, pair);
  return p.freeze(controls);
}
function validateCapabilities(bundle, pair) {
  p.exact(bundle, ["posts", "pages", "records"]);
  if (Object.values(bundle).some(capability => Object.hasOwn(capability, "generation"))) refuse();
  const posts = require("./no-build-post-state").validateCapability({ ...bundle.posts, generation: 1 });
  const pages = require("./no-build-page-ownership").validateNoBuildPageCapability({ ...bundle.pages, generation: 1 });
  const records = bundle.records;
  p.exact(records, ["schemaVersion", "rendererSha", "servingEnabled", "families", "terminalOwner"]);
  require("./no-build-record-capability").candidateNoBuildRecordContract({ schemaVersion: records.schemaVersion,
    rendererSha: records.rendererSha, enabled: records.servingEnabled, authoritative: true, families: records.families });
  const transports = ["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"];
  [posts, pages, { ...records, generation: 1 }].forEach((capability, index) => {
    if (!capability || capability.rendererSha !== pair.commitSha || !p.positive(capability.generation) ||
        index > 0 && (capability.terminalOwner?.schemaVersion !== 1 || capability.terminalOwner.transport !== transports[index] ||
        capability.terminalOwner.rendererSha !== pair.commitSha)) refuse();
  });
}
function parseSwitchWitness(value) {
  p.exact(value, ["schemaVersion", "oldPairDigest", "newPairDigest", "oldQualificationDigest", "newQualificationDigest",
    "cursor", "validators", "admittedContractDigest", "acceptedWorkDigest"]);
  if (value.schemaVersion !== 2 || ![value.oldPairDigest, value.newPairDigest, value.oldQualificationDigest,
      value.newQualificationDigest, value.admittedContractDigest, value.acceptedWorkDigest].every(p.digest)) refuse();
  parsePublicReleaseChangeHead(value.cursor);
  if (!Array.isArray(value.validators) || value.validators.length < REQUIRED_VALIDATORS.length || value.validators.length > 64) refuse();
  const paths = value.validators.map(validator => {
    p.exact(validator, ["path", "digest"]);
    // Allow only authority documents. No draft, credential, unbounded query or
    // arbitrary caller-selected path can become a switch validator.
    if (!p.digest(validator.digest) || typeof validator.path !== "string" ||
        (!REQUIRED_VALIDATORS.includes(validator.path) && !/^system\/publicDeployment\/(?:noBuildPostRoutes|noBuildPageRoutes|noBuildRecordRoutes)\/[a-f0-9]{64}$/.test(validator.path))) refuse();
    return validator.path;
  });
  if (new Set(paths).size !== paths.length || REQUIRED_VALIDATORS.some(path => !paths.includes(path))) refuse();
  return p.freeze(JSON.parse(JSON.stringify(value)));
}
function assertPins(value, pair) {
  const pins = parseCmsPublicationRuntimeControl(value), serializer = publicationTarget(pair.environment).serializerId;
  if (pins.phase !== "ready" || pins.commitSha !== pair.commitSha || pins.serializerId !== serializer ||
      pins.cloud?.phase !== "ready" || pins.cloud.commitSha !== pair.commitSha || pins.cloud.serializerId !== serializer) refuse();
  return pins;
}
async function reservePublicReleaseSwitch({ firestore, attempt: raw }) {
  const attempt = parseSwitchAttempt(raw), attemptDigest = p.publicReleaseDigest(attempt);
  assertPublicReleasePairDatabase(firestore, attempt.oldPair);
  return firestore.runTransaction(async transaction => {
    const attemptRef = firestore.doc(`${ATTEMPTS}/${attempt.operationId}`), fenceRef = firestore.doc(RELEASE_WRITER_FENCE_PATH);
    const [prior, fence, selector] = await transaction.getAll(attemptRef, fenceRef, firestore.doc(ROOT));
    if (prior.exists) {
      if (!equal(parseSwitchAttempt(prior.data()), attempt)) refuse();
      // A repeated reservation never grants provider-write permission.
      return { idempotent: true, attemptDigest };
    }
    if (fence.exists || p.publicReleaseDigest(require("./public-release-media-fence").parseStoredSelector(selector.data())) !== attempt.expectedSelectorDigest ||
        !equal(selector.data().selectedPair, p.publicReleasePairReference(attempt.oldPair))) refuse();
    transaction.create(attemptRef, attempt);
    transaction.create(fenceRef, { schemaVersion: 2, operationId: attempt.operationId, attemptDigest });
    return { idempotent: false, attemptDigest };
  });
}
async function applyPublicReleaseSwitch(options) { return runPublicReleaseSwitch(options, false); }
// A private read-only preflight shares every final guard. Its result grants no
// selection, reservation or success; apply always repeats the full transaction.
async function assertPublicReleaseSwitchPreflight(options) { await runPublicReleaseSwitch(options, true); }
async function runPublicReleaseSwitch({ firestore, attempt: raw, qualificationReadOwner,
  assertQualificationsCurrentInTransaction, assertAcceptedWorkIncludedInTransaction }, preflight) {
  const attempt = parseSwitchAttempt(raw), attemptDigest = p.publicReleaseDigest(attempt);
  assertPublicReleasePairDatabase(firestore, attempt.oldPair);
  return firestore.runTransaction(async originalTransaction => {
    if (typeof qualificationReadOwner?.trackQualificationTransactionReads !== "function" ||
        typeof qualificationReadOwner?.assertQualificationTransactionReadBudget !== "function" ||
        typeof qualificationReadOwner?.parseReaderSeals !== "function") refuse();
    // The actual qualifier owns this opaque tracker. Start once per contention
    // attempt, before ANY switch reads; both pair guards share its budget.
    const readTracker = qualificationReadOwner.trackQualificationTransactionReads(originalTransaction);
    const transaction = readTracker.transaction;
    const receiptRef = firestore.doc(`${RECEIPTS}/${attempt.operationId}`);
    const [prior, storedAttempt, fenceRow, selectorRow, pinsRow, witnessRow] = await transaction.getAll(receiptRef,
      firestore.doc(`${ATTEMPTS}/${attempt.operationId}`), firestore.doc(RELEASE_WRITER_FENCE_PATH), firestore.doc(ROOT),
      firestore.doc("system/cmsPublicationRuntime"), firestore.doc(`${WITNESSES}/${attempt.witnessDigest}`));
    if ((!preflight || storedAttempt.exists) && (!storedAttempt.exists || !equal(parseSwitchAttempt(storedAttempt.data()), attempt))) refuse();
    if (prior.exists) {
      if (!storedAttempt.exists) refuse();
      const receipt = prior.data();
      if (receipt.schemaVersion !== 2 || receipt.operationId !== attempt.operationId || receipt.attemptDigest !== attemptDigest ||
          p.publicReleaseDigest(p.parsePublicReleaseSelector(receipt.selector)) !== receipt.selectorDigest) refuse();
      return { idempotent: true, receipt };
    }
    if (!preflight || fenceRow.exists) {
      const fence = parseReleaseWriterFence(fenceRow.data());
      if (fence.operationId !== attempt.operationId || fence.attemptDigest !== attemptDigest) refuse();
    }
    if (preflight && storedAttempt.exists && !fenceRow.exists) refuse(); // explicitly abandoned identity
    const selector = require("./public-release-media-fence").parseStoredSelector(selectorRow.data());
    if (p.publicReleaseDigest(selector) !== attempt.expectedSelectorDigest || !equal(selector.selectedPair, p.publicReleasePairReference(attempt.oldPair))) refuse();
    await require("./page-reader-compatibility").assertCandidatePageReaders({ firestore, transaction,
      candidate: { commitSha: attempt.newPair.commitSha } });
    const pins = assertPins(pinsRow.data(), attempt.oldPair), witness = parseSwitchWitness(witnessRow.data());
    if (p.publicReleaseDigest(witness) !== attempt.witnessDigest || witness.oldPairDigest !== p.publicReleaseDigest(attempt.oldPair) ||
        witness.newPairDigest !== p.publicReleaseDigest(attempt.newPair) || witness.admittedContractDigest !== selector.admittedContractDigest) refuse();
    const pairs = [attempt.oldPair, attempt.newPair];
    const controls = [];
    for (const pair of pairs) {
      const row = await transaction.get(firestore.doc(`${publicReleasePairPath(pair.pairId)}/seals/privateReader`));
      const seals = qualificationReadOwner.parseReaderSeals(row.data(), pair);
      if (!row.exists || !equal(seals, row.data())) refuse();
      controls.push(publicationControlsForReaderSeals(seals, pair));
    }
    const rows = await transaction.getAll(...pairs.flatMap(pair => [firestore.doc(publicReleasePairPath(pair.pairId)),
      firestore.doc(`${publicReleasePairPath(pair.pairId)}/controls/runtime`),
      firestore.doc(`${publicReleasePairPath(pair.pairId)}/rollouts/publisher`)]),
      ...pairs.map((pair, index) => firestore.doc(`${publicReleasePairPath(pair.pairId)}/switchQualifications/${index ? witness.newQualificationDigest : witness.oldQualificationDigest}`)),
      ...witness.validators.map(validator => firestore.doc(validator.path)));
    const qualifications = pairs.map((pair, index) => {
      const base = index * 3, lifecycle = rows[base + 1].data(), rollout = rows[base + 2].data();
      p.exact(lifecycle, ["schemaVersion", "pairId", "status"]);
      if (!equal(p.parsePublicReleasePair(rows[base].data()), pair) || lifecycle.schemaVersion !== 2 || lifecycle.pairId !== pair.pairId ||
          !["retained", ...(index ? ["candidate"] : [])].includes(lifecycle.status) || rollout?.state !== "verified" ||
          rollout.pairDigest !== p.publicReleaseDigest(pair)) refuse();
      const qualification = parseSwitchQualification(rows[6 + index].data(), pair);
      if (p.publicReleaseDigest(qualification) !== (index ? witness.newQualificationDigest : witness.oldQualificationDigest) ||
          qualification.controlsDigest !== p.publicReleaseDigest(controls[index]) || !equal(qualification.capabilities, controls[index]) ||
          qualification.providerReadbackDigest !== rollout.readbackDigest || !equal(qualification.cursor, witness.cursor) ||
          qualification.validatorDigest !== p.publicReleaseDigest(witness.validators) || qualification.acceptedWorkDigest !== witness.acceptedWorkDigest ||
          qualification.admittedContractDigest !== witness.admittedContractDigest) refuse();
      return qualification;
    });
    witness.validators.forEach((validator, index) => {
      if (!rows[8 + index].exists || p.publicReleaseDigest(rows[8 + index].data()) !== validator.digest) refuse();
    });
    // Injected only by the private operator adapter. It must run the actual
    // qualification owner's late guard on its opaque outside preparation for
    // BOTH pairs, in this very transaction. No default or serialized flag.
    if (typeof assertQualificationsCurrentInTransaction !== "function") refuse();
    await assertQualificationsCurrentInTransaction({ firestore, transaction, readTracker, pairs, qualifications, witness });
    const authority = Object.fromEntries(witness.validators.map((validator, index) => [validator.path, rows[8 + index].data()]));
    const namespace = authority["system/publicDeployment/noBuildRecordFamilies/current"];
    p.exact(namespace, ["schemaVersion", "families"]);
    if (namespace.schemaVersion !== 1) refuse();
    const registered = require("./no-build-record-namespace").recordFamilies(namespace.families);
    // Neither selection nor the retained recovery side can release an owned
    // record family. A matching witness digest alone does not prove coverage.
    if (registered.length && qualifications.some(({ capabilities }) => !capabilities.records.servingEnabled ||
        registered.some(family => !capabilities.records.families.includes(family)))) refuse();
    if (!equal(parsePublicReleaseChangeHead(authority["system/publicReleaseChanges"]), witness.cursor) ||
        authority["system/billing"].disabled === true || authority["system/publicDeployment/contexts/public"]?.schemaVersion !== 1 ||
        !p.positive(authority["system/publicDeployment/contexts/public"].revision)) refuse();
    const producer = authority["system/publicReleaseChangeLog"];
    if (producer.schemaVersion !== 2 || producer.enabled !== true || !equal(producer.pair, selector.selectedPair) || !isPublicDeploymentIdentifier(producer.logEpoch)) refuse();
    if (p.publicReleaseDigest(authority[ADMISSIONS]) !== witness.acceptedWorkDigest ||
        typeof assertAcceptedWorkIncludedInTransaction !== "function") refuse();
    await assertAcceptedWorkIncludedInTransaction({ firestore, transaction, readTracker, pairs, qualifications, witness });
    const media = parsePairMedia(authority[MEDIA], selector);
    if (!media.references.some(ref => ref.pairId === attempt.newPair.pairId)) refuse();
    const generation = selector.activeGeneration + 1, epoch = selector.epoch + 1;
    if (![generation, epoch].every(p.positive)) refuse();
    // The accepted contract stays the intersection during the rollback window.
    // Qualification binds both exact bundles to this same admitted contract.
    const next = p.parsePublicReleaseSelector({ ...selector, epoch, activeGeneration: generation, lastReservedGeneration: generation,
      newestEligibleGeneration: generation, newestEligibleBuildBatchId: attempt.operationId, activeDeploymentId: attempt.newPair.publicWorker.versionId,
      activeCommitSha: attempt.newPair.commitSha, selectedPair: p.publicReleasePairReference(attempt.newPair),
      recoveryPair: p.publicReleasePairReference(attempt.oldPair), contentHead: qualifications[1].contentHead,
      priorSelectorDigest: attempt.expectedSelectorDigest, switchOperationId: attempt.operationId, proofDigest: attempt.witnessDigest });
    const newPins = { ...pins, commitSha: next.activeCommitSha, cloud: { ...pins.cloud, commitSha: next.activeCommitSha } };
    const references = new Map(media.references.map(reference => [reference.pairId, reference]));
    pairs.forEach((pair, index) => references.set(pair.pairId, { pairId: pair.pairId, manifestDigest: qualifications[index].contentHead.manifestDigest }));
    const nextMedia = parsePairMedia({ ...media, epoch, activeGeneration: generation, lastReservedGeneration: generation,
      newestEligibleGeneration: generation, references: [...references.values()].sort((left, right) => left.pairId.localeCompare(right.pairId)) }, next);
    const codePublication = await transaction.get(firestore.doc(`${publicReleasePairPath(attempt.newPair.pairId)}/codePacks/publication`));
    const codeReference = require("./public-release-pair-code-reference").parsePairCodePublication(codePublication.data(), attempt.newPair).reference;
    const historyRef = firestore.doc(`system/publicReleaseSwitches/entries/${attempt.operationId}`);
    const lineageRef = firestore.doc(lineage.publicReleaseSwitchLineagePath(attempt.operationId));
    if (preflight) {
      const [history, audit, savedLineage] = await transaction.getAll(historyRef,
        firestore.doc(`admin_logs/${p.publicReleaseDigest({ switchOperationId: attempt.operationId })}`), lineageRef);
      if (history.exists || audit.exists || savedLineage.exists) refuse();
    }
    const history = { schemaVersion: 2, operationId: attempt.operationId, selector: next, pins: newPins };
    const selectorLineage = lineage.publicReleaseSwitchLineage(selector, pins, next);
    const writeAuthorityChange = await require("./public-release-producer").preparePublicReleaseProducerInTransaction({ firestore, transaction,
      operationId: switchChangeOperationId(attempt.operationId), pairActivation: { commitSha: next.activeCommitSha, codeReference },
      contextRevision: authority["system/publicDeployment/contexts/public"].revision,
      changes: [{ kind: "provider", id: "public-code", action: "dependency", sourceVersion: generation,
        snapshot: { commitSha: next.activeCommitSha, generation, deploymentId: next.activeDeploymentId },
        sourceDocuments: [{ path: ROOT, data: next }, { path: MEDIA, data: nextMedia }, { path: historyRef.path, data: history }, { path: lineageRef.path, data: selectorLineage },
          ...Object.entries(CAPABILITY_PATHS).map(([family, path]) => ({ path, data: { ...qualifications[1].capabilities[family], generation } }))] }] });
    const receipt = { schemaVersion: 2, operationId: attempt.operationId, attemptDigest, selectorDigest: p.publicReleaseDigest(next), selector: next };
    qualificationReadOwner.assertQualificationTransactionReadBudget(readTracker);
    if (preflight) return; // no write closure, selector, receipt, fence or audit is committed
    writeAuthorityChange();
    transaction.create(historyRef, history);
    transaction.create(lineageRef, selectorLineage);
    transaction.set(firestore.doc(ROOT), next);
    transaction.set(pinsRow.ref, newPins);
    for (const [family, path] of Object.entries(CAPABILITY_PATHS)) transaction.set(firestore.doc(path), { ...qualifications[1].capabilities[family], generation });
    transaction.set(firestore.doc(`${publicReleasePairPath(attempt.newPair.pairId)}/controls/runtime`), { schemaVersion: 2, pairId: attempt.newPair.pairId, status: "retained" });
    pairs.forEach((pair, index) => transaction.set(firestore.doc(`${publicReleasePairPath(pair.pairId)}/heads/current`),
      { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), contentHead: qualifications[index].contentHead }));
    transaction.set(firestore.doc(MEDIA), nextMedia);
    transaction.create(receiptRef, receipt);
    transaction.create(firestore.doc(`admin_logs/${p.publicReleaseDigest({ switchOperationId: attempt.operationId })}`), {
      actorUid: "system:public-release-switch", actorEmail: null, target: ROOT,
      timestamp: FieldValue.serverTimestamp(), at: new Date().toISOString(),
      action: "public-release.switch", source: "public-release-switch", operationId: attempt.operationId,
      before: { epoch: selector.epoch, selectorDigest: attempt.expectedSelectorDigest }, after: { epoch, selectorDigest: receipt.selectorDigest } });
    transaction.delete(firestore.doc(RELEASE_WRITER_FENCE_PATH));
    return { idempotent: false, receipt };
  }, preflight ? { readOnly: true } : undefined);
}
// Explicit cancellation releases only an unapplied exact attempt. Lost-response
// recovery must read the immutable receipt before preparing another operation.
async function abandonPublicReleaseSwitch({ firestore, attempt: raw }) {
  const attempt = parseSwitchAttempt(raw); assertPublicReleasePairDatabase(firestore, attempt.oldPair);
  return firestore.runTransaction(async transaction => {
    const [stored, fence, receipt] = await transaction.getAll(firestore.doc(`${ATTEMPTS}/${attempt.operationId}`),
      firestore.doc(RELEASE_WRITER_FENCE_PATH), firestore.doc(`${RECEIPTS}/${attempt.operationId}`));
    if (!equal(parseSwitchAttempt(stored.data()), attempt) || receipt.exists) refuse();
    if (!fence.exists) return { idempotent: true };
    const value = parseReleaseWriterFence(fence.data());
    if (value.operationId !== attempt.operationId || value.attemptDigest !== p.publicReleaseDigest(attempt)) refuse();
    transaction.delete(fence.ref); return { idempotent: false };
  });
}
module.exports = { ROOT, WITNESSES, ATTEMPTS, RECEIPTS, MEDIA, CAPABILITY_PATHS, REQUIRED_VALIDATORS, ADMISSIONS,
  parseSwitchAttempt, parseSwitchWitness, parseSwitchQualification, parsePairMedia,
  switchChangeOperationId, publicationControlsForReaderSeals,
  reservePublicReleaseSwitch, applyPublicReleaseSwitch, assertPublicReleaseSwitchPreflight, abandonPublicReleaseSwitch };
