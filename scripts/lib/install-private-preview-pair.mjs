import { privateInstallLedger } from "./public-release-private-install-ledger.mjs";
import { startCandidateReceipt, verifyCandidateReceipt } from "./cms-component-receipt.mjs";
import { createPrivatePreviewPairProvider, previewProviderDigest, PreviewProviderError } from "./private-preview-pair-provider.mjs";
import preview from "../../functions/lib/cms-preview-pair.js";
import candidateAuthority from "../../functions/lib/cms-preview-pair-candidate.js";
import publicPairs from "../../functions/lib/public-release-pair.js";
// One shared caller for publisher and preview; no second ephemeral transport.
import { createPrivatePairPreflightCaller } from "./private-pair-preflight-caller.mjs";

const refuse = () => { throw new PreviewProviderError("preview-install-reconciliation-required"); };
const same = (a, b) => { if (previewProviderDigest(a) !== previewProviderDigest(b)) refuse(); };
const HEX = /^[a-f0-9]{64}$/;
function parseRequest(raw, prepared) {
  const fields = ["operationId", "expectedRuntimeDigest", "expectedCandidatePointerDigest", "bootstrapPublicPair", "candidate"];
  if (!raw || Object.keys(raw).length !== fields.length || fields.some(k => !Object.hasOwn(raw, k)) ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(raw.operationId) || !HEX.test(raw.expectedRuntimeDigest) ||
      raw.expectedCandidatePointerDigest !== null && !HEX.test(raw.expectedCandidatePointerDigest)) refuse();
  publicPairs.parsePublicReleasePairReference(raw.bootstrapPublicPair);
  const c = raw.candidate;
  if (!c || Object.keys(c).length !== 6 || !["sourceSha", "trustedWorkflowSha", "runId", "runAttempt", "inputFingerprint", "configurationFingerprint"].every(k => Object.hasOwn(c, k)) ||
      c.sourceSha !== prepared.pair.rendererSha || !/^[a-f0-9]{40}$/.test(c.trustedWorkflowSha) || !/^[0-9]{1,20}$/.test(c.runId) ||
      !Number.isSafeInteger(c.runAttempt) || c.runAttempt < 1 || c.runAttempt > 1000 || c.inputFingerprint !== prepared.bundleDigest || c.configurationFingerprint !== prepared.configurationDigest) refuse();
  return structuredClone(raw);
}
/** Fixed actual readback projection, reusable by the preflight target guard.
 * None of these reads creates a proof by copying expected hashes. */
export async function inspectPrivatePreviewPair({ provider, prepared, versionId }) {
  const [worker, version, deployment, namespace, privacy, schedules] = await Promise.all([
    provider.worker(), provider.version(versionId), provider.deployment(versionId), provider.namespace(versionId), provider.privateInventory(), provider.schedules(),
  ]);
  if (!worker || !namespace.namespaceId) refuse();
  const container = await provider.container(namespace.namespaceId);
  const pair = preview.parsePair({ ...prepared.pair, workerVersion: versionId });
  // Exhaust the account inventory every time, but bind only this Worker's
  // absence from it. Unrelated new domains/routes/zones cannot strand a pair.
  const ingress = { private: true, subdomain: privacy.subdomain, routes: [], domains: [] };
  return { pair, evidence: { worker, version, deployment, namespace, privacy, schedules, container },
    installedTargetDigest: previewProviderDigest({ pair, worker, version, deployment, namespace, ingress, schedules, container }) };
}
/** BUILD-only inert operator. Explicit invocation is required. Each provider
 * effect is journaled before dispatch, and ambiguous retries observe only the
 * original attempt. This operator never selects NEW or pauses/stops OLD. */
export async function installPrivatePreviewPair({ firestore, prepared, request: raw, readToken, readSecret,
  fetchImpl = fetch, signal, clock = Date.now, dryRun = true }) {
  const request = parseRequest(raw, prepared);
  // Resource ownership survives unrelated live releases. Runtime, candidate
  // and bootstrap authority are renewable requests, never provider identity.
  const plan = { operationId: request.operationId, prepared: { pair: prepared.pair, accountId: prepared.accountId, applicationName: prepared.applicationName,
    image: prepared.image, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest } };
  const planDigest = previewProviderDigest(plan);
  const provider = createPrivatePreviewPairProvider({ prepared, operationDigest: planDigest, readToken, readSecret, fetchImpl, signal });
  if (dryRun) return { dryRun: true, planDigest, plan };
  if (!prepared.rendererReady) throw new PreviewProviderError("renderer-disabled-in-sealed-version");
  const ledger = privateInstallLedger(firestore), resultRef = firestore.doc(`cmsPreviewPrivateInstalls/${request.operationId}`);
  const original = (await resultRef.get()).data();
  if (original) {
    same(original.plan, plan); same(original.planDigest, planDigest);
    const qualification = await qualifyPrivatePreviewPair({ firestore, prepared, resourceOperationId: request.operationId,
      request, readToken, readSecret, fetchImpl, signal, clock });
    return { resource: original, qualification };
  }
  const current = () => firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [root, billing] = await transaction.getAll(firestore.doc(preview.SELECTOR_PATH), firestore.doc("system/billing"));
    if (billing.data()?.disabled === true || preview.digest(candidateAuthority.previewRuntimeIdentity(root.data())) !== request.expectedRuntimeDigest) refuse();
  }, { readOnly: true });
  await current();
  await ledger.bindAttempt(request.operationId, planDigest);
  const step = async (action, effect, observe) => {
    await current(); signal?.throwIfAborted();
    return ledger.once({ attemptId: request.operationId, worker: prepared.applicationName, planDigest, action, effect, observe });
  };
  // Do not adopt an existing Worker, Container or namespace merely by name.
  // A prior immutable ownership claim is required before recovery is possible.
  const ownerKey = publicPairs.publicReleaseDigest({ worker: prepared.applicationName });
  const priorOwner = (await firestore.doc(`system/publicReleasePrivateInstalls/workers/${ownerKey}`).get()).data();
  const inventory = await provider.inventory();
  if (!priorOwner && (inventory.worker || inventory.applications.length || inventory.namespaces.length)) refuse();
  if (priorOwner) same(priorOwner, { schemaVersion: 1, attemptId: request.operationId, worker: prepared.applicationName, planDigest });
  const identity = await step("identity", () => provider.createIdentity(), async () => { const value = await provider.worker(); if (!value) refuse(); return value; });
  const uploaded = await step("version", () => provider.upload(), () => provider.recoverVersion());
  const deployed = await step("deployment", () => provider.deploy(uploaded.versionId), () => provider.deployment(uploaded.versionId));
  const namespace = await provider.namespace(uploaded.versionId);
  await step("container", () => provider.createContainer(namespace.namespaceId), () => provider.container(namespace.namespaceId));
  await step("schedule", () => provider.createSchedules(), () => provider.schedules());
  const observed = await inspectPrivatePreviewPair({ provider, prepared, versionId: uploaded.versionId });
  same(observed.evidence.worker, identity); same(observed.evidence.deployment, deployed);
  await current();
  await preview.registerPair(firestore, observed.pair);
  const resource = { schemaVersion: 1, plan, planDigest, pair: observed.pair, installedTargetDigest: observed.installedTargetDigest,
    providerEvidence: observed.evidence, completedAt: new Date(clock()).toISOString() };
  await firestore.runTransaction(async transaction => {
    const row = await transaction.get(resultRef);
    if (row.exists) { same(row.data(), resource); return; }
    signal?.throwIfAborted(); transaction.create(resultRef, resource);
  });
  const qualification = await qualifyPrivatePreviewPair({ firestore, prepared, resourceOperationId: request.operationId,
    request, readToken, readSecret, fetchImpl, signal, clock });
  return { resource, qualification };
}

/** Explicit fresh proof for the same installed resources, never a provider
 * mutation retry. A new request/operation/candidate receipt is required after
 * expiry or a lost health reply; original provider ownership stays unchanged. */
export async function qualifyPrivatePreviewPair({ firestore, prepared, resourceOperationId, request: raw, readToken,
  readSecret, fetchImpl = fetch, signal, clock = Date.now }) {
  const request = parseRequest(raw, prepared);
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(resourceOperationId)) refuse();
  const resource = (await firestore.doc(`cmsPreviewPrivateInstalls/${resourceOperationId}`).get()).data();
  if (resource?.schemaVersion !== 1 || resource.planDigest !== previewProviderDigest(resource.plan) ||
      resource.plan.operationId !== resourceOperationId) refuse();
  const provider = createPrivatePreviewPairProvider({ prepared, operationDigest: resource.planDigest, readToken, readSecret, fetchImpl, signal });
  same(resource.plan.prepared, { pair: prepared.pair, accountId: prepared.accountId, applicationName: prepared.applicationName,
    image: prepared.image, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest });
  const observed = await inspectPrivatePreviewPair({ provider, prepared, versionId: resource.pair.workerVersion });
  same(observed.pair, resource.pair); same(observed.installedTargetDigest, resource.installedTargetDigest);
  const workerKey = publicPairs.publicReleaseDigest({ worker: prepared.applicationName });
  const expectedSteps = { identity: observed.evidence.worker, version: observed.evidence.version, deployment: observed.evidence.deployment,
    container: observed.evidence.container, schedule: observed.evidence.schedules };
  const assertResourcesCurrent = async () => {
    const [owner, binding] = await firestore.getAll(firestore.doc(`system/publicReleasePrivateInstalls/workers/${workerKey}`),
      firestore.doc(`system/publicReleasePrivateInstalls/plans/${resourceOperationId}`));
    same(owner.data(), { schemaVersion: 1, attemptId: resourceOperationId, worker: prepared.applicationName, planDigest: resource.planDigest });
    same(binding.data(), { schemaVersion: 1, attemptId: resourceOperationId, planDigest: resource.planDigest });
    const fresh = await inspectPrivatePreviewPair({ provider, prepared, versionId: resource.pair.workerVersion });
    same(fresh.installedTargetDigest, resource.installedTargetDigest);
    for (const [action, result] of Object.entries(expectedSteps)) {
      const base = `system/publicReleasePrivateInstalls/attempts/${resourceOperationId}`;
      const [claim, receipt] = await firestore.getAll(firestore.doc(`${base}/steps/${workerKey}-${action}`), firestore.doc(`${base}/readbacks/${workerKey}-${action}`));
      const seal = { schemaVersion: 1, attemptId: resourceOperationId, worker: prepared.applicationName, planDigest: resource.planDigest, action };
      same(claim.data(), seal); same(receipt.data(), { ...seal, result });
    }
    same((await firestore.doc(`${preview.PAIRS}/${prepared.pair.pairId}`).get()).data(), observed.pair);
    return fresh.installedTargetDigest;
  };
  await assertResourcesCurrent();
  const requestDigest = previewProviderDigest({ resourceOperationId, request });
  const resultRef = firestore.doc(`cmsPreviewPrivateHealth/${request.operationId}`), prior = (await resultRef.get()).data();
  if (prior) { same(prior.requestDigest, requestDigest); return prior; }
  const current = () => firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [root, billing] = await transaction.getAll(firestore.doc(preview.SELECTOR_PATH), firestore.doc("system/billing"));
    if (billing.data()?.disabled === true || preview.digest(candidateAuthority.previewRuntimeIdentity(root.data())) !== request.expectedRuntimeDigest) refuse();
  }, { readOnly: true });
  await current();
  const component = { ...request.candidate, component: "renderer" };
  const stored = await startCandidateReceipt(firestore, component);
  const collect = async () => {
    await assertResourcesCurrent();
    const { pair, evidence } = observed;
    return { pairId: pair.pairId, rendererSha: pair.rendererSha, serializerId: pair.serializerId, workerName: pair.workerName,
      applicationName: pair.applicationName, workerVersion: pair.workerVersion, imageDigest: pair.imageDigest,
      applicationId: evidence.container.applicationId, workerDeploymentId: evidence.deployment.deploymentId,
      workerId: evidence.worker.workerId, namespaceId: evidence.namespace.namespaceId,
      bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest };
  };
  // A retry must not retime an existing candidate or invalidate its pointer.
  if (stored.state === "verified") same(stored.mutation.providerIdentities, await collect());
  else await verifyCandidateReceipt(firestore, component, { collect });
  await current();
  await candidateAuthority.recordPreviewPairCandidatePointer({ firestore, request: {
    operationId: request.operationId, pairId: prepared.pair.pairId, candidateReceiptId: `renderer-${request.candidate.runId}-${request.candidate.runAttempt}`,
    expectedPointerDigest: request.expectedCandidatePointerDigest, expectedRuntimeDigest: request.expectedRuntimeDigest,
    bootstrapPublicPair: request.bootstrapPublicPair,
  }, clock, signal });
  const preflight = createPrivatePairPreflightCaller({ firestore, plan: { schemaVersion: 1, operationId: request.operationId,
    kind: "preview", accountId: prepared.accountId, workerName: prepared.applicationName, workerVersion: resource.pair.workerVersion,
    identity: { pairId: prepared.pair.pairId, rendererSha: prepared.pair.rendererSha, serializerId: prepared.pair.serializerId },
    installedTargetDigest: observed.installedTargetDigest }, readToken, fetchImpl, signal, clock,
    assertTargetCurrent: assertResourcesCurrent });
  const health = await preflight({ pairId: prepared.pair.pairId, rendererSha: prepared.pair.rendererSha, serializerId: prepared.pair.serializerId });
  await current();
  const result = { schemaVersion: 1, resourceOperationId, request, requestDigest, pair: observed.pair,
    installedTargetDigest: observed.installedTargetDigest, health, completedAt: new Date(clock()).toISOString() };
  return firestore.runTransaction(async transaction => {
    const [row, root, billing] = await transaction.getAll(resultRef, firestore.doc(preview.SELECTOR_PATH), firestore.doc("system/billing"));
    if (row.exists) { same(row.data().requestDigest, requestDigest); return row.data(); }
    if (billing.data()?.disabled === true || preview.digest(candidateAuthority.previewRuntimeIdentity(root.data())) !== request.expectedRuntimeDigest) refuse();
    signal?.throwIfAborted(); transaction.create(resultRef, result); return result;
  });
}
