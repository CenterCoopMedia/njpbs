"use strict";

const {
  MEDIA_ASSET_ID_PATTERN,
  MEDIA_ASSET_REF_BACKENDS,
  MediaAssetRefValidationError,
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
  parseUniqueMediaAssetRefs,
  storedMediaAssetRef,
} = require("./media-asset-ref");

const FAVORITES_COLLECTION = "mediaFavorites";
const FAVORITES_ITEMS_COLLECTION = "items";
const MAX_FAVORITE_PAGE_SIZE = 30;
const MAX_FAVORITE_PROJECTION_REFS = 100;
const FAVORITE_REF_BACKENDS = MEDIA_ASSET_REF_BACKENDS;
const FAVORITE_ID_PATTERN = MEDIA_ASSET_ID_PATTERN;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

class MediaFavoriteValidationError extends MediaAssetRefValidationError {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaFavoriteValidationError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownFields(value, allowed, label) {
  if (!plainObject(value)) {
    throw new MediaFavoriteValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new MediaFavoriteValidationError(`Unknown ${label.toLowerCase()} field ${unknown}`);
  }
}

function favoriteValidation(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof MediaAssetRefValidationError) {
      throw new MediaFavoriteValidationError(error.message, error.status);
    }
    throw error;
  }
}

function parseFavoriteRef(value) {
  if (plainObject(value) && value.backend === "voiceover") {
    throw new MediaFavoriteValidationError(
      "Use the canonical R2 audio asset reference for voiceover favorites",
    );
  }
  return favoriteValidation(() => parseMediaAssetRef(value));
}

const canonicalFavoriteRef = canonicalMediaAssetRef;
const favoriteDocumentId = mediaAssetRefDocumentId;

function parseSetFavoriteRequest(value) {
  rejectUnknownFields(value, new Set(["ref", "favorite"]), "Request");
  if (typeof value.favorite !== "boolean") {
    throw new MediaFavoriteValidationError("Favorite state must be true or false");
  }
  return { ref: parseFavoriteRef(value.ref), favorite: value.favorite };
}

function uniqueRefs(values) {
  if (!Array.isArray(values) || values.length > MAX_FAVORITE_PROJECTION_REFS) {
    return favoriteValidation(() =>
      parseUniqueMediaAssetRefs(values, MAX_FAVORITE_PROJECTION_REFS));
  }
  if (values.some((value) =>
    plainObject(value) && value.backend === "voiceover")) {
    throw new MediaFavoriteValidationError(
      "Use the canonical R2 audio asset reference for voiceover favorites",
    );
  }
  return favoriteValidation(() =>
    parseUniqueMediaAssetRefs(values, MAX_FAVORITE_PROJECTION_REFS));
}

function parseSetFavoritesRequest(value) {
  rejectUnknownFields(value, new Set(["refs", "favorite"]), "Request");
  if (typeof value.favorite !== "boolean") {
    throw new MediaFavoriteValidationError("Favorite state must be true or false");
  }
  const refs = uniqueRefs(value.refs);
  if (refs.length === 0) {
    throw new MediaFavoriteValidationError("Refs must not be empty");
  }
  if (refs.length !== value.refs.length) {
    throw new MediaFavoriteValidationError("Refs must not contain duplicates");
  }
  return { refs, favorite: value.favorite };
}

function decodeFavoriteCursor(value, uid) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new MediaFavoriteValidationError("Cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !plainObject(decoded) ||
      decoded.v !== 1 ||
      decoded.uid !== uid ||
      !Number.isSafeInteger(decoded.seconds) ||
      decoded.seconds < 0 ||
      decoded.seconds > MAX_TIMESTAMP_SECONDS ||
      !Number.isSafeInteger(decoded.nanoseconds) ||
      decoded.nanoseconds < 0 ||
      decoded.nanoseconds > 999_999_999 ||
      typeof decoded.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(decoded.id)
    ) {
      throw new Error("Invalid cursor fields");
    }
    return {
      seconds: decoded.seconds,
      nanoseconds: decoded.nanoseconds,
      id: decoded.id,
    };
  } catch {
    throw new MediaFavoriteValidationError("Cursor is invalid");
  }
}

function encodeFavoriteCursor(uid, document) {
  const createdAt = document.data()?.createdAt;
  if (
    !Number.isSafeInteger(createdAt?.seconds) ||
    !Number.isSafeInteger(createdAt?.nanoseconds)
  ) {
    throw new Error(`Favorite ${document.id} has no valid createdAt`);
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    uid,
    seconds: createdAt.seconds,
    nanoseconds: createdAt.nanoseconds,
    id: document.id,
  }), "utf8").toString("base64url");
}

function parseListFavoritesRequest(value, uid) {
  rejectUnknownFields(value, new Set(["cursor", "limit", "refs"]), "Request");
  if (value.refs !== undefined) {
    if (value.cursor !== undefined || value.limit !== undefined) {
      throw new MediaFavoriteValidationError(
        "Favorite projection cannot include page fields",
      );
    }
    return { mode: "projection", refs: uniqueRefs(value.refs) };
  }
  const limit = value.limit === undefined ? MAX_FAVORITE_PAGE_SIZE : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FAVORITE_PAGE_SIZE) {
    throw new MediaFavoriteValidationError(
      `Limit must be a whole number from 1 through ${MAX_FAVORITE_PAGE_SIZE}`,
    );
  }
  return {
    mode: "page",
    limit,
    cursor: value.cursor === undefined ? null : decodeFavoriteCursor(value.cursor, uid),
  };
}

function storedFavoriteRef(value) {
  return storedMediaAssetRef(value);
}

function favoriteCreatedAt(value) {
  const date = value?.toDate?.();
  return date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

function favoritesCollection(firestore, uid) {
  return firestore
    .collection(FAVORITES_COLLECTION)
    .doc(uid)
    .collection(FAVORITES_ITEMS_COLLECTION);
}

async function readSnapshots(firestore, references) {
  if (references.length === 0) return [];
  if (typeof firestore.getAll === "function") {
    return firestore.getAll(...references);
  }
  return Promise.all(references.map((reference) => reference.get()));
}

async function readFavoriteProjection(firestore, uid, refs) {
  const collection = favoritesCollection(firestore, uid);
  const snapshots = await readSnapshots(
    firestore,
    refs.map((ref) => collection.doc(favoriteDocumentId(ref))),
  );
  return refs.map((ref, index) => {
    const storedRef = snapshots[index]?.exists
      ? storedFavoriteRef(snapshots[index].data())
      : null;
    return {
      ref,
      favorite: storedRef !== null &&
        canonicalFavoriteRef(storedRef) === canonicalFavoriteRef(ref),
    };
  });
}

module.exports = {
  FAVORITES_COLLECTION,
  FAVORITES_ITEMS_COLLECTION,
  FAVORITE_ID_PATTERN,
  FAVORITE_REF_BACKENDS,
  MAX_FAVORITE_PAGE_SIZE,
  MAX_FAVORITE_PROJECTION_REFS,
  MediaFavoriteValidationError,
  canonicalFavoriteRef,
  decodeFavoriteCursor,
  encodeFavoriteCursor,
  favoriteCreatedAt,
  favoriteDocumentId,
  favoritesCollection,
  parseFavoriteRef,
  parseListFavoritesRequest,
  parseSetFavoriteRequest,
  parseSetFavoritesRequest,
  readFavoriteProjection,
  readSnapshots,
  storedFavoriteRef,
};
