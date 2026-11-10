"use strict";

const { listNoBuildPageOwners, readNoBuildPageOwner, readNoBuildPageCapability,
  effectiveNoBuildPageState, assertPageOwnerSnapshot, pageRouteRef, refuse } = require("./no-build-page-ownership");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { readPublicContextInTransaction } = require("./public-context-revision");
const { pagePublicationTarget } = require("./no-build-page-target");

async function readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha, target }) {
  pagePublicationTarget({ firestore, target });
  if (state.pageId === "home" && state.visible !== true) refuse("Home cannot be unpublished.");
  const capability = await readNoBuildPageCapability({ firestore, transaction });
  const effective = effectiveNoBuildPageState(state, capability);
  if (state.pageId === "data-hub" && capability?.dataHubReportingVersion !== 1) refuse("The Data Hub publication gate is closed.");
  const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  if (!capability || pointer?.state !== "idle" || !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 1 || effective.rendererSha !== rendererSha ||
      pointer.activeCommitSha !== rendererSha) refuse("Public Page authority is unavailable.");
  const document = (await transaction.get(firestore.doc(`cmsPages/${state.pageId}`))).data();
  assertPageOwnerSnapshot(state, document);
  if (document?.published?.metadata?.dataHubCompositionVersion === 1 && capability?.dataHubCompositionVersion !== 1) {
    refuse("The installed Page renderer does not support Data Hub composition.");
  }
  const claims = await transaction.getAll(...state.ownedPaths.map(path => pageRouteRef(firestore, path)));
  for (const [index, path] of state.ownedPaths.entries()) {
    const claim = claims[index].data();
    if (claim?.schemaVersion !== 1 || claim.pageId !== state.pageId || claim.path !== path) refuse();
  }
  const admission = await readNoBuildFamilyAdmission({ firestore, transaction });
  const contextDigest = await readPublicContextInTransaction(transaction, firestore);
  if (state.visible && (!admission.valid || !effective.servingEnabled)) refuse();
  return { document, effective, admission, contextDigest, codeGeneration: pointer.activeGeneration };
}

/** An accepted route retains authority when admission is paused or unselected.
 * Only authoritative absence is a pass. Refusal leaves any Worker Assets
 * fallback unconfirmed; it cannot manufacture a publication receipt. */
async function readNoBuildPageDecision({ firestore, path, rendererSha, target, currentCodeRequest, scheduleCapture, readScheduledDecision, legacyStaffServing = false }) {
  target = pagePublicationTarget({ firestore, target });
  const schedules = require("./no-build-page-schedule-reader");
  if (schedules.isPageScheduleExportPath(path)) return schedules.readNoBuildPageScheduleExport({ firestore, path, rendererSha, target, currentCodeRequest, scheduleCapture });
  if (typeof path !== "string" || path.length > 512 || /[%?#\\]/.test(path) ||
      !/^(?:\/|\/_home-sources\.json|\/[^/]+\/)$/.test(path) || !/^[a-f0-9]{40}$/.test(rendererSha ?? "")) refuse();
  const read = () => firestore.runTransaction(transaction => readNoBuildPageDecisionInTransaction({
    firestore, transaction, path, rendererSha, target, scheduleCapture, legacyStaffServing }), { readOnly: true });
  try { return await read(); }
  catch (error) {
    if (!(error instanceof schedules.PageScheduleCaptureRequired)) throw error;
    try {
      scheduleCapture = await schedules.capturePageSchedule({ firestore, target, rendererSha, request: currentCodeRequest });
      if (readScheduledDecision) return await readScheduledDecision({ capture: scheduleCapture, read });
      return await read();
    } catch (captureError) {
      captureError.pageScheduleId = error.pageId;
      throw captureError;
    }
  }
}

async function readNoBuildPageDecisionInTransaction({ firestore, transaction, path, rendererSha, target, scheduleCapture, legacyStaffServing = false }) {
  const schedules = require("./no-build-page-schedule-reader");
  const route = (await transaction.get(pageRouteRef(firestore, path))).data();
  if (!route) {
    if ((await listNoBuildPageOwners({ firestore, transaction, path })).length) refuse();
    const decision = await require("./no-build-page-context-decision").readNoBuildPageContextDecision({
      firestore, transaction, path: path === "/_home-sources.json" ? "/" : path, rendererSha, target, scheduleCapture, requestScheduleCapture: true, legacyStaffServing });
    if (decision.kind === "pass") return decision;
    const { receipt, ...context } = decision;
    return { ...context, contextReceipt: receipt,
      ...(path === "/_home-sources.json" && decision.kind === "context-page" ? { kind: "context-home-sources" } : {}) };
  }
  if (route.schemaVersion !== 1 || route.path !== path) refuse();
  const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: route.pageId });
  if (!state || !state.ownedPaths.includes(path)) refuse();
  const authority = await readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha, target });
  const receipt = { schemaVersion: 1, pageId: state.pageId, operationId: state.operationId,
    sourceVersion: state.sourceVersion, snapshotDigest: state.snapshotDigest, path: state.path,
    ...(state.datasetFiguresDigest ? { datasetFiguresDigest: state.datasetFiguresDigest } : {}),
    ownedPaths: state.ownedPaths, visible: state.visible, rendererSha,
    generation: authority.effective.generation, operationGeneration: state.generation,
    codeGeneration: authority.codeGeneration, contextDigest: authority.contextDigest,
    ...(state.pageId === "home" ? { homeRefreshRevision: state.homeRefresh?.revision ?? 0 } : {}),
    admissionRevision: authority.admission.admissionRevision };
  if (!state.visible) return { kind: "gone", receipt };
  if (["schedule", "live"].includes(state.pageId)) {
    if (!scheduleCapture) throw new schedules.PageScheduleCaptureRequired(state.pageId);
    await schedules.readCapturedPageScheduleInTransaction({ firestore, transaction, target, rendererSha, capture: scheduleCapture });
  }
  if (path !== state.path && path !== "/_home-sources.json") return { kind: "alias", location: state.path, receipt };
  const published = await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({ firestore, transaction,
    pageId: state.pageId, rendererSha, nextDocument: authority.document, target, scheduleCapture, legacyStaffServing });
  // Home retained provider bytes have a separate owner; that owner supplies
  // their sealed snapshot before this decision can serve either Home output.
  if (state.pageId === "home") {
    const home = await require("./no-build-home-ownership").readHomeSourcesInTransaction({
      firestore, transaction, state, rendererSha, target });
    return { kind: path === "/_home-sources.json" ? "home-sources" : "page", receipt, published, ...home,
      publication: home.publication ?? { buildBatchId: state.operationId,
        generation: Math.max(state.generation, authority.codeGeneration), commitSha: rendererSha } };
  }
  return { kind: "page", receipt, published };
}

/** Schema two has its own retained-epoch/current-snapshot authority. It never
 * relaxes the legacy active-renderer guard above. */
async function readPairAwarePageDecision(input) {
  return require("./public-release-serving").readPublicReleaseDecision(input);
}
module.exports = { readNoBuildPageDecision, readNoBuildPageDecisionInTransaction, readPageAuthorityInTransaction, readPairAwarePageDecision };
