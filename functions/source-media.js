"use strict";

const { enrichSourceMediaUploaders } = require("./lib/source-media-uploader");
const { FieldPath } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { hasCapability } = require("./lib/rbac");
const {
  MediaSourceAccessError,
  authorizeMediaSource,
  mediaSourceSummary,
  objectKeyWithinSource,
} = require("./lib/media-sources");
const {
  SourceMediaValidationError,
  encodeCursor,
  parseSourceMediaAsset,
  parseSourceMediaListRequest,
  parseSourceMediaReadRequest,
  sourceMediaAssetSummary,
  sourceMediaAssetDetail,
} = require("./lib/source-media-contract");
const {
  SourceObjectError,
  createS3MediaSourceReader,
} = require("./lib/s3-media-source");
const {
  AWS_REGION,
  runtimeAwsConfig,
  runtimeRegistry,
} = require("./lib/media-source-runtime");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { computeMediaTabCounts } = require("./lib/media-tab-counts");

const { createOriginalStorage, refreshListedOriginals } = require("./lib/source-originals");

const { safeStorageDiagnostic } = require("./lib/source-original-state");
const { READ_SECRETS, privateVideoStorage } = require("./lib/private-video-runtime");
const { createPrivateVideoReader } = require("./lib/private-video-reader");

const MAX_SOURCE_JSON_BYTES = 8 * 1024;
const FUNCTION_SERVICE_ACCOUNT =
  "boardwalk-s3-media@njpbs-site.iam.gserviceaccount.com";

function privateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function requirePost(req, res) {
  privateNoStore(res);
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  validateBoundedJsonRequest(req, MAX_SOURCE_JSON_BYTES);
  return true;
}

function expectEmptyRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
    throw new SourceMediaValidationError("Request must be an empty object");
  }
}

// The source list takes {} or, for tab counts, exactly {counts: true}.
function parseSourcesRequest(value) {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === 1 && value.counts === true) {
    return { counts: true };
  }
  if (value && typeof value === "object" && Object.hasOwn(value, "counts")) {
    throw new SourceMediaValidationError("Request must be {} or {\"counts\": true}");
  }
  expectEmptyRequest(value);
  return { counts: false };
}

function expectedError(error) {
  return error instanceof JsonRequestError ||
    error instanceof MediaSourceAccessError ||
    error instanceof SourceMediaValidationError ||
    error instanceof SourceObjectError ||
    Number.isInteger(error?.status);
}

function respondWithError(res, log, operation, error) {
  if (res.headersSent) return;
  const known = expectedError(error);
  const status = error?.status ?? 500;
  if (!known || status >= 500) log.error(`${operation} failed`, { status, ...safeStorageDiagnostic(error) });
  res.status(status).json({
    error: known ? error.message : `Failed to ${operation}`,
    ...(error?.code === "original_archived" || error?.code === "original_restoring"
      ? { code: error.code, original: error.original } : {}),
  });
}

function createCmsListMediaSourcesHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const registryFn = deps.registryFn ?? runtimeRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const computeTabCountsFn = deps.computeTabCountsFn ?? computeMediaTabCounts;
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const { counts: countsRequested } = parseSourcesRequest(req.body);
      const actor = countsRequested
        ? await requirePrincipalFn(req, { includeAccountStatus: true })
        : await requirePrincipalFn(req);
      // With counts, the principal read already answered account status; reuse it for every
      // source check instead of reading the user document again.
      const statusOption = countsRequested && typeof actor?.approvedActive === "boolean"
        ? { isApprovedActiveAccountFn: async () => actor.approvedActive }
        : {};
      const registry = registryFn();
      const sources = [];
      for (const source of registry.values()) {
        try {
          await authorizeFn({ firestore, actor, source, operation: "browse", ...statusOption });
          const summary = mediaSourceSummary(source);
          if (source.writable) {
            try {
              await authorizeFn({ firestore, actor, source, operation: "upload", ...statusOption });
            } catch (error) {
              if (!(error instanceof MediaSourceAccessError) || error.status >= 500) throw error;
              summary.canUpload = false;
            }
            try {
              await authorizeFn({ firestore, actor, source, operation: "metadata", ...statusOption });
              summary.canEditMetadata = true;
            } catch (error) {
              if (!(error instanceof MediaSourceAccessError) || error.status >= 500) throw error;
            }
          }
          if (source.id === "video-library") {
            summary.canReplace = summary.canEditMetadata &&
              (deps.replacementEnabledFn ?? (() => require("./lib/media-source-runtime").videoReplacementRuntimeConfig().enabled))();
            summary.canExportOrientation = summary.canUpload === true;
            try {
              await authorizeFn({ firestore, actor, source, operation: "transcript", ...statusOption });
              summary.canRequestProduction = true;
            } catch (error) {
              if (!(error instanceof MediaSourceAccessError) || error.status >= 500) throw error;
            }
            try {
              await authorizeFn({ firestore, actor, source, operation: "delete", ...statusOption });
              summary.canDelete = true;
            } catch (error) {
              if (!(error instanceof MediaSourceAccessError) || error.status >= 500) throw error;
            }
          }
          sources.push(summary);
        } catch (error) {
          if (!(error instanceof MediaSourceAccessError) || error.status >= 500) throw error;
        }
      }
      if (!countsRequested) {
        res.status(200).json({ success: true, sources });
        return;
      }
      let counts = null;
      try {
        counts = await computeTabCountsFn({
          firestore,
          actor,
          registry,
          approvedActive: typeof actor?.approvedActive === "boolean"
            ? actor.approvedActive
            : await isApprovedActiveAccount(firestore, actor?.uid),
          browseSourceIds: sources.map((summary) => summary.id),
          log,
        });
      } catch (error) {
        log.warn?.("cmsListMediaSources left out tab counts", {
          uid: actor?.uid ?? null,
          error: error?.message,
        });
      }
      res.status(200).json({ success: true, sources, ...(counts ? { counts } : {}) });
    } catch (error) {
      respondWithError(res, log, "list media sources", error);
    }
  };
}

async function readSourceMediaPage(firestore, source, request, documentIdField) {
  if (request.assetId) {
    const snapshot = await firestore.collection("mediaSourceAssets").doc(request.assetId).get();
    const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
    const assets = asset && asset.sourceId === source.id && objectKeyWithinSource(source, asset.objectKey)
      ? [asset] : [];
    return { records: assets.map(sourceMediaAssetDetail), assets, nextCursor: null, hasMore: false };
  }
  let query = firestore
    .collection("mediaSourceAssets")
    .where("sourceId", "==", source.id)
    .where("lifecycle", "==", "active");
  if (request.tag) query = query.where("tags", "array-contains", request.tag);
  if (request.createdBy) query = query.where("createdBy", "==", request.createdBy);
  if (request.rightsStatus) query = query.where("rightsStatus", "==", request.rightsStatus);
  const order = request.q ? "name_asc" : (request.sort ?? "updated_desc");
  let sortField = "updatedAtSort";
  if (order === "name_asc") sortField = "nameSort";
  if (order === "size_desc" || order === "size_asc") sortField = "sizeBytes";
  const direction = order.endsWith("_desc") ? "desc" : "asc";
  if (request.q) {
    query = query
      .where("nameSort", ">=", request.q)
      .where("nameSort", "<", `${request.q}\uf8ff`);
  }
  query = query.orderBy(sortField, direction).orderBy(documentIdField, direction);
  if (request.cursor) query = query.startAfter(request.cursor.sort, request.cursor.id);
  let snapshot;
  try {
    snapshot = await query.limit(request.limit + 1).get();
  } catch (error) {
    const indexUnavailable = [9, "FAILED_PRECONDITION", "failed-precondition"].includes(error?.code) &&
      /index/i.test(error?.message ?? "");
    if (sortField !== "sizeBytes" || !indexUnavailable) throw error;
    // Never reuse a numeric size cursor in update order. Return page 1 and tell Admin
    // to adopt the fallback sort before it follows the returned update-order cursor.
    const page = await readSourceMediaPage(firestore, source, { ...request, sort: "updated_desc", cursor: null }, documentIdField);
    return { ...page, sortFallback: "updated_desc" };
  }
  const documents = snapshot.docs.slice(0, request.limit);
  const assets = documents.flatMap((document) => {
    const asset = parseSourceMediaAsset(document.id, document.data());
    return asset && asset.sourceId === source.id && objectKeyWithinSource(source, asset.objectKey)
      ? [asset]
      : [];
  });
  const records = assets.map(sourceMediaAssetSummary);
  const hasMore = snapshot.docs.length > request.limit;
  const last = hasMore ? documents.at(-1) : null;
  const lastData = last?.data();
  const sortValue = lastData?.[sortField];
  const validSortValue = sortField === "sizeBytes"
    ? Number.isSafeInteger(sortValue) && sortValue >= 0
    : typeof sortValue === "string";
  if (last && !validSortValue) {
    throw new Error(`Indexed media asset ${last.id} has no valid ${sortField}`);
  }
  const nextCursor = last
    ? encodeCursor({
        sourceId: source.id,
        q: request.q,
        tag: request.tag,
        createdBy: request.createdBy,
        rightsStatus: request.rightsStatus,
        order,
        id: last.id,
        sort: sortValue,
      })
    : null;
  // `assets` holds the parsed private records for server use only; the handler never returns it.
  return { records, assets, hasMore, nextCursor };
}

const POSTER_SIGNING_WORKERS = 8;
const POSTER_SIGNING_BUDGET_MS = 1500;

// Sign the ready posters for one listed page, so a page needs no read call per tile. Each poster
// keeps the same version, size and prefix checks as cmsCreateSourceMediaRead. Signing has a time
// budget so slow storage cannot hold the list: the page returns the posters signed by then, and a
// poster that is missing, failed or late is left out so its tile falls back to its own read.
async function signListedPosters(createReadFn, source, assets, log, budgetMs = POSTER_SIGNING_BUDGET_MS) {
  const ready = assets.filter((asset) => asset.rendition?.state === "ready");
  const posters = [];
  let next = 0;
  let open = true;
  async function worker() {
    while (open && next < ready.length) {
      const asset = ready[next++];
      try {
        const access = await createReadFn(source, asset, "poster");
        if (open) posters.push({ assetId: access.assetId, url: access.url, expiresAt: access.expiresAt });
      } catch (error) {
        if (!(error instanceof SourceObjectError)) log.warn("Listed poster signing failed", { assetId: asset.id });
      }
    }
  }
  let timer;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(POSTER_SIGNING_WORKERS, ready.length) }, worker)),
    new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  clearTimeout(timer);
  open = false;
  return posters.slice();
}

async function readExactSourceTotal(firestore, sourceId) {
  const snapshot = await firestore.collection("mediaSourceStats").doc(sourceId).get();
  const data = snapshot.exists ? snapshot.data() : null;
  return data?.exact === true && data.sourceId === sourceId &&
    Number.isSafeInteger(data.activeCount) && data.activeCount >= 0
    ? data.activeCount
    : null;
}

function createCmsListSourceMediaHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const registryFn = deps.registryFn ?? runtimeRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const readPageFn = deps.readPageFn ?? readSourceMediaPage;
  const readTotalFn = deps.readTotalFn ?? readExactSourceTotal;
  const documentIdField = deps.documentIdField ?? FieldPath.documentId();
  const posterBudgetMs = deps.posterBudgetMs ?? POSTER_SIGNING_BUDGET_MS;
  let defaultOriginalStorage;
  let defaultReadFn;
  const createReadFn = deps.createReadFn ?? ((...args) => {
    defaultReadFn ??= createS3MediaSourceReader(runtimeAwsConfig(), {
      privateReadFn: createPrivateVideoReader({ firestore, storage: privateVideoStorage }),
    });
    return defaultReadFn(...args);
  });
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSourceMediaListRequest(req.body);
      const actor = await requirePrincipalFn(req);
      const source = registryFn().get(request.sourceId);
      await authorizeFn({ firestore, actor, source, operation: "browse" });
      if (request.pendingIds) {
        const snapshots = await firestore.getAll(...request.pendingIds.map(id =>
          firestore.collection("mediaSourceAssets").doc(id)));
        const records = snapshots.flatMap(snapshot => {
          const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
          if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) return [];
          const { id, viewingCopy, fileVersion } = sourceMediaAssetSummary(asset);
          return [{ id, viewingCopy, ...(fileVersion ? { fileVersion } : {}) }];
        });
        // Status reads never query a page, read totals or uploaders, or sign posters.
        res.status(200).json({ success: true, records });
        return;
      }
      const canViewUsers = hasCapability(actor?.principal, "users.view");
      if (request.createdBy && request.createdBy !== actor.uid && !canViewUsers) {
        throw new MediaSourceAccessError(403, "Uploader filter access denied");
      }
      const [{ assets = [], ...page }, total] = await Promise.all([
        readPageFn(firestore, source, request, documentIdField),
        request.assetId || request.q || request.tag || request.createdBy || request.rightsStatus
          ? Promise.resolve(null)
          : readTotalFn(firestore, source.id),
      ]);
      const [records, posters] = await Promise.all([
        refreshListedOriginals({ firestore, source, assets, records: page.records, log,
          storage: deps.originalStorage ?? (defaultOriginalStorage ??= createOriginalStorage(runtimeAwsConfig())) })
          .then(records => enrichSourceMediaUploaders(firestore, records, canViewUsers)),
        request.posters ? signListedPosters(createReadFn, source, assets, log, posterBudgetMs) : null,
      ]);
      page.records = records;
      res.status(200).json({ success: true, ...page, total, ...(posters ? { posters } : {}) });
    } catch (error) {
      respondWithError(res, log, "list source media", error);
    }
  };
}

function sourceMediaReadIdentity(asset, action) {
  return JSON.stringify([asset.sourceId, asset.objectKey, asset.objectVersionId,
    asset.sizeBytes, asset.mimeType, asset.preview,
    action !== "download" && asset.rendition?.state === "ready"
      ? [asset.rendition.web, asset.rendition.poster] : null]);
}

function createCmsCreateSourceMediaReadHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const registryFn = deps.registryFn ?? runtimeRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  let defaultReadFn;
  const createReadFn = deps.createReadFn ?? ((...args) => {
    defaultReadFn ??= createS3MediaSourceReader(runtimeAwsConfig(), {
      privateReadFn: createPrivateVideoReader({ firestore, storage: privateVideoStorage }),
    });
    return defaultReadFn(...args);
  });
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSourceMediaReadRequest(req.body);
      const actor = await requirePrincipalFn(req);
      const source = registryFn().get(request.sourceId);
      await authorizeFn({ firestore, actor, source, operation: "read" });
      const snapshot = await firestore.collection("mediaSourceAssets").doc(request.assetId).get();
      const asset = snapshot.exists
        ? parseSourceMediaAsset(snapshot.id, snapshot.data())
        : null;
      if (
        !asset || asset.sourceId !== source.id ||
        !objectKeyWithinSource(source, asset.objectKey)
      ) {
        throw new SourceObjectError(404, "Media asset not found");
      }
      const access = await createReadFn(source, asset, request.action);
      // Storage verification and signing await external services. A promotion or
      // deletion during that work must not release the earlier file's URL.
      const freshSnapshot = await firestore.collection("mediaSourceAssets").doc(request.assetId).get();
      const fresh = freshSnapshot.exists
        ? parseSourceMediaAsset(freshSnapshot.id, freshSnapshot.data()) : null;
      if (!fresh || fresh.sourceId !== source.id || !objectKeyWithinSource(source, fresh.objectKey)) {
        throw new SourceObjectError(404, "Media asset not found");
      }
      if (sourceMediaReadIdentity(fresh, request.action) !== sourceMediaReadIdentity(asset, request.action)) {
        throw new SourceObjectError(409, "The video changed. Refresh it and try again.");
      }
      const downloadCredit = request.action === "download" || request.action === "download_web"
        ? { credit: fresh.credit } : {};
      const fileVersion = sourceMediaAssetSummary(fresh).fileVersion;
      res.status(200).json({ success: true, access: { ...access, ...downloadCredit, ...(fileVersion ? { fileVersion } : {}) } });
    } catch (error) {
      respondWithError(res, log, "create source media read", error);
    }
  };
}

// Full CPU lets parallel reads, such as a page of poster reads, share one instance and its
// cached AWS credentials instead of each starting a cold, fractional-CPU instance.
const functionOptions = {
  cors: true,
  maxInstances: 20,
  timeoutSeconds: 30,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT,
  cpu: 1,
  concurrency: 80,
};
const cmsListMediaSources = cmsOnRequest(
  functionOptions,
  createCmsListMediaSourcesHandler(),
);
const cmsListSourceMedia = cmsOnRequest(
  { ...functionOptions, minInstances: 1, secrets: READ_SECRETS },
  createCmsListSourceMediaHandler(),
);
const cmsCreateSourceMediaRead = cmsOnRequest(
  { ...functionOptions, secrets: READ_SECRETS },
  createCmsCreateSourceMediaReadHandler(),
);

module.exports = {
  AWS_REGION,
  FUNCTION_SERVICE_ACCOUNT,
  MAX_SOURCE_JSON_BYTES,
  cmsCreateSourceMediaRead,
  cmsListMediaSources,
  cmsListSourceMedia,
  createCmsCreateSourceMediaReadHandler,
  createCmsListMediaSourcesHandler,
  createCmsListSourceMediaHandler,
  respondWithError,
  readExactSourceTotal,
  readSourceMediaPage,
  runtimeAwsConfig,
  runtimeRegistry,
};
