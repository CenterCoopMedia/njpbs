"use strict";

const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const pointerOwner = require("./public-deployment-pointer");
const runtimeOwner = require("./cms-publication-runtime-control");
const adoption = require("./public-release-bootstrap-adoption");
const pauseOwner = require("./dev-public-release-pause");

const ROOT = "system/devPreviewRendererBootstrap";
const PREVIEW = "system/cmsPreviewRuntime";
const COMPONENT = "cmsDeploymentReceipts/renderer";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const imageAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const IMAGE = /^[a-f0-9]{32}$/.test(imageAccount)
  ? new RegExp("^registry\\.cloudflare\\.com/" + imageAccount + "/template-dev-cms-preview-renderer@sha256:[a-f0-9]{64}$")
  : /a^/;
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
const refuse = () => { throw new Error("Development renderer bootstrap refused; preserve its original receipt"); };
function database(firestore) { if (firestore?.projectId !== "njpbs-site-dev") refuse(); }
function pausedPreview(value) {
  if (value?.schemaVersion !== 1 || value.phase !== "paused" || !/^[a-f0-9]{40}$/.test(value.rendererSha ?? "") ||
      value.serializerId !== "cloudflare-preview") refuse();
  return value;
}
const replacement = attempt => ({ schemaVersion: 1, phase: "paused", rendererSha: attempt.rendererSha, serializerId: "cloudflare-preview" });

async function state(firestore, transaction, rendererSha) {
  const paths = ["system/publicDeployment", "system/cmsPublicationRuntime", PREVIEW, COMPONENT,
    "system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog",
    "system/publicDeployment/contexts/public"];
  const rows = await transaction.getAll(...paths.map(path => firestore.doc(path)));
  const pointer = pointerOwner.assertPublicDeploymentPointer(rows[0].data());
  const runtime = runtimeOwner.parseCmsPublicationRuntimeControl(rows[1].data());
  const cloud = runtimeOwner.cloudCmsPublicationRuntimeControl(runtime);
  if (pointer.schemaVersion !== 1 || pointer.state !== "idle" || pointer.activeCommitSha !== rendererSha ||
      pointer.activeGeneration < 1 || pointer.mediaLifecycleReady !== true ||
      pointer.lastReservedGeneration !== pointer.activeGeneration || pointer.newestEligibleGeneration !== pointer.activeGeneration ||
      runtime.phase !== "paused" || cloud.phase !== "paused" || runtime.commitSha !== rendererSha ||
      cloud.commitSha !== rendererSha || cloud.serializerId !== "cloudflare-dev-publisher" ||
      rows.slice(4, 7).some(row => row.exists) || !rows[7].exists) refuse();
  const fence = await adoption.assertClosedBootstrapFenceInTransaction({ firestore, transaction,
    environment: "development", before: pointer });
  const preview = pausedPreview(rows[2].data());
  const drain = await pauseOwner.assertDevPublicReleaseDrainInTransaction({ firestore, transaction, operationId: fence.operationId });
  return { rendererSha, bootstrapOperationId: fence.operationId,
    publicDigest: p.publicReleaseDigest({ pointer: rows[0].data(), runtime: rows[1].data(), fence, context: rows[7].data(), drain }),
    preview, component: rows[3].exists ? rows[3].data() : null };
}

async function inspectDevPreviewBootstrap({ firestore, rendererSha }) {
  database(firestore);
  return firestore.runTransaction(async transaction => {
    if ((await transaction.get(firestore.doc(ROOT))).exists) refuse();
    return state(firestore, transaction, rendererSha);
  }, { readOnly: true });
}

function parseAttempt(attempt) {
  if (attempt?.schemaVersion !== 1 || !/^dev-renderer-[1-9][0-9]*$/.test(attempt.operationId ?? "") ||
      !/^[a-f0-9]{40}$/.test(attempt.rendererSha ?? "") || !/^[a-f0-9]{40}$/.test(attempt.operatorCommitSha ?? "") ||
      !p.digest(attempt.publicDigest) || !pointerOwner.isPublicDeploymentIdentifier(attempt.bootstrapOperationId) ||
      !Number.isFinite(Date.parse(attempt.startedAt)) || attempt.provenance?.rendererSha !== attempt.rendererSha ||
      attempt.provenance?.operatorCommitSha !== attempt.operatorCommitSha ||
      !/^[a-f0-9]{40}$/.test(attempt.provenance?.rendererTree ?? "") || !p.digest(attempt.provenance?.workerSourceDigest)) refuse();
  pausedPreview(attempt.prior?.preview);
  const prior = attempt.prior;
  if (prior.provider?.rendererSha !== prior.preview.rendererSha || prior.provider?.serializerId !== "cloudflare-preview" ||
      prior.provider?.worker !== "template-dev-cms-preview-renderer" || !p.digest(prior.provider?.imageFingerprint) ||
      ![prior.provider.applicationId, prior.provider.workerVersionId, prior.provider.workerDeploymentId].every(value => UUID.test(value ?? "")) ||
      !IMAGE.test(prior.image ?? "") || prior.component?.schemaVersion !== 1 || prior.component.environment !== "development" ||
      prior.component.projectId !== "njpbs-site-dev" || prior.component.state !== "complete" ||
      prior.component.sourceSha !== prior.preview.rendererSha) refuse();
  return p.freeze(attempt);
}

async function claimDevPreviewBootstrap({ firestore, attempt: raw }) {
  database(firestore); const attempt = parseAttempt(raw);
  return firestore.runTransaction(async transaction => {
    const saved = await transaction.get(firestore.doc(ROOT));
    if (saved.exists) refuse();
    const current = await state(firestore, transaction, attempt.rendererSha);
    if (current.publicDigest !== attempt.publicDigest || current.bootstrapOperationId !== attempt.bootstrapOperationId ||
        !same(current.preview, attempt.prior.preview) || !same(current.component, attempt.prior.component)) refuse();
    const row = { schemaVersion: 1, kind: "development-preview-renderer-bootstrap", attempt,
      attemptDigest: p.publicReleaseDigest(attempt), status: "claimed" };
    transaction.create(firestore.doc(ROOT), row);
    return row;
  });
}

function original(row, expectedDigest) {
  if (!row.exists) refuse();
  const value = row.data();
  if (value?.schemaVersion !== 1 || value.kind !== "development-preview-renderer-bootstrap" ||
      !["claimed", "failed", "committed-paused", "restored-paused"].includes(value.status)) refuse();
  parseAttempt(value.attempt);
  if (value.attemptDigest !== p.publicReleaseDigest(value.attempt) ||
      expectedDigest !== undefined && value.attemptDigest !== expectedDigest) refuse();
  if (value.recoveryProvider !== undefined || value.recoveryProviderDigest !== undefined) {
    providerReceipt(value.attempt, value.recoveryProvider, "committed-paused");
    if (value.recoveryProviderDigest !== p.publicReleaseDigest(value.recoveryProvider)) refuse();
  }
  return value;
}

async function guardedState(firestore, transaction, attemptDigest) {
  const saved = original(await transaction.get(firestore.doc(ROOT)), attemptDigest);
  const current = await state(firestore, transaction, saved.attempt.rendererSha);
  if (current.publicDigest !== saved.attempt.publicDigest || current.bootstrapOperationId !== saved.attempt.bootstrapOperationId ||
      ![saved.attempt.prior.preview, replacement(saved.attempt)].some(value => same(current.preview, value))) refuse();
  if (["committed-paused", "restored-paused"].includes(saved.status)) {
    const expected = saved.status === "committed-paused" ? replacement(saved.attempt) : saved.attempt.prior.preview;
    if (!same(current.preview, expected) || !same(current.component, saved.receipt)) refuse();
  } else if (!["claimed", "failed"].includes(saved.status) || !same(current.component, saved.attempt.prior.component)) refuse();
  return saved;
}
async function guardDevPreviewBootstrap({ firestore, attemptDigest }) {
  database(firestore);
  return firestore.runTransaction(transaction => guardedState(firestore, transaction, attemptDigest), { readOnly: true });
}

/** Seal the actual partial image before any restore can change Worker identity. */
async function bindDevPreviewBootstrapRecovery({ firestore, attemptDigest, provider }) {
  database(firestore);
  return firestore.runTransaction(async transaction => {
    const saved = await guardedState(firestore, transaction, attemptDigest);
    if (!["claimed", "failed"].includes(saved.status)) refuse();
    providerReceipt(saved.attempt, provider, "committed-paused");
    if (saved.recoveryProvider !== undefined) {
      if (!same(saved.recoveryProvider, provider)) refuse();
      return saved;
    }
    const result = { ...saved, recoveryProvider: provider, recoveryProviderDigest: p.publicReleaseDigest(provider) };
    transaction.set(firestore.doc(ROOT), result);
    return result;
  });
}

function providerReceipt(attempt, provider, stateName) {
  const sourceSha = stateName === "restored-paused" ? attempt.prior.preview.rendererSha : attempt.rendererSha;
  if (provider?.worker !== "template-dev-cms-preview-renderer" || provider.rendererSha !== sourceSha ||
      provider.serializerId !== "cloudflare-preview" || !p.digest(provider.imageFingerprint) || provider.enabled !== false ||
      provider.imageState !== "configured" || provider.operationId !== attempt.operationId ||
      provider.applicationId !== attempt.prior.provider.applicationId ||
      ![provider.workerVersionId, provider.workerDeploymentId].every(value => UUID.test(value ?? "")) || !IMAGE.test(provider.image ?? "") ||
      provider.imageFingerprint !== createHash("sha256").update(JSON.stringify({ image: provider.image, digest: null })).digest("hex") ||
      stateName === "restored-paused" && provider.image !== attempt.prior.image) refuse();
  return { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev",
    state: "bootstrap-paused", sourceSha,
    releaseStartedAt: stateName === "restored-paused" ? attempt.prior.component.releaseStartedAt : attempt.startedAt, provider,
    verificationMode: "provider-and-paused-control", operationId: attempt.operationId };
}

async function finishDevPreviewBootstrap({ firestore, attemptDigest, provider, restore = false }) {
  database(firestore);
  return firestore.runTransaction(async transaction => {
    const saved = original(await transaction.get(firestore.doc(ROOT)), attemptDigest);
    const current = await state(firestore, transaction, saved.attempt.rendererSha);
    if (current.publicDigest !== saved.attempt.publicDigest || current.bootstrapOperationId !== saved.attempt.bootstrapOperationId) refuse();
    const nextStatus = restore ? "restored-paused" : "committed-paused";
    const receipt = providerReceipt(saved.attempt, provider, nextStatus);
    const nextPreview = restore ? saved.attempt.prior.preview : replacement(saved.attempt);
    if (saved.status === nextStatus) {
      if (!same(saved.receipt, receipt) || !same(current.preview, nextPreview) || !same(current.component, receipt)) refuse();
      return saved;
    }
    if (!["claimed", "failed", ...(restore ? ["committed-paused"] : [])].includes(saved.status) ||
        ![saved.attempt.prior.preview, replacement(saved.attempt)].some(value => same(current.preview, value)) ||
        ![saved.attempt.prior.component, saved.receipt].filter(Boolean).some(value => same(current.component, value))) refuse();
    transaction.set(firestore.doc(PREVIEW), nextPreview);
    transaction.set(firestore.doc(COMPONENT), receipt);
    const result = { ...saved, status: nextStatus, receipt };
    transaction.set(firestore.doc(ROOT), result);
    return result;
  });
}

async function failDevPreviewBootstrap({ firestore, attemptDigest, phase }) {
  database(firestore);
  if (!/^[a-z-]{1,64}$/.test(phase ?? "")) refuse();
  return firestore.runTransaction(async transaction => {
    const saved = original(await transaction.get(firestore.doc(ROOT)), attemptDigest);
    if (saved.status !== "claimed") return saved;
    const result = { ...saved, status: "failed", failedPhase: phase };
    transaction.set(firestore.doc(ROOT), result);
    return result;
  });
}

module.exports = { ROOT, PREVIEW, COMPONENT, inspectDevPreviewBootstrap, claimDevPreviewBootstrap,
  guardDevPreviewBootstrap, bindDevPreviewBootstrapRecovery, finishDevPreviewBootstrap, failDevPreviewBootstrap };
