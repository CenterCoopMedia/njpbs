"use strict";
// Original source owners retain authorization, immutable snapshot/history,
// route and media checks in this same transaction. No acceptance endpoint.
const p = require("./public-release-pair");
const { createHash } = require("node:crypto");
const work = require("./public-release-pair-work");
const log = require("./public-release-change-log");
const producer = require("./public-release-producer");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { parseCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { projectNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { publicationTarget } = require("./publication-target");
const { readPublicContextRevisionInTransaction } = require("./public-context-revision");
const { ADMISSIONS, CONTRACTS, TRANSPORT, FAMILY, initialAdmissionHead, parseAdmissionHead, togglePendingDigest,
  parsePublicationSource, parseAdmission, ownerPath, assertQueue, assertRetainedPairAdmissionInTransaction } = require("./public-release-admission-contract");
function refuse() { throw new p.PublicReleaseProtocolError(); }
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const id = value => { if (!isPublicDeploymentIdentifier(value)) refuse(); return value; };
const snapshotDigest = value => createHash("sha256").update(producer.publicReleaseSnapshotJson(value)).digest("hex");
const publicationPendingPath = (pairId, operationId) => `${work.publicReleasePairPath(pairId)}/publicationPending/${id(operationId)}`;
function publicationSource({ kind, id: sourceId, family = FAMILY[kind], action, snapshot, sourceVersion = snapshot?.sourceVersion }) {
  const features = [];
  if (action !== "withdraw") {
    if (require("./live-blog-compatibility").containsLiveBlog(snapshot)) features.push("liveBlogVersion:1");
    if (require("./election-results-compatibility").containsVisibleElectionResults(snapshot)) features.push(`electionResultsVersion:${require("./election-results-compatibility").requiredElectionResultsVersion(snapshot)}`);
    if (require("./data-figure-compatibility").containsVisibleDataFigure(snapshot)) features.push("dataFigureVersion:1");
    if (snapshot?.metadata?.dataHubCompositionVersion === 1) features.push("dataHubCompositionVersion:1");
    if (kind === "page" && sourceId === "data-hub") features.push("dataHubReportingVersion:1");
  }
  return parsePublicationSource({ kind, id: sourceId, family, action, sourceVersion,
    snapshotDigest: snapshotDigest(snapshot), requiredFeatures: features.sort() });
}
async function assertOwnedWithdrawal({ firestore, transaction, source }) {
  const marker = (await transaction.get(firestore.doc(ownerPath(source)))).data();
  if (!marker && ["post", "page", "record"].includes(source.kind)) {
    const names = { page: "noBuildPageOwners", record: "noBuildRecordOwners" };
    const [owner, document] = await Promise.all([
      source.kind === "post" ? require("./no-build-post-ownership").readNoBuildPostOwner({ firestore, transaction, postId: source.id })
        : transaction.get(firestore.doc(`system/publicDeployment/${names[source.kind]}/${source.id}`)).then(row => ({ state: row.data() })),
      transaction.get(firestore.doc(`${source.kind === "page" ? "cmsPages" : "cmsPosts"}/${source.id}`)),
    ]);
    const state = owner.state, stored = document.data();
    if (state?.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(state.operationId ?? "") || state.visible !== true ||
        state.sourceVersion !== source.sourceVersion || !stored?.published || publicationSource({ ...source, snapshot: stored.published }).snapshotDigest !== source.snapshotDigest ||
        state.snapshotDigest !== undefined && state.snapshotDigest !== source.snapshotDigest) refuse();
    return;
  }
  if (marker?.schemaVersion !== 2 || !isPublicDeploymentIdentifier(marker.operationId)) refuse();
  const prior = parseAdmission((await transaction.get(firestore.doc(`${ADMISSIONS}/operations/${marker.operationId}`))).data());
  if (p.publicReleaseDigest(prior) !== marker.admissionDigest || prior.source.kind !== source.kind || prior.source.id !== source.id ||
      prior.source.sourceVersion !== source.sourceVersion || prior.source.snapshotDigest !== source.snapshotDigest) refuse();
}
/** No pre-captured H and no task. Persist original-pair admission, queue and
 * accepted-source outbox together; H is captured from that durable event. */
async function preparePairPublicationInTransaction({ firestore, transaction, operationId, source: rawSource, change, contextRevision }) {
  id(operationId); const source = parsePublicationSource(rawSource);
  const derived = publicationSource({ ...change, family: source.family });
  if (!same(source, derived) || change.kind !== source.kind || change.id !== source.id || change.action !== source.action) refuse();
  const admissionRef = firestore.doc(`${ADMISSIONS}/operations/${operationId}`), queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const [existing, queueRow] = await transaction.getAll(admissionRef, queueRef);
  if (existing.exists) {
    const admission = parseAdmission(existing.data());
    if (!same(admission.source, source) || admission.operationId !== operationId) refuse();
    assertQueue(queueRow.data(), admission);
    return { idempotent: true, admission, write() {} };
  }
  if (queueRow.exists) refuse();
  const withdrawal = source.action === "withdraw";
  if (!withdrawal) await require("./live-blog-compatibility").assertLiveBlogPresentationRenderer({
    firestore, transaction, liveBlog: change.snapshot?.metadata?.liveBlog });
  if (withdrawal) await assertOwnedWithdrawal({ firestore, transaction, source });
  const [selectorRow, headRow, adoptionRow, configRow, cursorRow, billingRow] = await transaction.getAll(
    firestore.doc("system/publicDeployment"), firestore.doc(ADMISSIONS), firestore.doc(`${ADMISSIONS}/controls/adoption`),
    firestore.doc("system/noBuildPostAdmission"), firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH), firestore.doc("system/billing"));
  p.exact(adoptionRow.data(), ["schemaVersion", "enabled"]);
  if (adoptionRow.data().schemaVersion !== 2 || adoptionRow.data().enabled !== true || !withdrawal && billingRow.data()?.disabled === true) refuse();
  const selector = require("./public-release-media-fence").parseStoredSelector(selectorRow.data()), head = parseAdmissionHead(headRow.data());
  const base = work.publicReleasePairPath(selector.selectedPair.pairId);
  const [pairRow, runtimeRow, contractRow, pinsRow, enrolledRow] = await transaction.getAll(firestore.doc(base),
    firestore.doc(`${base}/controls/runtime`), firestore.doc(`${CONTRACTS}/${selector.admittedContractDigest}`),
    firestore.doc("system/cmsPublicationRuntime"), firestore.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL));
  const pair = p.parsePublicReleasePair(pairRow.data()); work.assertPublicReleasePairDatabase(firestore, pair);
  if (!same(selector.selectedPair, p.publicReleasePairReference(pair)) || runtimeRow.data()?.status !== "retained" ||
      runtimeRow.data()?.pairId !== pair.pairId || enrolledRow.data()?.enabled !== true || !same(enrolledRow.data()?.pair, selector.selectedPair)) refuse();
  const config = projectNoBuildFamilyAdmission(configRow.data(), process.env, publicationTarget(pair.environment));
  if (!withdrawal && (!config.valid || !config.enabled)) refuse();
  const selection = config.families[source.family];
  if (!withdrawal && ["posts", "pages", "programs", "events"].includes(source.family) && selection?.mode !== "all" &&
      !(selection?.mode === "ids" && selection.ids.includes(source.id))) refuse();
  const contract = contractRow.data(); p.exact(contract, ["schemaVersion", "families", "features"]);
  if (contract.schemaVersion !== 2 || p.publicReleaseDigest(contract) !== selector.admittedContractDigest ||
      !Array.isArray(contract.families) || !Array.isArray(contract.features) ||
      !withdrawal && (!contract.families.includes(source.family) || source.requiredFeatures.some(feature => !contract.features.includes(feature)))) refuse();
  const pins = parseCmsPublicationRuntimeControl(pinsRow.data()), serializerId = publicationTarget(pair.environment).serializerId;
  if (!withdrawal && [pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== pair.commitSha || pin.serializerId !== serializerId)) refuse();
  const revision = await readPublicContextRevisionInTransaction(transaction, firestore);
  if (contextRevision !== revision + 1 || !p.positive(contextRevision)) refuse();
  const cursor = log.parsePublicReleaseChangeHead(cursorRow.data());
  const admission = parseAdmission({ schemaVersion: 2, operationId, source, pair: selector.selectedPair, pairDigest: p.publicReleaseDigest(pair),
    epoch: selector.epoch, changeSequence: cursor.sequence + 1, contextRevision, admissionSequence: head.sequence + 1,
    admittedContractDigest: selector.admittedContractDigest });
  const writeChange = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId, changes: [change], contextRevision });
  const writeHold = await require("./public-release-rehearsal-hold").prepareAdmissionInTransaction({ firestore, transaction, pair, accepted: admission });
  const admissionDigest = p.publicReleaseDigest(admission);
  return { idempotent: false, admission, write() {
    writeChange(); writeHold();
    transaction.create(admissionRef, admission);
    transaction.create(firestore.doc(`${ADMISSIONS}/pending/${operationId}`), { schemaVersion: 2, operationId, admissionDigest });
    transaction.create(firestore.doc(publicationPendingPath(pair.pairId, operationId)), { schemaVersion: 2, operationId, admissionDigest, nextAttemptAt: 0 });
    transaction.set(firestore.doc(ownerPath(source)), { schemaVersion: 2, operationId, admissionDigest, admissionSequence: admission.admissionSequence });
    transaction.set(firestore.doc(ADMISSIONS), { ...head, sequence: admission.admissionSequence, pendingCount: head.pendingCount + 1,
      pendingDigest: togglePendingDigest(head.pendingDigest, admissionDigest) });
    transaction.create(queueRef, { schemaVersion: 2, transport: TRANSPORT, operationId, admissionDigest,
      pair: admission.pair, status: "pending", execution: null, terminalReceipt: null });
  } };
}
module.exports = { ADMISSIONS, CONTRACTS, TRANSPORT, initialAdmissionHead, parseAdmissionHead, togglePendingDigest,
  parsePublicationSource, publicationSource, parseAdmission, ownerPath, assertQueue,
  preparePairPublicationInTransaction, assertRetainedPairAdmissionInTransaction, publicationPendingPath };
