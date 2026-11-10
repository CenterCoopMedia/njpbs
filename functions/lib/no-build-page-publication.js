"use strict";

const { preparePublicReleaseProducerInTransaction, publicContentChange } = require("./public-release-producer");

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { assertPublicDeploymentPointer } = require("./public-deployment");
const { PUBLIC_PAGE_DEFINITIONS, publicPageDefinition, publicPagePath } = require("./public-page-contract");
const { readNoBuildFamilyAdmission, selectsNoBuildPage } = require("./no-build-family-admission");
const { validateNoBuildPageSnapshot } = require("./no-build-page-contract");
const { publiclyVisible } = require("./public-video-references");
const { pagePublicationTarget } = require("./no-build-page-target");
const { readCmsPublicationRuntimeControlInTransaction, assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");
const { readPublicContextRevisionInTransaction, publicContextDigest, bumpPublicContextRevision } = require("./public-context-revision");
const { readNoBuildPageOwner, readNoBuildPageCapability, effectiveNoBuildPageState,
  preparePageRouteClaimsInTransaction, assertNoBuildPageRouteAvailable, maxOwnedPagePaths, digest, refuse } = require("./no-build-page-ownership");

const TRANSPORT = "page-no-build-v1";
const selectsPagePublication = selectsNoBuildPage;
function pageAggregateOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(operationId)) refuse();
  return createHash("sha256").update(`page-context-v1:${operationId}`).digest("hex").slice(0, 20);
}
function defer(message) { throw Object.assign(new Error(message), { status: 409, scheduleDeferred: true }); }
async function pagePublicationSelected({ firestore, transaction, documentId, config }) {
  if (!publicPageDefinition(documentId)) return false;
  const owner = await readNoBuildPageOwner({ firestore, transaction, pageId: documentId });
  config ??= await readNoBuildFamilyAdmission({ firestore, transaction });
  return Boolean(owner.state || selectsPagePublication(config, documentId));
}
function pagePaths(pageId, plan, state, snapshot) {
  const paths = pageId === "home" ? ["/", "/_home-sources.json"] :
    [plan.path, ...plan.previousSlugs.map(slug => `/${slug}/`)];
  const definition = Object.hasOwn(PUBLIC_PAGE_DEFINITIONS, pageId) ? publicPageDefinition(pageId) : null;
  if (definition && pageId !== "home") {
    paths.push(definition.path, ...(definition.aliases ?? []));
    if (snapshot.metadata.slug) paths.push(`/${snapshot.metadata.slug}/`);
  }
  const ownedPaths = [...new Set([...(state?.ownedPaths ?? []), ...paths])];
  if (ownedPaths.length > maxOwnedPagePaths(pageId)) refuse("This Page has too many retained routes.");
  return ownedPaths;
}

// Ownership, admission and runtime fences decide the transport before any
// source preparation. A retained owner cannot become a serializer operation.
async function readPagePublicationAuthority({ firestore, transaction, documentId, nextDocument, config, target }) {
  const owner = await readNoBuildPageOwner({ firestore, transaction, pageId: documentId });
  config ??= await readNoBuildFamilyAdmission({ firestore, transaction });
  const owned = Boolean(owner.state);
  const visible = publiclyVisible(nextDocument);
  const withdrawal = owned && !visible;
  const selected = selectsPagePublication(config, documentId);
  if (documentId === "home" && !visible && (owned || selected)) {
    refuse("The homepage can't be unpublished. Edit, hide or reorder its sections instead.");
  }
  // Selection admits future publications. A removal before first acceptance
  // belongs to the existing publisher, including legacy snapshot formats.
  if (!owned && (!selected || !visible)) {
    const path = publicPagePath(documentId, nextDocument.published?.metadata);
    const aliases = Array.isArray(nextDocument.published?.metadata?.previousSlugs) ? nextDocument.published.metadata.previousSlugs : [];
    for (const candidatePath of [path, ...aliases.map(slug => `/${slug}/`)].filter(Boolean)) {
      await assertNoBuildPageRouteAvailable({ firestore, transaction, pageId: documentId, path: candidatePath });
    }
    return null;
  }
  if (owned && !withdrawal && !selected) refuse("Build-free publication no longer admits this owned Page.");
  target = pagePublicationTarget({ firestore, target });
  const capability = await readNoBuildPageCapability({ firestore, transaction });
  const state = effectiveNoBuildPageState(owner.state, capability);
  if (documentId === "data-hub" && capability?.dataHubReportingVersion !== 1) defer("The Data Hub publication gate is closed.");
  if (!capability || !capability.servingEnabled) defer("The public Page renderer is unavailable. Try this publication again shortly.");
  if (capability.terminalOwner?.schemaVersion !== 1 || capability.terminalOwner.transport !== TRANSPORT ||
      capability.terminalOwner.rendererSha !== capability.rendererSha) {
    defer("Page publication requires the serving, confirmation and recovery owner.");
  }
  if (!withdrawal && (!config.valid || !config.enabled)) defer("Build-free Page publication is paused.");
  const pointerRef = firestore.doc("system/publicDeployment");
  const pointer = assertPublicDeploymentPointer((await transaction.get(pointerRef)).data());
  if (pointer.state !== "idle" || pointer.activeCommitSha !== capability.rendererSha) {
    defer("A public code release is in progress. Try this publication again shortly.");
  }
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  assertCmsPublicationCloudAdmission(control, { commitSha: capability.rendererSha, serializerId: target.serializerId });
  return { owner, state, config, visible, withdrawal, capability, pointer, pointerRef, target };
}

/** Prepare under the content caller's transaction. Auth, draft version checks,
 * history and media usage stay with that caller; writes land together. */
async function prepareNoBuildPagePublication({ firestore, transaction, collection, documentId,
  nextDocument, queueRef, actor, config: admissionOverride, target, pageScheduleCapture, dependencyRefresh = false, electionResultsRefresh, videoReplacementRefresh, validationOnly = false }) {
  if (collection !== "cmsPages" || typeof documentId !== "string" || !publicPageDefinition(documentId)) return null;
  if (publiclyVisible(nextDocument)) await require("./page-reader-compatibility").assertInstalledPageReaders({
    firestore, transaction, pageId: documentId, blocks: nextDocument.published?.blocks });
  const authority = await readPagePublicationAuthority({ firestore, transaction, documentId, nextDocument,
    config: admissionOverride, target });
  if (!authority) return null;
  const { owner, state, config, visible, withdrawal, capability, pointer } = authority;
  target = authority.target;
  const previousDocument = (await transaction.get(firestore.doc(`cmsPages/${documentId}`))).data();
  if (videoReplacementRefresh) require("./source-video-replacement-publication").assertVideoReplacementRefresh(previousDocument, nextDocument, videoReplacementRefresh);
  if (dependencyRefresh) {
    require("./dataset-refresh-identity").assertSameSourceRefresh(previousDocument, nextDocument);
  }
  if (electionResultsRefresh) {
    require("./election-source-refresh").assertElectionSourceRefresh(previousDocument, nextDocument, electionResultsRefresh);
  }
  if (!dependencyRefresh && !electionResultsRefresh && !videoReplacementRefresh && (!Number.isSafeInteger(nextDocument.version) || nextDocument.version < 1 ||
      previousDocument && nextDocument.version <= previousDocument.version)) refuse("This Page changed during publication acceptance.");
  const snapshot = nextDocument.published;
  if (visible && !require("./election-results-compatibility").supportsElectionResults(snapshot, capability)) {
    refuse("The installed Page renderer does not support election results yet.");
  }
  if (snapshot?.metadata?.dataHubCompositionVersion === 1 && capability?.dataHubCompositionVersion !== 1) {
    defer("The installed Page renderer does not support Data Hub composition yet.");
  }
  if (visible && require("./data-figure-compatibility").containsVisibleDataFigure(snapshot) &&
      !require("./data-figure-compatibility").supportsDataFigures(capability)) {
    refuse("The installed Page renderer does not support data figures yet.");
  }
  const plan = validateNoBuildPageSnapshot({ pageId: documentId, snapshot });
  if (visible && !dependencyRefresh && !electionResultsRefresh && !videoReplacementRefresh && snapshot.sourceVersion !== nextDocument.version) refuse("The published Page source does not match its saved version.");
  const snapshotDigest = digest(snapshot);
  if (withdrawal && (snapshotDigest !== owner.state.snapshotDigest || snapshot.sourceVersion !== owner.state.sourceVersion)) {
    refuse("The retained Page snapshot changed before removal.");
  }
  if (visible) {
    // The context owner reads only published inputs and exact media in this
    // transaction. Withdrawals need no dependency to remain publicly present.
    await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({
      firestore, transaction, pageId: documentId, nextDocument, rendererSha: capability.rendererSha,
      now: new Date(snapshot.publishedAt), target, scheduleCapture: pageScheduleCapture });
  }
  const ownedPaths = pagePaths(documentId, plan, state, snapshot);
  const writeRoutes = await preparePageRouteClaimsInTransaction({ firestore, transaction, pageId: documentId, ownedPaths });
  const contextRevision = await readPublicContextRevisionInTransaction(transaction, firestore);
  if (!Number.isSafeInteger(contextRevision + 1)) refuse("Public context identity is exhausted.");
  if (!/^[A-Za-z0-9]{20}$/.test(queueRef?.id ?? "") || queueRef.path !== `cmsPublishQueue/${queueRef.id}`) refuse();
  const previousQueueRef = state?.operationId ? firestore.doc(`cmsPublishQueue/${state.operationId}`) : null;
  const previousQueue = previousQueueRef ? (await transaction.get(previousQueueRef)).data() : null;
  if (previousQueueRef && (previousQueue?.transport !== TRANSPORT ||
      previousQueue.noBuildPage?.operationId !== state.operationId || previousQueue.noBuildPage.pageId !== documentId ||
      previousQueue.noBuildPage.sourceVersion !== owner.state.sourceVersion ||
      previousQueue.noBuildPage.snapshotDigest !== owner.state.snapshotDigest ||
      previousQueue.backgroundRuntime?.owner !== owner.state.runtime.owner ||
      previousQueue.backgroundRuntime?.release !== owner.state.runtime.release)) refuse();
  const generation = Math.max(pointer.lastReservedGeneration, state?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) refuse();
  const runtime = { owner: "cloudflare", release: capability.rendererSha };
  const contentRedirectUrl = snapshot.metadata?.contentLinkMode === "custom" ? new URL(snapshot.metadata.contentLinkUrl).href : null;
  if (contentRedirectUrl && require("./content-link").contentLinkError(snapshot.metadata)) refuse("The custom content URL is invalid.");
  const operation = { schemaVersion: 1,
    ...(contentRedirectUrl || state?.contentRedirectUrl !== undefined ? { contentRedirectUrl } : {}), pageId: documentId, operationId: queueRef.id,
    sourceVersion: snapshot.sourceVersion, path: plan.path, ownedPaths, visible,
    rendererSha: capability.rendererSha, generation, snapshotDigest,
    ...(snapshot.datasetFigures ? { datasetFiguresDigest: require("./dataset-dependencies").digest(snapshot.datasetFigures) } : {}),
    admissionRevision: config.admissionRevision ?? state?.admissionRevision ?? null,
    contextRevision: contextRevision + 1, contextDigest: publicContextDigest(contextRevision + 1) };
  const contextWork = await require("./public-context-publication").enqueuePublicContextInTransaction({
    firestore, transaction, operationId: pageAggregateOperationId(queueRef.id), runtime,
    reason: "context", contextRevision: operation.contextRevision });
  operation.contextQueueId = contextWork.queueId;
  const homePlan = documentId === "home" ? await require("./no-build-home-ownership").prepareHomePlanInTransaction({
    firestore, transaction, nextDocument, operation, runtime }) : null;
  if (documentId === "home" && !homePlan) refuse("Home route ownership is not ready for transfer.");
  const change = { collection, id: documentId, sourceVersion: snapshot.sourceVersion,
    ...(visible ? {} : { operation: "withdraw" }) };
  const queue = { backgroundRuntime: runtime, status: "pending", transport: TRANSPORT,
    triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null,
    triggeredAt: FieldValue.serverTimestamp(), completedAt: null, error: null,
    changes: [change], noBuildPage: operation, contextPublication: {
      queueId: contextWork.queueId, contextRevision: contextWork.contextRevision,
      contextDigest: contextWork.contextDigest, outputs: contextWork.outputs,
    }, nextAttemptAt: 0, attempts: 0, claim: null };
  const nextOwner = { ...owner.state, ...operation, servingEnabled: capability.servingEnabled, runtime,
    ...(!visible ? { durableWithdrawal: { schemaVersion: 1, pageId: documentId, operationId: operation.operationId,
      sourceVersion: operation.sourceVersion, revision: operation.generation, ownedPaths: operation.ownedPaths,
      snapshotDigest, contextRevision: operation.contextRevision } } : {}) };
  if (!operation.datasetFiguresDigest) delete nextOwner.datasetFiguresDigest;
  const releaseChange = publicContentChange(collection, documentId, nextDocument, visible, { path: owner.ref.path, data: nextOwner });
  if (homePlan) releaseChange.sourceDocuments.push(homePlan.background);
  const writeReleaseChange = validationOnly ? () => {} : await preparePublicReleaseProducerInTransaction({ firestore, transaction,
    operationId: queueRef.id, contextRevision: operation.contextRevision, changes: [releaseChange] });
  return { transport: TRANSPORT, operation, requiresPrimaryAdmission: false, queueId: queueRef.id, contentQueueId: queueRef.id,
    affectedHomeSections: [], warnings: [], homeFullBuildQueueId: null,
    write() {
      writeReleaseChange();
      if (visible && ["schedule", "live"].includes(documentId)) {
        require("./no-build-page-schedule-reader").assertPageScheduleCapture({
          firestore, target, rendererSha: capability.rendererSha, capture: pageScheduleCapture });
      }
      if (previousQueue && !["success", "cancelled"].includes(previousQueue.status)) {
        transaction.update(previousQueueRef, { status: "cancelled", completedAt: FieldValue.serverTimestamp(),
          claim: null, nextAttemptAt: null, error: "Superseded by a newer Page publication" });
      }
      transaction.create(queueRef, queue);
      transaction.set(owner.ref, nextOwner);
      writeRoutes();
      homePlan?.write();
      contextWork.write();
      bumpPublicContextRevision(transaction, firestore, { withdrawal: !visible, homePublication: documentId === "home" });
    } };
}

async function assertNoBuildPageScheduleInTransaction({ firestore, transaction, collection, documentId, nextDocument, target, pageScheduleCapture }) {
  if (collection !== "cmsPages" || !publicPageDefinition(documentId)) return;
  if (!await pagePublicationSelected({ firestore, transaction, documentId })) return;
  const prepared = await prepareNoBuildPagePublication({ firestore, transaction, collection, documentId,
    nextDocument: { ...nextDocument, version: nextDocument.published?.sourceVersion, status: "published", publiclyVisible: true },
    queueRef: firestore.collection("cmsPublishQueue").doc(), actor: { uid: "system:scheduler" }, target, pageScheduleCapture, validationOnly: true });
  return prepared?.transport;
}
/** Called by an authorized publish/schedule caller before its write transaction.
 * Selection is repeated at acceptance; a changed selection cannot mint work. */
async function capturePageScheduleForPublication({ firestore, collection, documentId, publishing, config,
  target, currentCodeRequest, releaseSelector, scheduledCandidate = false, now = Date.now, deadline = now() + 45_000 }) {
  if (!publishing || collection !== "cmsPages" || !["schedule", "live"].includes(documentId)) return undefined;
  target = pagePublicationTarget({ firestore, target });
  if (releaseSelector === undefined && !await pagePublicationSelected({ firestore, documentId, config })) return undefined;
  const capability = await readNoBuildPageCapability({ firestore });
  if (!capability?.servingEnabled || capability.terminalOwner?.transport !== TRANSPORT ||
      capability.terminalOwner.rendererSha !== capability.rendererSha) defer("The qualified Page terminal is unavailable.");
  const schedules = require("./no-build-page-schedule-reader");
  try {
    return await schedules.capturePageSchedule({ firestore, target,
      rendererSha: capability.rendererSha, request: currentCodeRequest, now, deadline,
      ...(releaseSelector !== undefined ? { releaseSelector } : {}) });
  } catch (error) {
    if (scheduledCandidate && schedules.isPageScheduleAvailabilityError(error)) defer(error.message);
    throw error;
  }
}

module.exports = { pagePaths, preparePairPagePublication: options => require("./public-release-family-admission").preparePairContentPublication({
  ...options, collection: "cmsPages", kind: "page", family: "pages" }),
  capturePageScheduleForPublication, TRANSPORT, pageAggregateOperationId, pagePublicationSelected, prepareNoBuildPagePublication, assertNoBuildPageScheduleInTransaction };
