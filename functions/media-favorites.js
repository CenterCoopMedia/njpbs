"use strict";

const { FieldPath, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const {
  FAVORITES_COLLECTION,
  FAVORITES_ITEMS_COLLECTION,
  MediaFavoriteValidationError,
  canonicalFavoriteRef,
  encodeFavoriteCursor,
  favoriteCreatedAt,
  favoriteDocumentId,
  parseListFavoritesRequest,
  parseSetFavoriteRequest,
  parseSetFavoritesRequest,
  favoritesCollection,
  readFavoriteProjection,
  storedFavoriteRef,
} = require("./lib/media-favorites");
const {
  authorizeMediaSource,
} = require("./lib/media-sources");
const {
  MEDIA_ASSET_UNAVAILABLE_MESSAGE,
  MediaAssetUnavailableError,
  assertMediaAssetAvailable,
  resolveMediaAssets,
} = require("./lib/media-asset-resolver");

const MAX_FAVORITES_JSON_BYTES = 32 * 1024;
const ACCESS_DENIED_MESSAGE = "Media favorite access denied";
const ASSET_UNAVAILABLE_MESSAGE = MEDIA_ASSET_UNAVAILABLE_MESSAGE;

class MediaFavoriteRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MediaFavoriteRejection";
    this.status = status;
  }
}

function privateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function requirePost(req, res) {
  privateNoStore(res);
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  validateBoundedJsonRequest(req, MAX_FAVORITES_JSON_BYTES);
  return true;
}

async function requireFavoriteActor(firestore, req, requirePrincipalFn, isActiveFn) {
  const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
  const approvedActive = typeof actor.approvedActive === "boolean"
    ? actor.approvedActive
    : await isActiveFn(firestore, actor.uid);
  if (!approvedActive) {
    throw new MediaFavoriteRejection(403, ACCESS_DENIED_MESSAGE);
  }
  return { ...actor, approvedActive };
}

function defaultRegistry() {
  return require("./source-media").runtimeRegistry();
}

async function readFavoritePage(firestore, uid, request, documentIdField, timestampFn) {
  let query = favoritesCollection(firestore, uid)
    .orderBy("createdAt", "desc")
    .orderBy(documentIdField, "desc");
  if (request.cursor) {
    query = query.startAfter(
      timestampFn(request.cursor.seconds, request.cursor.nanoseconds),
      request.cursor.id,
    );
  }
  const snapshot = await query.limit(request.limit + 1).get();
  const hasMore = snapshot.docs.length > request.limit;
  const documents = snapshot.docs.slice(0, request.limit);
  return {
    documents,
    nextCursor: hasMore && documents.length > 0
      ? encodeFavoriteCursor(uid, documents.at(-1))
      : null,
  };
}

async function resolveFavoriteRecords({
  firestore,
  actor,
  records,
  registryFn,
  authorizeFn,
}) {
  const refs = records.map((record) => record.ref);
  const resolved = await resolveMediaAssets({
    firestore,
    actor,
    refs,
    registryFn,
    authorizeFn,
  });
  return records.map((record, index) => {
    const asset = resolved[index];
    return asset.available
      ? { ...record, available: true, asset: asset.summary }
      : { ...record, available: false };
  });
}

async function assertFavoriteTargetAvailable({
  firestore,
  actor,
  ref,
  registryFn,
  authorizeFn,
}) {
  try {
    await assertMediaAssetAvailable({
      firestore,
      actor,
      ref,
      registryFn,
      authorizeFn,
    });
  } catch (error) {
    if (error instanceof MediaAssetUnavailableError) {
      throw new MediaFavoriteRejection(404, ASSET_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

function applyFavoriteState(transaction, reference, snapshot, ref, favorite, serverTimestampFn) {
  const canonicalRef = canonicalFavoriteRef(ref);
  const existingRef = snapshot.exists ? storedFavoriteRef(snapshot.data()) : null;
  if (
    snapshot.exists &&
    (!existingRef || canonicalFavoriteRef(existingRef) !== canonicalRef)
  ) {
    throw new Error("Favorite identity collision");
  }
  if (favorite) {
    if (snapshot.exists) return false;
    transaction.create(reference, {
      ref,
      canonicalRef,
      createdAt: serverTimestampFn(),
    });
    return true;
  }
  if (!snapshot.exists) return false;
  transaction.delete(reference);
  return true;
}

async function writeFavoriteState(firestore, uid, ref, favorite, serverTimestampFn) {
  const reference = favoritesCollection(firestore, uid).doc(favoriteDocumentId(ref));
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    return applyFavoriteState(transaction, reference, snapshot, ref, favorite, serverTimestampFn);
  });
}

function favoriteItemError(ref, error, log) {
  if (error instanceof MediaFavoriteRejection) {
    return { ref, error: error.message, status: error.status };
  }
  log?.error("set media favorites item failed", error);
  return { ref, error: "Failed to set media favorite", status: 500 };
}

async function writeFavoriteStates(firestore, uid, results, favorite, serverTimestampFn, log) {
  const admitted = results.filter((result) => !result.error);
  if (admitted.length === 0) return results;
  const collection = favoritesCollection(firestore, uid);
  const references = admitted.map(({ ref }) => collection.doc(favoriteDocumentId(ref)));
  try {
    const written = await firestore.runTransaction(async (transaction) => {
      // Read the bounded batch before any writes; one request uses one transaction.
      const snapshots = typeof transaction.getAll === "function"
        ? await transaction.getAll(...references)
        : await Promise.all(references.map((reference) => transaction.get(reference)));
      const errors = [];
      const items = admitted.map(({ ref }, index) => {
        try {
          const changed = applyFavoriteState(
            transaction, references[index], snapshots[index], ref, favorite, serverTimestampFn,
          );
          return { ref, favorite, changed };
        } catch (error) {
          errors.push(error);
          return favoriteItemError(ref, error);
        }
      });
      return { items, errors };
    });
    for (const error of written.errors) log.error("set media favorites item failed", error);
    let index = 0;
    return results.map((result) => result.error ? result : written.items[index++]);
  } catch (error) {
    log.error("set media favorites failed", error);
    return results.map((result) => result.error ? result : favoriteItemError(result.ref, error));
  }
}

function expectedError(error) {
  return error instanceof JsonRequestError ||
    error instanceof MediaFavoriteValidationError ||
    error instanceof MediaFavoriteRejection ||
    Number.isInteger(error?.status);
}

function respondWithError(res, log, operation, error) {
  if (res.headersSent) return;
  const known = expectedError(error);
  const status = error?.status ?? 500;
  if (!known || status >= 500) log.error(`${operation} failed`, error);
  res.status(status).json({ error: known ? error.message : `Failed to ${operation}` });
}

function createCmsSetMediaFavoriteHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  const isActiveFn = deps.isActiveFn ?? isApprovedActiveAccount;
  const registryFn = deps.registryFn ?? defaultRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const serverTimestampFn = deps.serverTimestampFn ?? (() => FieldValue.serverTimestamp());
  const writeStateFn = deps.writeStateFn ?? writeFavoriteState;
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSetFavoriteRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await requireFavoriteActor(
        firestore,
        req,
        requirePrincipalFn,
        isActiveFn,
      );
      if (request.favorite) {
        await assertFavoriteTargetAvailable({
          firestore,
          actor,
          ref: request.ref,
          registryFn,
          authorizeFn,
        });
      }
      const changed = await writeStateFn(
        firestore,
        actor.uid,
        request.ref,
        request.favorite,
        serverTimestampFn,
      );
      res.status(200).json({
        success: true,
        ref: request.ref,
        favorite: request.favorite,
        changed,
      });
    } catch (error) {
      respondWithError(res, log, "set media favorite", error);
    }
  };
}

function createCmsSetMediaFavoritesHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  const isActiveFn = deps.isActiveFn ?? isApprovedActiveAccount;
  const registryFn = deps.registryFn ?? defaultRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const serverTimestampFn = deps.serverTimestampFn ?? (() => FieldValue.serverTimestamp());
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSetFavoritesRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await requireFavoriteActor(
        firestore,
        req,
        requirePrincipalFn,
        isActiveFn,
      );
      const checked = await Promise.all(request.refs.map(async (ref) => {
        try {
          if (request.favorite) {
            await assertFavoriteTargetAvailable({
              firestore, actor, ref, registryFn, authorizeFn,
            });
          }
          return { ref };
        } catch (error) {
          return favoriteItemError(ref, error, log);
        }
      }));
      const results = await writeFavoriteStates(
        firestore, actor.uid, checked, request.favorite, serverTimestampFn, log,
      );
      res.status(200).json({ success: true, favorite: request.favorite, results });
    } catch (error) {
      respondWithError(res, log, "set media favorites", error);
    }
  };
}

function createCmsListMediaFavoritesHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const isActiveFn = deps.isActiveFn ?? isApprovedActiveAccount;
  const registryFn = deps.registryFn ?? defaultRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const documentIdField = deps.documentIdField ?? FieldPath.documentId();
  const timestampFn = deps.timestampFn ?? ((seconds, nanoseconds) =>
    new Timestamp(seconds, nanoseconds));
  const readProjectionFn = deps.readProjectionFn ?? readFavoriteProjection;
  const readPageFn = deps.readPageFn ?? readFavoritePage;
  const resolveRecordsFn = deps.resolveRecordsFn ?? resolveFavoriteRecords;
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const actor = await requireFavoriteActor(
        firestore,
        req,
        requirePrincipalFn,
        isActiveFn,
      );
      const request = parseListFavoritesRequest(req.body, actor.uid);
      if (request.mode === "projection") {
        const states = await readProjectionFn(firestore, actor.uid, request.refs);
        res.status(200).json({ success: true, states });
        return;
      }
      const page = await readPageFn(
        firestore,
        actor.uid,
        request,
        documentIdField,
        timestampFn,
      );
      const storedRecords = page.documents.flatMap((document) => {
        const ref = storedFavoriteRef(document.data());
        const createdAt = favoriteCreatedAt(document.data()?.createdAt);
        return ref && createdAt ? [{ ref, createdAt }] : [];
      });
      const records = await resolveRecordsFn({
        firestore,
        actor,
        records: storedRecords,
        registryFn,
        authorizeFn,
      });
      res.status(200).json({
        success: true,
        records,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      });
    } catch (error) {
      respondWithError(res, log, "list media favorites", error);
    }
  };
}

const functionOptions = { cors: true, maxInstances: 10, timeoutSeconds: 30 };
const cmsSetMediaFavorite = cmsOnRequest(
  functionOptions,
  createCmsSetMediaFavoriteHandler(),
);
const cmsSetMediaFavorites = cmsOnRequest(
  functionOptions,
  createCmsSetMediaFavoritesHandler(),
);
const cmsListMediaFavorites = cmsOnRequest(
  { ...functionOptions, cpu: 1, concurrency: 80 },
  createCmsListMediaFavoritesHandler(),
);

module.exports = {
  ACCESS_DENIED_MESSAGE,
  ASSET_UNAVAILABLE_MESSAGE,
  FAVORITES_COLLECTION,
  FAVORITES_ITEMS_COLLECTION,
  MAX_FAVORITES_JSON_BYTES,
  MediaFavoriteRejection,
  assertFavoriteTargetAvailable,
  cmsListMediaFavorites,
  cmsSetMediaFavorite,
  cmsSetMediaFavorites,
  createCmsListMediaFavoritesHandler,
  createCmsSetMediaFavoriteHandler,
  createCmsSetMediaFavoritesHandler,
  favoritesCollection,
  readFavoritePage,
  readFavoriteProjection,
  resolveFavoriteRecords,
  writeFavoriteState,
};
