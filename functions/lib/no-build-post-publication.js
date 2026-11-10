"use strict";

const { preparePublicReleaseProducerInTransaction, publicContentChange } = require("./public-release-producer");

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { assertPublicDeploymentPointer, assertMediaLifecycleDeploymentFence, assertPublishedMediaReadiness } = require("./public-deployment");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { selectedAssets } = require("./public-content-projection");
const { mediaReplacementRef } = require("./media-replacement");
const { publiclyVisible } = require("./public-video-references");
const { visibleLayoutBlocks } = require("./content-layout");
const { selectPublishedStoryCredits } = require("./published-story-credits");
const { useFullBuildForPausedPost } = require("./transitional-post-fallback");
const { collectPublishedMediaUsage } = require("./media-usage");
const { isServerMintableSlugShape } = require("./post-slug-contract");
const { createPostBackgroundOutputs } = require("./post-background-outputs");
const { bumpPublicContextRevision, readPublicContextInTransaction, readPublicBackgroundContextInTransaction } = require("./public-context-revision");

const { readNoBuildFamilyAdmission, selectsNoBuildPost } = require("./no-build-family-admission");
const { validateState, readNoBuildPostOwner, listNoBuildPostOwners, readNoBuildPostCapability, effectiveNoBuildPostState, candidateNoBuildContract, candidateSupportsPost, findNoBuildPostOwnersForSlug, CAPABILITY_PATH } = require("./no-build-post-ownership");
const { publicationTarget, assertPublicationTarget } = require("./publication-target");
const { readCmsPublicationRuntimeControlInTransaction, assertCmsPublicationCloudAdmission, assertSerializerPublicationAdmissionInTransaction } = require("./cms-publication-runtime-control");
const { readSerializerPublicationControlInTransaction } = require("./serializer-publication-control");
const { instantBlockAllowed, unsupportedPostBlockReason, joinedRecordIds } = require("./joined-records");
const { digest: canonicalDigest } = require("./no-build-page-ownership");

const { publicationRuntime, runtimeFields } = require("./publication-runtime-owner");
const { homePostPlacements } = require("./home-source-catalog");
const { prepareHomePostRefreshInTransaction } = require("./no-build-home-ownership");
const STATE_PATH = "system/publicDeployment/noBuildPosts/current";
const TRANSPORT = "post-no-build-v1";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(message = "This Post cannot use instant publication.", scheduleDeferred = false) {
  throw Object.assign(new Error(message), { status: 409, code: "post_publication_unavailable",
    ...(scheduleDeferred ? { scheduleDeferred: true } : {}) });
}
function noBuildPostStateRef(firestore) { return firestore.doc(STATE_PATH); }
function normalizeAdmission(config) {
  if (config.families) return config;
  return { ...config, valid: config.valid !== false && typeof config.postId === "string" && Boolean(config.postId),
    families: config.postId ? { posts: { mode: "ids", ids: [config.postId] } } : {} };
}
const LEGACY_HOME_CARD_REASON = "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again.";
const MEDIA_LIMIT_REASON = "This Post uses more than 100 media files. Remove some images, then publish again.";
/** The first reason a published Post cannot publish build-free, in words staff can act on. */
function unsupportedSnapshotReason(document) {
  const snapshot = document?.published;
  if (!snapshot || snapshot.metadata?.type !== "post") return "This record is not a Post with a published snapshot.";
  if (!isServerMintableSlugShape(snapshot.metadata.slug)) {
    return "This Post slug must use only lowercase letters, numbers and single hyphens. Change the slug, then publish again.";
  }
  if (!Number.isSafeInteger(snapshot.sourceVersion) || snapshot.sourceVersion < 1) return "This Post has no valid published version.";
  try { selectPublishedStoryCredits(snapshot.metadata.credits); }
  catch { return "This Post has a credit that is not a registered author or a custom name. Fix the credits, then publish again."; }
  if (joinedRecordIds(snapshot.blocks).length > 100) {
    return "This Post links more than 100 programs, events, sponsors or newsletters. Remove some, then publish again.";
  }
  const block = visibleLayoutBlocks(snapshot.blocks).find(block => !instantBlockAllowed(block.type));
  if (block) return unsupportedPostBlockReason(block.type);
  return null;
}
function supportedSnapshot(document) {
  return unsupportedSnapshotReason(document) === null;
}
/** An owned route refuses at once. A first admission may still fall back to the
 * serializer while that transport is enabled; once it is off, the reason is the
 * answer staff see instead of a generic unavailability message. */
async function refuseUnlessSerializerFallback({ firestore, transaction, owned, fallback, reason }) {
  if (owned) refuse(reason);
  if (fallback) fallback.reason = reason;
  if (!(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) refuse(reason);
}
async function supportsPostMediaInTransaction(transaction, firestore, document, { accepting = false } = {}) {
  const { assetIds } = collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: document.published });
  if (assetIds.length > 100) return false;
  const refs = assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`),
    firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id)]);
  const assets = refs.length ? await transaction.getAll(...refs) : [];
  try {
    let uploadedMediaReady = false;
    if (assetIds.some((_id, index) => assets[index * 3]?.data()?.source === "upload")) {
      const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
      if (accepting) assertMediaLifecycleDeploymentFence(pointer);
      else assertPublishedMediaReadiness(pointer);
      uploadedMediaReady = true;
    }
    const projections = new Map(assetIds.map((id, index) => {
      if (assets[index * 3 + 2]?.exists) refuse();
      return [id, assertPublishedAssetProjection({ assetId: id, owner: "published Post",
        privateSnapshot: assets[index * 3], publicSnapshot: assets[index * 3 + 1], uploadedMediaReady })];
    }));
    // Use the public reader's origin, MIME and dimension contract at acceptance,
    // in addition to the save owner's exact projection and lifecycle fence.
    selectedAssets({ assetIds }, projections);
    return true;
  } catch (error) {
    if (error.status) refuse("This Post media is not ready for instant publication.");
    throw error;
  }
}
function postPlacements(snapshot, postId, slugs, metadata) {
  return homePostPlacements({ blocks: snapshot?.blocks, homeHero: snapshot?.metadata?.homeHero }, postId, slugs, metadata);
}
async function readHomePlacements(transaction, firestore, postId, slugs, metadata, previousMetadata) {
  const home = (await transaction.get(firestore.doc("cmsPages/home"))).data();
  if (!publiclyVisible(home)) return [];
  const placements = postPlacements(home.published, postId, slugs, metadata);
  const previous = previousMetadata ? postPlacements(home.published, postId, slugs, previousMetadata) : [];
  // A legacy body block can share an ID with the virtual hero section.
  return [...new Map([...previous, ...placements].map(section => [JSON.stringify([section.section, section.blockId]), section])).values()];
}
function assertRefreshableHome(placements) {
  if (placements.some(section => !section.refreshable)) refuse(LEGACY_HOME_CARD_REASON);
}
async function assertHomePilotExclusion(transaction, firestore, state, snapshot) {
  if (!state?.operationId || state.mode === "static") return;
  const post = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
  assertRefreshableHome(postPlacements(snapshot, state.postId, state.ownedSlugs, post?.published?.metadata));
}
function prepareBackground(firestore, postId, runtime) {
  // Admission uses only this existing owner's transaction preparation. Generation
  // and immutable storage stay with the existing publication service, off-path.
  return createPostBackgroundOutputs({ firestore, runtime, enabled: true, postIds: [postId], contentApiEnabled: true,
    readContextInTransaction: transaction => readPublicBackgroundContextInTransaction(transaction, firestore) });
}

/** Select and reserve before acceptance. The caller keeps auth, validation,
 * history and media writes in its existing transaction. A previously owned Post
 * never returns to the build strategy merely because serving/admission is off. */
async function prepareNoBuildPostPublication({ firestore, transaction, collection, documentId,
  nextDocument, queueRef, actor, config, fallback, target, electionResultsRefresh, videoReplacementRefresh, validationOnly = false }) {
  if (collection !== "cmsPosts" && !(collection === "cmsPages" && documentId === "home")) return null;
  if (collection === "cmsPages") {
    for (const { state } of await listNoBuildPostOwners({ firestore, transaction })) {
      await assertHomePilotExclusion(transaction, firestore, state, nextDocument.published);
    }
    return null;
  }
  const owner = await readNoBuildPostOwner({ firestore, transaction, postId: documentId });
  const capability = await readNoBuildPostCapability({ firestore, transaction });
  let state = effectiveNoBuildPostState(owner.state, capability);
  if (state?.mode === "static") {
    if (state.postId === documentId && publiclyVisible(nextDocument)) {
      const pointer = assertPublicDeploymentPointer((await transaction.get(firestore.doc("system/publicDeployment"))).data());
      if (pointer.state !== "idle") refuse("A public code release is in progress. Try this publication again shortly.", true);
    }
    return null;
  }
  config = config === undefined ? await readNoBuildFamilyAdmission({ firestore, transaction }) : normalizeAdmission(config);
  const owned = Boolean(owner.state?.operationId);
  const withdrawal = owned && !publiclyVisible(nextDocument);
  const selected = selectsNoBuildPost(config, documentId);
  if (owned && !withdrawal && !selected) refuse("Instant publication no longer admits this owned Post.");
  if (!selected && !withdrawal) return null;
  if (useFullBuildForPausedPost({ owned, admissionEnabled: config.enabled })) return null;
  if (!withdrawal && (await listNoBuildPostOwners({ firestore, transaction })).some(claim =>
    claim.state.mode === "static" && claim.state.visible)) {
    refuse("A retained static Post blocks family publication. Ask the operator to complete the approved Post cutover first.");
  }
  if (!withdrawal && (!config.enabled || state?.servingEnabled === false || capability?.servingEnabled === false)) {
    refuse("Instant publication is paused. The owned public route stays protected.", true);
  }
  if (!state) {
    if (capability?.schemaVersion !== 2) refuse("The active public renderer does not support Post family admission.");
    state = { schemaVersion: 1, postId: documentId, rendererSha: capability.rendererSha,
      servingEnabled: capability.servingEnabled, generation: capability.generation, ownedSlugs: [], operationId: null };
  }
  if (publiclyVisible(nextDocument) &&
      !require("./election-results-compatibility").supportsElectionResults(nextDocument.published, capability)) {
    refuse("The installed Post renderer does not support election results yet.");
  }
  if (publiclyVisible(nextDocument) &&
      require("./data-figure-compatibility").containsVisibleDataFigure(nextDocument.published) &&
      !require("./data-figure-compatibility").supportsDataFigures(capability)) {
    refuse("The installed Post renderer does not support data figures yet.");
  }
  if (publiclyVisible(nextDocument)) {
    const reason = unsupportedSnapshotReason(nextDocument) ??
      (await supportsPostMediaInTransaction(transaction, firestore, nextDocument, { accepting: true }) ? null : MEDIA_LIMIT_REASON);
    if (reason) {
      await refuseUnlessSerializerFallback({ firestore, transaction, owned, fallback, reason });
      return null;
    }
  }
  const pointerRef = firestore.doc("system/publicDeployment");
  const pointer = assertPublicDeploymentPointer((await transaction.get(pointerRef)).data());
  if (!withdrawal && (pointer.state !== "idle" || pointer.activeCommitSha !== state.rendererSha)) {
    refuse("A public code release is in progress. Try this publication again shortly.", true);
  }
  const snapshot = nextDocument.published;
  require("./dataset-dependencies").validateFrozenDatasetFigures(snapshot);
  if (!snapshot?.metadata || !Number.isSafeInteger(snapshot.sourceVersion)) refuse();
  if (!withdrawal && snapshot.datasetFigures) {
    try {
      const input = await require("../published-post-reader").readPublishedPost({ firestore, transaction,
        documentId, nextDocument, slug: snapshot.metadata.slug, now: new Date(snapshot.publishedAt) });
      if (input.kind !== "published-post") refuse("The data figure Post has no valid public input.");
    } catch (error) {
      if (error.readerCode) refuse("The Post and its data figures exceed the public input limit or use an unavailable dependency.");
      throw error;
    }
  }
  const slugs = [...new Set([...(state.ownedSlugs ?? []), snapshot.metadata.slug,
    ...(snapshot.metadata.previousSlugs ?? [])])];
  if (slugs.length > 100 || slugs.some(slug => !isServerMintableSlugShape(slug))) {
    refuse("This Post has more than 100 previous slugs, or a previous slug with letters, numbers and single hyphens only is missing.");
  }
  const previousDocument = (await transaction.get(firestore.doc(`cmsPosts/${documentId}`))).data();
  if (videoReplacementRefresh) require("./source-video-replacement-publication").assertVideoReplacementRefresh(previousDocument, nextDocument, videoReplacementRefresh);
  if (electionResultsRefresh) {
    require("./election-source-refresh").assertElectionSourceRefresh(previousDocument, nextDocument, electionResultsRefresh);
  }
  const affectedHomeSections = await readHomePlacements(transaction, firestore, documentId, slugs, snapshot.metadata,
    publiclyVisible(previousDocument) ? previousDocument?.published?.metadata : undefined);
  // A copied legacy Home card has no build-free refresh. An owned route cannot
  // silently switch transports or leave those copies stale.
  if (affectedHomeSections.some(section => !section.refreshable)) {
    await refuseUnlessSerializerFallback({ firestore, transaction, owned, fallback, reason: LEGACY_HOME_CARD_REASON });
    return null;
  }
  // An initialized complete context is a release prerequisite, not a constant
  // synthesized by the pilot. Every relevant producer advances it atomically.
  await readPublicContextInTransaction(transaction, firestore);
  const previousQueueRef = state.operationId ? firestore.doc(`cmsPublishQueue/${state.operationId}`) : null;
  const previousQueue = previousQueueRef ? (await transaction.get(previousQueueRef)).data() : null;
  if (previousQueueRef && previousQueue?.transport !== TRANSPORT) refuse();
  const previousHomeReceipt = previousQueue?.homeFullBuild;
  let previousHomeRef = null;
  let supersedePreviousHome = false;
  if (previousHomeReceipt?.status === "reserved") {
    if (!/^[A-Za-z0-9]{20}$/.test(previousHomeReceipt.queueId ?? "") || previousHomeReceipt.sourceOperationId !== state.operationId) refuse();
    previousHomeRef = firestore.doc(`cmsPublishQueue/${previousHomeReceipt.queueId}`);
    const previousHome = (await transaction.get(previousHomeRef)).data();
    if (!["serializer", "github"].includes(previousHome?.transport) || previousHome.homeFullBuild?.sourceOperationId !== state.operationId) refuse();
    supersedePreviousHome = previousHome.status === "reserved";
  }
  const provider = owner.state ? publicationRuntime(owner.state.runtime ?? { owner: "node-compute", release: owner.state.rendererSha }).owner : "cloudflare";
  const runtime = publicationRuntime({ owner: provider, release: state.rendererSha });
  if (provider === "cloudflare") {
    target = assertPublicationTarget(target ?? publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production"));
    const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
    assertCmsPublicationCloudAdmission(control, { commitSha: state.rendererSha, serializerId: target.serializerId });
    if (withdrawal && pointer.activeCommitSha !== state.rendererSha) {
      throw Object.assign(new Error("The active Post renderer changed. Try this removal again shortly."), { code: "failed-precondition" });
    }
  } else {
    await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction });
  }
  for (const slug of slugs) {
    const claims = await listNoBuildPostOwners({ firestore, transaction, slug });
    if (claims.some(claim => claim.state.postId !== documentId)) refuse("Another Post owns this public route.");
  }
  const writeHomeRefresh = await prepareHomePostRefreshInTransaction({ firestore, transaction,
    postId: documentId, nextDocument, queueId: queueRef.id, affectedSections: affectedHomeSections });
  const writeBackground = await prepareBackground(firestore, documentId, runtime).prepareInTransaction({
    transaction, queueId: queueRef.id, postId: documentId, nextDocument,
    homePlacementPaths: affectedHomeSections.length ? ["/"] : [] });
  const generation = Math.max(pointer.lastReservedGeneration, state.generation) + 1;
  if (!Number.isSafeInteger(generation)) refuse();
  const contentRedirectUrl = snapshot.metadata?.contentLinkMode === "custom" ? new URL(snapshot.metadata.contentLinkUrl).href : null;
  if (contentRedirectUrl && require("./content-link").contentLinkError(snapshot.metadata)) refuse("The custom content URL is invalid.");
  const operation = { schemaVersion: 1,
    ...(contentRedirectUrl || state?.contentRedirectUrl !== undefined ? { contentRedirectUrl } : {}), operationId: queueRef.id, generation, rendererSha: state.rendererSha,
    admissionRevision: config.admissionRevision ?? null,
    postId: documentId, sourceVersion: snapshot.sourceVersion, slug: snapshot.metadata.slug,
    ...(capability?.dataFigureVersion === 1 ? { snapshotDigest: require("./dataset-dependencies").digest(snapshot) } : {}),
    ...(snapshot.datasetFigures ? { datasetFiguresDigest: require("./dataset-dependencies").digest(snapshot.datasetFigures) } : {}),
    visible: publiclyVisible(nextDocument), ownedSlugs: slugs };
  const change = { collection, id: documentId, sourceVersion: snapshot.sourceVersion,
    ...(operation.visible ? {} : { operation: "withdraw" }) };
  const withdrawalRevision = operation.visible ? null :
    (await readPublicBackgroundContextInTransaction(transaction, firestore)).withdrawalRevision + 1;
  if (!operation.visible && (!Number.isSafeInteger(withdrawalRevision) || withdrawalRevision < 1)) refuse();
  const cloudWithdrawal = !operation.visible && provider === "cloudflare";
  const buildFreeWithdrawal = cloudWithdrawal && !writeBackground.preparationFailed;
  if (cloudWithdrawal) {
    await require("./no-build-post-withdrawal").assertWithdrawalReady({ firestore, transaction });
  }
  const homeBuild = !operation.visible && !buildFreeWithdrawal ?
    await require("./transitional-post-withdrawal").preparePostWithdrawalBuild({ firestore, actor, change, operationId: queueRef.id, runtime, transaction,
      homeAffected: affectedHomeSections.length > 0 }) : null;
  const queue = { backgroundRuntime: runtime, status: "pending", transport: TRANSPORT, triggeredBy: actor.uid,
    triggeredByEmail: actor.email ?? null, triggeredAt: FieldValue.serverTimestamp(), completedAt: null,
    error: null, changes: [change], noBuildPost: operation, affectedHomeSections, homeAffected: affectedHomeSections.length > 0,
    ...(!operation.visible ? { withdrawalRevision } : {}),
    ...(cloudWithdrawal && writeBackground.preparationFailed ? { backgroundAdmissionFailed: true } : {}),
    ...(homeBuild ? { homeFullBuild: homeBuild.receipt } : {}), nextAttemptAt: 0, attempts: 0, claim: null };
  const warnings = !operation.visible && affectedHomeSections.length
    ? [`Home will lose a card in: ${affectedHomeSections.map(section => section.title).join(", ")}. Review those sections.`,
      homeBuild ? require("./no-build-home-withdrawal").HOME_WITHDRAWAL_WARNING
        : require("./no-build-post-withdrawal").HOME_OUTPUT_WITHDRAWAL_WARNING] : [];
  const nextOwner = { ...state, ...runtimeFields(runtime), ...operation };
  if (!operation.datasetFiguresDigest) delete nextOwner.datasetFiguresDigest;
  if (!operation.snapshotDigest) delete nextOwner.snapshotDigest;
  const writeReleaseChange = validationOnly ? () => {} : await preparePublicReleaseProducerInTransaction({ firestore, transaction,
    operationId: queueRef.id, changes: [publicContentChange(collection, documentId, nextDocument, operation.visible, { path: owner.ref.path, data: nextOwner })] });
  return { transport: TRANSPORT, operation, requiresPrimaryAdmission: provider !== "cloudflare" || Boolean(homeBuild),
    queueId: queueRef.id, contentQueueId: homeBuild?.queueRef.id ?? queueRef.id,
    homeFullBuildQueueId: homeBuild?.queueRef.id ?? null, affectedHomeSections, warnings, write() {
    writeReleaseChange();
    const cancelPrevious = previousQueue && !["success", "cancelled"].includes(previousQueue.status);
    if (cancelPrevious || supersedePreviousHome) {
      transaction.update(previousQueueRef, {
        ...(cancelPrevious ? { status: "cancelled", completedAt: FieldValue.serverTimestamp(),
          claim: null, nextAttemptAt: null, error: "Superseded by a newer instant publication" } : {}),
        ...(supersedePreviousHome ? { homeFullBuild: { ...previousHomeReceipt, status: "superseded" } } : {}),
      });
    }
    if (supersedePreviousHome) {
      // Maintenance follows only the current operation. Settle the predecessor's
      // unpromoted reservation before replacing that operation, even if its
      // detail publication already succeeded. Already queued builds still drain.
      transaction.update(previousHomeRef, { status: "superseded", completedAt: FieldValue.serverTimestamp() });
    }
    transaction.create(queueRef, queue);
    if (homeBuild) {
      transaction.create(homeBuild.queueRef, homeBuild.queue);
      transaction.create(homeBuild.auditRef, homeBuild.audit);
    }
    transaction.set(owner.ref, nextOwner);
    bumpPublicContextRevision(transaction, firestore, { withdrawal: !operation.visible });
    writeBackground();
    writeHomeRefresh();
  } };
}

/** Version and visibility are checked in the same read transaction as ownership.
 * Nothing here selects an older static baseline for an owned path. */
async function readNoBuildPostDecision({ firestore, path, rendererSha, probe }) {
  return firestore.runTransaction(transaction => readNoBuildPostDecisionInTransaction({ firestore, transaction, path, rendererSha, probe }), { readOnly: true });
}
async function readNoBuildPostDecisionInTransaction({ firestore, transaction, path, rendererSha, probe }) {
  const match = /^\/posts\/([^/]+)\/$/.exec(path);
  const receipts = ["/_publication.json", "/_content-status.json"].includes(path);
  const { backgroundOutputForPath: outputForPath, isBackgroundAssetPath, lastGood } = require("./post-background-outputs");
  const { recordOutputForPath, recordFamilyRegistered } = require("./no-build-record-namespace");
  const recordFamily = recordOutputForPath(path);
  if (recordFamily && !await recordFamilyRegistered({ firestore, transaction, family: recordFamily })) return { kind: "pass" };
  const background = outputForPath(path) || isBackgroundAssetPath(path);
  if (!receipts && !background && !match) return { kind: "pass" };
  const contextBackground = background && await require("./public-context-background-reader")
    .readPublicContextBackgroundInTransaction({ firestore, transaction, path, rendererSha });
  if (contextBackground) return contextBackground;
  const owners = (match ? await findNoBuildPostOwnersForSlug({ firestore, transaction, slug: match[1] })
    : await listNoBuildPostOwners({ firestore, transaction })).filter(owner => owner.state.operationId);
  // A first renderer activation has no Post owners yet. Its artifact probe
  // still requires the exact candidate lease before Assets can answer it.
  if (!owners.length && !(receipts && probe)) return { kind: "pass" };
  if (match && owners.length !== 1) refuse("Two Posts claim the same public route.");
  const readPointer = require("./public-deployment-pointer").readPublicDeploymentPointer;
  const pointer = readPointer((await transaction.get(firestore.doc("system/publicDeployment"))).data());
  const capability = await readNoBuildPostCapability({ firestore, transaction });
  const candidate = pointer.state !== "idle" && rendererSha === pointer.candidateCommitSha ?
    (await transaction.get(firestore.doc(`system/publicDeployment/buildBatches/${pointer.candidateBuildBatchId}/candidates/worker`))).data() : null;
  if (receipts && probe) {
    if (pointer.state === "idle" || pointer.candidateBuildBatchId !== probe.buildBatchId ||
        candidate?.workerVersionId !== probe.versionId || candidate.commitSha !== rendererSha) refuse();
    await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate });
    return { kind: "baseline-probe" };
  }
  if (!owners.length) return { kind: "pass" };
  if (background === "home") {
    if (owners.every(owner => owner.state.mode === "static")) return { kind: "pass" };
    const homeState = (await transaction.get(firestore.doc("cmsBackgroundOutputs/home"))).data();
    // Without a verified Home manifest, keep the existing static copy.
    if (!lastGood(homeState)) return { kind: "pass" };
  }
  const admission = await readNoBuildFamilyAdmission({ firestore, transaction });
  const contextDigest = await readPublicContextInTransaction(transaction, firestore);
  const context = { firestore, transaction, pointer, capability, candidate, rendererSha, admission, contextDigest };
  if (match) return readOwnedPostDecision({ ...context, owner: owners[0], path, slug: match[1] });
  if (owners.length === 1) {
    return readOwnedPostDecision({ ...context, owner: owners[0], path });
  }
  const posts = [];
  // Catalogs must qualify every owner even while the release pointer disables
  // reply caching. Overlap independent reads in this same read-only transaction
  // without issuing an unbounded burst as the owner set grows.
  for (let offset = 0; offset < owners.length; offset += 8) {
    const replies = await Promise.all(owners.slice(offset, offset + 8).map(owner =>
      readOwnedPostDecision({ ...context, owner, path: `/posts/${owner.state.slug}/`, catalog: true })));
    posts.push(...replies.map(reply => reply.receipt));
  }
  if (!admission.valid) refuse("Instant publication admission is unavailable.");
  const catalog = { schemaVersion: 1, rendererSha, admissionRevision: admission.admissionRevision, contextDigest,
    generation: posts.reduce((generation, post) => Math.max(generation, post.generation), pointer.activeGeneration), posts };
  if (background) return { kind: "background", catalog, backgroundBucket: admission.backgroundBucket };
  return { kind: "receipts", catalog };
}

async function readOwnedPostDecision({ firestore, transaction, owner, pointer, capability, candidate, rendererSha,
  admission, contextDigest, path, slug, catalog = false }) {
  const state = effectiveNoBuildPostState(owner.state, capability);
  const staticCandidate = candidate?.noBuildStatic?.postId === state.postId ? candidate : null;
  if (state.mode === "static" || staticCandidate) {
    if (candidate) {
      const contract = candidateNoBuildContract(candidate.noBuildPost);
      if (!candidateSupportsPost(contract, state.postId) || contract.rendererSha !== rendererSha ||
          candidate.commitSha !== rendererSha || candidate.generation !== pointer.candidateGeneration) refuse();
    }
    return require("./no-build-post-static-return").readStaticDecision({
      firestore, transaction, state, pointer, rendererSha, path, candidate: staticCandidate ?? candidate,
    });
  }
  let servingEnabled = state.servingEnabled;
  if (candidate) {
    const contract = candidateNoBuildContract(candidate.noBuildPost);
    if (!candidateSupportsPost(contract, state.postId) || contract.rendererSha !== rendererSha) refuse();
    servingEnabled = contract.enabled;
  } else if (rendererSha !== state.rendererSha) refuse();
  if (pointer.state === "idle" && pointer.activeCommitSha !== rendererSha) refuse();
  const document = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
  const liveBlogCompatibility = require("./live-blog-compatibility");
  let liveBlogContract = candidate ? candidateNoBuildContract(candidate.noBuildPost) : capability;
  if (liveBlogCompatibility.requiredLiveBlogContractVersion(document?.published?.metadata?.liveBlog) > 1) liveBlogContract = {
    ...liveBlogContract, liveBlogContractVersion: await liveBlogCompatibility.readLiveBlogContractForRenderer({ firestore, transaction, rendererSha }),
  };
  if (!liveBlogCompatibility.candidateSupportsOwnedLiveBlog(state, document?.published, liveBlogContract)) {
    refuse("The installed Post renderer does not support the published live blog.");
  }
  if (document?.published?.sourceVersion !== state.sourceVersion || publiclyVisible(document) !== state.visible ||
      document?.published?.metadata?.slug !== state.slug ||
      state.snapshotDigest && canonicalDigest(document?.published) !== state.snapshotDigest ||
      state.datasetFiguresDigest && canonicalDigest(document?.published?.datasetFigures) !== state.datasetFiguresDigest) refuse();
  const receipt = { schemaVersion: 1, postId: state.postId, operationId: state.operationId,
    rendererSha, sourceVersion: state.sourceVersion, slug: state.slug, ownedSlugs: state.ownedSlugs,
    visible: state.visible, admissionRevision: admission.admissionRevision, contextDigest,
    ...(state.snapshotDigest ? { snapshotDigest: state.snapshotDigest } : {}),
    ...(state.datasetFiguresDigest ? { datasetFiguresDigest: state.datasetFiguresDigest } : {}),
    generation: Math.max(state.generation, candidate?.generation ?? 0) };
  if (!state.visible && (catalog || slug)) return { kind: "gone", receipt };
  // Current admission selects new operations. An accepted owner keeps serving
  // its exact published snapshot and can finish confirmation after a pause.
  if (!servingEnabled || !admission.valid) refuse();
  if (state.visible && (!supportedSnapshot(document) || !await supportsPostMediaInTransaction(transaction, firestore, document))) refuse();
  assertRefreshableHome(await readHomePlacements(transaction, firestore, state.postId, state.ownedSlugs, document?.published?.metadata));
  if (catalog || ["/_publication.json", "/_content-status.json"].includes(path)) return { kind: "receipts", receipt };
  const { backgroundOutputForPath: outputForPath, isBackgroundAssetPath } = require("./post-background-outputs");
  if (outputForPath(path) || isBackgroundAssetPath(path)) return { kind: "background", receipt, backgroundBucket: admission.backgroundBucket };
  if (!state.visible) return { kind: "gone", receipt };
  if (slug !== state.slug) return { kind: "alias", location: `/posts/${state.slug}/`, receipt };
  return { kind: "post", receipt, published: await require("../published-post-reader").readPublishedPost({
    firestore, transaction, slug: state.slug, now: new Date() }) };
}

async function assertNoBuildCandidateInTransaction({ firestore, transaction, candidate }) {
  const owners = await listNoBuildPostOwners({ firestore, transaction });
  const activeOwners = owners.filter(owner => owner.state.operationId);
  const contract = candidateNoBuildContract(candidate.noBuildPost);
  if (!activeOwners.length) {
    if (candidate.noBuildStatic) refuse();
    return { owners, state: owners[0]?.state ?? null, contract };
  }
  const staticOwner = candidate.noBuildStatic ? activeOwners.find(owner => owner.state.postId === candidate.noBuildStatic.postId) : null;
  if (candidate.noBuildStatic && !staticOwner) refuse();
  let staticReturn;
  // Every active owner must qualify before the candidate can take the public
  // pointer, and the probe must answer inside the Worker's authority deadline.
  // Overlap independent owner reads in this same transaction without issuing
  // an unbounded burst as the owner set grows. Settle each batch in owner
  // order so the first refusal is the same one a serial pass would raise.
  for (let offset = 0; offset < activeOwners.length; offset += 8) {
    const results = await Promise.allSettled(activeOwners.slice(offset, offset + 8).map(owner =>
      assertNoBuildOwnerPreservedInTransaction({ firestore, transaction, owner, candidate, contract, staticOwner })));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) staticReturn = result.value;
    }
  }
  return { owners, state: staticOwner?.state ?? activeOwners[0].state, contract, staticOwner, staticReturn };
}

async function assertNoBuildOwnerPreservedInTransaction({ firestore, transaction, owner, candidate, contract, staticOwner }) {
  const state = owner.state;
  if (!candidateSupportsPost(contract, state.postId) || contract.rendererSha !== candidate.commitSha) {
    refuse("The public candidate does not preserve owned instant Post routes.");
  }
  if (!require("./data-figure-compatibility").candidateSupportsOwnedDataFigures(state, contract)) {
    refuse("The public candidate does not preserve published data figures.");
  }
  const current = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
  if (!require("./election-results-compatibility").candidateSupportsOwnedElectionResults(state, current?.published, contract)) {
    refuse("The public candidate does not preserve published election results.");
  }
  const liveBlogCompatibility = require("./live-blog-compatibility");
  const liveBlogContract = liveBlogCompatibility.requiredLiveBlogContractVersion(current?.published?.metadata?.liveBlog) === 1 ? contract : {
    ...contract, liveBlogContractVersion: await liveBlogCompatibility.readLiveBlogContractForRenderer({ firestore, transaction, rendererSha: candidate.commitSha }),
  };
  if (!liveBlogCompatibility.candidateSupportsOwnedLiveBlog(state, current?.published, liveBlogContract)) {
    refuse("The public candidate does not preserve published live blogs.");
  }
  if (owner === staticOwner) {
    return require("./no-build-post-static-return").assertStaticCandidateInTransaction({ firestore, transaction, state, candidate });
  }
  if (state.mode === "static") refuse("A static Post candidate must refresh its retained route proof.");
  if (publiclyVisible(current) &&
      (!supportedSnapshot(current) ||
        !await supportsPostMediaInTransaction(transaction, firestore, current))) refuse();
  if (current?.published?.sourceVersion !== state.sourceVersion || publiclyVisible(current) !== state.visible ||
      current?.published?.metadata?.slug !== state.slug ||
      state.snapshotDigest && canonicalDigest(current?.published) !== state.snapshotDigest ||
      state.datasetFiguresDigest && canonicalDigest(current?.published?.datasetFigures) !== state.datasetFiguresDigest) refuse();
  assertRefreshableHome(await readHomePlacements(transaction, firestore, state.postId, state.ownedSlugs, current?.published?.metadata));
}

function writeNoBuildCandidateActivation(transaction, firestore, { owners, state, contract, staticOwner, staticReturn }, candidate) {
  if (!contract) return;
  const capability = { schemaVersion: contract.schemaVersion, rendererSha: candidate.commitSha,
    servingEnabled: contract.enabled, generation: candidate.generation,
    ...(contract.dataFigureVersion === 1 ? { dataFigureVersion: 1 } : {}),
    ...([1, 2].includes(contract.electionResultsVersion) ? { electionResultsVersion: contract.electionResultsVersion } : {}),
    ...(contract.liveBlogVersion === 1 ? { liveBlogVersion: 1 } : {}),
    ...(contract.schemaVersion === 1 ? { postId: contract.postId } : {}) };
  transaction.set(firestore.doc(CAPABILITY_PATH), capability);
  if (staticReturn) {
    const owner = staticOwner ?? { ref: noBuildPostStateRef(firestore), state };
    transaction.set(owner.ref, { ...owner.state, mode: "static", servingEnabled: false,
      rendererSha: candidate.commitSha, generation: candidate.generation,
      ownedSlugs: staticReturn.proof.ownedSlugs, staticProof: { ...staticReturn.proof, contextDigest: staticReturn.nextContextDigest } });
    // This activation already proved the static bytes; the dynamic proof owner
    // will no longer retry this route or supply its editor projection.
    transaction.update(firestore.doc(`cmsPosts/${owner.state.postId}`), { publicPostProof: FieldValue.delete() });
    return;
  }
  // Retained schema-1 candidates can initialize only their exact legacy owner.
  // Family candidates need no Post row before the first admitted transaction.
  if (contract.schemaVersion === 1 && !state && !owners?.length) {
    transaction.set(noBuildPostStateRef(firestore), { schemaVersion: 1, postId: contract.postId,
      rendererSha: candidate.commitSha, servingEnabled: contract.enabled, generation: 0,
      operationId: null, sourceVersion: null, slug: null, visible: false, ownedSlugs: [] });
  }
}

async function assertNoBuildScheduleInTransaction({ firestore, transaction, collection, documentId, nextDocument, firing = false }) {
  if (collection !== "cmsPosts" && !(collection === "cmsPages" && documentId === "home")) return;
  if (collection === "cmsPages") {
    for (const { state } of await listNoBuildPostOwners({ firestore, transaction })) {
      await assertHomePilotExclusion(transaction, firestore, state, nextDocument?.published);
    }
    return;
  }
  const { state } = await readNoBuildPostOwner({ firestore, transaction, postId: documentId });
  if (state?.mode === "static" && state.postId === documentId) {
    if (firing) {
      const pointer = assertPublicDeploymentPointer((await transaction.get(firestore.doc("system/publicDeployment"))).data());
      if (pointer.state !== "idle") {
        // A lease is transient. Retain the due request for the next tick.
        throw Object.assign(new Error("A public code release is in progress. Scheduled publication will retry."), {
          status: 503, scheduleDeferred: true,
        });
      }
    }
    return;
  }
  const config = await readNoBuildFamilyAdmission({ firestore, transaction });
  if (!state?.operationId && !selectsNoBuildPost(config, documentId)) return;
  if (nextDocument?.published?.metadata?.type !== "post") {
    if (state?.operationId) refuse("A saved Post snapshot is required for instant scheduling.");
    return;
  }
  if (!config.valid || !config.enabled) {
    if (state?.operationId) refuse("Build-free scheduling is unavailable. Keep this draft and try again when publication is ready.");
    return;
  }
  // Prepare only. Scheduling must pass the same admission and dependency checks
  // as immediate publication, without writing a public operation before it is due.
  const prepared = await prepareNoBuildPostPublication({ firestore, transaction, collection, documentId,
    nextDocument: { ...nextDocument, version: nextDocument.published.sourceVersion, status: "published", publiclyVisible: true }, config,
    queueRef: firestore.collection("cmsPublishQueue").doc(), actor: { uid: "system:scheduler" }, validationOnly: true });
  return prepared?.transport;
}
module.exports = { preparePairPostPublication: options => require("./public-release-family-admission").preparePairContentPublication({
  ...options, collection: "cmsPosts", kind: "post", family: "posts" }),
  assertNoBuildScheduleInTransaction, STATE_PATH, TRANSPORT, noBuildPostStateRef, validateState, supportedSnapshot, unsupportedSnapshotReason,
  prepareNoBuildPostPublication, readNoBuildPostDecision, readNoBuildPostDecisionInTransaction, candidateNoBuildContract,
  assertNoBuildCandidateInTransaction, writeNoBuildCandidateActivation, digest,
  readNoBuildPostStateInTransaction: require("./no-build-post-ownership").readNoBuildPostStateInTransaction,
  listNoBuildPostStatesInTransaction: require("./no-build-post-ownership").listNoBuildPostStatesInTransaction };
