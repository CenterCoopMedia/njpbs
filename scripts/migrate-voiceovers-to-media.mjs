#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import mediaCategories from "../functions/lib/media-categories.js";
import mediaContract from "../functions/lib/media-contract.js";
import mediaDiscovery from "../functions/lib/media-discovery.js";
import mediaFavorites from "../functions/lib/media-favorites.js";
import voiceoverReview from "../functions/lib/voiceover-review.js";

const DEMO_PROJECT_ID = "demo-njpbs";
const PRODUCTION_PROJECT_ID = "njpbs-site";
const REQUIRED_TAKE_COUNT = 196;
const MIGRATION_ID = "voiceover-media-v1";
const MIGRATION_VERSION = 1;
const COMPLETION_DOCUMENT = "system/voiceoverMediaMigrationV1";
const SYSTEM_ACTOR = "system:voiceover-media-migration";
const MEDIA_COLLECTION = "media_assets";
const TAKE_PATH = /^voiceoverTakes\/([^/]+)$/;
const REVIEW_PATH = /^voiceoverReviews\/([^/]+)\/takes\/([^/]+)$/;
const DEFAULT_TRANSACTION_CHUNK_SIZE = 25;
const MAX_TRANSACTION_CHUNK_SIZE = 25;

const { normalizeMediaCategoryId, parseMediaCategoryDefinition } = mediaCategories;
const { assertAssetId, normalizeOriginalName, normalizeTags } = mediaContract;
const { bumpMediaDiscoveryRevision, withMediaDiscovery } = mediaDiscovery;
const {
  canonicalFavoriteRef,
  favoriteDocumentId,
  storedFavoriteRef,
} = mediaFavorites;
const {
  LIBRARY_DOCUMENT,
  MAX_AUDIO_BYTES,
  MAX_TAKES,
  SUPPORTED_MANIFEST_VERSION,
  TAKES_COLLECTION,
  libraryProjection,
  reviewProjection,
  takeProjection,
  validId,
} = voiceoverReview;

function stableValue(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function withoutMigrationMarker(value) {
  const record = { ...value };
  delete record.voiceoverMigration;
  return record;
}

function validDateString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertChunkSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSACTION_CHUNK_SIZE) {
    throw new Error(`Migration chunk size must be an integer from 1 through ${MAX_TRANSACTION_CHUNK_SIZE}`);
  }
  return value;
}

function assertSourceTimestamps(label, value) {
  if (!validDateString(value.createdAt) || !validDateString(value.updatedAt)) {
    throw new Error(`${label} has invalid source timestamps`);
  }
}

function sourceActor(value) {
  return typeof value === "string" && value.trim() ? value : SYSTEM_ACTOR;
}

function conciseName(take) {
  const prefix = "Voiceover: ";
  const normalized = take.display_text.trim().replace(/\s+/g, " ");
  const maximum = 180 - prefix.length;
  if (normalized.length <= maximum) return `${prefix}${normalized}`;
  return `${prefix}${normalized.slice(0, maximum - 3).trimEnd()}...`;
}

function derivedMediaTags(projection) {
  const tags = [];
  const seen = new Set();
  let omissions = 0;
  for (const candidate of ["voiceover", projection.style, ...projection.flags]) {
    const tag = candidate.trim();
    const key = tag.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    if (tag.length > 40 || tags.length >= 20) {
      omissions += 1;
      continue;
    }
    tags.push(tag);
  }
  return { tags: normalizeTags(tags), omissions };
}

function assertPrivateTakeFields(id, value) {
  if (value.objectKey !== `takes/v1/${id}.wav`) {
    throw new Error(`Voiceover take ${id} has no storage object`);
  }
  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
    throw new Error(`Voiceover take ${id} has an invalid content hash`);
  }
  if (!Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 1 || value.sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error(`Voiceover take ${id} has an invalid size`);
  }
}

function mediaIdForTake(takeId) {
  if (!validId(takeId)) throw new Error(`Voiceover take id ${takeId} is invalid`);
  const mediaId = `voiceover-${takeId}`;
  try {
    return assertAssetId(mediaId);
  } catch {
    throw new Error(`Voiceover take ${takeId} cannot form a valid media asset id`);
  }
}

function voiceoverSourceHash({ projection, performerName, raw }) {
  return fingerprint({
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    ...projection,
    performer_name: performerName,
    objectKey: raw.objectKey,
    contentHash: raw.contentHash,
    sizeBytes: raw.sizeBytes,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    recordedByUid: raw.recordedByUid ?? null,
  });
}

function mediaRecord({ category, projection, performerName, raw }) {
  assertPrivateTakeFields(projection.id, raw);
  assertSourceTimestamps(`Voiceover take ${projection.id}`, raw);
  const id = mediaIdForTake(projection.id);
  const actor = sourceActor(raw.recordedByUid);
  const originalName = normalizeOriginalName(`${projection.id}.wav`);
  const voiceover = {
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    ...projection,
    performer_name: performerName,
  };
  const derivedTags = derivedMediaTags(projection);
  const record = withMediaDiscovery(id, {
    id,
    name: conciseName(projection),
    originalName,
    category,
    categories: [category],
    tags: derivedTags.tags,
    description: projection.text,
    altText: null,
    license: null,
    credit: performerName,
    mimeType: "audio/wav",
    kind: "audio",
    sizeBytes: raw.sizeBytes,
    width: null,
    height: null,
    contentHash: raw.contentHash,
    storageKey: raw.objectKey,
    url: `https://admin.njpbs.org/media/voiceovers?asset=${encodeURIComponent(id)}`,
    lifecycle: "active",
    source: "voiceover",
    voiceoverTakeId: projection.id,
    voiceover,
    version: 1,
    createdAt: raw.createdAt,
    createdBy: actor,
    updatedAt: raw.updatedAt,
    updatedBy: actor,
  });
  const sourceTakeHash = voiceoverSourceHash({
    projection,
    performerName,
    raw,
  });
  return {
    ...record,
    voiceoverMigration: {
      id: MIGRATION_ID,
      version: MIGRATION_VERSION,
      category,
      sourcePath: `${TAKES_COLLECTION}/${projection.id}`,
      sourceTakeHash,
      fingerprint: fingerprint(record),
    },
  };
}

function favoriteSourceHash({ takeId, projection, raw }) {
  return fingerprint({
    takeId,
    manifestVersion: raw.manifestVersion,
    favorite: projection.favorite,
    createdAt: raw.createdAt,
  });
}

function timestampForReview(raw) {
  assertSourceTimestamps("Voiceover review", raw);
  return Timestamp.fromDate(new Date(raw.createdAt));
}

function favoriteRecord({ category, mediaId, path, takeId, projection, raw }) {
  const ref = { backend: "r2", id: mediaId };
  const base = {
    ref,
    canonicalRef: canonicalFavoriteRef(ref),
    createdAt: timestampForReview(raw),
  };
  return {
    ...base,
    voiceoverMigration: {
      id: MIGRATION_ID,
      version: MIGRATION_VERSION,
      category,
      sourcePath: path,
      sourceReviewHash: favoriteSourceHash({ takeId, projection, raw }),
      fingerprint: fingerprint(base),
    },
  };
}

function migrationMarker(value, category) {
  const marker = value?.voiceoverMigration;
  return marker?.id === MIGRATION_ID &&
    marker.version === MIGRATION_VERSION &&
    marker.category === category
    ? marker
    : null;
}

function sourceDatasetHash(sources) {
  return fingerprint({
    library: sources.libraryRaw,
    takes: sources.takes.map(({ path, raw }) => ({ path, value: raw })),
  });
}

function sourceReviewDatasetHash(reviews) {
  return fingerprint(reviews.map(({ path, raw }) => ({ path, value: raw })));
}

function completionRecord(category, sources) {
  return {
    id: MIGRATION_ID,
    version: MIGRATION_VERSION,
    category,
    state: "complete",
    source: {
      libraryDocument: LIBRARY_DOCUMENT,
      manifestVersion: SUPPORTED_MANIFEST_VERSION,
      activeTakeCount: REQUIRED_TAKE_COUNT,
      datasetHash: sourceDatasetHash(sources),
    },
  };
}

function completionPlan(
  firestore,
  snapshot,
  category,
  sources,
  { allowSourceDrift = false } = {},
) {
  const expected = completionRecord(category, sources);
  const stored = snapshot.exists ? snapshot.data() : null;
  const storedDatasetHash = stored?.source?.datasetHash;
  const validStoredSchema = !snapshot.exists || (
    typeof storedDatasetHash === "string" &&
    /^[a-f0-9]{64}$/.test(storedDatasetHash) &&
    isDeepStrictEqual(
      {
        ...stored,
        source: { ...stored.source, datasetHash: expected.source.datasetHash },
      },
      expected,
    )
  );
  const sourceMatches = !snapshot.exists || isDeepStrictEqual(stored, expected);
  if (!validStoredSchema || (!allowSourceDrift && !sourceMatches)) {
    throw new Error(`Voiceover migration completion marker collision at ${snapshot.ref.path}`);
  }
  return {
    ref: firestore.doc(COMPLETION_DOCUMENT),
    record: stored ?? expected,
    create: !snapshot.exists,
    verified: snapshot.exists ? 1 : 0,
    sourceMatches,
    conflicts: snapshot.exists && !sourceMatches ? 1 : 0,
  };
}

function validFavoriteTimestamp(value) {
  return value instanceof Timestamp && Number.isFinite(value.toDate().getTime());
}

function correctRetainedFavorite(value, expectedCanonicalRef) {
  const stored = storedFavoriteRef(value);
  return Boolean(
    stored &&
    canonicalFavoriteRef(stored) === expectedCanonicalRef &&
    value.canonicalRef === expectedCanonicalRef &&
    validFavoriteTimestamp(value.createdAt)
  );
}

function correctUnownedFavorite(value, expectedCanonicalRef) {
  return correctRetainedFavorite(value, expectedCanonicalRef) &&
    value.voiceoverMigration === undefined;
}

function firestoreProjectId(firestore) {
  return firestore?.app?.options?.projectId ?? firestore?._settings?.projectId ?? null;
}

export function assertMigrationEnvironment({
  firestore,
  env = process.env,
  projectId = firestoreProjectId(firestore),
  allowProduction = false,
} = {}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (projectId === PRODUCTION_PROJECT_ID) {
    if (allowProduction !== true) {
      throw new Error("Production migration requires --allow-production");
    }
    return projectId;
  }
  if (projectId !== DEMO_PROJECT_ID) {
    throw new Error(
      `The voiceover media migration requires project ${DEMO_PROJECT_ID} or ${PRODUCTION_PROJECT_ID}`,
    );
  }
  if (typeof env.FIRESTORE_EMULATOR_HOST !== "string" ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]*$/.test(env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error("The demo voiceover media migration requires a local Firestore emulator");
  }
  return projectId;
}

async function requireActiveCategory(firestore, category) {
  const categoryId = normalizeMediaCategoryId(category);
  const snapshot = await firestore.collection("mediaCategories").doc(categoryId).get();
  const definition = snapshot.exists
    ? parseMediaCategoryDefinition(snapshot.id, snapshot.data())
    : null;
  if (!definition) throw new Error(`Media category ${category} does not exist`);
  if (!definition.active) throw new Error(`Media category ${category} is not active`);
  return definition;
}

async function readVoiceoverSources(firestore) {
  const [librarySnapshot, takesSnapshot, reviewsSnapshot] = await Promise.all([
    firestore.doc(LIBRARY_DOCUMENT).get(),
    firestore.collection(TAKES_COLLECTION).limit(MAX_TAKES + 1).get(),
    firestore.collectionGroup("takes").get(),
  ]);
  if (!librarySnapshot.exists) throw new Error("The voiceover library is unavailable");
  const library = libraryProjection(librarySnapshot.data());
  if (library.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
      library.takeCount !== REQUIRED_TAKE_COUNT) {
    throw new Error(`The voiceover library must declare exactly ${REQUIRED_TAKE_COUNT} takes`);
  }
  if (takesSnapshot.size > MAX_TAKES) {
    throw new Error("The voiceover take collection exceeds its supported limit");
  }

  const takes = [];
  for (const snapshot of takesSnapshot.docs) {
    if (snapshot.data()?.active !== true) continue;
    const projection = takeProjection(
      snapshot.id,
      snapshot.data(),
      library.manifestVersion,
    );
    assertSourceTimestamps(`Voiceover take ${snapshot.id}`, snapshot.data());
    const performer = library.performers[projection.performer_id];
    if (!performer) {
      throw new Error(`Voiceover take ${snapshot.id} uses an unknown performer`);
    }
    takes.push({
      path: snapshot.ref.path,
      projection,
      performerName: performer.name,
      raw: snapshot.data(),
    });
  }
  takes.sort((left, right) => left.projection.id.localeCompare(right.projection.id));
  if (takes.length !== REQUIRED_TAKE_COUNT) {
    throw new Error(`The voiceover library must contain exactly ${REQUIRED_TAKE_COUNT} active takes`);
  }
  if (new Set(takes.map(({ projection }) => projection.id)).size !== takes.length) {
    throw new Error("The voiceover library contains duplicate active take ids");
  }

  const activeIds = new Set(takes.map(({ projection }) => projection.id));
  const reviews = [];
  for (const snapshot of reviewsSnapshot.docs) {
    const match = REVIEW_PATH.exec(snapshot.ref.path);
    if (!match) continue;
    const [, uid, takeId] = match;
    if (!activeIds.has(takeId)) {
      if (snapshot.data()?.favorite === true) {
        throw new Error(`Favorite review ${snapshot.ref.path} has no active voiceover take`);
      }
      continue;
    }
    const projection = reviewProjection(
      takeId,
      snapshot.data(),
      library.manifestVersion,
    );
    assertSourceTimestamps(`Voiceover review ${snapshot.ref.path}`, snapshot.data());
    reviews.push({
      path: snapshot.ref.path,
      uid,
      takeId,
      projection,
      raw: snapshot.data(),
    });
  }
  reviews.sort((left, right) => left.path.localeCompare(right.path));
  return { library, libraryRaw: librarySnapshot.data(), takes, reviews };
}

function sourceCounts(sources) {
  return {
    activeTakes: sources.takes.length,
    reviews: sources.reviews.length,
    favoriteReviews: sources.reviews.filter(({ projection }) => projection.favorite).length,
    falseFavorites: sources.reviews.filter(({ projection }) => !projection.favorite).length,
    moreLikeThis: sources.reviews.filter(({ projection }) => projection.moreLikeThis).length,
    notes: sources.reviews.filter(({ projection }) => projection.notes.length > 0).length,
    derivedTagOmissions: sources.takes.reduce(
      (count, { projection }) => count + derivedMediaTags(projection).omissions,
      0,
    ),
  };
}

function resultForMigration({
  apply,
  chunkSize,
  project,
  sources,
  media,
  favorites,
  completion,
}) {
  const mediaWrites = media.create.length;
  const favoriteWrites = favorites.create.length;
  const revisionWrites = Math.ceil(mediaWrites / chunkSize);
  const completionWrites = completion.create ? 1 : 0;
  return {
    mode: "migrate",
    apply,
    chunkSize,
    project,
    source: sourceCounts(sources),
    media: {
      planned: mediaWrites,
      created: apply ? mediaWrites : 0,
      verified: media.verified,
      retained: 0,
      deleted: 0,
      skipped: 0,
      conflicts: 0,
    },
    favorites: {
      planned: favoriteWrites,
      created: apply ? favoriteWrites : 0,
      verified: favorites.verified,
      retained: favorites.retained,
      deleted: 0,
      skipped: favorites.skipped,
      conflicts: 0,
    },
    discoveryRevision: {
      planned: revisionWrites,
      updated: apply ? revisionWrites : 0,
    },
    completion: {
      planned: completionWrites,
      created: apply ? completionWrites : 0,
      verified: completion.verified,
      retained: 0,
      deleted: 0,
      skipped: 0,
      conflicts: 0,
    },
    plannedWrites: mediaWrites + favoriteWrites + revisionWrites + completionWrites,
  };
}

async function preflightMigration({
  firestore,
  category,
  categoryDefinition,
  sources,
}) {
  const completionSnapshot = await firestore.doc(COMPLETION_DOCUMENT).get();
  const completion = completionPlan(
    firestore,
    completionSnapshot,
    category,
    sources,
  );
  const media = { create: [], verified: 0 };
  const byTakeId = new Map();
  const expectedMedia = sources.takes.map((source) => {
    const record = mediaRecord({ category, ...source });
    byTakeId.set(source.projection.id, record.id);
    return { source, record, ref: firestore.collection(MEDIA_COLLECTION).doc(record.id) };
  });
  const mediaSnapshots = await firestore.getAll(...expectedMedia.map(({ ref }) => ref));
  for (const [index, expected] of expectedMedia.entries()) {
    const snapshot = mediaSnapshots[index];
    if (!snapshot.exists) {
      media.create.push(expected);
      continue;
    }
    if (!migrationMarker(snapshot.data(), category) ||
        !isDeepStrictEqual(snapshot.data(), expected.record)) {
      throw new Error(`Media asset collision at ${snapshot.ref.path}`);
    }
    media.verified += 1;
  }

  const favorites = { create: [], verified: 0, retained: 0, skipped: 0 };
  const expectedFavorites = sources.reviews
    .filter(({ projection }) => projection.favorite)
    .map((review) => {
      const mediaId = byTakeId.get(review.takeId);
      const ref = { backend: "r2", id: mediaId };
      const id = favoriteDocumentId(ref);
      return {
        review,
        record: favoriteRecord({ category, mediaId, ...review }),
        ref: firestore.collection("mediaFavorites").doc(review.uid).collection("items").doc(id),
      };
    });
  const favoriteSnapshots = expectedFavorites.length > 0
    ? await firestore.getAll(...expectedFavorites.map(({ ref }) => ref))
    : [];
  for (const [index, expected] of expectedFavorites.entries()) {
    const snapshot = favoriteSnapshots[index];
    if (!snapshot.exists) {
      if (completion.verified) {
        favorites.retained += 1;
        favorites.skipped += 1;
        continue;
      }
      favorites.create.push(expected);
      continue;
    }
    const stored = snapshot.data();
    if (correctUnownedFavorite(stored, expected.record.canonicalRef)) {
      favorites.retained += 1;
      continue;
    }
    if (migrationMarker(stored, category) &&
        isDeepStrictEqual(stored, expected.record)) {
      favorites.verified += 1;
      continue;
    }
    if (completion.verified && correctRetainedFavorite(stored, expected.record.canonicalRef)) {
      favorites.retained += 1;
      continue;
    }
    throw new Error(`Media favorite collision at ${snapshot.ref.path}`);
  }
  return { media, favorites, completion, categoryDefinition };
}

function currentCategoryDefinition(snapshot) {
  if (!snapshot.exists) return null;
  const definition = parseMediaCategoryDefinition(snapshot.id, snapshot.data());
  return definition?.active ? definition : null;
}

function currentLibraryProjection(snapshot) {
  if (!snapshot.exists) return null;
  try {
    return libraryProjection(snapshot.data());
  } catch {
    return null;
  }
}

function assertCreateContext(categorySnapshot, librarySnapshot, plan, sources) {
  const category = currentCategoryDefinition(categorySnapshot);
  if (!category || !isDeepStrictEqual(category, plan.categoryDefinition)) {
    throw new Error("Media category changed after migration preflight");
  }
  const library = currentLibraryProjection(librarySnapshot);
  if (!library || !isDeepStrictEqual(library, sources.library)) {
    throw new Error("Voiceover library changed after migration preflight");
  }
  return library;
}

async function commitCreatePlan({ firestore, plan, sources, category, chunkSize }) {
  const categoryRef = firestore.collection("mediaCategories").doc(category);
  const libraryRef = firestore.doc(LIBRARY_DOCUMENT);
  for (let index = 0; index < plan.media.create.length;
    index += chunkSize) {
    const entries = plan.media.create.slice(index, index + chunkSize);
    await firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(
        categoryRef,
        libraryRef,
        ...entries.map(({ source }) => firestore.doc(source.path)),
        ...entries.map(({ ref }) => ref),
      );
      const library = assertCreateContext(snapshots[0], snapshots[1], plan, sources);
      const sourceOffset = 2;
      const targetOffset = sourceOffset + entries.length;
      for (const [entryIndex, entry] of entries.entries()) {
        const source = currentTakeSource(
          snapshots[sourceOffset + entryIndex],
          library,
        );
        if (!source || !isDeepStrictEqual(
          mediaRecord({ category, ...source }),
          entry.record,
        )) {
          throw new Error(`Voiceover source changed for ${entry.source.projection.id}`);
        }
        if (snapshots[targetOffset + entryIndex].exists) {
          throw new Error(`Media asset collision at ${entry.ref.path}`);
        }
      }
      for (const entry of entries) transaction.create(entry.ref, entry.record);
      bumpMediaDiscoveryRevision(transaction, firestore);
    });
  }
  for (let index = 0; index < plan.favorites.create.length;
    index += chunkSize) {
    const entries = plan.favorites.create.slice(
      index,
      index + chunkSize,
    );
    await firestore.runTransaction(async (transaction) => {
      const snapshots = await transaction.getAll(
        categoryRef,
        libraryRef,
        ...entries.map(({ review }) => firestore.doc(review.path)),
        ...entries.map(({ ref }) => ref),
      );
      const library = assertCreateContext(snapshots[0], snapshots[1], plan, sources);
      const sourceOffset = 2;
      const targetOffset = sourceOffset + entries.length;
      for (const [entryIndex, entry] of entries.entries()) {
        const review = currentReviewSource(
          snapshots[sourceOffset + entryIndex],
          library,
          entry.review.uid,
          entry.review.takeId,
        );
        if (!review || !review.projection.favorite || !isDeepStrictEqual(
          favoriteRecord({
            category,
            mediaId: entry.record.ref.id,
            ...review,
          }),
          entry.record,
        )) {
          throw new Error(`Voiceover review changed at ${entry.review.path}`);
        }
        if (snapshots[targetOffset + entryIndex].exists) {
          throw new Error(`Media favorite collision at ${entry.ref.path}`);
        }
      }
      for (const entry of entries) transaction.create(entry.ref, entry.record);
    });
  }
  await firestore.runTransaction(async (transaction) => {
    const [categorySnapshot, librarySnapshot, completionSnapshot] =
      await transaction.getAll(categoryRef, libraryRef, plan.completion.ref);
    const currentLibrary = assertCreateContext(
      categorySnapshot,
      librarySnapshot,
      plan,
      sources,
    );
    const currentTakesSnapshot = await transaction.get(
      firestore.collection(TAKES_COLLECTION).limit(MAX_TAKES + 1),
    );
    if (currentTakesSnapshot.size > MAX_TAKES) {
      throw new Error("Voiceover source dataset changed after migration preflight");
    }
    const currentTakes = [];
    for (const snapshot of currentTakesSnapshot.docs) {
      if (snapshot.data()?.active !== true) continue;
      const source = currentTakeSource(snapshot, currentLibrary);
      if (!source) {
        throw new Error("Voiceover source dataset changed after migration preflight");
      }
      currentTakes.push(source);
    }
    currentTakes.sort((left, right) =>
      left.projection.id.localeCompare(right.projection.id));
    const currentCompletion = completionRecord(category, {
      libraryRaw: librarySnapshot.data(),
      takes: currentTakes,
    });
    if (currentTakes.length !== REQUIRED_TAKE_COUNT || !isDeepStrictEqual(
      currentCompletion,
      plan.completion.record,
    )) {
      throw new Error("Voiceover source dataset changed after migration preflight");
    }
    if (plan.completion.create) {
      const activeIds = new Set(currentTakes.map(({ projection }) => projection.id));
      const reviewSnapshots = await transaction.get(firestore.collectionGroup("takes"));
      const currentReviews = [];
      for (const snapshot of reviewSnapshots.docs) {
        const match = REVIEW_PATH.exec(snapshot.ref.path);
        if (!match) continue;
        const [, uid, takeId] = match;
        if (!activeIds.has(takeId)) {
          if (snapshot.data()?.favorite === true) {
            throw new Error("Voiceover review dataset changed after migration preflight");
          }
          continue;
        }
        const review = currentReviewSource(snapshot, currentLibrary, uid, takeId);
        if (!review) {
          throw new Error("Voiceover review dataset changed after migration preflight");
        }
        currentReviews.push(review);
      }
      currentReviews.sort((left, right) => left.path.localeCompare(right.path));
      if (sourceReviewDatasetHash(currentReviews) !==
          sourceReviewDatasetHash(sources.reviews)) {
        throw new Error("Voiceover review dataset changed after migration preflight");
      }
      if (completionSnapshot.exists) {
        throw new Error("Voiceover migration completion marker changed after preflight");
      }
      transaction.create(plan.completion.ref, plan.completion.record);
      return;
    }
    if (!completionSnapshot.exists || !isDeepStrictEqual(
      completionSnapshot.data(),
      plan.completion.record,
    )) {
      throw new Error("Voiceover migration completion marker changed after preflight");
    }
  });
}

function rollbackMediaEligibility(entry, source, category) {
  const stored = entry.snapshot.data();
  const marker = migrationMarker(stored, category);
  const takeId = stored.voiceoverTakeId;
  if (!marker || stored.version !== 1 || !source ||
      marker.sourcePath !== `${TAKES_COLLECTION}/${takeId}` ||
      marker.sourceTakeHash !== voiceoverSourceHash({
        projection: source.projection,
        performerName: source.performerName,
        raw: source.raw,
      }) ||
      marker.fingerprint !== fingerprint(withoutMigrationMarker(stored))) {
    return false;
  }
  return true;
}

async function preflightRollback({ firestore, category, sources }) {
  const [mediaSnapshot, favoriteSnapshot, completionSnapshot] = await Promise.all([
    firestore.collection(MEDIA_COLLECTION)
      .where("voiceoverMigration.id", "==", MIGRATION_ID)
      .get(),
    firestore.collectionGroup("items")
      .where("voiceoverMigration.id", "==", MIGRATION_ID)
      .get(),
    firestore.doc(COMPLETION_DOCUMENT).get(),
  ]);
  const sourcesByTakeId = new Map(
    sources.takes.map((source) => [source.projection.id, source]),
  );
  const media = { remove: [], conflicts: 0 };
  for (const snapshot of mediaSnapshot.docs) {
    if (snapshot.data()?.voiceoverMigration?.category !== category) continue;
    const entry = { snapshot, ref: snapshot.ref };
    if (rollbackMediaEligibility(
      entry,
      sourcesByTakeId.get(snapshot.data()?.voiceoverTakeId),
      category,
    )) {
      media.remove.push(entry);
    } else {
      media.conflicts += 1;
    }
  }
  // Favorites are staff state. Rollback leaves both migrated and preexisting
  // favorites intact, including their ownership marker and original timestamp.
  const favorites = { retained: 0, conflicts: 0 };
  const ownedFavoritePaths = new Set();
  for (const snapshot of favoriteSnapshot.docs) {
    if (!REVIEW_PATH.test(snapshot.data()?.voiceoverMigration?.sourcePath ?? "") ||
        snapshot.data()?.voiceoverMigration?.category !== category) continue;
    ownedFavoritePaths.add(snapshot.ref.path);
    favorites.retained += 1;
  }
  const completion = completionPlan(
    firestore,
    completionSnapshot,
    category,
    sources,
    { allowSourceDrift: true },
  );
  completion.retainedFavoriteRefs = [];
  if (completion.verified) {
    const expectedFavoriteRefs = sources.reviews
      .filter(({ projection }) => projection.favorite)
      .map(({ uid, takeId }) => firestore.collection("mediaFavorites")
        .doc(uid).collection("items")
        .doc(favoriteDocumentId({ backend: "r2", id: mediaIdForTake(takeId) })));
    const snapshots = expectedFavoriteRefs.length > 0
      ? await firestore.getAll(...expectedFavoriteRefs)
      : [];
    favorites.conflicts += snapshots.filter(({ exists }) => !exists).length;
    favorites.retained += snapshots.filter((snapshot) =>
      snapshot.exists && !ownedFavoritePaths.has(snapshot.ref.path)).length;
    completion.retainedFavoriteRefs = expectedFavoriteRefs;
  }
  return { media, favorites, completion };
}

function resultForRollback({
  apply,
  chunkSize,
  project,
  sources,
  media,
  favorites,
  completion,
  applied = null,
}) {
  const mediaWrites = media.remove.length;
  const mediaConflicts = media.conflicts + (applied?.mediaConflicts ?? 0);
  const favoriteConflicts = favorites.conflicts;
  const revisionWrites = Math.ceil(mediaWrites / chunkSize);
  const completionWrites = 0;
  const completionDeleted = apply ? (applied?.completionDeleted ?? 0) : 0;
  const completionRetained = apply
    ? (applied?.completionRetained ?? 0)
    : completion.verified;
  const completionConflicts = completion.conflicts +
    (apply ? (applied?.completionConflicts ?? 0) : 0);
  return {
    mode: "rollback",
    apply,
    chunkSize,
    project,
    source: sourceCounts(sources),
    media: {
      planned: mediaWrites,
      created: 0,
      verified: 0,
      retained: mediaConflicts,
      deleted: apply ? (applied?.mediaDeleted ?? 0) : 0,
      skipped: mediaConflicts,
      conflicts: mediaConflicts,
    },
    favorites: {
      planned: 0,
      created: 0,
      verified: 0,
      retained: favorites.retained + favoriteConflicts,
      deleted: 0,
      skipped: favoriteConflicts,
      conflicts: favoriteConflicts,
    },
    discoveryRevision: {
      planned: revisionWrites,
      updated: apply ? (applied?.discoveryUpdates ?? 0) : 0,
    },
    completion: {
      planned: completionWrites,
      created: 0,
      verified: 0,
      retained: completionRetained,
      deleted: completionDeleted,
      skipped: completionRetained,
      conflicts: completionConflicts,
    },
    plannedWrites: mediaWrites + revisionWrites + completionWrites,
  };
}

function currentTakeSource(snapshot, library) {
  if (!snapshot.exists) return null;
  try {
    const raw = snapshot.data();
    const projection = takeProjection(
      snapshot.id,
      raw,
      library.manifestVersion,
    );
    const performer = library.performers[projection.performer_id];
    if (!performer) return null;
    assertPrivateTakeFields(projection.id, raw);
    assertSourceTimestamps(`Voiceover take ${projection.id}`, raw);
    return {
      path: snapshot.ref.path,
      projection,
      performerName: performer.name,
      raw,
    };
  } catch {
    return null;
  }
}

function currentReviewSource(snapshot, library, uid, takeId) {
  if (!snapshot.exists) return null;
  try {
    const raw = snapshot.data();
    assertSourceTimestamps(`Voiceover review ${snapshot.ref.path}`, raw);
    return {
      path: snapshot.ref.path,
      uid,
      takeId,
      projection: reviewProjection(
        takeId,
        raw,
        library.manifestVersion,
      ),
      raw,
    };
  } catch {
    return null;
  }
}

async function commitRollbackPlan({ firestore, plan, category, chunkSize }) {
  const result = {
    mediaDeleted: 0,
    mediaConflicts: 0,
    discoveryUpdates: 0,
    completionDeleted: 0,
    completionRetained: 0,
    completionConflicts: 0,
  };
  for (let index = 0; index < plan.media.remove.length;
    index += chunkSize) {
    const entries = plan.media.remove.slice(
      index,
      index + chunkSize,
    );
    const removed = await firestore.runTransaction(async (transaction) => {
      const [librarySnapshot, ...targetSnapshots] = await transaction.getAll(
        firestore.doc(LIBRARY_DOCUMENT),
        ...entries.map(({ ref }) => ref),
      );
      const library = currentLibraryProjection(librarySnapshot);
      const candidates = targetSnapshots.map((snapshot, targetIndex) => {
        const marker = migrationMarker(snapshot.data(), category);
        const pathMatch = TAKE_PATH.exec(marker?.sourcePath ?? "");
        return {
          entry: entries[targetIndex],
          snapshot,
          marker,
          pathMatch,
        };
      });
      const sourceReferences = candidates
        .filter(({ snapshot, marker, pathMatch }) =>
          snapshot.exists && marker && pathMatch &&
          pathMatch[1] === snapshot.data()?.voiceoverTakeId)
        .map(({ marker }) => firestore.doc(marker.sourcePath));
      const sourceSnapshots = sourceReferences.length > 0
        ? await transaction.getAll(...sourceReferences)
        : [];
      const sourcesByPath = new Map(
        sourceSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]),
      );
      let deleted = 0;
      for (const candidate of candidates) {
        const { entry, snapshot, marker, pathMatch } = candidate;
        const current = { ref: entry.ref, snapshot };
        const sourceSnapshot = marker
          ? sourcesByPath.get(marker.sourcePath)
          : null;
        const source = pathMatch && sourceSnapshot &&
          pathMatch[1] === snapshot.data()?.voiceoverTakeId
          ? currentTakeSource(sourceSnapshot, library)
          : null;
        if (!rollbackMediaEligibility(current, source, category)) continue;
        transaction.delete(entry.ref);
        deleted += 1;
      }
      if (deleted > 0) bumpMediaDiscoveryRevision(transaction, firestore);
      return deleted;
    });
    result.mediaDeleted += removed;
    result.mediaConflicts += entries.length - removed;
    if (removed > 0) result.discoveryUpdates += 1;
  }
  if (plan.completion.verified) {
    const targetConflicts = plan.media.conflicts + plan.favorites.conflicts +
      result.mediaConflicts;
    const outcome = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(plan.completion.ref);
      if (!snapshot.exists) return "missing";
      if (!isDeepStrictEqual(snapshot.data(), plan.completion.record)) {
        return "conflict";
      }
      if (targetConflicts === 0) {
        const retainedFavorites = plan.completion.retainedFavoriteRefs.length > 0
          ? await transaction.getAll(...plan.completion.retainedFavoriteRefs)
          : [];
        if (retainedFavorites.some(({ exists }) => !exists)) return "conflict";
        // The cutover receipt survives rollback: canonical favorites remain
        // authoritative even while the corresponding media is unavailable.
      }
      return "retained";
    });
    if (outcome === "retained" || outcome === "conflict") {
      result.completionRetained += 1;
    }
    if (outcome === "missing" || outcome === "conflict") {
      result.completionConflicts += 1;
    }
  }
  return result;
}

export async function migrateVoiceoversToMedia({
  firestore,
  category,
  apply = false,
  rollback = false,
  nowIso = new Date().toISOString(),
  env = process.env,
  allowProduction = false,
  chunkSize = DEFAULT_TRANSACTION_CHUNK_SIZE,
} = {}) {
  const project = assertMigrationEnvironment({ firestore, env, allowProduction });
  if (typeof category !== "string" || category.trim() !== category || !category) {
    throw new Error("A media category is required");
  }
  if (typeof apply !== "boolean" || typeof rollback !== "boolean") {
    throw new Error("Migration mode flags must be boolean");
  }
  assertChunkSize(chunkSize);
  if (!validDateString(nowIso)) throw new Error("The migration timestamp is invalid");
  const categoryDefinition = await requireActiveCategory(firestore, category);
  const sources = await readVoiceoverSources(firestore);
  if (rollback) {
    const plan = await preflightRollback({ firestore, category, sources });
    let applied = null;
    if (apply) {
      applied = await commitRollbackPlan({
        firestore,
        plan,
        category,
        chunkSize,
      });
    }
    return resultForRollback({ apply, chunkSize, project, sources, ...plan, applied });
  }
  const plan = await preflightMigration({
    firestore,
    category,
    categoryDefinition,
    sources,
  });
  const result = resultForMigration({ apply, chunkSize, project, sources, ...plan });
  if (apply) {
    await commitCreatePlan({ firestore, plan, sources, category, chunkSize });
  }
  return result;
}

export function parseArguments(argv) {
  const options = {
    apply: false,
    allowProduction: false,
    rollback: false,
    project: DEMO_PROJECT_ID,
    category: null,
    chunkSize: DEFAULT_TRANSACTION_CHUNK_SIZE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--allow-production") {
      options.allowProduction = true;
    } else if (argument === "--rollback") {
      options.rollback = true;
    } else if (argument === "--chunk-size") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !/^(?:[1-9]|1[0-9]|2[0-5])$/.test(value)) {
        throw new Error(`--chunk-size must be an integer from 1 through ${MAX_TRANSACTION_CHUNK_SIZE}`);
      }
      options.chunkSize = Number(value);
      index += 1;
    } else if (argument === "--category" || argument === "--project") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!options.category) throw new Error("--category is required");
  if (![DEMO_PROJECT_ID, PRODUCTION_PROJECT_ID].includes(options.project)) {
    throw new Error(`--project must be ${DEMO_PROJECT_ID} or ${PRODUCTION_PROJECT_ID}`);
  }
  if (options.project === PRODUCTION_PROJECT_ID && !options.allowProduction) {
    throw new Error("--project njpbs-site requires --allow-production");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const app = getApps()[0] || initializeApp({ projectId: options.project });
  try {
    const result = await migrateVoiceoversToMedia({
      firestore: getFirestore(app),
      category: options.category,
      apply: options.apply,
      rollback: options.rollback,
      allowProduction: options.allowProduction,
      chunkSize: options.chunkSize,
    });
    console.log(JSON.stringify(result));
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
