"use strict";

// Authenticated media reads stay on the server side. Firestore rules deny browser reads of both
// media collections, so this endpoint applies category authorization before it returns records,
// facet counts, totals, or page counts. Active records are scanned in document-id order,
// in bounded batches, with a separate safety ceiling until indexed search replaces the scan.
// Exact-id hydration reads at most 12 documents independently so one failed read does not hide
// the other requested assets.
// Self-service profile-photo reads use a separate caller-bounded query, so the station-wide cap
// cannot prevent a user from selecting or reusing their own uploaded profile photo.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { FieldPath } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { hasCapability } = require("./lib/rbac");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const { computeMediaTabCounts } = require("./lib/media-tab-counts");
const { runtimeRegistry } = require("./lib/media-source-runtime");
const {
  JsonRequestError,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const {
  DEFAULT_MEDIA_KINDS,
  MAX_MEDIA_LIBRARY_PAGE_SIZE,
  MediaLibraryValidationError,
  mediaAssetSummary,
  parseMediaListRequest,
  selectMediaLibrary,
} = require("./lib/media-library");
const { AUTHOR_PHOTO_CATEGORY } = require("./lib/author-profile-contract");
const {
  INDEX_REQUIRED_MESSAGE,
  MAX_ACTIVE_MEDIA_SCAN,
  encodeMediaCorpusCursor,
  parseMediaCorpusRequest,
} = require("./lib/media-corpus");
const { MAX_FAVORITE_PROJECTION_REFS, readFavoriteProjection } = require("./lib/media-favorites");
const { readIndexedMedia } = require("./lib/media-discovery-query");
const {
  MEDIA_CATEGORIES_COLLECTION,
  parseMediaCategoryDefinition,
} = require("./lib/media-categories");

const MAX_MEDIA_SCAN = MAX_MEDIA_LIBRARY_PAGE_SIZE;
// Keep the legacy cap above for upload admission and recycle-bin callers.
const MEDIA_SCAN_BATCH_SIZE = 300;
const MAX_MEDIA_JSON_BYTES = 16 * 1024;
const FORBIDDEN_MESSAGE = "You do not have permission to list media.";
const PROFILE_PHOTO_SCOPE_MESSAGE =
  "Profile photo browsing is limited to your own staff profile images.";
const COUNTS_FLAG_MESSAGE =
  "counts must be true and cannot be combined with assetIds or profilePhotoScope";
const FAVORITES_FLAG_MESSAGE =
  "favorites must be true and cannot be combined with profile photo scope.";
const SUMMARY_FIELDS = Object.freeze([
  "name",
  "originalName",
  "category",
  "categories",
  "tags",
  "description",
  "altText",
  "altTextGenerated",
  "metadataUpdateRequested",
  "license",
  "credit",
  "mimeType",
  "kind",
  "sizeBytes",
  "width",
  "height",
  "url",
  "thumbnails",
  "animated",
  // Server-only receipt: mediaAssetSummary exposes only its availability flag.
  "master",
  "source",
  "voiceover",
  "voiceoverTakeId",
  "lifecycle",
  "version",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
]);

class ListMediaRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ListMediaRejection";
    this.status = status;
  }
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

async function scanMediaSummaries(query, {
  batchSize = MEDIA_SCAN_BATCH_SIZE,
  maxAssets = MAX_ACTIVE_MEDIA_SCAN,
} = {}) {
  // Refuse an oversized library using index entries before loading its summaries.
  const count = (await query.limit(maxAssets + 1).count().get()).data().count;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid media count");
  if (count > maxAssets) return { overflow: true, records: [] };
  const records = [];
  let scanned = 0;
  let cursor;
  const ordered = query.orderBy(FieldPath.documentId()).select(...SUMMARY_FIELDS);
  while (true) {
    // Read only one extra document to distinguish an exact ceiling from overflow.
    const limit = Math.min(batchSize, maxAssets + 1 - scanned);
    const page = cursor ? ordered.startAfter(cursor) : ordered;
    const snapshot = await page.limit(limit).get();
    for (const document of snapshot.docs) {
      if (++scanned > maxAssets) return { overflow: true, records };
      const summary = mediaAssetSummary(document.id, document.data());
      if (summary) records.push(summary);
    }
    if (snapshot.docs.length < limit) return { overflow: false, records };
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
  }
}

async function readMediaAssetSummaries(firestore, scanOptions) {
  return scanMediaSummaries(firestore
    .collection("media_assets")
    .where("lifecycle", "==", "active"), scanOptions);
}

async function readMediaCorpusPage(firestore, request) {
  const active = firestore.collection("media_assets").where("lifecycle", "==", "active");
  // This global gate cannot be bypassed by changing a cursor. Aggregation reads index
  // entries only and honors the limit; never expose the count in the response.
  const count = (await active.limit(MAX_ACTIVE_MEDIA_SCAN + 1).count().get()).data().count;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid media count");
  if (count > MAX_ACTIVE_MEDIA_SCAN) throw new ListMediaRejection(503, INDEX_REQUIRED_MESSAGE);
  let query = active.orderBy(FieldPath.documentId()).select(...SUMMARY_FIELDS);
  if (request.after !== null) query = query.startAfter(request.after);
  const snapshot = await query.limit(request.limit + 1).get();
  const documents = snapshot.docs.slice(0, request.limit);
  return {
    records: documents.flatMap(document => {
      const summary = mediaAssetSummary(document.id, document.data());
      // The related-results corpus serves the Images tab, which never lists audio.
      return summary && DEFAULT_MEDIA_KINDS.includes(summary.kind) ? [summary] : [];
    }),
    // Advance over malformed, audio and denied summaries, including a wholly skipped batch.
    after: snapshot.docs.length > request.limit ? documents.at(-1).id : null,
  };
}

async function readMediaAssetSummariesByIds(firestore, assetIds) {
  if (assetIds.length === 0) return { overflow: false, records: [], failedIds: [] };
  const mediaAssets = firestore.collection("media_assets");
  if (typeof firestore.getAll === "function") {
    try {
      const snapshots = await firestore.getAll(
        ...assetIds.map((assetId) => mediaAssets.doc(assetId)),
      );
      const records = snapshots.flatMap((snapshot) => {
        if (!snapshot?.exists) return [];
        const summary = mediaAssetSummary(snapshot.id, snapshot.data());
        return summary ? [summary] : [];
      });
      return { overflow: false, records, failedIds: [] };
    } catch {
      // Fall through to per-id reads so one missing API still hydrates rows.
    }
  }
  const results = await Promise.allSettled(
    assetIds.map((assetId) => mediaAssets.doc(assetId).get()),
  );
  const records = [];
  const failedIds = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failedIds.push(assetIds[index]);
      return;
    }
    if (!result.value.exists) return;
    const summary = mediaAssetSummary(result.value.id, result.value.data());
    if (summary) records.push(summary);
  });
  return { overflow: false, records, failedIds };
}

async function readSelfProfilePhotoSummaries(firestore, uid, scanOptions) {
  return scanMediaSummaries(firestore
    .collection("media_assets")
    .where("createdBy", "==", uid)
    .where("category", "==", AUTHOR_PHOTO_CATEGORY)
    .where("lifecycle", "==", "active"), scanOptions);
}

async function readMediaCategoryLabels(firestore) {
  const snapshot = await firestore.collection(MEDIA_CATEGORIES_COLLECTION).limit(501).get();
  if (snapshot.size > 500) {
    throw new ListMediaRejection(503, "Media categories exceed the indexed query budget.");
  }
  return Object.fromEntries(
    snapshot.docs.flatMap((document) => {
      const category = parseMediaCategoryDefinition(document.id, document.data());
      return category ? [[category.id, category.label]] : [];
    }),
  );
}

function visibleMediaSummaries(
  principal,
  records,
  selfProfileUid = null,
  audioReadAdmitted = false,
) {
  return records.flatMap((record) => {
    const summary = mediaAssetSummary(record?.id, record);
    if (!summary) return [];
    if (selfProfileUid !== null) {
      return summary.category === AUTHOR_PHOTO_CATEGORY &&
        summary.kind === "image" &&
        summary.createdBy === selfProfileUid
        ? [summary]
        : [];
    }
    if (!mayUseMedia(principal, summary.category, summary.kind, audioReadAdmitted)) return [];
    return [summary];
  });
}

function hasMediaLibraryCapability(principal) {
  return hasCapability(principal, "media.image.read") || hasCapability(principal, "media.upload") ||
    hasCapability(principal, "media.manage");
}

function isAudioReadRequest(query) {
  return Boolean(query.assetIds) ||
    (query.kinds.length === 1 && query.kinds[0] === "audio");
}

function hasAdmittedAudioRead(user, query) {
  return (isAudioReadRequest(query) || hasCapability(user.principal, "media.image.read")) &&
    isAudioReadAdmitted(user);
}

// Counts never block the list: any failure leaves them out and the page still loads.
async function readTabCounts({
  firestore,
  user,
  imagesCount,
  computeTabCountsFn,
  registryFn,
  isApprovedActiveAccountFn,
  log,
}) {
  try {
    const approvedActive = typeof user.approvedActive === "boolean"
      ? user.approvedActive
      : await isApprovedActiveAccountFn(firestore, user.uid);
    return await computeTabCountsFn({
      firestore,
      actor: user,
      registry: registryFn(),
      approvedActive,
      imagesCount,
      log,
    });
  } catch (error) {
    log.warn?.("cmsListMedia left out tab counts", { uid: user.uid, error: error?.message });
    return null;
  }
}

function createCmsListMediaHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    readRecordsFn = readMediaAssetSummaries,
    readCorpusPageFn = readMediaCorpusPage,
    readRecordsByIdsFn = readMediaAssetSummariesByIds,
    readSelfProfileRecordsFn = readSelfProfilePhotoSummaries,
    readCategoryLabelsFn = readMediaCategoryLabels,
    readIndexedMediaFn = readIndexedMedia,
    isApprovedActiveAccountFn = isApprovedActiveAccount,
    computeTabCountsFn = computeMediaTabCounts,
    readFavoriteProjectionFn = readFavoriteProjection,
    registryFn = runtimeRegistry,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateBoundedJsonRequest(req, MAX_MEDIA_JSON_BYTES);
      const corpusRequested = Boolean(req.body) && typeof req.body === "object" &&
        Object.hasOwn(req.body, "corpus");
      // Tab counts are opt-in; every list still requires current account admission.
      const countsRequested = Boolean(req.body) && typeof req.body === "object" &&
        Object.hasOwn(req.body, "counts");
      // Favorite states for the listed page are opt-in too. They replace the separate
      // cmsListMediaFavorites round trip that otherwise waits for this response.
      const favoritesRequested = Boolean(req.body) && typeof req.body === "object" &&
        Object.hasOwn(req.body, "favorites");
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      if (corpusRequested) {
        const request = parseMediaCorpusRequest(req.body, user.uid);
        if (user.approvedActive !== true ||
            !hasMediaLibraryCapability(user.principal)) {
          throw new ListMediaRejection(403, FORBIDDEN_MESSAGE);
        }
        const page = await readCorpusPageFn(firestore, request);
        res.status(200).json({
          success: true,
          records: visibleMediaSummaries(user.principal, page.records, null, isAudioReadAdmitted(user)),
          nextCursor: page.after === null ? null : encodeMediaCorpusCursor(user.uid, page.after),
        });
        return;
      }
      let listBody = req.body;
      let countsFlag;
      let favoritesFlag;
      if (countsRequested) ({ counts: countsFlag, ...listBody } = listBody);
      if (favoritesRequested) ({ favorites: favoritesFlag, ...listBody } = listBody);
      const query = parseMediaListRequest(listBody);
      if (favoritesRequested && (favoritesFlag !== true || query.profilePhotoScope)) {
        throw new ListMediaRejection(400, FAVORITES_FLAG_MESSAGE);
      }
      if (
        countsRequested &&
        (countsFlag !== true || query.assetIds || query.profilePhotoScope)
      ) {
        throw new ListMediaRejection(400, COUNTS_FLAG_MESSAGE);
      }
      const audioReadAdmitted = hasAdmittedAudioRead(user, query);
      const selfProfileScope = query.profilePhotoScope === "self";
      if (selfProfileScope) {
        if (
          query.categories.length !== 1 ||
          query.categories[0] !== AUTHOR_PHOTO_CATEGORY ||
          query.kinds.length !== 1 ||
          query.kinds[0] !== "image"
        ) {
          throw new ListMediaRejection(400, PROFILE_PHOTO_SCOPE_MESSAGE);
        }
        if (!(await isApprovedActiveAccountFn(firestore, user.uid))) {
          throw new ListMediaRejection(403, PROFILE_PHOTO_SCOPE_MESSAGE);
        }
      } else if (!hasMediaLibraryCapability(user.principal) &&
          !audioReadAdmitted) {
        log.warn("cmsListMedia refused a caller without media access", {
          uid: user.uid,
        });
        throw new ListMediaRejection(403, FORBIDDEN_MESSAGE);
      }

      let library;
      if (query.paging === "cursor") {
        const labels = await readCategoryLabelsFn(firestore);
        library = await readIndexedMediaFn(firestore, user, query, labels, SUMMARY_FIELDS);
      } else {
        const readResult = query.assetIds
          ? readRecordsByIdsFn(firestore, query.assetIds)
          : selfProfileScope
            ? readSelfProfileRecordsFn(firestore, user.uid)
            : readRecordsFn(firestore);
        const [result, categoryLabels] = await Promise.all([
          readResult,
          readCategoryLabelsFn(firestore),
        ]);
        if (result.failedIds?.length > 0) {
          log.warn("cmsListMedia could not read some requested assets", {
            assetIds: result.failedIds,
          });
        }
        if (result.overflow) {
          throw new ListMediaRejection(503, INDEX_REQUIRED_MESSAGE);
        }
        // Re-project at the response boundary even though the default Firestore reader already
        // selected and normalized these fields. This prevents a future reader change from turning
        // a private storage or recovery field into an accidental API property.
        const visible = visibleMediaSummaries(
          user.principal,
          result.records,
          selfProfileScope ? user.uid : null,
          audioReadAdmitted,
        );
        library = selectMediaLibrary(visible, query, query.pageSize, categoryLabels);
      }
      // Favorites belong to approved active accounts, as in cmsListMediaFavorites. Otherwise the
      // states are omitted and the client's own favorites request reports the refusal.
      const favoriteRefs = library.records.map((asset) => ({ backend: "r2", id: asset.id }));
      const [counts, favoriteStates] = await Promise.all([
        countsRequested
          ? readTabCounts({
            firestore,
            user,
            imagesCount: query.kinds.includes("audio") ? null : library.allCount,
            computeTabCountsFn,
            registryFn,
            isApprovedActiveAccountFn,
            log,
          })
          : null,
        favoritesRequested && user.approvedActive === true &&
          favoriteRefs.length <= MAX_FAVORITE_PROJECTION_REFS
          // A failed read leaves the states out; the list still loads and the client asks again.
          ? readFavoriteProjectionFn(firestore, user.uid, favoriteRefs).catch((error) => {
            log.warn("cmsListMedia could not read favorite states", { uid: user.uid, error: error?.message });
            return null;
          })
          : null,
      ]);
      res.status(200).json({
        success: true,
        ...library,
        ...(counts ? { counts } : {}),
        ...(favoriteStates ? { favoriteStates } : {}),
      });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof ListMediaRejection ||
        error instanceof MediaLibraryValidationError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status ||
        (error?.code === "failed-precondition" || error?.code === 9 ? 503 : 500);
      if (!expected || status >= 500) {
        log.error("cmsListMedia failed", error);
      }
      res.status(status).json({
        error: expected
          ? error.message
          : "Failed to list media",
      });
    }
  };
}

const cmsListMedia = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30, minInstances: 1, cpu: 1, concurrency: 80 },
  createCmsListMediaHandler(),
);

module.exports = {
  COUNTS_FLAG_MESSAGE,
  FORBIDDEN_MESSAGE,
  INDEX_REQUIRED_MESSAGE,
  ListMediaRejection,
  MAX_MEDIA_SCAN,
  MAX_ACTIVE_MEDIA_SCAN,
  MEDIA_SCAN_BATCH_SIZE,
  MAX_MEDIA_JSON_BYTES,
  PROFILE_PHOTO_SCOPE_MESSAGE,
  SUMMARY_FIELDS,
  cmsListMedia,
  createCmsListMediaHandler,
  mayUseMedia,
  readMediaAssetSummaries,
  readMediaCorpusPage,
  readMediaAssetSummariesByIds,
  readMediaCategoryLabels,
  readSelfProfilePhotoSummaries,
  setPrivateNoStore,
  visibleMediaSummaries,
};
