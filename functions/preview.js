"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { Timestamp } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { hasPreviewAccess } = require("./lib/preview-access");
const { waitForPreviewStatus } = require("./lib/preview-status-wait");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
} = require("./lib/audit");
const { assertBillingEnabled } = require("./lib/billing-state");
const previewPairs = require("./lib/cms-preview-pair");
const {
  createPreviewSnapshot,
  createPostPreviewSnapshot,
  referencedPreviewAssetIds,
  createPreviewAssetSnapshot,
} = require("./lib/preview-snapshot");
const { withFrozenCredits } = require("./lib/story-credit-directory");
const { previewVideoState, previewVideosCurrent, withPreviewVideos } = require("./lib/public-video");
const {
  PREVIEW_HEADS_COLLECTION,
  PREVIEW_REFRESH_MS,
  PREVIEW_TTL_MS,
  previewExpiryMillis,
  timestampToMillis,
  validPreviewTarget,
  previewContentKey,
  previewTargetPath,
} = require("./lib/preview-target");
const {
  PREVIEW_BUILD_TIMEOUT_MS,
  PREVIEW_BUILD_TIMEOUT_ERROR,
} = require("./lib/preview-build-policy");

const PREVIEW_ASSET_READ_BATCH_SIZE = 20;
async function withFrozenDatasetFigures({ firestore, transaction, snapshot, collection }) {
  const owner = collection === "cmsPosts" ? snapshot.published : snapshot;
  if (!require("./lib/dataset-dependencies").figureBlocks(owner).length) return snapshot;
  const blocks = owner.blocks.filter(block => block.type !== "data_figure" || require("./lib/data-figure").isDataFigureData(block.data, true));
  const frozen = await require("./lib/dataset-dependencies").resolveDatasetFiguresInTransaction({ firestore, transaction,
    snapshot: { ...owner, blocks } });
  const next = { ...owner, ...(frozen.datasetFigures ? { datasetFigures: frozen.datasetFigures } : {}) };
  return collection === "cmsPosts" ? { ...snapshot, published: next } : next;
}
async function previewDatasetFiguresCurrent({ firestore, transaction, snapshot, collection }) {
  try {
    const current = await withFrozenDatasetFigures({ firestore, transaction, snapshot, collection });
    const field = value => (collection === "cmsPosts" ? value.published : value)?.datasetFigures ?? null;
    return require("./lib/dataset-dependencies").digest(field(current)) === require("./lib/dataset-dependencies").digest(field(snapshot));
  } catch { return false; }
}

const PREVIEW_RENDERER_SHA = defineString("CMS_PREVIEW_RENDERER_SHA", {
  default: "",
});
const PREVIEW_TRANSPORT = defineString("CMS_PREVIEW_TRANSPORT", {
  default: "serializer",
});
const PREVIEW_SERIALIZER_READY = defineString(
  "CMS_PREVIEW_SERIALIZER_READY",
  { default: "false" },
);
const SERIALIZER_TRANSPORT = "serializer";
const QUEUE_COLLECTION = "cmsPreviewQueue";
const QUEUE_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;
const NON_TERMINAL_STATUSES = new Set(["pending", "building"]);
const CLIENT_PREVIEW_ERROR_CODES = new Set([
  "preview-renderer-updating",
  "preview-version-unavailable",
]);
const RENDERER_NOT_CONFIGURED_ERROR =
  "Preview pipeline is not configured: reviewed renderer revision not confirmed";
const SERIALIZER_NOT_READY_ERROR =
  "Preview pipeline is not configured: serializer service not confirmed ready";
const INVALID_PREVIEW_TRANSPORT_ERROR =
  "Preview pipeline is not configured: preview transport is invalid";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const EMULATOR_RENDERER_SHA = "0000000000000000000000000000000000000000";
const PUBLIC_STATUSES = new Set([
  "pending",
  "building",
  "ready",
  "failed",
  "expired",
]);
const PREVIEW_FORBIDDEN_MESSAGE =
  "You do not have permission to preview this record";

class PreviewRequestError extends Error {
  constructor(message, status = 400, fields = {}) {
    super(message);
    this.name = "PreviewRequestError";
    this.status = status;
    Object.assign(this, fields);
  }
}

function assertPreviewReadCapability(principal) {
  if (!hasPreviewAccess(principal)) {
    throw new PreviewRequestError(PREVIEW_FORBIDDEN_MESSAGE, 403);
  }
}

async function assertStoredPreviewAccess(
  firestore,
  collection,
  pageId,
) {
  const snapshot = await firestore.collection(collection).doc(pageId).get();
  const stored = snapshot.exists ? snapshot.data() : null;
  if (!stored || stored.deleted || stored.status === "archived") {
    throw new PreviewRequestError(PREVIEW_FORBIDDEN_MESSAGE, 403);
  }
}

async function assertPreviewJobAccess(firestore, snapshot) {
  const data = snapshot.exists ? snapshot.data() : null;
  const collection = data?.collection ?? "cmsPages";
  if (!data || !validPreviewTarget(collection, data.pageId)) {
    throw new PreviewRequestError("Preview request not found", 404);
  }
  try {
    await assertStoredPreviewAccess(firestore, collection, data.pageId);
  } catch (error) {
    // A job ID must not reveal whether an inaccessible target exists.
    if (error instanceof PreviewRequestError && error.status === 403) {
      throw new PreviewRequestError("Preview request not found", 404);
    }
    throw error;
  }
  return data;
}

function defaultPreviewTransport() {
  const value = PREVIEW_TRANSPORT.value();
  return value === undefined || value === null || value === ""
    ? SERIALIZER_TRANSPORT
    : value;
}

function resolvePreviewTransport(value) {
  const transport = typeof value === "function" ? value() : value;
  if (transport === SERIALIZER_TRANSPORT) {
    return transport;
  }
  throw new PreviewRequestError(INVALID_PREVIEW_TRANSPORT_ERROR, 503);
}

function defaultSerializerReady() {
  return PREVIEW_SERIALIZER_READY.value() === "true";
}

function resolveSerializerReady(value) {
  return typeof value === "function" ? value() : value;
}

function resolvePreviewRequestConfiguration({ getTransport, serializerReady, getRendererSha }) {
  const transport = resolvePreviewTransport(getTransport);
  if (!resolveSerializerReady(serializerReady)) {
    throw new PreviewRequestError(SERIALIZER_NOT_READY_ERROR, 503);
  }
  const rendererSha = getRendererSha();
  if (!SHA_PATTERN.test(rendererSha)) {
    throw new PreviewRequestError(RENDERER_NOT_CONFIGURED_ERROR, 503);
  }
  return { transport, rendererSha };
}

function readRendererSha() {
  const value = PREVIEW_RENDERER_SHA.value().trim();
  if (!value && process.env.FUNCTIONS_EMULATOR === "true") {
    return EMULATOR_RENDERER_SHA;
  }
  return value;
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function validQueueId(value) {
  return typeof value === "string" && QUEUE_ID_PATTERN.test(value);
}

function timestampToIso(value) {
  const millis = timestampToMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function previewBuildTimedOut(data, now = Date.now()) {
  if (!NON_TERMINAL_STATUSES.has(data.status)) return false;
  const requestedAt = timestampToMillis(data.requestedAt);
  return (
    requestedAt === null ||
    requestedAt + PREVIEW_BUILD_TIMEOUT_MS <= Number(now)
  );
}

function publicPreviewStatus(queueId, data, now = Date.now(), retained = false) {
  const expiry = previewExpiryMillis(data);
  const expiresAt = expiry === null ? null : new Date(expiry).toISOString();
  const expired =
    expiresAt !== null && new Date(expiresAt).getTime() <= Number(now);
  const timedOut = previewBuildTimedOut(data, now);
  const observedStatus = PUBLIC_STATUSES.has(data.status)
    ? data.status
    : "failed";
  const storedStatus = timedOut ? "failed" : observedStatus;
  const status =
    (storedStatus === "ready" && expiresAt === null) ||
    (expired && storedStatus !== "failed")
      ? "expired"
      : storedStatus;
  return {
    success: true,
    queueId,
    status,
    ...(status === "building" && data.contextRefreshing === true ? { contextRefreshing: true } : {}),
    ...(status === "failed" && data.failureReason === "preview_context_refreshing"
      ? { failureReason: "preview_context_refreshing" } : {}),
    pageId: data.pageId,
    ...(data.collection ? { collection: data.collection, pagePath: data.pagePath } : {}),
    sourceVersion: data.sourceVersion,
    ...(typeof data.rendererSha === "string" ? { rendererSha: data.rendererSha } : {}),
    ...(/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(data.previewPairId ?? "") ? { previewPairId: data.previewPairId } : {}),
    ...(data.transport === SERIALIZER_TRANSPORT ? { transport: SERIALIZER_TRANSPORT } : {}),
    previewUrl:
      status === "ready" && expiresAt !== null
        ? data.previewUrl ?? null
        : null,
    error:
      status === "failed"
        ? data.error ??
          (timedOut ? PREVIEW_BUILD_TIMEOUT_ERROR : "Preview build failed")
        : null,
    requestedAt: timestampToIso(data.requestedAt),
    completedAt: timestampToIso(data.completedAt),
    expiresAt,
    ...(retained ? { persistent: true } : {}),
  };
}

// The head keeps the last ready file separate from the job replacing it. Reads
// use document identities, so no history scan grows with the number of edits.
async function readPreviewHead(firestore, collection, pageId, transaction = null, readRetainedOutputs = true) {
  const ref = firestore.collection(PREVIEW_HEADS_COLLECTION)
    .doc(previewContentKey(collection, pageId));
  const read = (target) => transaction ? transaction.get(target) : target.get();
  const head = (await read(ref)).data() ?? {};
  // Exact expiring requests lock this head but resolve reuse by exactTargetKey.
  if (!readRetainedOutputs) return { ref, head };
  const rows = new Map();
  for (const queueId of new Set([head.latestQueueId, head.readyQueueId])) {
    if (!validQueueId(queueId)) continue;
    const row = await read(firestore.collection(QUEUE_COLLECTION).doc(queueId));
    const data = row.data();
    if (row.exists && data.collection === collection && data.pageId === pageId) {
      rows.set(queueId, { queueId, data });
    }
  }
  return { ref, head, latest: rows.get(head.latestQueueId), ready: rows.get(head.readyQueueId) };
}

function previewHeadResponse(current, now) {
  const status = (row) => row ? publicPreviewStatus(
    row.queueId, row.data, now,
    row.queueId === current.head.readyQueueId && row.data.persistent === true,
  ) : null;
  return { success: true, latest: status(current.latest), ready: status(current.ready) };
}

// Failure audits can contain bounded receipts rather than document snapshots.
// A later history entry can still preserve the exact version as its full before.
async function readSavedPreviewVersion(firestore, transaction, collection, pageId, version) {
  const fullSnapshot = (document) => Array.isArray(document?.blocks) ||
    (collection === "cmsPosts" && ["program", "event"].includes(document?.type));
  const unavailable = () => new PreviewRequestError(
    "The requested saved preview version is unavailable", 409,
    { code: "preview-version-unavailable" },
  );
  const history = firestore.collection(AUDIT_COLLECTIONS.versionHistory)
    .where("collection", "==", collection).where("documentId", "==", pageId);
  const after = await transaction.get(history.where("after.version", "==", version).limit(2));
  if (after.size > 1) throw unavailable();
  const entry = after.docs[0]?.data();
  if (entry?.restorable !== false && fullSnapshot(entry?.after)) return entry.after;
  const before = await transaction.get(history.where("before.version", "==", version).limit(2));
  const document = before.docs[0]?.data().before;
  if (before.size !== 1 || document?.beforeTruncated || !fullSnapshot(document)) throw unavailable();
  return document;
}

async function enqueuePreview(fields, deps = {}) {
  const {
    firestore = db,
    createSnapshot = createPreviewSnapshot,
    now = () => Date.now(),
    getTransport = defaultPreviewTransport,
    serializerReady = defaultSerializerReady,
    getRendererSha = readRendererSha,
    assertBillingEnabledFn = assertBillingEnabled,
    adminLogEntryFn = adminLogEntry,
  } = deps;
  const { actor, pageId, source = null, collection = "cmsPages", persistent = false, automatic = false,
    sourceVersion: expectedSourceVersion } = fields;
  if (!actor?.uid) throw new Error("enqueuePreview requires an actor");
  if (!validPreviewTarget(collection, pageId)) {
    throw new PreviewRequestError(`Unknown preview page ${pageId}`);
  }
  if (!hasPreviewAccess(actor.principal)) {
    throw new PreviewRequestError(PREVIEW_FORBIDDEN_MESSAGE, 403);
  }
  // Optional only while the old staff callers are being migrated. An explicit
  // version is an exact snapshot address, never permission to use the latest.
  if (expectedSourceVersion !== undefined &&
      (!Number.isSafeInteger(expectedSourceVersion) || expectedSourceVersion < 1)) {
    throw new PreviewRequestError("Invalid saved preview version");
  }
  const { transport, rendererSha: configuredRendererSha } =
    resolvePreviewRequestConfiguration({
      getTransport,
      serializerReady,
      getRendererSha,
    });

  try {
    await assertBillingEnabledFn(firestore);
  } catch (error) {
    if (error?.code === "failed-precondition") {
      throw new PreviewRequestError(
        error?.message || "Preview builds are disabled by the billing kill switch",
        503,
      );
    }
    throw error;
  }

  // Interactive previews reuse the existing expiring /p artifact path. Unlike
  // the legacy retained export, another build cannot delete them during opening.
  const exactExpiring = !persistent && expectedSourceVersion !== undefined;
  let rendererSha = configuredRendererSha;
  let previewPairId;
  let exactTargetKey;
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc();
  const auditRef = firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc();
  const requestedAt = Number(now());
  let sourceVersion;
  let pagePath;
  const reused = await firestore.runTransaction(async (transaction) => {
    const pageRef = firestore.collection(collection).doc(pageId);
    let pageSnapshot;
    let current = null;
    if (exactExpiring) {
      const ref = firestore.collection(PREVIEW_HEADS_COLLECTION)
        .doc(previewContentKey(collection, pageId));
      // Both known document addresses remain locked by this transaction.
      // Exact reuse still comes from the target index, not retained outputs.
      const [page, head] = await transaction.getAll(pageRef, ref);
      pageSnapshot = page;
      current = { ref, head: head.data() ?? {} };
    } else {
      pageSnapshot = await transaction.get(pageRef);
    }
    if (!pageSnapshot.exists) {
      throw new PreviewRequestError(`Page ${pageId} has not been saved yet`, 409);
    }
    const document = pageSnapshot.data();
    // Selector read participates in the same transaction as the frozen saved
    // version, media, queue and audit. A racing switch retries wholly on one side.
    const runtimeSnapshot = await transaction.get(firestore.doc("system/cmsPreviewRuntime"));
    let runtime = runtimeSnapshot.data();
    let selectedPair = null;
    previewPairId = undefined;
    rendererSha = configuredRendererSha;
    if (runtime?.schemaVersion === 2) {
      const updating = () => new PreviewRequestError("Preview renderer is updating; try again shortly", 503, {
        code: "preview-renderer-updating",
      });
      let selected;
      try { selected = previewPairs.parseSelector(runtime); } catch { throw updating(); }
      // Keep the SDK read outside the parser catch so contention can retry.
      const pairSnapshot = await transaction.get(firestore.collection(previewPairs.PAIRS).doc(selected.selectedPairId));
      try {
        selectedPair = previewPairs.parsePair(pairSnapshot.data());
        previewPairs.assertProjection(selected, selectedPair);
        if (selectedPair.requirements.previewRequest !== 1) throw updating();
      } catch { throw updating(); }
      rendererSha = selectedPair.rendererSha;
      previewPairId = selectedPair.pairId;
      runtime = { ...runtime, ...selectedPair.capabilities };
    }
    const pairedPersistent = persistent && selectedPair;
    exactTargetKey = exactExpiring
      ? `${previewContentKey(collection, pageId)}:${expectedSourceVersion}:${selectedPair ? "paired-v2" : rendererSha}`
      : pairedPersistent ? `${previewContentKey(collection, pageId)}:${expectedSourceVersion ?? document.version}:retained-paired-v2` : null;
    // A ready preview froze the public video copies current at its build. Reuse it only
    // while a new build would show the same ones.
    const videosCurrent = (row) => previewVideosCurrent({ tx: transaction, firestore, state: row.previewVideos });
    const figuresCurrent = (row) => previewDatasetFiguresCurrent({ firestore, transaction, snapshot: row.snapshot, collection });
    if (document.deleted || document.status === "archived") {
      throw new PreviewRequestError("Archived content cannot be previewed", 409);
    }
    if (persistent) current = await readPreviewHead(firestore, collection, pageId, transaction);
    let snapshotDocument = document;
    let exactAttempt = 0;
    if (pairedPersistent) {
      // The mutable latest/ready head cannot locate an older accepted version
      // once newer work overlaps it. Keep every paired retained attempt in the
      // existing exact-target index, including requests with no version field.
      const attempts = await transaction.get(firestore.collection(QUEUE_COLLECTION)
        .where("exactTargetKey", "==", exactTargetKey).orderBy("exactAttempt", "desc").limit(1));
      const accepted = attempts.docs[0];
      exactAttempt = (accepted?.data().exactAttempt ?? 0) + 1;
      const row = accepted?.data();
      if (row?.persistent === true && row.collection === collection && row.pageId === pageId &&
          row.sourceVersion === (expectedSourceVersion ?? document.version) &&
          [runtime.selectedPairId, runtime.recoveryPairId].includes(row.previewPairId)) {
        const status = publicPreviewStatus(accepted.id, row, requestedAt);
        if (NON_TERMINAL_STATUSES.has(status.status)) return { ...status, dispatched: false, reused: true, retryAfterMs: 0 };
      }
    }
    if (exactExpiring) {
      // The content head still serializes acceptance, but target identity lives
      // on the queue so interleaved versions cannot displace one another.
      const attempts = await transaction.get(firestore.collection(QUEUE_COLLECTION)
        .where("exactTargetKey", "==", exactTargetKey).orderBy("exactAttempt", "desc").limit(1));
      const last = attempts.docs[0];
      const accepted = last ? { queueId: last.id, data: last.data() } : null;
      exactAttempt = (accepted?.data.exactAttempt ?? 0) + 1;
      if (accepted && accepted.data.collection === collection && accepted.data.pageId === pageId &&
          accepted.data.persistent !== true && accepted.data.sourceVersion === expectedSourceVersion &&
          (!selectedPair ? accepted.data.rendererSha === rendererSha :
            [runtime.selectedPairId, runtime.recoveryPairId].includes(accepted.data.previewPairId)) &&
          (previewExpiryMillis(accepted.data) ?? 0) > requestedAt + 5 * 60_000 &&
          await videosCurrent(accepted.data) &&
          (accepted.data.status !== "ready" || await figuresCurrent(accepted.data))) {
        const status = publicPreviewStatus(accepted.queueId, accepted.data, requestedAt);
        if (NON_TERMINAL_STATUSES.has(status.status) || status.status === "ready") {
          return { ...status, dispatched: false, reused: true, retryAfterMs: 0 };
        }
      }
      if (document.version !== expectedSourceVersion) {
        snapshotDocument = await readSavedPreviewVersion(
          firestore, transaction, collection, pageId, expectedSourceVersion,
        );
      }
    } else if (expectedSourceVersion !== undefined) {
      // Retry an already accepted exact snapshot without rereading its content
      // from a newer mutable document. This reuses the existing two-row index.
      for (const row of [current?.latest, current?.ready]) {
        if (!row || row.data.sourceVersion !== expectedSourceVersion || (!selectedPair ? row.data.rendererSha !== rendererSha :
          ![runtime.selectedPairId, runtime.recoveryPairId].includes(row.data.previewPairId))) continue;
        const status = publicPreviewStatus(row.queueId, row.data, requestedAt,
          row.queueId === current.head.readyQueueId && row.data.persistent === true);
        // Ready is written before the replacement advances the retained head.
        // Until settlement, it can still retire the older ready artifact.
        const replacementInFlight = status.status === "ready" &&
          current.latest?.queueId !== row.queueId &&
          (NON_TERMINAL_STATUSES.has(current.latest?.data.status) || current.latest?.data.status === "ready");
        if (!replacementInFlight && (NON_TERMINAL_STATUSES.has(status.status) ||
          (status.status === "ready" && await videosCurrent(row.data) && await figuresCurrent(row.data)))) {
          return { ...status, dispatched: false, reused: true, retryAfterMs: 0 };
        }
      }
      if (document.version !== expectedSourceVersion) {
        throw new PreviewRequestError("The requested saved preview version is unavailable", 409, {
          code: "preview-version-unavailable",
        });
      }
    }
    if (!exactExpiring && current?.latest) {
      const latest = current.latest;
      const status = publicPreviewStatus(latest.queueId, latest.data, requestedAt,
        latest.queueId === current.head.readyQueueId);
      const inFlight = NON_TERMINAL_STATUSES.has(status.status);
      if (selectedPair && inFlight && ![runtime.selectedPairId, runtime.recoveryPairId].includes(latest.data.previewPairId)) {
        throw new PreviewRequestError("Preview queue requires its retained pair", 503, { code: "preview-renderer-updating" });
      }
      if (!selectedPair && expectedSourceVersion !== undefined && inFlight &&
          (latest.data.rendererSha !== rendererSha || !Number.isSafeInteger(latest.data.sourceVersion) ||
            latest.data.sourceVersion > expectedSourceVersion)) {
        throw new PreviewRequestError("Preview renderer is updating; try again shortly", 503, {
          code: "preview-renderer-updating",
        });
      }
      const unchanged = (!selectedPair || [runtime.selectedPairId, runtime.recoveryPairId].includes(latest.data.previewPairId)) &&
        status.status === "ready" && latest.data.sourceVersion === document.version &&
        latest.data.rendererSha === rendererSha && await videosCurrent(latest.data) &&
        await figuresCurrent(latest.data);
      const retryAfterMs = Math.max(0,
        (timestampToMillis(latest.data.requestedAt) ?? 0) + PREVIEW_REFRESH_MS - requestedAt);
      const reuseInFlight = inFlight && (!selectedPair || expectedSourceVersion === undefined ||
        latest.data.sourceVersion === expectedSourceVersion);
      if (reuseInFlight || unchanged || (expectedSourceVersion === undefined && automatic && retryAfterMs > 0)) {
        return { ...status, dispatched: false, reused: true, retryAfterMs };
      }
    }
    if (collection === "cmsPages") {
      try {
        await require("./lib/page-reader-compatibility").assertPreviewPageReader({
          firestore, transaction, pageId, blocks: snapshotDocument.blocks, rendererSha });
      } catch (error) {
        if (error.code === "page_reader_contract_unavailable") throw new PreviewRequestError(
          "Preview is updating; try again shortly", 503, { code: "preview-renderer-updating" });
        throw error;
      }
    }
    if (runtimeSnapshot.exists) {
      if ((!selectedPair && runtime.schemaVersion !== 1) || runtime.phase !== "ready" || runtime.rendererSha !== rendererSha ||
        typeof runtime.serializerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(runtime.serializerId)) {
        throw new PreviewRequestError("Preview renderer is updating; try again shortly", 503, {
          code: "preview-renderer-updating",
        });
      }
    }
    // Reuse above keeps already admitted immutable work available during a pause.
    // Only a new composed snapshot needs the current private runtime's marker.
    if (require("./lib/election-results-compatibility").containsVisibleElectionResults(snapshotDocument) &&
        (!require("./lib/election-results-compatibility").supportsElectionResults(snapshotDocument, runtime, false) || runtime?.rendererSha !== rendererSha)) {
      throw new PreviewRequestError("The election results preview renderer is updating; try again shortly", 503, {
        code: "preview-renderer-updating",
      });
    }
    if (collection === "cmsPages" && pageId === "data-hub" && snapshotDocument.dataHubCompositionVersion === 1 &&
        runtime?.dataHubCompositionVersion !== 1) {
      throw new PreviewRequestError("The Data Hub preview renderer is updating; try again shortly", 503, {
        code: "preview-renderer-updating",
      });
    }
    const requiredLiveBlogContract = require("./lib/live-blog-compatibility").requiredLiveBlogContractVersion(snapshotDocument.liveBlog);
    if (collection === "cmsPosts" && snapshotDocument.type === "post" && snapshotDocument.liveBlog !== undefined &&
        (runtime?.liveBlogVersion !== 1 || runtime?.rendererSha !== rendererSha ||
          requiredLiveBlogContract > 1 && await require("./lib/live-blog-compatibility").readLiveBlogContractForRenderer({ firestore, transaction, rendererSha }) < requiredLiveBlogContract)) {
      throw new PreviewRequestError("The live blog preview renderer is updating; try again shortly", 503, {
        code: "preview-renderer-updating",
      });
    }
    // A draft never carries server-owned video data. Use the current public copy
    // when one exists; otherwise the draft renderer shows a placeholder.
    try {
      if (collection === "cmsPosts") snapshotDocument = await withFrozenCredits({
        firestore, tx: transaction, document: snapshotDocument, at: new Date(requestedAt).toISOString(), preview: true,
      });
    } catch (error) { throw new PreviewRequestError(error.message, 409); }
    snapshotDocument = await withPreviewVideos({ tx: transaction, firestore, document: snapshotDocument });
    const previewVideos = previewVideoState(snapshotDocument);
    let snapshot;
    try {
      snapshot = collection === "cmsPosts"
        ? createPostPreviewSnapshot(pageId, snapshotDocument, requestedAt)
        : createSnapshot(pageId, snapshotDocument);
      snapshot = await withFrozenDatasetFigures({ firestore, transaction, snapshot, collection });
    } catch (error) {
      throw new PreviewRequestError(error.message, 409);
    }
    const assets = [];
    try {
      const assetIds = referencedPreviewAssetIds(snapshot);
      const pdfAssetIds = new Set(snapshot.blocks.filter(block => block.type === "document_list")
        .flatMap(block => block.data.documents.map(item => item.assetId)));
      for (let offset = 0; offset < assetIds.length; offset += PREVIEW_ASSET_READ_BATCH_SIZE) {
        const batch = assetIds.slice(offset, offset + PREVIEW_ASSET_READ_BATCH_SIZE);
        const snapshots = await transaction.getAll(...batch.map(assetId =>
          firestore.collection("media_assets_public").doc(assetId)));
        for (const [index, assetSnapshot] of snapshots.entries()) {
          const assetId = batch[index];
          if (!assetSnapshot.exists) {
            throw new Error(`Media asset ${assetId} is missing`);
          }
          assets.push(createPreviewAssetSnapshot(assetId, assetSnapshot.data(), { pdf: pdfAssetIds.has(assetId) }));
        }
      }
    } catch (error) {
      throw new PreviewRequestError(error.message, 409);
    }
    sourceVersion = snapshot.version;
    pagePath = previewTargetPath(collection, pageId, snapshot);
    const queue = {
      status: "pending",
      transport,
      pageId,
      ...(persistent || exactExpiring || collection === "cmsPosts" ? {
        collection,
        pagePath,
      } : {}),
      ...(persistent ? { persistent: true, contentKey: previewContentKey(collection, pageId) } : {}),
      sourceVersion,
      rendererSha,
      ...(selectedPair ? { previewPairId: selectedPair.pairId, serializerId: selectedPair.serializerId,
        previewRequestContract: 1, previewEpoch: runtime.epoch } : {}),
      ...(exactTargetKey ? { exactTargetKey, exactAttempt } : {}),
      ...(previewVideos ? { previewVideos } : {}),
      snapshot,
      assets,
      requestedBy: actor.uid,
      requestedByEmail: actor.email ?? null,
      requestedAt: Timestamp.fromMillis(requestedAt),
      completedAt: null,
      expiresAt: Timestamp.fromMillis(requestedAt + PREVIEW_TTL_MS),
      // Queue history retention is separate from the 24-hour artifact lifetime.
      ...(!persistent ? { purgeAt: Timestamp.fromMillis(requestedAt + 30 * 24 * 60 * 60 * 1000) } : {}),
      previewUrl: null,
      deploymentId: null,
      error: null,
    };
    transaction.create(queueRef, queue);
    if (current) transaction.set(current.ref, {
      ...current.head, collection, pageId,
      ...(exactExpiring ? { exactQueueId: queueRef.id } : { latestQueueId: queueRef.id }),
    });
    transaction.create(
      auditRef,
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "cms.preview.request",
        target: queueRef.id,
        after: {
          status: "pending",
          transport: SERIALIZER_TRANSPORT,
          pageId,
          sourceVersion,
        },
        source,
      }),
    );
  });

  if (reused) return reused;

  return {
    success: true,
    queueId: queueRef.id,
    pageId,
    sourceVersion,
    rendererSha,
    ...(previewPairId ? { previewPairId } : {}),
    dispatched: false,
    status: "pending",
    transport: SERIALIZER_TRANSPORT,
    ...(persistent || exactExpiring || collection === "cmsPosts" ? { collection, pagePath, previewUrl: null } : {}),
  };
}

function createCmsPreviewHandler(deps = {}) {
  const { requirePrincipalFn = requirePrincipal, log = logger } = deps;
  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      const actor = await requirePrincipalFn(req, { previewStaff: true });
      // These modes change shared retention state and keep the former admin
      // boundary. Ordinary previews are available to every active staff account.
      if ((req.body?.persistent === true || req.body?.automatic === true) &&
          !can(actor.principal, "settings.manage")) {
        throw new PreviewRequestError(
          "Administrator access is required for retained or automatic previews", 403,
        );
      }
      const pageId =
        typeof req.body?.pageId === "string" ? req.body.pageId.trim() : "";
      const result = await enqueuePreview(
        { actor, pageId, source: getClientIp(req),
          collection: req.body?.collection ?? "cmsPages",
          persistent: req.body?.persistent === true,
          automatic: req.body?.automatic === true,
          sourceVersion: req.body?.sourceVersion },
        deps,
      );
      // Only the committed queue result can request an edge wake. Reused
      // unfinished jobs need the same signal if their first wake was lost.
      if (result.success === true && result.transport === SERIALIZER_TRANSPORT &&
          NON_TERMINAL_STATUSES.has(result.status) && validQueueId(result.queueId) &&
          /^[a-f0-9]{40}$/.test(result.rendererSha)) {
        res.set("x-njpbs-preview-wake", result.rendererSha);
        if (/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(result.previewPairId ?? "")) {
          res.set("x-njpbs-preview-pair", result.previewPairId);
        }
        // Join the edge receipt to the existing queue without logging a draft,
        // actor, claim token or arbitrary client-supplied header.
        const requestId = req.headers?.["x-njpbs-request-id"];
        try {
          log.info("cms_preview_accepted", {
            queueId: result.queueId, rendererSha: result.rendererSha, status: result.status,
            ...(typeof requestId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
              ? { requestId } : {}),
          });
        } catch { /* Logging cannot invalidate a committed acceptance. */ }
      }
      res.status(202).json(result);
    } catch (error) {
      if (res.headersSent) return;
      log.error("cmsPreview failed", error);
      const clientCode = error instanceof PreviewRequestError && CLIENT_PREVIEW_ERROR_CODES.has(error.code)
        ? error.code : null;
      res.status(error?.status || 500).json({
        error: error?.message || "Failed to request preview",
        ...(error?.queueId ? { queueId: error.queueId } : {}),
        ...(clientCode ? { code: clientCode } : {}),
      });
    }
  };
}

function createCmsPreviewStatusHandler(deps = {}) {
  const {
    requirePrincipalFn = requirePrincipal,
    firestore = db,
    now = () => Date.now(),
    log = logger,
  } = deps;
  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      let actor = await requirePrincipalFn(req, { previewStaff: true });
      assertPreviewReadCapability(actor.principal);
      if (req.body?.retained !== undefined) {
        if (deps.retainedReplies !== true) throw new PreviewRequestError("Retained replies are disabled", 400);
        return res.status(200).json(await require("./lib/cms-reader-retained-request").retainedReaderReply({
          firestore, body: req.body, feature: "previewRequest", now }));
      }
      if (req.body?.pageId !== undefined) {
        const collection = req.body.collection ?? "cmsPages";
        const pageId = req.body.pageId;
        if (!validPreviewTarget(collection, pageId)) throw new PreviewRequestError("Invalid preview target");
        await assertStoredPreviewAccess(
          firestore,
          collection,
          pageId,
        );
        const current = await readPreviewHead(firestore, collection, pageId);
        res.status(200).json(previewHeadResponse(current, Number(now())));
        return;
      }
      const queueId =
        typeof req.body?.queueId === "string" ? req.body.queueId.trim() : "";
      if (!validQueueId(queueId)) {
        throw new PreviewRequestError("Invalid preview queue id");
      }
      const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
      const waitMs = req.body?.waitMs;
      let snapshot;
      if (waitMs !== undefined) {
        const observedStatus = req.body?.observedStatus;
        if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 5000 ||
            !NON_TERMINAL_STATUSES.has(observedStatus)) {
          throw new PreviewRequestError("Invalid preview status wait");
        }
        // Admit only readers of the stored target before allocating a listener.
        await assertPreviewJobAccess(firestore, await queueRef.get());
        const waited = await waitForPreviewStatus({ queueRef, req, res, waitMs, now,
          inspect(current) {
            if (!current.exists) return null;
            const data = current.data();
            if (data.persistent === true || data.transport !== SERIALIZER_TRANSPORT ||
                publicPreviewStatus(queueId, data, Number(now())).status !== observedStatus) return null;
            const expiry = timestampToMillis(data.expiresAt);
            const requested = timestampToMillis(data.requestedAt);
            return Math.min(expiry ?? Infinity,
              requested === null ? Infinity : requested + PREVIEW_BUILD_TIMEOUT_MS);
          },
        });
        snapshot = waited.snapshot;
        // Recheck actual revocation, disabled-account and stored-role authority
        // after holding the request. A listener never extends an admission grant.
        if (waited.delayed) {
          actor = await requirePrincipalFn(req, { previewStaff: true });
          assertPreviewReadCapability(actor.principal);
        }
      } else {
        snapshot = await queueRef.get();
      }
      if (req.aborted || res.destroyed) return;
      const currentTime = Number(now());
      // Record lifecycle can change during a wait, independently of staff access.
      let data = await assertPreviewJobAccess(firestore, snapshot);
      if (previewBuildTimedOut(data, currentTime)) {
        try {
          data = await firestore.runTransaction(async (transaction) => {
            const current = await transaction.get(queueRef);
            if (!current.exists) {
              throw new PreviewRequestError("Preview request not found", 404);
            }
            const currentData = current.data();
            if (!previewBuildTimedOut(currentData, currentTime)) {
              return currentData;
            }
            const failure = {
              status: "failed",
              completedAt: Timestamp.fromMillis(currentTime),
              previewUrl: null,
              error: PREVIEW_BUILD_TIMEOUT_ERROR,
            };
            transaction.update(queueRef, failure);
            return { ...currentData, ...failure };
          });
        } catch (error) {
          // The response still derives the same terminal failure from the
          // stored request time, so an unavailable persistence path cannot
          // leave the editor polling indefinitely.
          log.warn?.("cmsPreviewStatus could not persist preview timeout", {
            queueId,
            error: error?.message || String(error),
          });
        }
      }
      let retained = false;
      if (data.persistent === true && validPreviewTarget(data.collection, data.pageId)) {
        const current = await readPreviewHead(firestore, data.collection, data.pageId);
        retained = current.head.readyQueueId === queueId;
      }
      res.status(200).json(publicPreviewStatus(queueId, data, currentTime, retained));
    } catch (error) {
      if (res.headersSent || req.aborted || res.destroyed || error?.code === "ABORT_ERR") return;
      log.error("cmsPreviewStatus failed", error);
      res.status(error?.status || 500).json({
        error: error?.message || "Failed to load preview status",
      });
    }
  };
}

const cmsPreview = cmsOnRequest(
  { cors: true },
  createCmsPreviewHandler(),
);
const cmsPreviewStatus = cmsOnRequest(
  { cors: true },
  createCmsPreviewStatusHandler(),
);

module.exports = {
  cmsPreview,
  cmsPreviewStatus,
  createCmsPreviewHandler,
  createCmsPreviewStatusHandler,
  enqueuePreview,
  publicPreviewStatus,
  validQueueId,
  QUEUE_COLLECTION,
  PREVIEW_TTL_MS,
  PREVIEW_BUILD_TIMEOUT_MS,
  PREVIEW_BUILD_TIMEOUT_ERROR,
  PREVIEW_RENDERER_SHA,
  PREVIEW_TRANSPORT,
  PREVIEW_SERIALIZER_READY,
  RENDERER_NOT_CONFIGURED_ERROR,
  SERIALIZER_NOT_READY_ERROR,
  INVALID_PREVIEW_TRANSPORT_ERROR,
  SERIALIZER_TRANSPORT,
  resolvePreviewTransport,
  previewBuildTimedOut,
  readPreviewHead,
  previewHeadResponse,
  EMULATOR_RENDERER_SHA,
};
