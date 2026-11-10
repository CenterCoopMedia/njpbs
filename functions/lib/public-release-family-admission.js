"use strict";
// Schema-two source-owner adapters. Existing handlers do not select these
// exports. Their caller keeps auth, source/history/media writes and transaction.
const p = require("./public-release-pair");
const a = require("./public-release-admission");
const { FieldValue } = require("firebase-admin/firestore");
const { publiclyVisible } = require("./public-video-references");
const { readPublicContextRevisionInTransaction, publicContextDigest, bumpPublicContextRevision } = require("./public-context-revision");
const { collectPublishedMediaUsage } = require("./media-usage");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { selectedAssets } = require("./public-content-projection");
const { mediaReplacementRef } = require("./media-replacement");
function refuse() { throw new p.PublicReleaseProtocolError(); }
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
async function readMedia({ firestore, transaction, selector, collection, documentId, snapshot }) {
  const usage = collectPublishedMediaUsage({ collection, documentId, snapshot });
  if (usage.assetIds.length > 100) refuse();
  const rows = usage.assetIds.length ? await transaction.getAll(...usage.assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`),
    firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id)])) : [];
  const uploadedMediaReady = rows.some((row, index) => index % 3 === 0 && row.data()?.source === "upload");
  if (uploadedMediaReady) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector });
  const assets = new Map(usage.assetIds.map((id, index) => {
    if (rows[index * 3 + 2].exists) refuse();
    return [id, assertPublishedAssetProjection({ assetId: id, owner: "pair publication", privateSnapshot: rows[index * 3],
      publicSnapshot: rows[index * 3 + 1], uploadedMediaReady,
      requiresPdf: usage.documentAssetIds?.includes(id), requiresImage: !usage.documentAssetIds?.includes(id) || usage.imageAssetIds?.includes(id) })];
  }));
  selectedAssets(usage, assets);
  return usage.assetIds;
}
function result(prepared, operation, writeSource, releaseSelector) {
  return { idempotent: prepared.idempotent, admission: prepared.admission, operation,
    transport: a.TRANSPORT, requiresPrimaryAdmission: false, queueId: prepared.admission.operationId,
    contentQueueId: prepared.admission.operationId, affectedHomeSections: [], warnings: [], homeFullBuildQueueId: null,
    ...(releaseSelector ? { releaseSelector } : {}),
    write() { if (!prepared.idempotent) { prepared.write(); writeSource(); } } };
}
async function preparePairContentPublication({ firestore, transaction, collection, documentId, nextDocument, queueRef, actor,
  kind, family, target, pageScheduleCapture, dependencyRefresh = false, electionResultsRefresh, videoReplacementRefresh }) {
  if (!/^[A-Za-z0-9]{20}$/.test(queueRef?.id ?? "") || queueRef.path !== `cmsPublishQueue/${queueRef.id}`) refuse();
  const visible = publiclyVisible(nextDocument), snapshot = nextDocument?.published;
  if (kind === "page" && documentId === "home" && !visible) throw Object.assign(new Error("The homepage can't be unpublished."), { status: 409 });
  const change = { kind, id: documentId, action: visible ? "publish" : "withdraw", sourceVersion: snapshot?.sourceVersion, snapshot };
  const source = a.publicationSource({ ...change, family });
  // A lost acceptance response is resolved before current selection, owner or
  // source-version checks; callers must honor idempotent before source writes.
  const existing = await transaction.get(firestore.doc(`${a.ADMISSIONS}/operations/${queueRef.id}`));
  if (existing.exists) {
    const prepared = await a.preparePairPublicationInTransaction({ firestore, transaction, operationId: queueRef.id,
      source, change, contextRevision: existing.data().contextRevision });
    return result(prepared, prepared.admission.source, () => {});
  }
  const [pointerRow, storedRow] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(`${collection}/${documentId}`));
  const selector = require("./public-release-media-fence").parseStoredSelector(pointerRow.data()), stored = storedRow.data();
  const refresh = dependencyRefresh || Boolean(electionResultsRefresh) || Boolean(videoReplacementRefresh);
  if (typeof dependencyRefresh !== "boolean" || !p.positive(nextDocument.version) ||
      !refresh && nextDocument.version <= (stored?.version ?? 0) ||
      visible && !refresh && snapshot.sourceVersion !== nextDocument.version ||
      !visible && (!stored?.published || !same(stored.published, snapshot))) refuse();
  if (refresh) {
    if (!visible || !["post", "page"].includes(kind) || [dependencyRefresh, electionResultsRefresh, videoReplacementRefresh].filter(Boolean).length !== 1) refuse();
    if (dependencyRefresh) require("./dataset-refresh-identity").assertSameSourceRefresh(stored, nextDocument);
    if (electionResultsRefresh) require("./election-source-refresh").assertElectionSourceRefresh(stored, nextDocument, electionResultsRefresh);
    if (videoReplacementRefresh) require("./source-video-replacement-publication").assertVideoReplacementRefresh(stored, nextDocument, videoReplacementRefresh);
  }
  const revision = await readPublicContextRevisionInTransaction(transaction, firestore), contextRevision = revision + 1;
  const runtime = { owner: "cloudflare", release: selector.activeCommitSha };
  if (visible && ["post", "page"].includes(kind)) require("./dataset-dependencies").validateFrozenDatasetFigures(snapshot);
  let owner, capability, plan, writeRoutes = () => {}, homePlan, namespace;
  if (kind === "post") {
    const post = require("./no-build-post-ownership");
    owner = await post.readNoBuildPostOwner({ firestore, transaction, postId: documentId });
    capability = await post.readNoBuildPostCapability({ firestore, transaction });
    if (owner.state?.mode === "static" || visible && (await post.listNoBuildPostOwners({ firestore, transaction }))
      .some(({ state }) => state.mode === "static" && state.visible))
      throw Object.assign(new Error("A retained static Post requires its approved cutover before pair publication."), { status: 409 });
    if (visible && require("./no-build-post-publication").unsupportedSnapshotReason(nextDocument)) refuse();
    if (visible) {
      const read = await require("../published-post-reader").readPublishedPost({ firestore, transaction,
        documentId, nextDocument, slug: snapshot.metadata.slug, now: new Date(snapshot.publishedAt), releaseSelector: selector });
      if (read.kind !== "published-post") refuse();
    }
    const slugs = [...new Set([...(owner.state?.ownedSlugs ?? []), snapshot.metadata.slug, ...(snapshot.metadata.previousSlugs ?? [])])];
    if (slugs.length > 100 || slugs.some(slug => !require("./post-slug-contract").isServerMintableSlugShape(slug))) refuse();
    for (const slug of slugs) if ((await post.listNoBuildPostOwners({ firestore, transaction, slug })).some(value => value.state.postId !== documentId)) refuse();
    plan = { slug: snapshot.metadata.slug, ownedSlugs: slugs };
  } else if (kind === "page") {
    if (visible) await require("./page-reader-compatibility").assertInstalledPageReaders({
      firestore, transaction, pageId: documentId, blocks: snapshot?.blocks });
    const page = require("./no-build-page-ownership");
    owner = await page.readNoBuildPageOwner({ firestore, transaction, pageId: documentId });
    capability = await page.readNoBuildPageCapability({ firestore, transaction });
    plan = require("./no-build-page-contract").validateNoBuildPageSnapshot({ pageId: documentId, snapshot });
    const paths = require("./no-build-page-publication").pagePaths(documentId, plan, owner.state, snapshot);
    plan = { ...plan, ownedPaths: paths };
    writeRoutes = await page.preparePageRouteClaimsInTransaction({ firestore, transaction, pageId: documentId, ownedPaths: paths });
    if (visible) await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({ firestore, transaction,
      pageId: documentId, nextDocument, rendererSha: selector.activeCommitSha, releaseSelector: selector,
      target, scheduleCapture: pageScheduleCapture, now: new Date(snapshot.publishedAt) });
  } else if (kind === "record") {
    owner = await require("./no-build-record-ownership").readNoBuildRecordOwner({ firestore, transaction, documentId });
    capability = await require("./no-build-record-capability").readRecordCapability({ firestore, transaction });
    plan = require("./no-build-record-contract").validateNoBuildRecordSnapshot({ family, documentId, snapshot });
    writeRoutes = await require("./no-build-record-ownership").prepareRecordRouteClaimsInTransaction({ firestore, transaction,
      family, documentId, ownedPaths: plan.ownedPaths });
    namespace = await require("./no-build-record-namespace").prepareRecordNamespace({ firestore, transaction, family });
    if (visible) {
      const pending = await require("./no-build-record-source").readPendingRecordFamilyInTransaction({ firestore, transaction, family,
        rendererSha: selector.activeCommitSha, releaseSelector: selector, nextDocument, documentId, now: new Date(snapshot.publishedAt) });
      if (!pending.sources.some(source => source.documentId === documentId && source.sourceVersion === snapshot.sourceVersion &&
          source.snapshotDigest === require("./no-build-record-contract").recordSnapshotDigest(snapshot))) refuse();
    }
  } else refuse();
  const previousQueue = owner.state
    ? await transaction.get(firestore.doc(`cmsPublishQueue/${owner.state.operationId}`)) : null;
  const previous = previousQueue?.data();
  const legacyPage = kind === "page" && previous?.transport === "page-no-build-v1";
  const legacyPost = kind === "post" && previous?.transport === "post-no-build-v1";
  const previousHome = legacyPost ? previous.homeFullBuild : null;
  let previousHomeRef, supersedeHome = false;
  if (previousHome?.status === "reserved") {
    if (!/^[A-Za-z0-9]{20}$/.test(previousHome.queueId ?? "") || previousHome.sourceOperationId !== owner.state.operationId) refuse();
    previousHomeRef = firestore.doc(`cmsPublishQueue/${previousHome.queueId}`);
    const homeQueue = (await transaction.get(previousHomeRef)).data();
    if (!["serializer", "github"].includes(homeQueue?.transport) || homeQueue.homeFullBuild?.sourceOperationId !== owner.state.operationId) refuse();
    supersedeHome = homeQueue.status === "reserved";
  }
  if (legacyPage && (previous.noBuildPage?.operationId !== owner.state.operationId || previous.noBuildPage.pageId !== documentId ||
      previous.noBuildPage.sourceVersion !== owner.state.sourceVersion || previous.noBuildPage.snapshotDigest !== owner.state.snapshotDigest ||
      previous.backgroundRuntime?.owner !== owner.state.runtime.owner || previous.backgroundRuntime?.release !== owner.state.runtime.release)) refuse();
  if (visible && (!capability?.servingEnabled || capability.rendererSha !== selector.activeCommitSha ||
      source.requiredFeatures.some(feature => {
        const [name, version] = feature.split(":");
        return name === "electionResultsVersion" ? ![1, 2].includes(capability[name]) || capability[name] < Number(version) : capability[name] !== 1;
      }) ||
      kind === "record" && !capability.families.includes(family))) refuse();
  if (visible && kind !== "post" && (capability.terminalOwner?.rendererSha !== selector.activeCommitSha ||
      capability.terminalOwner.transport !== (kind === "page" ? "page-no-build-v1" : "public-context-no-build-v1"))) refuse();
  if (!visible && (!owner.state || owner.state.sourceVersion !== snapshot.sourceVersion)) refuse();
  if (visible) await readMedia({ firestore, transaction, selector, collection, documentId, snapshot });
  const generation = Math.max(owner.state?.generation ?? 0, selector.activeGeneration) + 1;
  if (!p.positive(generation) || !p.positive(contextRevision)) refuse();
  const operation = { schemaVersion: 1, operationId: queueRef.id, sourceVersion: source.sourceVersion,
    snapshotDigest: source.snapshotDigest, generation, rendererSha: selector.activeCommitSha, visible,
    contextRevision, contextDigest: publicContextDigest(contextRevision), ...plan,
    ...(snapshot.datasetFigures ? { datasetFiguresDigest: require("./dataset-dependencies").digest(snapshot.datasetFigures) } : {}) };
  let state;
  if (kind === "post") {
    state = { ...owner.state, ...operation, postId: documentId, servingEnabled: capability?.servingEnabled ?? owner.state.servingEnabled, runtime };
    if (!operation.datasetFiguresDigest) delete state.datasetFiguresDigest;
    require("./no-build-post-ownership").validateState(state);
  }
  else if (kind === "page") {
    operation.pageId = documentId;
    state = { ...owner.state, ...operation, servingEnabled: capability?.servingEnabled ?? owner.state.servingEnabled, runtime };
    if (!operation.datasetFiguresDigest) delete state.datasetFiguresDigest;
    if (!visible) state.durableWithdrawal = { schemaVersion: 1, pageId: documentId, operationId: queueRef.id,
      sourceVersion: source.sourceVersion, revision: generation, ownedPaths: plan.ownedPaths, snapshotDigest: source.snapshotDigest, contextRevision };
    if (documentId === "home") homePlan = await require("./no-build-home-ownership").prepareHomePlanInTransaction({ firestore, transaction, nextDocument, operation, runtime });
    require("./no-build-page-ownership").validateNoBuildPageState(state);
  } else {
    state = { schemaVersion: 1, family, documentId, operationId: queueRef.id, sourceVersion: source.sourceVersion,
      snapshotDigest: source.snapshotDigest, canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths, visible,
      rendererSha: selector.activeCommitSha, generation, runtime, contextRevision, contextDigest: operation.contextDigest,
      admissionRevision: owner.state?.admissionRevision ?? null,
      ...(owner.state?.durableWithdrawal ? { durableWithdrawal: owner.state.durableWithdrawal } : {}) };
    if (!visible) state.durableWithdrawal = { schemaVersion: 1, recordId: documentId, family, operationId: queueRef.id,
      sourceVersion: source.sourceVersion, revision: generation, ownedPaths: plan.ownedPaths, snapshotDigest: source.snapshotDigest, contextRevision };
    require("./no-build-record-ownership").validateNoBuildRecordState(state);
  }
  const sourceChange = require("./public-release-producer").publicContentChange(collection, documentId, nextDocument, visible,
    { path: owner.ref.path, data: state });
  if (homePlan) sourceChange.sourceDocuments.push(homePlan.background);
  if (namespace) sourceChange.sourceDocuments.push({ path: require("./no-build-record-namespace").NAMESPACE_PATH,
    data: { schemaVersion: 1, families: namespace.families } });
  const prepared = await a.preparePairPublicationInTransaction({ firestore, transaction, operationId: queueRef.id, source,
    change: sourceChange, contextRevision });
  return result(prepared, operation, () => {
    // Existing pair admissions keep their original queue until their inclusion
    // proof settles them. Only legacy bookkeeping is retired on adoption.
    if (legacyPage && !["success", "cancelled"].includes(previous.status)) transaction.update(previousQueue.ref,
      { status: "cancelled", completedAt: FieldValue.serverTimestamp(), claim: null, nextAttemptAt: null,
        error: "Superseded by a newer Page publication" });
    const cancelPost = legacyPost && !["success", "cancelled"].includes(previous.status);
    if (cancelPost || supersedeHome) transaction.update(previousQueue.ref, {
      ...(cancelPost ? { status: "cancelled", completedAt: FieldValue.serverTimestamp(), claim: null, nextAttemptAt: null,
        error: "Superseded by a newer instant publication" } : {}),
      ...(supersedeHome ? { homeFullBuild: { ...previousHome, status: "superseded" } } : {}) });
    if (supersedeHome) transaction.update(previousHomeRef, { status: "superseded", completedAt: FieldValue.serverTimestamp() });
    if (kind === "record" && previous?.transport !== a.TRANSPORT && previous?.recordConfirmationPendingAt)
      transaction.update(previousQueue.ref, { recordConfirmationPendingAt: FieldValue.delete() });
    transaction.set(owner.ref, state); writeRoutes(); homePlan?.write(); namespace?.write();
    transaction.update(queueRef, { familyPublication: { kind, id: documentId, operation }, backgroundRuntime: runtime,
      triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null });
    bumpPublicContextRevision(transaction, firestore, { withdrawal: !visible, homePublication: kind === "page" && documentId === "home" });
  }, selector);
}
async function preparePairSettingsPublication({ firestore, transaction, id, published, actor }) {
  const settings = require("./settings-publication");
  if (!settings.PUBLIC_SETTINGS_IDS.has(id)) refuse();
  const operationId = settings.settingsOperationId(id, published.sourceVersion);
  const change = { kind: "settings", id, action: "publish", sourceVersion: published.sourceVersion, snapshot: published };
  const source = a.publicationSource(change), revision = await readPublicContextRevisionInTransaction(transaction, firestore);
  const prepared = await a.preparePairPublicationInTransaction({ firestore, transaction, operationId, source, change, contextRevision: revision + 1 });
  let selector;
  if (!prepared.idempotent) {
    selector = require("./public-release-media-fence").parseStoredSelector((await transaction.get(firestore.doc("system/publicDeployment"))).data());
    if (selector.epoch !== prepared.admission.epoch || !same(selector.selectedPair, prepared.admission.pair)) refuse();
  }
  const operation = { operationId, id, sourceVersion: published.sourceVersion, snapshotDigest: source.snapshotDigest,
    pair: prepared.admission.pair, contextRevision: prepared.admission.contextRevision, requiredConsumers: settings.REQUIRED_CONSUMERS };
  return { ...result(prepared, operation, () => {
    transaction.update(firestore.doc(`cmsPublishQueue/${operationId}`), { familyPublication: { kind: "settings", id, operation },
      triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null, triggeredAt: FieldValue.serverTimestamp() });
  }, selector), publication: { queueId: operationId, originalOperationId: operationId, transport: a.TRANSPORT,
    sourceVersion: published.sourceVersion, rendererSha: prepared.admission.pair.commitSha,
    contextRevision: prepared.admission.contextRevision, contextDigest: publicContextDigest(prepared.admission.contextRevision),
    status: "pending", missingConsumers: [...settings.REQUIRED_CONSUMERS] } };
}
async function preparePairContextPublication({ firestore, transaction, operationId, change }) {
  if (change?.kind !== "provider" || change.action !== "dependency") refuse();
  const source = a.publicationSource(change), revision = await readPublicContextRevisionInTransaction(transaction, firestore);
  const prepared = await a.preparePairPublicationInTransaction({ firestore, transaction, operationId, source, change, contextRevision: revision + 1 });
  return result(prepared, prepared.admission.source, () => {
    bumpPublicContextRevision(transaction, firestore);
  });
}
module.exports = { preparePairContentPublication, preparePairSettingsPublication, preparePairContextPublication };
