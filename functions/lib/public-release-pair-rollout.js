"use strict";

const { parsePublicReleasePair, PublicReleaseProtocolError, publicReleaseDigest, exact, digest, freeze } = require("./public-release-pair");
const { publicReleasePairPath, assertPublicReleasePairDatabase, assertPrivatePairResources } = require("./public-release-pair-work");

function refuse() { throw new PublicReleaseProtocolError(); }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UNKNOWN_VERSION = "00000000-0000-0000-0000-000000000000";

/** A versionless intent is not an immutable registered pair. The placeholder
 * exists only to reuse the strict pair parser; it is never written as a pair.
 */
function parsePublicReleasePairUploadPlan(value) {
  const firstInstall = value?.schemaVersion === 3;
  exact(value, ["schemaVersion", "kind", "pairTemplate", "accountId", "imageReference", "bundleDigest", "configurationDigest", ...firstInstall ? ["slotInstall"] : []]);
  exact(value.pairTemplate?.publisher, ["application", "imageDigest", "journalNamespace"]);
  if (firstInstall) {
    exact(value.slotInstall, ["operationId", "readerOrigin"]);
    exact(value.pairTemplate?.publicWorker, ["service", "incarnation"]);
    if (Object.hasOwn(value.pairTemplate, "readerReceiptDigest") || !/^[A-Za-z0-9_-]{1,128}$/.test(value.slotInstall.operationId ?? "")) refuse();
    const origin = new URL(value.slotInstall.readerOrigin);
    if (origin.protocol !== "https:" || origin.origin !== value.slotInstall.readerOrigin || origin.username || origin.password) refuse();
  }
  const pair = publicReleasePairUploadCandidate(value);
  assertPrivatePairResources(pair);
  const image = typeof value.imageReference === "string"
    ? /^registry\.cloudflare\.com\/([a-f0-9]{32})\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.exec(value.imageReference) : null;
  if (![2, 3].includes(value.schemaVersion) || value.kind !== "private-pair-publisher-upload" ||
      !/^[a-f0-9]{32}$/.test(value.accountId ?? "") || !digest(value.bundleDigest) || !digest(value.configurationDigest) ||
      !image || image[1] !== value.accountId ||
      !value.imageReference.endsWith(`@${pair.publisher.imageDigest}`)) refuse();
  const publisher = { application: pair.publisher.application, imageDigest: pair.publisher.imageDigest,
    journalNamespace: pair.publisher.journalNamespace };
  const pairTemplate = { ...pair, publisher };
  if (firstInstall) {
    pairTemplate.publicWorker = { ...pair.publicWorker };
    delete pairTemplate.publicWorker.versionId;
    delete pairTemplate.readerReceiptDigest;
  }
  return freeze({ ...value, pairTemplate });
}

/** Process-local parser adapter only. Never persist this unassigned candidate. */
function publicReleasePairUploadCandidate(plan, workerVersionId = UNKNOWN_VERSION) {
  return parsePublicReleasePair({ ...plan.pairTemplate,
    ...plan.schemaVersion === 3 ? { readerReceiptDigest: "0".repeat(64), publicWorker: { ...plan.pairTemplate.publicWorker, versionId: UNKNOWN_VERSION } } : {},
    publisher: { ...plan.pairTemplate.publisher, workerVersionId } });
}
const uploadPair = publicReleasePairUploadCandidate;
function publicReleasePairUploadPath(pairId) { return `${publicReleasePairPath(pairId)}/rollouts/upload`; }
function publicReleasePairUploadCompletionPath(pairId) { return `${publicReleasePairUploadPath(pairId)}/completions/pair`; }
function matchesUploadTemplate(plan, pair) {
  const template = { ...pair, publisher: { ...pair.publisher }, publicWorker: { ...pair.publicWorker } };
  delete template.publisher.workerVersionId;
  if (plan.schemaVersion === 3) {
    delete template.publicWorker.versionId;
    delete template.readerReceiptDigest;
  }
  return publicReleaseDigest(plan.pairTemplate) === publicReleaseDigest(template);
}
async function completedUploadPair(transaction, firestore, plan, workerVersionId) {
  if (plan.schemaVersion === 2) return uploadPair(plan, workerVersionId);
  const completion = (await transaction.get(firestore.doc(publicReleasePairUploadCompletionPath(plan.pairTemplate.pairId)))).data();
  exact(completion, ["schemaVersion", "planDigest", "pair", "installation"]);
  const pair = parsePublicReleasePair(completion.pair);
  if (completion.schemaVersion !== 1 || completion.planDigest !== publicReleaseDigest(plan) ||
      pair.publisher.workerVersionId !== workerVersionId || !matchesUploadTemplate(plan, pair)) refuse();
  return pair;
}
async function readPublicReleasePairUploadPair({ firestore, plan: input, workerVersionId }) {
  const plan = parsePublicReleasePairUploadPlan(input);
  return firestore.runTransaction(transaction => completedUploadPair(transaction, firestore, plan, workerVersionId));
}
async function assertPublicReleasePairFirstInstallSlot({ firestore, pair: rawPair, operationId, readerOrigin }) {
  const pair = parsePublicReleasePair(rawPair);
  assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async transaction => {
    const [index, row] = await transaction.getAll(firestore.doc(UPLOADS), firestore.doc(publicReleasePairUploadPath(pair.pairId)));
    const plan = parseUploadIndex(index.data()).find(item => item.pairTemplate.pairId === pair.pairId);
    if (plan?.schemaVersion !== 3 || plan.slotInstall.operationId !== operationId || plan.slotInstall.readerOrigin !== readerOrigin ||
        !matchesUploadTemplate(plan, pair)) refuse();
    const seal = parseUploadAttempt(row.data(), plan);
    const expected = { planDigest: publicReleaseDigest(plan), publisherApplication: pair.publisher.application,
      workerVersionId: pair.publisher.workerVersionId, bundleDigest: plan.bundleDigest,
      configurationDigest: plan.configurationDigest, imageDigest: pair.publisher.imageDigest };
    if (seal.state !== "uploaded" || seal.workerVersionId !== pair.publisher.workerVersionId ||
        seal.readbackDigest !== publicReleaseDigest(expected)) refuse();
  });
}

/** Complete the original intent once, from native private-install receipts.
 * Provider bytes/configuration are independently checked by the concrete caller.
 * This seal cannot be replaced and grants no provider operation by itself. */
async function completePublicReleasePairUpload({ firestore, plan: input, pair: rawPair, installation }) {
  const plan = parsePublicReleasePairUploadPlan(input), pair = parsePublicReleasePair(rawPair);
  assertPublicReleasePairDatabase(firestore, pair);
  exact(installation, ["operationId", "installPlanDigest", "slot", "ingress"]);
  if (plan.schemaVersion !== 3 || !matchesUploadTemplate(plan, pair) ||
      installation.operationId !== plan.slotInstall.operationId || !digest(installation.installPlanDigest)) refuse();
  const receipt = publicReleaseDigest({ schemaVersion: 1, environment: pair.environment, service: pair.publicWorker.service,
    versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: plan.slotInstall.readerOrigin,
    contractDigest: pair.readerContractDigest });
  if (pair.readerReceiptDigest !== receipt || pair.publicWorker.versionId === UNKNOWN_VERSION ||
      pair.publisher.workerVersionId === pair.publicWorker.versionId) refuse();
  for (const member of [installation.slot, installation.ingress]) {
    exact(member, ["name", "planDigest", "tag", "workerId", "versionId", "deploymentId"]);
    if (!digest(member.planDigest) || !digest(member.tag) || !/^[a-f0-9]{32}$/.test(member.workerId ?? "") ||
        !UUID.test(member.versionId ?? "") || !UUID.test(member.deploymentId ?? "") ||
        member.tag !== publicReleaseDigest({ attemptId: installation.operationId, planDigest: member.planDigest })) refuse();
  }
  if (installation.slot.name !== pair.publicWorker.service || installation.slot.versionId !== pair.publicWorker.versionId ||
      !/^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(installation.ingress.name ?? "")) refuse();
  const value = { schemaVersion: 1, planDigest: publicReleaseDigest(plan), pair, installation };
  return firestore.runTransaction(async transaction => {
    const completionRef = firestore.doc(publicReleasePairUploadCompletionPath(pair.pairId));
    const [prior, upload, index, billing, originalPlan] = await transaction.getAll(completionRef,
      firestore.doc(publicReleasePairUploadPath(pair.pairId)), firestore.doc(UPLOADS), firestore.doc("system/billing"),
      firestore.doc(`system/publicReleasePrivateInstalls/plans/${installation.operationId}`));
    indexedPlan(parseUploadIndex(index.data()), plan);
    const seal = parseUploadAttempt(upload.data(), plan);
    const expectedUpload = { planDigest: value.planDigest, publisherApplication: pair.publisher.application,
      workerVersionId: pair.publisher.workerVersionId, bundleDigest: plan.bundleDigest,
      configurationDigest: plan.configurationDigest, imageDigest: pair.publisher.imageDigest };
    if (seal.state !== "uploaded" || seal.workerVersionId !== pair.publisher.workerVersionId ||
        seal.readbackDigest !== publicReleaseDigest(expectedUpload) || billing.data()?.disabled === true ||
        publicReleaseDigest(originalPlan.data()) !== publicReleaseDigest({ schemaVersion: 1,
          attemptId: installation.operationId, planDigest: installation.installPlanDigest })) refuse();
    const actions = ["create", "upload", "private-subdomain", "deploy"];
    for (const member of [installation.slot, installation.ingress]) {
      const base = "system/publicReleasePrivateInstalls", workerKey = publicReleaseDigest({ worker: member.name });
      const expected = { schemaVersion: 1, attemptId: installation.operationId, worker: member.name, planDigest: member.planDigest };
      const [owner, ...rows] = await transaction.getAll(firestore.doc(`${base}/workers/${workerKey}`),
        ...actions.flatMap(action => [firestore.doc(`${base}/attempts/${installation.operationId}/steps/${workerKey}-${action}`),
          firestore.doc(`${base}/attempts/${installation.operationId}/readbacks/${workerKey}-${action}`)]));
      if (publicReleaseDigest(owner.data()) !== publicReleaseDigest(expected)) refuse();
      const results = [{ workerId: member.workerId, name: member.name, tag: member.tag }, { versionId: member.versionId },
        { private: true }, { deploymentId: member.deploymentId, versionId: member.versionId }];
      actions.forEach((action, offset) => {
        if (publicReleaseDigest(rows[offset * 2].data()) !== publicReleaseDigest({ ...expected, action }) ||
            publicReleaseDigest(rows[offset * 2 + 1].data()) !== publicReleaseDigest({ ...expected, action, result: results[offset] })) refuse();
      });
    }
    if (prior.exists) {
      if (publicReleaseDigest(prior.data()) !== publicReleaseDigest(value)) refuse();
      return { idempotent: true, pair };
    }
    transaction.create(completionRef, value);
    return { idempotent: false, pair };
  });
}

function parseUploadAttempt(value, plan) {
  exact(value, ["schemaVersion", "pairId", "planDigest", "state", "workerVersionId", "readbackDigest"]);
  if (value.schemaVersion !== 2 || value.pairId !== plan.pairTemplate.pairId || value.planDigest !== publicReleaseDigest(plan) ||
      !["reserved", "uncertain", "uploaded"].includes(value.state) ||
      (value.state === "uploaded" ? typeof value.workerVersionId !== "string" || !UUID.test(value.workerVersionId) || value.workerVersionId === UNKNOWN_VERSION || !digest(value.readbackDigest)
        : value.workerVersionId !== null || value.readbackDigest !== null)) refuse();
  return value;
}

const UPLOADS = "system/publicReleasePairUploads";

function parseUploadIndex(value = { schemaVersion: 2, plans: [] }) {
  exact(value, ["schemaVersion", "plans"]);
  if (value.schemaVersion !== 2 || !Array.isArray(value.plans) || value.plans.length > 8) refuse();
  const plans = value.plans.map(parsePublicReleasePairUploadPlan);
  if (new Set(plans.map(plan => plan.pairTemplate.pairId)).size !== plans.length) refuse();
  return plans;
}
function indexedPlan(plans, plan) {
  const indexed = plans.find(item => item.pairTemplate.pairId === plan.pairTemplate.pairId);
  if (!indexed || publicReleaseDigest(indexed) !== publicReleaseDigest(plan)) refuse();
}
function assertDistinctResources(retained, pair) {
  if (retained.environment !== pair.environment || retained.pairId === pair.pairId ||
      retained.publisher.journalNamespace === pair.publisher.journalNamespace ||
      [retained.publisher.application, retained.publicWorker.service].some(name =>
        name === pair.publisher.application || name === pair.publicWorker.service)) refuse();
}
async function assertUploadResourcesAvailable(transaction, firestore, plan, plans) {
  const registry = (await transaction.get(firestore.doc("system/publicReleasePairs"))).data() ?? { schemaVersion: 2, pairIds: [] };
  exact(registry, ["schemaVersion", "pairIds"]);
  if (registry.schemaVersion !== 2 || !Array.isArray(registry.pairIds) || registry.pairIds.length > 8 ||
      new Set(registry.pairIds).size !== registry.pairIds.length) refuse();
  const occupied = new Set([...registry.pairIds, ...plans.map(item => item.pairTemplate.pairId)]);
  if (occupied.size >= 8 || occupied.has(plan.pairTemplate.pairId)) refuse();
  const rows = registry.pairIds.length
    ? await transaction.getAll(...registry.pairIds.map(id => firestore.doc(publicReleasePairPath(id)))) : [];
  const pair = uploadPair(plan);
  for (const row of rows) {
    const retained = parsePublicReleasePair(row.data());
    if (row.ref.path !== publicReleasePairPath(retained.pairId)) refuse();
    assertDistinctResources(retained, pair);
  }
  for (const pending of plans) assertDistinctResources(uploadPair(pending), pair);
}

async function requireUploadSeal(transaction, firestore, pair) {
  const [index, attempt] = await transaction.getAll(firestore.doc(UPLOADS),
    firestore.doc(publicReleasePairUploadPath(pair.pairId)));
  const plan = parseUploadIndex(index.data()).find(item => item.pairTemplate.pairId === pair.pairId);
  const mismatch = () => {
    const error = new PublicReleaseProtocolError();
    error.code = "PAIR_PUBLISHER_UPLOAD_PENDING";
    error.retryable = true;
    throw error;
  };
  if (!plan || !attempt.exists) mismatch();
  const seal = parseUploadAttempt(attempt.data(), plan);
  const expected = { planDigest: publicReleaseDigest(plan), publisherApplication: pair.publisher.application,
    workerVersionId: pair.publisher.workerVersionId, bundleDigest: plan.bundleDigest,
    configurationDigest: plan.configurationDigest, imageDigest: pair.publisher.imageDigest };
  if (seal.state !== "uploaded" || seal.workerVersionId !== pair.publisher.workerVersionId ||
      publicReleaseDigest(await completedUploadPair(transaction, firestore, plan, seal.workerVersionId)) !== publicReleaseDigest(pair) ||
      seal.readbackDigest !== publicReleaseDigest(expected)) mismatch();
}

/** Shared registration fence. The registration owner reads the same upload
 * index in its transaction, so pending names and slots cannot be stolen.
 */
async function assertPublicReleasePairUploadRegistration(transaction, firestore, pair, registry) {
  const index = await transaction.get(firestore.doc(UPLOADS));
  const plans = parseUploadIndex(index.data());
  const own = plans.find(plan => plan.pairTemplate.pairId === pair.pairId);
  if (own) await requireUploadSeal(transaction, firestore, pair);
  for (const plan of plans) {
    if (plan.pairTemplate.pairId !== pair.pairId) assertDistinctResources(uploadPair(plan), pair);
  }
  const occupied = new Set([...registry.pairIds, ...plans.map(plan => plan.pairTemplate.pairId)]);
  if (!occupied.has(pair.pairId) && occupied.size >= 8) refuse();
}

/** One durable install intent, before its assigned UUID exists.
 * This grant initializes the install; each provider mutation requires its own
 * install-operation grant. Repeated initialization grants no new install.
 */
async function reservePublicReleasePairUpload({ firestore, plan: rawPlan }) {
  const plan = parsePublicReleasePairUploadPlan(rawPlan), pair = uploadPair(plan);
  assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async transaction => {
    const attemptRef = firestore.doc(publicReleasePairUploadPath(pair.pairId));
    const [attempt, registered, billing, index] = await transaction.getAll(attemptRef, firestore.doc(publicReleasePairPath(pair.pairId)),
      firestore.doc("system/billing"), firestore.doc(UPLOADS));
    const plans = parseUploadIndex(index.data());
    if (attempt.exists) {
      const old = parseUploadAttempt(attempt.data(), plan);
      indexedPlan(plans, plan);
      if (registered.exists && (old.state !== "uploaded" ||
          publicReleaseDigest(parsePublicReleasePair(registered.data())) !== publicReleaseDigest(await completedUploadPair(transaction, firestore, plan, old.workerVersionId)))) refuse();
      return { mayStartInstall: false, planDigest: old.planDigest, state: old.state, workerVersionId: old.workerVersionId };
    }
    if (registered.exists || billing.data()?.disabled === true) refuse();
    await assertUploadResourcesAvailable(transaction, firestore, plan, plans);
    const value = { schemaVersion: 2, pairId: pair.pairId, planDigest: publicReleaseDigest(plan),
      state: "reserved", workerVersionId: null, readbackDigest: null };
    transaction.create(attemptRef, value);
    transaction.set(firestore.doc(UPLOADS), { schemaVersion: 2, plans: [...plans, plan] });
    return { mayStartInstall: true, planDigest: value.planDigest, state: value.state, workerVersionId: null };
  });
}

/** The concrete transport first checks real bytes/metadata outside this
 * transaction. This owner seals only its exact plan and assigned UUID.
 */
async function recordPublicReleasePairUploadReadback({ firestore, plan: rawPlan, readback = null }) {
  const plan = parsePublicReleasePairUploadPlan(rawPlan), pair = uploadPair(plan);
  assertPublicReleasePairDatabase(firestore, pair);
  if (readback !== null) {
    exact(readback, ["planDigest", "publisherApplication", "workerVersionId", "bundleDigest", "configurationDigest", "imageDigest"]);
    if (readback.planDigest !== publicReleaseDigest(plan) || readback.publisherApplication !== pair.publisher.application ||
        typeof readback.workerVersionId !== "string" || !UUID.test(readback.workerVersionId) || readback.workerVersionId === UNKNOWN_VERSION ||
        readback.bundleDigest !== plan.bundleDigest || readback.configurationDigest !== plan.configurationDigest ||
        readback.imageDigest !== pair.publisher.imageDigest) refuse();
  }
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(publicReleasePairUploadPath(pair.pairId));
    const [row, registered, index] = await transaction.getAll(ref, firestore.doc(publicReleasePairPath(pair.pairId)), firestore.doc(UPLOADS));
    indexedPlan(parseUploadIndex(index.data()), plan);
    if (!row.exists) refuse();
    const old = parseUploadAttempt(row.data(), plan);
    const readbackDigest = readback === null ? null : publicReleaseDigest(readback);
    if (registered.exists && (old.state !== "uploaded" ||
        publicReleaseDigest(parsePublicReleasePair(registered.data())) !== publicReleaseDigest(await completedUploadPair(transaction, firestore, plan, old.workerVersionId)))) refuse();
    if (old.state === "uploaded") {
      if (old.workerVersionId !== readback?.workerVersionId || old.readbackDigest !== readbackDigest) refuse();
      return { idempotent: true, workerVersionId: old.workerVersionId };
    }
    transaction.set(ref, { ...old, state: readback === null ? "uncertain" : "uploaded",
      workerVersionId: readback?.workerVersionId ?? null, readbackDigest });
    return { idempotent: false, workerVersionId: readback?.workerVersionId ?? null };
  });
}
const INSTALL_OPERATIONS = ["identity", "version", "deployment", "container", "trigger"];
function installOperationPath(plan, operation) {
  if (!INSTALL_OPERATIONS.includes(operation)) refuse();
  return `${publicReleasePairUploadPath(plan.pairTemplate.pairId)}/operations/${operation}`;
}
function parseInstallOperation(value, plan, operation, requestDigest) {
  exact(value, ["schemaVersion", "pairId", "planDigest", "operation", "requestDigest", "state", "readbackDigest"]);
  if (value.schemaVersion !== 2 || value.pairId !== plan.pairTemplate.pairId || value.planDigest !== publicReleaseDigest(plan) ||
      value.operation !== operation || value.requestDigest !== requestDigest || !digest(requestDigest) ||
      !["reserved", "uncertain", "verified"].includes(value.state) ||
      (value.state === "verified" ? !digest(value.readbackDigest) : value.readbackDigest !== null)) refuse();
  return value;
}
async function installRecords(transaction, firestore, plan, operation, requestDigest) {
  if (!digest(requestDigest)) refuse();
  const operationRef = firestore.doc(installOperationPath(plan, operation));
  const [attempt, index, upload, billing] = await transaction.getAll(operationRef, firestore.doc(UPLOADS),
    firestore.doc(publicReleasePairUploadPath(plan.pairTemplate.pairId)), firestore.doc("system/billing"));
  indexedPlan(parseUploadIndex(index.data()), plan);
  if (!upload.exists) refuse();
  const uploadState = parseUploadAttempt(upload.data(), plan);
  const old = attempt.exists ? parseInstallOperation(attempt.data(), plan, operation, requestDigest) : null;
  return { operationRef, old, uploadState, billingDisabled: billing.data()?.disabled === true };
}

/** Each provider mutation has its own durable one-attempt boundary. No write
 * belongs in a readback retry loop, including the first private Worker create.
 */
async function reservePublicReleasePairInstallOperation({ firestore, plan: input, operation, requestDigest }) {
  const plan = parsePublicReleasePairUploadPlan(input);
  assertPublicReleasePairDatabase(firestore, uploadPair(plan));
  return firestore.runTransaction(async transaction => {
    const { operationRef, old, uploadState, billingDisabled } = await installRecords(transaction, firestore, plan, operation, requestDigest);
    if (old) return { mayStartProviderWrite: false, state: old.state };
    if (billingDisabled) refuse();
    const previous = { version: "identity", container: "deployment", trigger: "container" }[operation];
    if (previous) {
      const prerequisite = (await transaction.get(firestore.doc(installOperationPath(plan, previous)))).data();
      if (!prerequisite || parseInstallOperation(prerequisite, plan, previous, prerequisite.requestDigest).state !== "verified") refuse();
    }
    if (["identity", "version"].includes(operation) && uploadState.state !== "reserved") refuse();
    if (["deployment", "container", "trigger"].includes(operation)) {
      if (uploadState.state !== "uploaded") refuse();
      const pair = await completedUploadPair(transaction, firestore, plan, uploadState.workerVersionId);
      await requireUploadSeal(transaction, firestore, pair);
      const rollout = await records(transaction, firestore, pair);
      if (!rollout.attempt.exists) refuse();
    }
    transaction.create(operationRef, { schemaVersion: 2, pairId: plan.pairTemplate.pairId, planDigest: publicReleaseDigest(plan),
      operation, requestDigest, state: "reserved", readbackDigest: null });
    return { mayStartProviderWrite: true, state: "reserved" };
  });
}
async function recordPublicReleasePairInstallOperation({ firestore, plan: input, operation, requestDigest, readbackDigest = null }) {
  const plan = parsePublicReleasePairUploadPlan(input);
  assertPublicReleasePairDatabase(firestore, uploadPair(plan));
  if (readbackDigest !== null && !digest(readbackDigest)) refuse();
  return firestore.runTransaction(async transaction => {
    const { operationRef, old } = await installRecords(transaction, firestore, plan, operation, requestDigest);
    if (!old) refuse();
    if (old.state === "verified") {
      if (old.readbackDigest !== readbackDigest) refuse();
      return { idempotent: true };
    }
    transaction.set(operationRef, { ...old, state: readbackDigest === null ? "uncertain" : "verified", readbackDigest });
    return { idempotent: false };
  });
}

async function records(transaction, firestore, input) {
  const pair = parsePublicReleasePair(input);
  assertPublicReleasePairDatabase(firestore, pair);
  const pairRef = firestore.doc(publicReleasePairPath(pair.pairId));
  const attemptRef = pairRef.collection("rollouts").doc("publisher");
  const [pairRow, control, attempt] = await transaction.getAll(pairRef, pairRef.collection("controls").doc("runtime"), attemptRef);
  exact(control.data(), ["schemaVersion", "pairId", "status"]);
  if (publicReleaseDigest(parsePublicReleasePair(pairRow.data())) !== publicReleaseDigest(pair) || control.data().schemaVersion !== 2 ||
      control.data().pairId !== pair.pairId || control.data().status !== "candidate") refuse();
  const pairDigest = publicReleaseDigest(pair);
  if (attempt.exists) {
    exact(attempt.data(), ["schemaVersion", "pairId", "pairDigest", "state", "readbackDigest"]);
    const old = attempt.data();
    if (old.schemaVersion !== 2 || old.pairId !== pair.pairId || old.pairDigest !== pairDigest ||
        !["reserved", "uncertain", "verified"].includes(old.state) ||
        (old.state === "verified" ? !digest(old.readbackDigest) : old.readbackDigest !== null)) refuse();
  }
  return { pair, pairDigest, attemptRef, attempt };
}

/** Exactly one caller receives permission to issue the provider mutation.
 * A crash or lost response always takes the readback path, never another POST.
 * This API performs no provider call and changes no public traffic.
 */
async function reservePublicReleasePairRollout({ firestore, pair }) {
  return firestore.runTransaction(async transaction => {
    const { pair: parsed, pairDigest, attemptRef, attempt } = await records(transaction, firestore, pair);
    await requireUploadSeal(transaction, firestore, parsed);
    if (attempt.exists) return { mayStartProviderWrite: false, state: attempt.data().state };
    transaction.create(attemptRef, { schemaVersion: 2, pairId: parsed.pairId, pairDigest, state: "reserved", readbackDigest: null });
    return { mayStartProviderWrite: true, state: "reserved" };
  });
}

async function recordPublicReleasePairRolloutReadback({ firestore, pair, readback = null }) {
  return firestore.runTransaction(async transaction => {
    const { pair: parsed, attemptRef, attempt } = await records(transaction, firestore, pair);
    if (!attempt.exists) refuse();
    if (readback !== null) {
      exact(readback, ["publisherApplication", "publisherWorkerVersionId", "imageDigest", "publicService", "publicWorkerVersionId",
        "publisherDeploymentId", "publicDeploymentId", "publisherTrafficPercent", "publicTrafficPercent"]);
      if (readback.publisherApplication !== parsed.publisher.application || readback.publisherWorkerVersionId !== parsed.publisher.workerVersionId ||
          readback.imageDigest !== parsed.publisher.imageDigest || readback.publicService !== parsed.publicWorker.service ||
          readback.publicWorkerVersionId !== parsed.publicWorker.versionId ||
          typeof readback.publisherDeploymentId !== "string" || !UUID.test(readback.publisherDeploymentId) ||
          typeof readback.publicDeploymentId !== "string" || !UUID.test(readback.publicDeploymentId) ||
          readback.publisherTrafficPercent !== 100 || readback.publicTrafficPercent !== 100) refuse();
    }
    const readbackDigest = readback === null ? null : publicReleaseDigest(readback);
    if (attempt.data().state === "verified") {
      if (attempt.data().readbackDigest !== readbackDigest) refuse();
      return { idempotent: true };
    }
    transaction.set(attemptRef, { ...attempt.data(), state: readback === null ? "uncertain" : "verified", readbackDigest });
    return { idempotent: false };
  });
}
module.exports = { reservePublicReleasePairRollout, recordPublicReleasePairRolloutReadback,
  parsePublicReleasePairUploadPlan, publicReleasePairUploadPath, reservePublicReleasePairUpload, recordPublicReleasePairUploadReadback,
  publicReleasePairUploadCandidate, publicReleasePairUploadCompletionPath, completePublicReleasePairUpload, readPublicReleasePairUploadPair,
  assertPublicReleasePairFirstInstallSlot,
  reservePublicReleasePairInstallOperation, recordPublicReleasePairInstallOperation, assertPublicReleasePairUploadRegistration };
