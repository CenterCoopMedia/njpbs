"use strict";

const { runtimeFields, ownsPublication, samePublicationOwner, publicationRuntime } = require("./publication-runtime-owner");
const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { isServerMintableSlugShape } = require("./post-slug-contract");
const { collectPublishedMediaUsage, MediaUsageError } = require("./media-usage");
const { publiclyVisible } = require("./public-video-references");
const { cloudBillingPaused } = require("./no-build-cloud-work");
const { SLOW_RETRY_MS, backgroundFailure, publicationAttempt, publicationClaim, publicationFailure } = require("./background-output-attempt");

const { OUTPUTS, outputForPath, backgroundOutputForPath, canonicalPath, isBackgroundAssetPath } = require("./post-background-paths");
const { RECORD_FAMILIES, outputLimits } = require("./no-build-record-namespace");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const SUPPORTED_OUTPUTS = [...OUTPUTS, ...RECORD_FAMILIES];
const { storeRecordManifest, readRecordManifest } = require("./post-background-record-manifest");
const OWNER = "post-background-v1";
const LEASE_MS = 60_000;
const ATTEMPT_MS = 20_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
const WITHDRAWAL_STALE_MS = 60_000;
const ALERT_AFTER_MS = 5 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const fileKey = (task, path) => `${OWNER}/${task.output}/${task.claim}/${hash(path)}`;
const unique = values => [...new Set(values)].sort();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => hash(JSON.stringify(canonical(value)));
class BackgroundContractError extends Error {
  constructor(code = "background_contract_refused") { super("Background output contract refused"); this.code = code; }
}
function requireValue(condition) {
  if (!condition) throw new BackgroundContractError();
}
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }

// Keep dependency identities, never working fields or snapshot bodies, on the
// queue. All changes regenerate a complete family, including retired pages.
function dependency(document) {
  const snapshot = document?.published;
  if (!snapshot) return { visible: false, sourceVersion: null, digest: digest(null), slugs: [], authorIds: [], mediaIds: [] };
  const metadata = snapshot.metadata;
  requireValue(metadata?.type === "post" && Number.isSafeInteger(snapshot.sourceVersion) && snapshot.sourceVersion > 0);
  requireValue((metadata.previousSlugs === undefined || Array.isArray(metadata.previousSlugs)) &&
    (snapshot.authorIds === undefined || Array.isArray(snapshot.authorIds)) &&
    (metadata.credits === undefined || (Array.isArray(metadata.credits) && metadata.credits.every(credit => credit && typeof credit === "object"))));
  const slugs = [metadata.slug, ...(metadata.previousSlugs ?? [])];
  requireValue(slugs.length <= 100 && slugs.every(slug => typeof slug === "string" && slug.length <= 200 && isServerMintableSlugShape(slug)));
  const credits = [...(metadata.credits ?? []), ...(metadata.liveBlog?.updates ?? []).flatMap(entry =>
    [...entry.credits, ...(entry.withdrawal === undefined ? entry.followUps ?? [] : []).flatMap(reply => reply.credits)])];
  // Keep every hydrated identity in the dependency set, using the reader's
  // first-100 budget. Older extra identities fill only the remaining slots.
  const candidates = [...new Set([...credits.filter(credit => credit.kind === "registered")
    .map(credit => credit.authorId), ...(snapshot.authorIds ?? [])])];
  requireValue(candidates.every(validId));
  const authorIds = unique(candidates.slice(0, 100));
  const media = collectPublishedMediaUsage({ collection: "cmsPosts", snapshot });
  const visible = publiclyVisible(document);
  if (visible) requireValue(Number.isSafeInteger(document.version) && snapshot.sourceVersion <= document.version &&
    (!Number.isSafeInteger(document.publicSourceVersion) || snapshot.sourceVersion >= document.publicSourceVersion));
  // Private video cleanup history is not a public dependency.
  const publicSnapshot = { metadata, blocks: snapshot.blocks, publishedAt: snapshot.publishedAt,
    sourceVersion: snapshot.sourceVersion, authorIds, ...(snapshot.datasetFigures ? { datasetFigures: snapshot.datasetFigures } : {}) };
  return { visible, sourceVersion: snapshot.sourceVersion, digest: digest({ visible, publicSnapshot }),
    slugs: unique(slugs), authorIds, mediaIds: unique(media.assetIds),
    dates: { date: metadata.date ?? null, firstPublishedAt: metadata.firstPublishedAt ?? null,
      meaningfulUpdatedAt: metadata.meaningfulUpdatedAt ?? null },
    taxonomyDigest: digest([metadata.categories ?? [], metadata.tags ?? []]),
    canonicalPath: `/posts/${metadata.slug}/` };
}

// Page authority owns the root/catalog pair. Validate the durable pair before
// legacy background admission, recovery, readers or monitoring yield it.
async function pageOwnsHomeInTransaction({ firestore, transaction, marker }) {
  if (marker?.owner !== "page-no-build-v1") return false;
  requireValue(marker.schemaVersion === 1 && marker.pageId === "home" &&
    marker.ownerPath === "system/publicDeployment/noBuildPageOwners/home");
  const owner = (await transaction.get(firestore.doc(marker.ownerPath))).data();
  requireValue(owner?.pageId === "home" && Array.isArray(owner.ownedPaths) &&
    owner.ownedPaths.length === 2 && owner.ownedPaths.includes("/") && owner.ownedPaths.includes("/_home-sources.json"));
  return true;
}

function validateGenerationInput(generation, task) {
  const input = generation?.input;
  requireValue(input?.kind === "public-background" && /^[a-f0-9]{40}$/.test(input.rendererSha) && /^[a-f0-9]{64}$/.test(input.contextDigest) && Array.isArray(input.routes));
  requireValue(input.routes.length <= 10_000 && input.routes.every(route => canonicalPath(route.path) &&
    Number.isSafeInteger(route.sourceVersion) && route.sourceVersion > 0 && /^[a-f0-9]{64}$/.test(route.digest)));
  requireValue(new Set(input.routes.map(route => route.path)).size === input.routes.length);
  const after = task.dependencies.after;
  const current = input.routes.find(route => route.path === after.canonicalPath);
  if (!task.contextOnly && after.visible) requireValue(current?.sourceVersion === after.sourceVersion && current.digest === after.digest);
  for (const slug of task.contextOnly ? [] : task.dependencies.slugs) {
    const route = input.routes.find(value => value.path === `/posts/${slug}/`);
    if (!after.visible || route?.path !== after.canonicalPath) requireValue(!route);
  }
  return input;
}
function validateGeneration(generation, task) {
  const input = validateGenerationInput(generation, task);
  requireValue(Array.isArray(generation.files));
  const assets = generation.assets ?? [];
  requireValue(Array.isArray(assets) && assets.every(file => isBackgroundAssetPath(file.path)));
  requireValue(generation.files.length + assets.length <= outputLimits(task.output).files);
  let size = 0;
  const files = [...generation.files, ...assets].map(file => {
    requireValue(canonicalPath(file.path) && (backgroundOutputForPath(file.path) === task.output || assets.includes(file)) &&
      typeof file.contentType === "string" && file.contentType.length <= 128 && /^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/.test(file.contentType));
    requireValue(typeof file.bytes === "string" || file.bytes instanceof Uint8Array);
    const bytes = Buffer.from(file.bytes);
    size += bytes.length;
    requireValue(bytes.length <= MAX_BYTES && size <= outputLimits(task.output).bytes);
    return { path: file.path, contentType: file.contentType, bytes, digest: hash(bytes), size: bytes.length };
  });
  const paths = new Set(files.map(file => file.path));
  requireValue(paths.size === files.length);
  const manifest = files.map(file => ({ path: file.path, key: fileKey(task, file.path),
    digest: file.digest, size: file.size, contentType: file.contentType }));
  // Search and record lists live in the immutable artifact store. Other
  // families retain their original inline representation.
  if (task.output !== "search" && !RECORD_FAMILIES.includes(task.output)) requireValue(Buffer.byteLength(JSON.stringify(manifest)) <= 800 * 1024);
  const required = { home: ["/", "/_home-sources.json"], listings: ["/posts/"], feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json"],
    search: ["/pagefind/pagefind.js", "/search/meaning-index.json"], programs: ["/programs/", "/shows/"], events: ["/events/"] }[task.output] ?? [];
  requireValue(required.every(path => paths.has(path)));
  let homeSource = null;
  if (task.output === "home") {
    const snapshot = JSON.parse(files.find(file => file.path === "/_home-sources.json").bytes.toString("utf8"));
    homeSource = require("./home-source-selection-admission").assertHomeCatalogReceipt(snapshot.editorial);
    requireValue(homeSource.receipt.commitSha === input.rendererSha &&
      snapshot.publication?.buildBatchId === homeSource.receipt.buildBatchId &&
      snapshot.publication?.generation === homeSource.receipt.generation &&
      snapshot.publication?.commitSha === homeSource.receipt.commitSha);
  }
  if (task.output === "sitemap") requireValue(paths.has("/sitemap-index.xml") || paths.has("/sitemap.xml"));
  return { files, homeSource, hasAssets: Array.isArray(generation.assets), rendererSha: input.rendererSha, contextDigest: input.contextDigest, routeSetDigest: digest([...input.routes].sort((a, b) => a.path.localeCompare(b.path))) };
}
function bounded(work, signal) {
  signal.throwIfAborted();
  let abort;
  const timeout = new Promise((_, reject) => {
    abort = () => reject(new Error("Background output deadline"));
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => signal.removeEventListener("abort", abort));
}
function unavailable() {
  return new Response("Content is being updated.", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
}

// The last successful manifest survives failed or superseded replacements.
function lastGood(state) {
  return state?.status === "verified" && state.receipt?.revision === state.revision &&
    Number.isSafeInteger(state.revision) && state.revision > 0 &&
    /^[a-f0-9]{64}$/.test(state.contextDigest) && state.receipt.contextDigest === state.contextDigest
    ? { receipt: state.receipt, after: state.after } : state?.lastGood ?? null;
}
function backgroundHealth(state, source, context, now, rebuildAfterMs = ALERT_AFTER_MS) {
  requireValue(state.owner === OWNER && state.schemaVersion === 1);
  const good = lastGood(state);
  const releaseKnown = /^[a-f0-9]{40}$/.test(good?.receipt.rendererSha);
  const releaseMatches = releaseKnown && good.receipt.rendererSha === context.rendererSha;
  const releaseCompatible = releaseKnown && (releaseMatches || Array.isArray(good.receipt.assets));
  const current = releaseMatches && state.status === "verified" && good?.receipt === state.receipt &&
    source.digest === state.after.digest && context.digest === state.receipt.contextDigest;
  const withdrawal = good && (context.withdrawalRevision !== (good.receipt.withdrawalRevision ?? 0) ||
    (!state.contextOnly && !source.visible && good.after.visible));
  // Repeated removals must not extend exposure of an earlier removal. The pilot
  // carries its first atomic deadline. Other removals use verification + 60s.
  const pilotDeadline = state.withdrawalDeadlineRevision === context.withdrawalRevision ? state.withdrawalDeadline : null;
  const withdrawalDeadline = withdrawal ? pilotDeadline ??
    Math.min(good.receipt.verifiedAt, good.receipt.sourceReadAt ?? good.receipt.verifiedAt) + WITHDRAWAL_STALE_MS : Infinity;
  const expiresAt = current ? null : Math.min(good ? good.receipt.verifiedAt + MAX_STALE_MS : 0, withdrawalDeadline);
  const pendingSince = state.pendingSince ?? context.changedAt ?? good?.receipt.verifiedAt ?? now;
  const searchLimits = outputLimits("search");
  const searchBytes = good?.receipt.totalBytes ?? [...(good?.receipt.manifest ?? []), ...(good?.receipt.assets ?? [])]
    .reduce((sum, file) => sum + file.size, 0);
  const reason = good && !releaseCompatible ? "release_mismatch" :
    !current && withdrawal && now >= withdrawalDeadline ? "withdrawal_expired" :
    !current && good && now >= expiresAt ? "stale_expired" :
    !current && now - Math.max(pendingSince, context.progressAt ?? 0) >= rebuildAfterMs ? "rebuild_delayed" :
    good && !releaseMatches ? "release_pending" :
    current && state.output === "search" &&
      ((good.receipt.fileManifest?.count ?? good.receipt.manifest.length + (good.receipt.assets?.length ?? 0)) >= Math.ceil(searchLimits.files * 0.8) ||
        searchBytes >= Math.ceil(searchLimits.bytes * 0.8))
      ? "search_capacity" : null;
  // Expose the existing serving fence for notification routing. Detection and
  // the reader's safety limits remain independent of Telegram delivery.
  const servingBlocked = !good || !releaseCompatible || !current && now >= expiresAt;
  return { good, current, expiresAt, reason, pendingSince, releaseCompatible, servingBlocked };
}
function selectServingState(state, source, context, now) {
  const health = backgroundHealth(state, source, context, now);
  requireValue(health.good?.receipt && Number.isFinite(health.good.receipt.verifiedAt));
  // Renderer changes require regeneration, not a reader outage. The same
  // authoritative removal and age limits apply throughout the release gap.
  // A normal Home publication replaces its saved selection. An older immutable
  // Home must yield to Assets until a generation includes that publication.
  requireValue(state.output !== "home" || (context.homeRevision ?? 0) === (health.good.receipt.homeRevision ?? 0));
  requireValue(health.releaseCompatible && (health.current || now < health.expiresAt));
  return { receipt: health.good.receipt, stale: !health.current, expiresAt: health.expiresAt };
}

// The atomic publication owner and authenticated reader compose this Node
// contract. The existing locked publisher supplies generation and storage.
function createPostBackgroundOutputs({ firestore, enabled = false, accepting = enabled, postIds = [], contentApiEnabled = false, recoveryOutputs = OUTPUTS,
  runtime, build, artifacts, readContextInTransaction, searchFileCount = 0, now = () => Date.now() } = {}) {
  requireValue(postIds.length <= 1 && postIds.every(validId));
  requireValue(Number.isSafeInteger(searchFileCount) && searchFileCount >= 0 && searchFileCount <= outputLimits("search").files);
  requireValue(!enabled || typeof readContextInTransaction === "function");
  if (runtime !== undefined) publicationRuntime(runtime);
  const owns = record => runtime === undefined ? record.runtime === undefined : ownsPublication(record, runtime);
  requireValue(Array.isArray(recoveryOutputs) && recoveryOutputs.every(output => SUPPORTED_OUTPUTS.includes(output)));
  const defaultOutputs = OUTPUTS.filter(output => output !== "home" && (output !== "contentApi" || contentApiEnabled));
  const stateRef = output => firestore.doc(`cmsBackgroundOutputs/${output}`);
  async function currentContext(transaction, output) {
    const context = await readContextInTransaction(transaction, output);
    requireValue(/^[a-f0-9]{40}$/.test(context?.rendererSha) && /^[a-f0-9]{64}$/.test(context?.digest) && Number.isSafeInteger(context.withdrawalRevision) && context.withdrawalRevision >= 0);
    requireValue(Number.isSafeInteger(context.homeRevision ?? 0) && (context.homeRevision ?? 0) >= 0);
    return context;
  }
  const validHomePaths = paths => Array.isArray(paths) && (paths.length === 0 || (paths.length === 1 && paths[0] === "/"));
  const changedDependencies = (before, after, homePlacementPaths = []) => ({ before, after, slugs: unique([...before.slugs, ...after.slugs]),
    authorIds: unique([...before.authorIds, ...after.authorIds]), mediaIds: unique([...before.mediaIds, ...after.mediaIds]),
    homePlacementPaths });

  async function prepareKnownInTransaction({ transaction, queueId, postId, nextDocument, homePlacementPaths }) {
    if (!enabled || !accepting || !postIds.includes(postId)) return () => {};
    requireValue(validId(queueId) && validHomePaths(homePlacementPaths));
    // Once Home has a manifest, the same owner keeps it current even when the
    // next saved Home removes its last Post selection.
    const homeState = (await transaction.get(stateRef("home"))).data();
    const pageOwnsHome = homeState?.owner === "page-no-build-v1";
    if (pageOwnsHome) await pageOwnsHomeInTransaction({ firestore, transaction, marker: homeState });
    const aggregate = (await transaction.get(firestore.doc("system/publicDeployment/aggregateContexts/current"))).data();
    // The cloud aggregate keeps final namespace ownership across context and
    // release changes. This fence does not claim that its bytes are complete.
    if (aggregate?.finalNamespaceOwner === true) requireValue(aggregate.schemaVersion === 1 &&
      aggregate.runtime?.owner === "cloudflare" && /^[a-f0-9]{40}$/.test(aggregate.runtime.release ?? "") &&
      /^[A-Za-z0-9]{20}$/.test(aggregate.operationId ?? "") && /^[A-Za-z0-9]{20}$/.test(aggregate.preparationOperationId ?? "") &&
      /^[A-Za-z0-9]{20}$/.test(aggregate.namespaceOperationId ?? "") &&
      Number.isSafeInteger(aggregate.contextRevision) && aggregate.contextRevision > 0 && /^[a-f0-9]{64}$/.test(aggregate.contextDigest ?? ""));
    const namespaceOutputs = aggregate?.finalNamespaceOwner === true ? [] : defaultOutputs;
    const activeOutputs = !pageOwnsHome && (homePlacementPaths.length || homeState) ? ["home", ...namespaceOutputs] : namespaceOutputs;
    if (!activeOutputs.length) return () => {};
    const after = dependency(nextDocument);
    const taskRefs = activeOutputs.map(output => firestore.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`));
    const existing = await transaction.getAll(...taskRefs);
    const identity = digest({ postId, after, activeOutputs,
      ...(homePlacementPaths.length ? { homePlacementPaths } : {}) });
    if (existing.some(row => row.exists)) {
      if (!existing.every(row => row.data()?.identity === identity && owns(row.data()))) throw new BackgroundContractError("background_identity_conflict");
      return () => {};
    }
    const before = dependency((await transaction.get(firestore.doc(`cmsPosts/${postId}`))).data());
    if (before.digest === after.digest) return () => {};
    const states = await transaction.getAll(...activeOutputs.map(stateRef));
    requireValue(states.every(row => !row.exists || (row.data().schemaVersion === 1 && row.data().owner === OWNER &&
      typeof row.data().taskPath === "string" && /^cmsPublishQueue\/[A-Za-z0-9_-]{1,200}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(row.data().taskPath))));
    const previousRefs = states.filter(row => row.exists).map(row => firestore.doc(row.data().taskPath));
    const previous = previousRefs.length ? await transaction.getAll(...previousRefs) : [];
    requireValue(previous.every(row => row.exists && row.data().schemaVersion === 1 && row.data().owner === OWNER));
    const context = await currentContext(transaction);
    const dependencies = changedDependencies(before, after, homePlacementPaths);
    return () => {
      for (const row of previous) {
        if (row.exists && row.data().status !== "verified") transaction.update(row.ref,
          { status: "superseded", claim: null, nextAttemptAt: null });
      }
      activeOutputs.forEach((output, index) => {
        const previousState = states[index].data();
        const good = lastGood(previousState);
        const withdrawal = before.visible && !after.visible;
        const priorRemoval = good && context.withdrawalRevision !== (good.receipt.withdrawalRevision ?? 0);
        const withdrawalDeadline = previousState?.withdrawalDeadline ?? (withdrawal ?
          Math.min(now() + WITHDRAWAL_STALE_MS, priorRemoval ? good.receipt.verifiedAt + WITHDRAWAL_STALE_MS : Infinity) : null);
        const revision = (states[index].data()?.revision ?? 0) + 1;
        const task = { ...runtimeFields(runtime), schemaVersion: 1, owner: OWNER, output, revision, identity, postId, dependencies, contextDigest: null,
          status: "pending", attempts: 0, claim: null, nextAttemptAt: now(), error: null };
        transaction.create(taskRefs[index], task);
        transaction.set(stateRef(output), { ...runtimeFields(runtime), schemaVersion: 1, owner: OWNER, output, revision, postId,
          taskPath: taskRefs[index].path, after, contextDigest: null, status: "pending", receipt: null,
          previousAssets: previousState?.previousAssets ?? null, lastGood: good, pendingSince: previousState?.pendingSince ?? now(), withdrawalDeadline,
          withdrawalDeadlineRevision: withdrawal ? context.withdrawalRevision + 1 : previousState?.withdrawalDeadlineRevision ?? null });
      });
    };
  }

  async function prepareInTransaction(input) {
    try { return await prepareKnownInTransaction(input); }
    catch (error) {
      const withdrawal = !publiclyVisible(input.nextDocument);
      const contractFailure = error instanceof BackgroundContractError || error instanceof MediaUsageError;
      if (!withdrawal || !contractFailure || error.code === "background_identity_conflict" || !validId(input.queueId) ||
          !postIds.includes(input.postId) || !validHomePaths(input.homePlacementPaths)) throw error;
      // Withdrawal cannot wait for repair of obsolete background metadata. The
      // current-source check (or unknown-schema refusal) already closes every
      // admitted family when this same transaction makes the Post invisible.
      // Keep the failure on the addressed queue without downgrading its detail
      // receipt or overwriting a newer background schema. Database errors still
      // abort/retry the transaction, and conflicting queue identities stay refused.
      return Object.assign(() => input.transaction.set(firestore.doc(`cmsPublishQueue/${input.queueId}/backgroundOutputs/_admission`),
        { ...runtimeFields(runtime), schemaVersion: 1, owner: OWNER, postId: input.postId, stage: "preparation", status: "failed",
          error: "background_preparation_failed", nextAttemptAt: null }), { preparationFailed: true });
    }
  }

  async function attempt(output) {
    // The frozen preparation supplies the count before retained-byte reads.
    // Budget one second per bounded batch plus manifest overhead; keep the
    // existing minimum and 40-second claim settlement margin.
    const attemptMs = output === "search" ? Math.max(ATTEMPT_MS, 2_000 + Math.ceil(searchFileCount / 8) * 1_000) : ATTEMPT_MS;
    const leaseMs = Math.max(LEASE_MS, attemptMs + 40_000);
    const claimed = await firestore.runTransaction(async transaction => {
      if (await cloudBillingPaused({ runtime,
        read: async path => (await transaction.get(firestore.doc(path))).data() ?? null })) return null;
      const state = (await transaction.get(stateRef(output))).data();
      if (!state) return null;
      // A Post preparation cannot replace the explicitly selected aggregate
      // namespace while its frozen cohort is finishing an older context.
      if (postIds.length > 0 && state.contextOnly === true) return null;
      if (output === "home" && await pageOwnsHomeInTransaction({ firestore, transaction, marker: state })) return null;
      requireValue(state.owner === OWNER && state.schemaVersion === 1);
      // Let the single predecessor graph's original cache grace finish before
      // another handoff can replace it. Publication/removal fences still advance.
      if (state.previousAssets?.expiresAt > now()) return null;
      let ref = firestore.doc(state.taskPath);
      let task = (await transaction.get(ref)).data();
      requireValue(task?.owner === OWNER && task.schemaVersion === 1 && task.revision === state.revision);
      const sameRelease = owns(state) && owns(task);
      if (!sameRelease) {
        if (!runtime || !samePublicationOwner(state, runtime) || !samePublicationOwner(task, runtime)) return null;
        const active = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
        if (active?.state !== "idle" || active.activeCommitSha !== runtime.release) return null;
      }
      const context = await currentContext(transaction, output);
      const contextDigest = context.digest;
      const recordContextRevision = RECORD_FAMILIES.includes(output)
        ? context.contextRevision ?? await readPublicContextRevisionInTransaction(transaction, firestore) : null;
      if (recordContextRevision !== null) requireValue(publicContextDigest(recordContextRevision) === contextDigest);
      const source = state.contextOnly ? dependency(null) : dependency((await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data());
      const changed = !sameRelease || (state.status === "verified" && state.receipt?.rendererSha !== context.rendererSha) ||
        (state.contextDigest !== null && state.contextDigest !== contextDigest) || source.digest !== state.after.digest;
      if (changed) {
        // A public-context change makes the prior manifest stale. The same
        // recovery owner creates a
        // new generation; a pilot edit is not required to refresh shared output.
        const revision = state.revision + 1;
        requireValue(Number.isSafeInteger(revision));
        if (task.status !== "verified") transaction.update(ref, { status: "superseded", claim: null, nextAttemptAt: null });
        ref = ref.parent.doc(`${output}-${revision}`);
        task = { ...task, ...runtimeFields(runtime), revision, dependencies: changedDependencies(state.after, source, task.dependencies.homePlacementPaths), contextDigest,
          status: "pending", attempts: 0, claim: null, nextAttemptAt: now(), error: null, receipt: null, lastAttempt: null, slowRetryAt: null };
        transaction.update(stateRef(output), { ...runtimeFields(runtime), revision, taskPath: ref.path, after: source, contextDigest, status: "pending", receipt: null,
          lastGood: lastGood(state), pendingSince: state.pendingSince ?? context.changedAt ?? now() });
      } else if (state.status === "verified") return null;
      const decision = publicationAttempt(task, "background", now());
      if (!decision) return null;
      if (decision === "exhaust") {
        // An interrupted final claim still gets a terminal outcome and a slow
        // retry. Do not let an expired lease become a permanent silent stop.
        const interrupted = typeof task.claim === "string";
        const lastAttempt = { attempt: task.attempts, startedAt: task.startedAt ?? now() - leaseMs,
          durationMs: Math.max(0, now() - (task.startedAt ?? now() - leaseMs)), budgetMs: attemptMs,
          failureClass: interrupted ? "lease_lost" : "validation", retryable: interrupted };
        transaction.update(ref, { ...publicationFailure(task, "background", now()), error: "background_retry_exhausted",
          lastAttempt, slowRetryAt: interrupted ? now() + SLOW_RETRY_MS : null });
        if (/^[a-f0-9-]{36}$/.test(task.claim ?? "")) transaction.set(ref.collection("attempts").doc(task.claim), lastAttempt);
        transaction.update(stateRef(output), { status: "failed" });
        return null;
      }
      const claim = randomUUID();
      const next = { ...task, ...runtimeFields(runtime), contextDigest, rendererSha: context.rendererSha,
        ...(context.sourceReadAt === undefined ? {} : { sourceReadAt: context.sourceReadAt }),
        ...(recordContextRevision === null ? {} : { recordContextRevision }),
        // Staff retries reset attempts on the same task. Re-arm its notices once.
        alertEpoch: task.attempts === 0 ? claim : task.alertEpoch ?? null,
        lastAttempt: task.attempts === 0 ? null : task.lastAttempt ?? null,
        withdrawalRevision: context.withdrawalRevision, homeRevision: context.homeRevision ?? 0,
        startedAt: now(), slowRetryAt: null, ...publicationClaim(task, claim, now(), leaseMs) };
      if (changed) transaction.create(ref, next);
      else transaction.set(ref, next);
      if (!changed) transaction.update(stateRef(output), { ...runtimeFields(runtime), contextDigest });
      return { ...next, taskPath: ref.path };
    });
    if (!claimed) return;
    let receipt = null;
    let homeSource = null;
    const signal = AbortSignal.timeout(attemptMs);
    let stage = "validation";
    let failure = { failureClass: "validation", retryable: false };
    try {
      receipt = await bounded(async () => {
        const generation = await build(claimed, { signal });
        const input = validateGenerationInput(generation, claimed);
        let prepared;
        if (generation.prepared) {
          stage = "storage";
          prepared = await require("./post-background-record-checkpoint").readPreparedRecordManifest({
            firestore, artifacts, task: claimed, reference: generation.prepared, signal });
          stage = "validation";
          requireValue(isDeepStrictEqual(prepared.routes, input.routes));
        }
        const generated = prepared ? { homeSource: null, files: [], hasAssets: true,
          rendererSha: input.rendererSha, contextDigest: input.contextDigest,
          routeSetDigest: digest([...input.routes].sort((a, b) => a.path.localeCompare(b.path))) } : validateGeneration(generation, claimed);
        requireValue(generated.contextDigest === claimed.contextDigest && generated.rendererSha === claimed.rendererSha);
        requireValue(output !== "search" || searchFileCount === 0 || generated.files.length === searchFileCount);
        homeSource = generated.homeSource;
        const manifest = prepared?.manifest ?? [];
        stage = "storage";
        async function storeFile(file) {
          signal.throwIfAborted();
          const key = fileKey(claimed, file.path);
          await artifacts.put(key, file.bytes, { contentType: file.contentType, signal });
          const readback = await artifacts.get(key, { signal });
          requireValue(readback instanceof Uint8Array && hash(readback) === file.digest);
          return { path: file.path, key, digest: file.digest, size: file.size, contentType: file.contentType };
        }
        // Search and record catalogs have many independent files. Keep one bounded I/O
        // batch; retain source order and the existing deadline/readback fence.
        const width = output === "search" || RECORD_FAMILIES.includes(output) ? 8 : 1;
        for (let offset = 0; offset < generated.files.length; offset += width) {
          manifest.push(...await Promise.all(generated.files.slice(offset, offset + width).map(storeFile)));
        }
        const fileManifest = output === "search" || RECORD_FAMILIES.includes(output) ? await storeRecordManifest({ manifest, task: claimed, artifacts, signal, checkpoint: generation.prepared }) : null;
        return { ...runtimeFields(claimed.runtime), revision: claimed.revision, rendererSha: generated.rendererSha, contextDigest: generated.contextDigest, routeSetDigest: generated.routeSetDigest,
          ...(RECORD_FAMILIES.includes(output) ? { recordContextRevision: claimed.recordContextRevision } : {}),
          ...(output === "search" ? { totalBytes: manifest.reduce((sum, file) => sum + file.size, 0) } : {}),
          manifest: fileManifest ? [] : manifest.filter(file => !isBackgroundAssetPath(file.path)),
          ...(fileManifest ? { fileManifest, assets: [] } : generated.hasAssets ? { assets: manifest.filter(file => isBackgroundAssetPath(file.path)) } : {}),
          ...(homeSource ? { homeSourceReceipt: homeSource.receipt } : {}),
          digest: digest(manifest), verifiedAt: now(), ...(claimed.sourceReadAt === undefined ? {} : { sourceReadAt: claimed.sourceReadAt }),
          withdrawalRevision: claimed.withdrawalRevision, homeRevision: claimed.homeRevision };
      }, signal);
    } catch (error) { failure = backgroundFailure(error, signal, stage); }
    await firestore.runTransaction(async transaction => {
      const state = (await transaction.get(stateRef(output))).data();
      const ref = firestore.doc(claimed.taskPath);
      const current = (await transaction.get(ref)).data();
      const source = claimed.contextOnly ? dependency(null) : dependency((await transaction.get(firestore.doc(`cmsPosts/${claimed.postId}`))).data());
      const context = await currentContext(transaction, output);
      const contextDigest = context.digest;
      const attempt = { attempt: claimed.attempts, startedAt: claimed.startedAt,
        durationMs: Math.max(0, now() - claimed.startedAt), budgetMs: attemptMs };
      if (!state || !current || !owns(state) || !owns(current) || state?.taskPath !== claimed.taskPath || state.revision !== claimed.revision || current?.claim !== claimed.claim) {
        transaction.set(ref.collection("attempts").doc(claimed.claim), { ...attempt, failureClass: "lease_lost", retryable: true });
        return;
      }
      if (context.rendererSha !== claimed.rendererSha || source.digest !== claimed.dependencies.after.digest || contextDigest !== claimed.contextDigest) {
        receipt = null;
        failure = { failureClass: "context_changed", retryable: false };
      } else if (now() >= current.nextAttemptAt) {
        receipt = null;
        failure = { failureClass: "lease_lost", retryable: true };
      }
      const catalogRef = receipt && homeSource ? firestore.collection(require("./home-source-selection-admission").HOME_CATALOGS_COLLECTION)
        .doc(homeSource.receipt.buildBatchId) : null;
      const retainedCatalog = catalogRef ? await transaction.get(catalogRef) : null;
      if (retainedCatalog?.exists && !isDeepStrictEqual(retainedCatalog.data(), homeSource)) {
        receipt = null;
        failure = { failureClass: "validation", retryable: false };
      }
      const status = receipt ? "verified" : "failed";
      const prior = lastGood(state);
      // One graph only, for the 15s edge entries filled before this handoff.
      // Never chain predecessors or retain their listing bytes.
      const assetIdentity = receipt => receipt.fileManifest?.digest ?? digest((receipt.assets ?? []).map(({ path, digest, size, contentType }) =>
        ({ path, digest, size, contentType })).sort((a, b) => a.path.localeCompare(b.path)));
      const previousAssets = receipt && (prior?.receipt.fileManifest || prior?.receipt.assets?.length) &&
        assetIdentity(prior.receipt) !== assetIdentity(receipt) ? {
          good: { receipt: { ...prior.receipt, manifest: [] }, after: prior.after }, expiresAt: now() + 15_000,
          withdrawalDeadline: state.withdrawalDeadline ?? null,
          withdrawalDeadlineRevision: state.withdrawalDeadlineRevision ?? null,
        } : state.previousAssets ?? null;
      const lastAttempt = { ...attempt, ...(receipt ? { failureClass: null, retryable: false } : failure) };
      const outcome = receipt ? { status, claim: null, nextAttemptAt: null, error: null } : publicationFailure(claimed, "background", now());
      transaction.set(ref.collection("attempts").doc(claimed.claim), lastAttempt);
      transaction.update(ref, { ...outcome, receipt, lastAttempt,
        slowRetryAt: !receipt && outcome.nextAttemptAt === null && failure.retryable ? now() + SLOW_RETRY_MS : null });
      transaction.update(stateRef(output), { status, receipt,
        ...(receipt ? { previousAssets, lastGood: { receipt, after: source }, pendingSince: null, withdrawalDeadline: null, withdrawalDeadlineRevision: null } : {}) });
      if (receipt && catalogRef && !retainedCatalog.exists) transaction.create(catalogRef, homeSource);
    });
  }

  async function recover() {
    if (!enabled) return;
    requireValue(typeof build === "function" && typeof artifacts?.put === "function" && typeof artifacts?.get === "function");
    const started = now();
    // This is the only recovery owner. Fixed family reads avoid queue scans or
    // competition with serializer claims; one failed family cannot stop another.
    for (const output of recoveryOutputs) {
      if (now() - started >= 45_000) break;
      try { await attempt(output); } catch { /* Durable task/lease remains recoverable. */ }
    }
  }

  async function authorizedState(output, assetPath) {
    const authority = await firestore.runTransaction(async transaction => {
      const state = (await transaction.get(stateRef(output))).data();
      if (!state) return null;
      if (output === "home" && await pageOwnsHomeInTransaction({ firestore, transaction, marker: state })) return null;
      const source = state.contextOnly ? dependency(null) : dependency((await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data());
      return { state, source, context: await currentContext(transaction) };
    }, { readOnly: true });
    if (!authority) return null;
    const { state, source, context } = authority;
    if (assetPath) {
      const good = lastGood(state);
      const selected = good && await receiptFiles(good.receipt, output, AbortSignal.timeout(ATTEMPT_MS));
      if (!selected?.some(file => file.path === assetPath)) {
        const previous = state.previousAssets;
        if (!previous?.good || previous.expiresAt <= now()) return null;
        const files = await receiptFiles(previous.good.receipt, output, AbortSignal.timeout(ATTEMPT_MS));
        if (!files.some(file => file.path === assetPath)) return null;
        const prior = selectServingState({ ...state, status: "pending", receipt: null, lastGood: previous.good,
          withdrawalDeadline: previous.withdrawalDeadline, withdrawalDeadlineRevision: previous.withdrawalDeadlineRevision }, source, context, now());
        return { ...prior, expiresAt: Math.min(prior.expiresAt, previous.expiresAt) };
      }
    }
    return selectServingState(state, source, context, now());
  }
  async function receiptFiles(receipt, output, signal) {
    if (!receipt.fileManifest) return [...receipt.manifest, ...(receipt.assets ?? [])];
    const files = await readRecordManifest({ receipt, output, artifacts, signal, scope: firestore.projectId });
    requireValue(digest(files) === receipt.digest);
    return files;
  }

  async function serve(request) {
    let path = new URL(request.url).pathname;
    let output = backgroundOutputForPath(path);
    const asset = isBackgroundAssetPath(path);
    let malformed = false;
    for (let count = 0; count < 32 && /%[a-f0-9]{2}/i.test(path); count++) {
      try { path = decodeURIComponent(path); }
      catch {
        path = path.replace(/%[a-f0-9]{2}/gi, value => String.fromCharCode(parseInt(value.slice(1), 16)));
        malformed = true;
      }
      output ??= backgroundOutputForPath(path);
    }
    if (/%[a-f0-9]{2}/i.test(path)) return unavailable();
    if (!output && !asset) return null;
    if (malformed || !canonicalPath(path)) return unavailable();
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { "Cache-Control": "no-store" } });
    if (asset) {
      // Only manifests still eligible for readers can expose their old graph.
      // No release history or arbitrary storage path is addressable.
      let failed = false;
      for (const family of SUPPORTED_OUTPUTS) {
        const response = await serveOutput(request, path, family);
        if (response?.status === 200) return response;
        failed ||= response?.status === 503;
      }
      return failed ? unavailable() : new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return serveOutput(request, path, output);
  }

  async function serveOutput(request, path, output) {
    try {
      let state = await authorizedState(output, isBackgroundAssetPath(path) ? path : null);
      // Disabling admission never discards an existing fence or tombstone.
      if (!state) return null;
      const lookupPath = path.endsWith("/index.html") ? path.slice(0, -10) : /^\/(posts|programs|shows|events)$/.test(path) ? `${path}/` : path;
      const signal = AbortSignal.timeout(ATTEMPT_MS);
      for (let attempt = 0; attempt < 2; attempt++) {
        const files = await receiptFiles(state.receipt, output, signal);
        const file = files.find(value => value.path === lookupPath);
        if (!file) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
        const bytes = await bounded(() => artifacts.get(file.key, { signal }), signal);
        requireValue(bytes instanceof Uint8Array && bytes.length === file.size && hash(bytes) === file.digest);
        const current = await authorizedState(output, isBackgroundAssetPath(path) ? path : null);
        requireValue(current);
        // A successful replacement during this read is a normal handoff.
        if (current.receipt.digest !== state.receipt.digest) { state = current; continue; }
        return new Response(request.method === "HEAD" ? null : bytes, { status: 200,
          headers: { "Cache-Control": "no-store", "Content-Type": file.contentType, "X-Content-Type-Options": "nosniff",
            "X-Njpbs-Background-Renderer-Sha": current.receipt.rendererSha,
            "X-Njpbs-Background-Context-Sha256": current.receipt.contextDigest,
            ...(RECORD_FAMILIES.includes(output) ? { "X-Njpbs-Background-Context-Revision": String(current.receipt.recordContextRevision) } : {}),
            "X-Njpbs-Background-Revision": String(current.receipt.revision),
            ...(Array.isArray(current.receipt.assets) ? { "X-Njpbs-Background-Assets": "verified" } : {}),
            "X-Njpbs-Background-State": current.stale ? "stale" : "current",
            "X-Njpbs-Background-Verified-At": String(current.receipt.verifiedAt),
            ...(current.expiresAt === null ? {} : { "X-Njpbs-Background-Expires-At": String(current.expiresAt) }) } });
      }
      return unavailable();
    } catch { return unavailable(); }
  }
  return { prepareInTransaction, recover, serve };
}

module.exports = { createPostBackgroundOutputs, outputForPath, backgroundOutputForPath, dependency, lastGood,
  MAX_STALE_MS, WITHDRAWAL_STALE_MS, ALERT_AFTER_MS, backgroundHealth, selectServingState, OUTPUTS, SUPPORTED_OUTPUTS, isBackgroundAssetPath, pageOwnsHomeInTransaction };
