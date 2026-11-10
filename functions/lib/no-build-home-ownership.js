"use strict";

const { isDeepStrictEqual } = require("node:util");
const { publicationRuntime } = require("./publication-runtime-owner");
const { publiclyVisible } = require("./public-video-references");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");

const HOME_PAGE_OWNER_PATH = "system/publicDeployment/noBuildPageOwners/home";
const HOME_BACKGROUND_PATH = "cmsBackgroundOutputs/home";
const HOME_PAGE_OWNER = "page-no-build-v1";
const HOME_PATHS = ["/", "/_home-sources.json"];
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validOperationId = value => typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
const validSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function refuse(message = "Home publication ownership is unavailable.") {
  throw Object.assign(new Error(message), { status: 409 });
}

// Paused serving and unfinished publication do not release the root or catalog.
function isHomePageAuthority(state) {
  if (state == null) return false;
  if (state.schemaVersion !== 1 || state.pageId !== "home" || state.path !== "/" ||
      !Array.isArray(state.ownedPaths) || state.ownedPaths.length !== 2 ||
      !HOME_PATHS.every(path => state.ownedPaths.includes(path)) ||
      !validOperationId(state.operationId) || !Number.isSafeInteger(state.sourceVersion) || state.sourceVersion < 1 ||
      !Number.isSafeInteger(state.generation) || state.generation < 1 || !validSha(state.rendererSha) ||
      typeof state.visible !== "boolean") refuse();
  let runtime;
  try { runtime = publicationRuntime(state.runtime); }
  catch { refuse(); }
  if (runtime.owner !== "cloudflare" || runtime.release !== state.rendererSha) refuse();
  return true;
}

function homePageOwnsPath(state, path) {
  return isHomePageAuthority(state) && HOME_PATHS.includes(path === "/index.html" ? "/" : path);
}

async function readHomePageAuthorityInTransaction({ firestore, transaction }) {
  const [owner, background] = await transaction.getAll(firestore.doc(HOME_PAGE_OWNER_PATH),
    firestore.doc(HOME_BACKGROUND_PATH));
  const state = owner.data();
  if (!isHomePageAuthority(state)) {
    if (background.data()?.owner === HOME_PAGE_OWNER) refuse();
    return null;
  }
  const marker = background.data();
  if (marker?.schemaVersion !== 1 || marker.owner !== HOME_PAGE_OWNER || marker.pageId !== "home" ||
      marker.ownerPath !== HOME_PAGE_OWNER_PATH || marker.operationId !== state.operationId) refuse();
  return state;
}

/** Serving supplies the raw owner after its Page capability check. Retained
 * provider provenance stays separate from the publication being rendered. */
async function readHomeSourcesInTransaction({ firestore, transaction, state, rendererSha, readHomeSource, homeCodeCapture, target }) {
  const owner = await readHomePageAuthorityInTransaction({ firestore, transaction });
  if (!owner || !isDeepStrictEqual(owner, state) || !validSha(rendererSha)) refuse();
  const [background, deployment, page, context] = await transaction.getAll(firestore.doc(HOME_BACKGROUND_PATH),
    firestore.doc("system/publicDeployment"), firestore.doc("cmsPages/home"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const pointer = deployment.data();
  const home = page.data();
  const publicContext = context.data();
  if (pointer?.state !== "idle" || pointer.activeCommitSha !== rendererSha ||
      !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 1 ||
      home?.published?.sourceVersion !== owner.sourceVersion || publiclyVisible(home) !== owner.visible ||
      publicContext?.schemaVersion !== 1 || !Number.isSafeInteger(publicContext.revision) || publicContext.revision < 1) refuse();
  const source = background.data().retainedSource;
  const homeRefresh = owner.homeRefresh ?? null;
  const externalInputs = publicContext.externalInputs ?? null;
  const identity = { publicContextRevision: publicContext.revision, externalInputs, homeRefresh };
  const publication = { buildBatchId: owner.operationId,
    generation: Math.max(owner.generation, pointer.activeGeneration), commitSha: rendererSha };
  // First transfer has no legacy file. The Worker loads the active code
  // baseline from ASSETS, seals it, and repeats its full authority read.
  if (source == null && externalInputs == null) {
    if (!homeCodeCapture) return { homeSources: null, publication: null, ...identity, needsBaseline: true };
    const code = await require("./no-build-page-home-code-capture").readCapturedPageHomeCodeSourcesInTransaction({
      firestore, transaction, rendererSha, target, capture: homeCodeCapture });
    return { ...code, publication, ...identity };
  }
  const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
  const admission = await readNoBuildFamilyAdmission({ firestore, transaction });
  if (!admission.valid) refuse();
  let homeSources;
  try {
    const readers = require("./home-retained-sources");
    const artifacts = readHomeSource ? null
      : require("./post-background-storage").createPostBackgroundStorage(admission.backgroundBucket);
    const read = readHomeSource
      ? key => readHomeSource({ key, bucket: admission.backgroundBucket })
      : key => artifacts.get(key, { signal: AbortSignal.timeout(10_000) });
    homeSources = externalInputs != null
      ? await readers.readPreparedHomeSources({ inputs: externalInputs, read, publication })
      : await readers.readRetainedHomeSources({ source, read });
  } catch { refuse("The retained Home provider snapshot is unavailable."); }
  return { homeSources, publication, ...identity };
}

function retainedHomeSource(state) {
  if (state?.owner === HOME_PAGE_OWNER) return state.retainedSource ?? null;
  // Reuse the existing last-good selection; keep only the immutable source file
  // identity, not old HTML, working content or provider response bodies.
  const { lastGood } = require("./post-background-outputs");
  const good = state ? lastGood(state) : null;
  if (!good) return null;
  const receipt = good.receipt;
  const file = receipt.manifest?.find(value => value.path === "/_home-sources.json");
  const publication = receipt.homeSourceReceipt;
  if (!file || !publication || publication.commitSha !== receipt.rendererSha ||
      !validSha(publication.commitSha) || !Number.isSafeInteger(publication.generation) || publication.generation < 1 ||
      typeof publication.buildBatchId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(publication.buildBatchId) ||
      !/^[a-f0-9]{64}$/.test(publication.digest ?? "") ||
      typeof file.key !== "string" || !/^post-background-v1\/home\/[A-Za-z0-9-]+\/[a-f0-9]{64}$/.test(file.key) ||
      !/^[a-f0-9]{64}$/.test(file.digest ?? "") || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024 ||
      !["application/json", "application/json; charset=utf-8"].includes(file.contentType)) refuse("The retained Home provider snapshot is unavailable.");
  return { file: { path: file.path, key: file.key, digest: file.digest, size: file.size, contentType: file.contentType },
    publication: { buildBatchId: publication.buildBatchId, generation: publication.generation,
      commitSha: publication.commitSha }, catalogDigest: publication.digest };
}

/** The Page acceptance owner writes its route owner in this same transaction. */
async function prepareHomePlanInTransaction({ firestore, transaction, nextDocument, operation, runtime }) {
  if (operation?.pageId !== "home") return null;
  isHomePageAuthority({ ...operation, runtime });
  if (nextDocument?.published?.sourceVersion !== operation.sourceVersion ||
      publiclyVisible(nextDocument) !== operation.visible) refuse();
  const [owner, background] = await transaction.getAll(firestore.doc(HOME_PAGE_OWNER_PATH),
    firestore.doc(HOME_BACKGROUND_PATH));
  const oldOwner = owner.data();
  const state = background.data();
  if (oldOwner) await readHomePageAuthorityInTransaction({ firestore, transaction });
  else if (state?.owner === HOME_PAGE_OWNER) refuse();
  const refresh = oldOwner?.homeRefresh;
  let refreshRef = null;
  if (oldOwner?.operationId !== operation.operationId && refresh?.status === "pending") {
    if (refresh.schemaVersion !== 1 || !Number.isSafeInteger(refresh.revision) || refresh.revision < 1 ||
        !validOperationId(refresh.sourceOperationId) ||
        refresh.taskPath !== `cmsPublishQueue/${refresh.sourceOperationId}/homePageRefresh/home`) refuse();
    refreshRef = firestore.doc(refresh.taskPath);
    const previousRefresh = (await transaction.get(refreshRef)).data();
    if (previousRefresh?.schemaVersion !== 1 || previousRefresh.owner !== HOME_PAGE_OWNER ||
        previousRefresh.revision !== refresh.revision || previousRefresh.input?.homeOperationId !== oldOwner.operationId ||
        previousRefresh.input.homeSourceVersion !== oldOwner.sourceVersion) refuse();
  }
  let taskRef = null;
  let task = null;
  if (state && state.owner !== HOME_PAGE_OWNER) {
    if (state.schemaVersion !== 1 || state.owner !== "post-background-v1" || state.output !== "home" ||
        !/^cmsPublishQueue\/[A-Za-z0-9_-]{1,200}\/backgroundOutputs\/home(?:-[1-9][0-9]*)?$/.test(state.taskPath ?? "")) refuse();
    taskRef = firestore.doc(state.taskPath);
    task = (await transaction.get(taskRef)).data();
    if (task?.schemaVersion !== 1 || task.owner !== "post-background-v1" || task.output !== "home" ||
        task.revision !== state.revision) refuse();
    // Do not erase an uncertain claim. The legacy owner must settle it first.
    if (task.claim != null) refuse("A Home background publication is still in progress. Retry after it settles.");
  }
  const retainedSource = retainedHomeSource(state);
  const backgroundMarker = { schemaVersion: 1, owner: HOME_PAGE_OWNER,
    output: "home", pageId: "home", ownerPath: HOME_PAGE_OWNER_PATH, operationId: operation.operationId, retainedSource };
  // The common Page owner must set its new owner row before this closure.
  return { ownedPaths: [...HOME_PATHS], retainedSource, background: { path: HOME_BACKGROUND_PATH, data: backgroundMarker }, write() {
    if (refreshRef) {
      transaction.update(refreshRef, { status: "superseded", supersededBy: operation.operationId });
      transaction.update(firestore.doc(HOME_PAGE_OWNER_PATH), { homeRefresh: {
        ...refresh, status: "superseded", supersededBy: operation.operationId } });
    }
    if (taskRef && !["verified", "superseded"].includes(task.status)) {
      transaction.update(taskRef, { status: "superseded", claim: null, nextAttemptAt: null });
    }
    transaction.set(firestore.doc(HOME_BACKGROUND_PATH), backgroundMarker);
  } };
}

/** Public Post changes also refresh the picker catalog when no shelf uses them.
 * No working Home fields or draft versions are copied into this durable signal. */
async function prepareHomePostRefreshInTransaction({ firestore, transaction, postId, nextDocument, queueId, affectedSections }) {
  return prepareHomeRefreshInTransaction({ firestore, transaction, queueId, prepareInput(owner) {
    if (!validId(postId) || !Array.isArray(affectedSections) ||
        !Number.isSafeInteger(nextDocument?.published?.sourceVersion) || nextDocument.published.sourceVersion < 1) refuse();
    const input = { postId, sourceOperationId: queueId, sourceVersion: nextDocument.published.sourceVersion,
      visible: publiclyVisible(nextDocument), homeSourceVersion: owner.sourceVersion, homeOperationId: owner.operationId };
    return { input, affectedSections, refreshIdentity: { postId, sourceVersion: input.sourceVersion } };
  } });
}

/** A full-build queue can settle multiple Posts. Freeze only the matching public
 * revisions in one task so the Page owner can prove their queue's success. */
async function prepareHomeFullBuildPostRefreshInTransaction({ firestore, transaction, queueId, posts, sourceTransport }) {
  return prepareHomeRefreshInTransaction({ firestore, transaction, queueId, prepareInput(owner, home) {
    if (!["serializer", "github"].includes(sourceTransport) || !Array.isArray(posts) || posts.length === 0) refuse();
    const postChanges = posts.map(({ postId, nextDocument }) => {
      const sourceVersion = nextDocument?.published?.sourceVersion;
      if (!validId(postId) || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) refuse();
      return { postId, sourceVersion, visible: publiclyVisible(nextDocument) };
    }).sort((left, right) => left.postId < right.postId ? -1 : left.postId > right.postId ? 1 : 0);
    if (new Set(postChanges.map(change => change.postId)).size !== postChanges.length) refuse();
    const input = { sourceTransport, postChanges, sourceOperationId: queueId,
      homeSourceVersion: owner.sourceVersion, homeOperationId: owner.operationId };
    const snapshot = home.published;
    const { homePostPlacements } = require("./home-source-catalog");
    const placements = posts.flatMap(({ postId, nextDocument }) => homePostPlacements({ blocks: snapshot.blocks,
      homeHero: snapshot.metadata?.homeHero }, postId,
      [nextDocument.published.metadata?.slug, ...(Array.isArray(nextDocument.published.metadata?.previousSlugs)
        ? nextDocument.published.metadata.previousSlugs : [])]
        .filter(slug => typeof slug === "string")));
    // Completion no longer has the previous public labels or complete owned
    // slug set. Conservatively invalidate every published section, including
    // copied legacy cards; current labels must not hide a former placement.
    const allSections = (snapshot.blocks ?? []).flatMap((block, index) => block.visible === false ? [] : [{
      blockId: block.id ?? `legacy-block-${index}`, section: block.section ?? "content",
      title: String(block.data?.title ?? block.section ?? "Home content"),
      refreshable: block.type === "content_shelf",
    }]);
    if (snapshot.metadata?.homeHero) allSections.push({ blockId: "hero", section: "hero",
      title: "Home hero", refreshable: true });
    const affectedSections = [...new Map([...allSections, ...placements]
      .map(section => [JSON.stringify([section.section, section.blockId]), section])).values()];
    return { input, affectedSections, refreshIdentity: { sourceTransport, postChanges } };
  } });
}

async function prepareHomeRefreshInTransaction({ firestore, transaction, queueId, prepareInput }) {
  const owner = await readHomePageAuthorityInTransaction({ firestore, transaction });
  if (!owner) return () => {};
  if (!validOperationId(queueId)) refuse();
  const home = (await transaction.get(firestore.doc("cmsPages/home"))).data();
  if (home?.published?.sourceVersion !== owner.sourceVersion || publiclyVisible(home) !== owner.visible) refuse();
  const { input, affectedSections, refreshIdentity } = prepareInput(owner, home);
  const taskRef = firestore.doc(`cmsPublishQueue/${queueId}/homePageRefresh/home`);
  const existing = (await transaction.get(taskRef)).data();
  if (existing) {
    if (!isDeepStrictEqual(existing.input, input)) refuse("Home refresh identity changed.");
    return () => {};
  }
  const revision = (owner.homeRefresh?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) refuse();
  const refresh = { schemaVersion: 1, revision, sourceOperationId: queueId, ...refreshIdentity,
    status: "pending", taskPath: taskRef.path };
  return () => {
    transaction.create(taskRef, { schemaVersion: 1, owner: HOME_PAGE_OWNER, pageId: "home", revision,
      input, affectedSections, status: "pending", runtime: owner.runtime, rendererSha: owner.rendererSha });
    transaction.update(firestore.doc(HOME_PAGE_OWNER_PATH), { homeRefresh: refresh });
  };
}

module.exports = { HOME_PAGE_OWNER_PATH, HOME_BACKGROUND_PATH, HOME_PAGE_OWNER, HOME_PATHS,
  isHomePageAuthority, homePageOwnsPath, readHomePageAuthorityInTransaction, readHomeSourcesInTransaction,
  prepareHomePlanInTransaction, prepareHomePostRefreshInTransaction, prepareHomeFullBuildPostRefreshInTransaction };
