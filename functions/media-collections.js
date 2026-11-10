"use strict";

const { FieldPath, FieldValue, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { registeredPrincipalFromUserDoc } = require("./lib/principal");
const { hasCapability } = require("./lib/rbac");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const {
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
} = require("./lib/media-asset-ref");
const {
  resolveMediaAssets,
} = require("./lib/media-asset-resolver");
const { authorizeMediaSource } = require("./lib/media-sources");
const {
  COLLECTION_SCHEMA_VERSION,
  MAX_COLLECTION_ITEM_BATCH,
  MAX_COLLECTION_ITEM_SCAN,
  MediaCollectionValidationError,
  collectionDocumentId,
  collectionRequestDocumentId,
  encodeCursor,
  parseListCollectionItemsRequest,
  parseListCollectionsRequest,
  parseMutateCollectionRequest,
  parseSetCollectionItemsRequest,
  requestFingerprint,
  storedCollection,
  storedCollectionItem,
  timestampIso,
} = require("./lib/media-collections");

const COLLECTIONS_COLLECTION = "mediaCollections";
const COLLECTION_ITEMS_COLLECTION = "items";
const COLLECTION_REQUESTS_COLLECTION = "requests";
const MAX_COLLECTIONS_JSON_BYTES = 64 * 1024;
const ACCESS_DENIED_MESSAGE = "Media collection access denied";
const COLLECTION_NOT_FOUND_MESSAGE = "Media collection not found";
const COLLECTION_CONFLICT_MESSAGE = "Media collection changed. Reload and try again";
const ITEM_UNAVAILABLE_MESSAGE = "Media collection item is unavailable";

class MediaCollectionRejection extends Error {
  constructor(status, message, code = null, data = null) {
    super(message);
    this.name = "MediaCollectionRejection";
    this.status = status;
    this.code = code;
    this.data = data;
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
  validateBoundedJsonRequest(req, MAX_COLLECTIONS_JSON_BYTES);
  return true;
}

function defaultRegistry() {
  return require("./source-media").runtimeRegistry();
}

function collectionReference(firestore, collectionId) {
  return firestore.collection(COLLECTIONS_COLLECTION).doc(collectionId);
}

function itemReference(collectionRef, ref) {
  return collectionRef.collection(COLLECTION_ITEMS_COLLECTION).doc(
    mediaAssetRefDocumentId(ref),
  );
}

function requestReference(collectionRef, actorUid, requestId) {
  return collectionRef.collection(COLLECTION_REQUESTS_COLLECTION).doc(
    collectionRequestDocumentId(actorUid, requestId),
  );
}

async function readSnapshots(firestore, references) {
  if (references.length === 0) return [];
  if (typeof firestore.getAll === "function") return firestore.getAll(...references);
  return Promise.all(references.map((reference) => reference.get()));
}

async function transactionSnapshots(transaction, references) {
  if (references.length === 0) return [];
  if (typeof transaction.getAll === "function") return transaction.getAll(...references);
  return Promise.all(references.map((reference) => transaction.get(reference)));
}

async function requireCollectionActor(firestore, req, requirePrincipalFn, isActiveFn) {
  const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
  const approvedActive = typeof actor.approvedActive === "boolean"
    ? actor.approvedActive
    : await isActiveFn(firestore, actor.uid);
  if (!approvedActive) {
    throw new MediaCollectionRejection(403, ACCESS_DENIED_MESSAGE);
  }
  return { ...actor, approvedActive };
}

async function assertActiveCollectionActor(transaction, firestore, actor) {
  // Current media authority joins each attempt's read set, including receipt replays.
  const snapshot = await transaction.get(firestore.collection("users").doc(actor.uid));
  const principal = await registeredPrincipalFromUserDoc(
    firestore, actor.uid, snapshot.data(), transaction,
  );
  if (!snapshot.exists || !["media.upload", "media.manage", "media.audio.read"].some(
    (capability) => hasCapability(principal, capability),
  )) {
    throw new MediaCollectionRejection(403, ACCESS_DENIED_MESSAGE);
  }
}

function assertCollectionAccess(actor, collection) {
  if (!collection || (collection.scope === "private" && collection.ownerUid !== actor.uid)) {
    throw new MediaCollectionRejection(404, COLLECTION_NOT_FOUND_MESSAGE);
  }
  return collection;
}

function currentSummary(collectionId, collection) {
  return {
    id: collectionId,
    scope: collection.scope,
    name: collection.name,
    description: collection.description,
    color: collection.color || "slate",
    lifecycle: collection.lifecycle,
    version: collection.version,
    membershipVersion: collection.membershipVersion,
    cover: null,
    canEdit: true,
    createdAt: timestampIso(collection.createdAt),
    updatedAt: timestampIso(collection.updatedAt),
    ...(collection.scope === "private" ? { itemCount: collection.itemCount } : {}),
  };
}

function conflict(collectionId, collection, revision) {
  return new MediaCollectionRejection(
    409,
    COLLECTION_CONFLICT_MESSAGE,
    "media_collection_conflict",
    { revision, collection: currentSummary(collectionId, collection) },
  );
}

function storedCollectionOrThrow(snapshot) {
  const collection = snapshot.exists ? storedCollection(snapshot.data()) : null;
  if (snapshot.exists && !collection) {
    throw new Error(`Media collection ${snapshot.id} has invalid stored data`);
  }
  return collection;
}

async function readAuthorizedCollection(firestore, actor, collectionId) {
  const snapshot = await collectionReference(firestore, collectionId).get();
  return assertCollectionAccess(actor, storedCollectionOrThrow(snapshot));
}

function sameRef(left, right) {
  return left === null && right === null ||
    left !== null && right !== null &&
      canonicalMediaAssetRef(left) === canonicalMediaAssetRef(right);
}

async function resolveCollectionCovers({
  firestore,
  actor,
  records,
  registryFn,
  authorizeFn,
}) {
  const memberships = await readSnapshots(
    firestore,
    records.map(({ document, collection }) => collection.coverRef
      ? itemReference(document.ref, collection.coverRef)
      : null).filter(Boolean),
  );
  let membershipIndex = 0;
  const admitted = records.map(({ collection }) => {
    if (!collection.coverRef) return null;
    const snapshot = memberships[membershipIndex++];
    const ref = snapshot?.exists ? storedCollectionItem(snapshot.data()) : null;
    return ref && sameRef(ref, collection.coverRef) ? ref : null;
  });
  const unique = new Map();
  for (const ref of admitted) {
    if (ref) unique.set(canonicalMediaAssetRef(ref), ref);
  }
  const refs = [...unique.values()];
  const resolved = await resolveMediaAssets({
    firestore,
    actor,
    refs,
    registryFn,
    authorizeFn,
  });
  const byRef = new Map(resolved.map((record) => [
    canonicalMediaAssetRef(record.ref),
    record.available ? record.summary : null,
  ]));
  return admitted.map((ref) => ref
    ? byRef.get(canonicalMediaAssetRef(ref)) ?? null
    : null);
}

async function presentCollections({
  firestore,
  actor,
  records,
  registryFn,
  authorizeFn,
}) {
  const covers = await resolveCollectionCovers({
    firestore,
    actor,
    records,
    registryFn,
    authorizeFn,
  });
  return records.map(({ document, collection }, index) => ({
    ...currentSummary(document.id, collection),
    cover: covers[index],
  }));
}

async function readCollectionPage(
  firestore,
  actor,
  request,
  documentIdField,
  timestampFn,
) {
  let query = firestore.collection(COLLECTIONS_COLLECTION)
    .where("scope", "==", request.scope)
    .where("lifecycle", "==", request.lifecycle);
  if (request.scope === "private") query = query.where("ownerUid", "==", actor.uid);
  query = query.orderBy("updatedAt", "desc").orderBy(documentIdField, "desc");
  if (request.cursor) {
    query = query.startAfter(
      timestampFn(request.cursor.seconds, request.cursor.nanoseconds),
      request.cursor.id,
    );
  }
  const snapshot = await query.limit(request.limit + 1).get();
  const documents = snapshot.docs.slice(0, request.limit);
  const hasMore = snapshot.docs.length > request.limit;
  return {
    documents,
    nextCursor: hasMore && documents.length > 0
      ? encodeCursor(
        {
          uid: actor.uid,
          scope: request.scope,
          lifecycle: request.lifecycle,
          kind: "collections",
        },
        documents.at(-1),
        "updatedAt",
      )
      : null,
  };
}

async function readCollectionItemCandidates(
  firestore,
  actor,
  collectionRef,
  request,
  documentIdField,
  timestampFn,
) {
  let query = collectionRef.collection(COLLECTION_ITEMS_COLLECTION)
    .orderBy("addedAt", "desc")
    .orderBy(documentIdField, "desc");
  if (request.cursor) {
    query = query.startAfter(
      timestampFn(request.cursor.seconds, request.cursor.nanoseconds),
      request.cursor.id,
    );
  }
  const snapshot = await query.limit(MAX_COLLECTION_ITEM_SCAN + 1).get();
  const candidates = snapshot.docs.slice(0, MAX_COLLECTION_ITEM_SCAN).map((document) => {
    const ref = storedCollectionItem(document.data());
    const addedAt = timestampIso(document.data()?.addedAt);
    if (!ref || !addedAt) {
      throw new Error(`Media collection item ${document.id} has invalid stored data`);
    }
    return { document, ref, addedAt };
  });
  return {
    candidates,
    hasMoreCandidates: snapshot.docs.length > MAX_COLLECTION_ITEM_SCAN,
  };
}

async function resolveCollectionItems({
  firestore,
  actor,
  collection,
  candidates,
  limit,
  registryFn,
  authorizeFn,
}) {
  const resolved = await resolveMediaAssets({
    firestore,
    actor,
    refs: candidates.map((candidate) => candidate.ref),
    registryFn,
    authorizeFn,
  });
  const items = [];
  let consumed = 0;
  for (const [index, candidate] of candidates.entries()) {
    consumed = index + 1;
    const asset = resolved[index];
    if (asset.available) {
      items.push({
        ref: candidate.ref,
        addedAt: candidate.addedAt,
        available: true,
        asset: asset.summary,
      });
    } else if (collection.scope === "private") {
      items.push({
        ref: candidate.ref,
        addedAt: candidate.addedAt,
        available: false,
      });
    }
    if (items.length === limit) break;
  }
  return { items, consumed };
}

async function assertItemsAvailable({
  firestore,
  actor,
  refs,
  registryFn,
  authorizeFn,
}) {
  const resolved = await resolveMediaAssets({
    firestore,
    actor,
    refs,
    registryFn,
    authorizeFn,
  });
  if (resolved.some((record) => !record.available)) {
    throw new MediaCollectionRejection(404, ITEM_UNAVAILABLE_MESSAGE);
  }
  return resolved;
}

function storedReceiptChangedRefs(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEM_BATCH) {
    throw new Error("Media collection request receipt has invalid changed refs");
  }
  let refs;
  try {
    refs = value.map(parseMediaAssetRef);
  } catch {
    throw new Error("Media collection request receipt has invalid changed refs");
  }
  const canonical = refs.map(canonicalMediaAssetRef);
  const sorted = [...canonical].sort((left, right) => left.localeCompare(right));
  if (new Set(canonical).size !== canonical.length ||
      canonical.some((ref, index) => ref !== sorted[index])) {
    throw new Error("Media collection request receipt has invalid changed refs");
  }
  return refs;
}

function receiptResult(receipt, collection, collectionId, kind) {
  if (receipt.kind !== kind) {
    throw new MediaCollectionRejection(
      409,
      "Request id was already used for a different collection action",
    );
  }
  const currentRevision = kind === "metadata"
    ? collection.version
    : collection.membershipVersion;
  if (receipt.resultingRevision !== currentRevision) {
    throw conflict(collectionId, collection, kind);
  }
  const changedRefs = kind === "membership"
    ? storedReceiptChangedRefs(receipt.changedRefs)
    : undefined;
  return {
    changed: receipt.changed === true,
    replayed: true,
    version: collection.version,
    membershipVersion: collection.membershipVersion,
    ...(changedRefs === undefined ? {} : { changedRefs }),
  };
}

function assertReceipt(receipt, fingerprint, action) {
  if (receipt.fingerprint !== fingerprint || receipt.action !== action) {
    throw new MediaCollectionRejection(
      409,
      "Request id was already used for different collection changes",
    );
  }
}

function createAudit(transaction, firestore, actor, collectionId, action, before, after) {
  transaction.create(
    firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
    adminLogEntry({
      actorUid: actor.uid,
      actorEmail: actor.email ?? null,
      action,
      target: { collection: COLLECTIONS_COLLECTION, documentId: collectionId },
      before,
      after,
    }),
  );
}

function createReceipt(
  transaction,
  receiptRef,
  { action, kind, fingerprint, changed, resultingRevision, createdAt, changedRefs },
) {
  transaction.create(receiptRef, {
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    action,
    kind,
    fingerprint,
    changed,
    resultingRevision,
    createdAt,
    ...(changedRefs === undefined ? {} : { changedRefs }),
  });
}

function newCollection(actor, request, timestamp) {
  return {
    schemaVersion: COLLECTION_SCHEMA_VERSION,
    scope: request.scope,
    ...(request.scope === "private" ? { ownerUid: actor.uid } : {}),
    createdBy: actor.uid,
    name: request.name,
    description: request.description,
    color: request.color === undefined ? "slate" : request.color,
    lifecycle: "active",
    version: 1,
    membershipVersion: 1,
    itemCount: 0,
    coverRef: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: actor.uid,
  };
}

function createCollectionMutation({
  transaction,
  firestore,
  actor,
  request,
  collectionId,
  collectionRef,
  receiptRef,
  fingerprint,
  timestamp,
}) {
  transaction.create(collectionRef, newCollection(actor, request, timestamp));
  createReceipt(transaction, receiptRef, {
    action: request.action,
    kind: "metadata",
    fingerprint,
    changed: true,
    resultingRevision: 1,
    createdAt: timestamp,
  });
  if (request.scope === "all_staff") {
    createAudit(transaction, firestore, actor, collectionId, "media_collection_create", null, {
      scope: request.scope,
      version: 1,
      membershipVersion: 1,
      lifecycle: "active",
    });
  }
  return {
    collectionId,
    changed: true,
    replayed: false,
    version: 1,
    membershipVersion: 1,
  };
}

function metadataUpdates(request, collection) {
  if (request.action !== "update") {
    const lifecycle = request.action === "archive" ? "archived" : "active";
    return collection.lifecycle === lifecycle ? {} : { lifecycle };
  }
  return {
    ...(request.name !== undefined && request.name !== collection.name
      ? { name: request.name }
      : {}),
    ...(request.description !== undefined && request.description !== collection.description
      ? { description: request.description }
      : {}),
    ...(request.color !== undefined && request.color !== (collection.color || "slate")
      ? { color: request.color }
      : {}),
    ...(request.coverRef !== undefined && !sameRef(request.coverRef, collection.coverRef)
      ? { coverRef: request.coverRef }
      : {}),
  };
}

async function assertCoverMembership(transaction, collectionRef, request) {
  if (request.action !== "update" || !request.coverRef) return;
  const snapshot = await transaction.get(itemReference(collectionRef, request.coverRef));
  const memberRef = snapshot.exists ? storedCollectionItem(snapshot.data()) : null;
  if (!memberRef || !sameRef(memberRef, request.coverRef)) {
    throw new MediaCollectionRejection(409, "Collection cover must be a current item");
  }
}

async function updateCollectionMutation({
  transaction,
  firestore,
  actor,
  request,
  collection,
  collectionId,
  collectionRef,
  receiptRef,
  fingerprint,
  timestamp,
}) {
  assertCollectionAccess(actor, collection);
  if (collection.version !== request.baseVersion) {
    throw conflict(collectionId, collection, "metadata");
  }
  await assertCoverMembership(transaction, collectionRef, request);
  const updates = metadataUpdates(request, collection);
  const changed = Object.keys(updates).length > 0;
  const resultingVersion = changed ? collection.version + 1 : collection.version;
  if (changed) {
    transaction.update(collectionRef, {
      ...updates,
      version: resultingVersion,
      updatedAt: timestamp,
      updatedBy: actor.uid,
    });
  }
  createReceipt(transaction, receiptRef, {
    action: request.action,
    kind: "metadata",
    fingerprint,
    changed,
    resultingRevision: resultingVersion,
    createdAt: timestamp,
  });
  if (changed && collection.scope === "all_staff") {
    createAudit(
      transaction,
      firestore,
      actor,
      collectionId,
      `media_collection_${request.action}`,
      { version: collection.version, lifecycle: collection.lifecycle },
      {
        version: resultingVersion,
        lifecycle: updates.lifecycle ?? collection.lifecycle,
      },
    );
  }
  return {
    collectionId,
    changed,
    replayed: false,
    version: resultingVersion,
    membershipVersion: collection.membershipVersion,
  };
}

async function mutateCollection({
  firestore,
  actor,
  request,
  serverTimestampFn = () => FieldValue.serverTimestamp(),
}) {
  const collectionId = request.action === "create"
    ? collectionDocumentId(actor.uid, request.requestId)
    : request.collectionId;
  const collectionRef = collectionReference(firestore, collectionId);
  const receiptRef = requestReference(collectionRef, actor.uid, request.requestId);
  const fingerprint = requestFingerprint(request);
  return firestore.runTransaction(async (transaction) => {
    await assertActiveCollectionActor(transaction, firestore, actor);
    const collectionSnapshot = await transaction.get(collectionRef);
    const receiptSnapshot = await transaction.get(receiptRef);
    const collection = storedCollectionOrThrow(collectionSnapshot);
    if (receiptSnapshot.exists) {
      if (!collection) throw new Error("Collection request receipt has no collection");
      assertCollectionAccess(actor, collection);
      const receipt = receiptSnapshot.data();
      assertReceipt(receipt, fingerprint, request.action);
      return {
        collectionId,
        ...receiptResult(receipt, collection, collectionId, "metadata"),
      };
    }
    if (request.action === "create") {
      if (collectionSnapshot.exists) {
        throw new MediaCollectionRejection(409, "Collection create state is uncertain");
      }
      const timestamp = serverTimestampFn();
      return createCollectionMutation({
        transaction,
        firestore,
        actor,
        request,
        collectionId,
        collectionRef,
        receiptRef,
        fingerprint,
        timestamp,
      });
    }
    return updateCollectionMutation({
      transaction,
      firestore,
      actor,
      request,
      collection,
      collectionId,
      collectionRef,
      receiptRef,
      fingerprint,
      timestamp: serverTimestampFn(),
    });
  });
}

function membershipChanges(request, itemRefs, snapshots) {
  const changes = [];
  for (const [index, ref] of request.refs.entries()) {
    const snapshot = snapshots[index];
    const existingRef = snapshot.exists ? storedCollectionItem(snapshot.data()) : null;
    if (snapshot.exists && (!existingRef || !sameRef(existingRef, ref))) {
      throw new Error(`Media collection item identity collision at ${snapshot.id}`);
    }
    if (snapshot.exists !== request.present) {
      changes.push({ ref, reference: itemRefs[index] });
    }
  }
  return changes;
}

function writeMembershipChanges(transaction, actor, changes, present, timestamp) {
  for (const change of changes) {
    if (!present) {
      transaction.delete(change.reference);
      continue;
    }
    transaction.create(change.reference, {
      schemaVersion: COLLECTION_SCHEMA_VERSION,
      ref: change.ref,
      canonicalRef: canonicalMediaAssetRef(change.ref),
      addedBy: actor.uid,
      addedAt: timestamp,
    });
  }
}

async function mutateCollectionItems({
  firestore,
  actor,
  request,
  serverTimestampFn = () => FieldValue.serverTimestamp(),
}) {
  const collectionRef = collectionReference(firestore, request.collectionId);
  const receiptRef = requestReference(collectionRef, actor.uid, request.requestId);
  const fingerprint = requestFingerprint(request);
  return firestore.runTransaction(async (transaction) => {
    await assertActiveCollectionActor(transaction, firestore, actor);
    const collectionSnapshot = await transaction.get(collectionRef);
    const receiptSnapshot = await transaction.get(receiptRef);
    const collection = assertCollectionAccess(
      actor,
      storedCollectionOrThrow(collectionSnapshot),
    );
    if (receiptSnapshot.exists) {
      const receipt = receiptSnapshot.data();
      assertReceipt(receipt, fingerprint, request.present ? "add" : "remove");
      return {
        collectionId: request.collectionId,
        ...receiptResult(receipt, collection, request.collectionId, "membership"),
      };
    }
    if (collection.lifecycle !== "active") {
      throw new MediaCollectionRejection(409, "Archived collections cannot change items");
    }
    if (collection.membershipVersion !== request.baseMembershipVersion) {
      throw conflict(request.collectionId, collection, "membership");
    }
    const itemRefs = request.refs.map((ref) => itemReference(collectionRef, ref));
    const snapshots = await transactionSnapshots(transaction, itemRefs);
    const changes = membershipChanges(request, itemRefs, snapshots);
    const changedRefs = changes.map((change) => change.ref);
    const countDelta = request.present ? changes.length : -changes.length;
    const itemCount = collection.itemCount + countDelta;
    if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
      throw new Error(`Media collection ${request.collectionId} has an invalid item count`);
    }
    const changed = changes.length > 0;
    const resultingRevision = changed
      ? collection.membershipVersion + 1
      : collection.membershipVersion;
    const timestamp = serverTimestampFn();
    writeMembershipChanges(transaction, actor, changes, request.present, timestamp);
    if (changed) {
      transaction.update(collectionRef, {
        membershipVersion: resultingRevision,
        itemCount,
        updatedAt: timestamp,
        updatedBy: actor.uid,
      });
    }
    const action = request.present ? "add" : "remove";
    createReceipt(transaction, receiptRef, {
      action,
      kind: "membership",
      fingerprint,
      changed,
      resultingRevision,
      createdAt: timestamp,
      changedRefs,
    });
    if (changed && collection.scope === "all_staff") {
      createAudit(
        transaction,
        firestore,
        actor,
        request.collectionId,
        `media_collection_items_${action}`,
        { membershipVersion: collection.membershipVersion },
        { membershipVersion: resultingRevision },
      );
    }
    return {
      collectionId: request.collectionId,
      changed,
      replayed: false,
      version: collection.version,
      membershipVersion: resultingRevision,
      changedRefs,
    };
  });
}

async function projectChangedRefs({
  firestore,
  actor,
  changedRefs,
  resolved,
  registryFn,
  authorizeFn,
}) {
  const records = resolved ?? await resolveMediaAssets({
    firestore,
    actor,
    refs: changedRefs,
    registryFn,
    authorizeFn,
  });
  const available = new Set(records.flatMap((record) =>
    record.available ? [canonicalMediaAssetRef(record.ref)] : []));
  const projected = changedRefs.filter((ref) =>
    available.has(canonicalMediaAssetRef(ref)));
  return {
    changedRefs: projected,
    hiddenChangedCount: changedRefs.length - projected.length,
  };
}

function expectedError(error) {
  return error instanceof JsonRequestError ||
    error instanceof MediaCollectionValidationError ||
    error instanceof MediaCollectionRejection ||
    Number.isInteger(error?.status);
}

function respondWithError(res, log, operation, error) {
  if (res.headersSent) return;
  const known = expectedError(error);
  const status = error?.status ?? 500;
  if (!known || status >= 500) log.error(`${operation} failed`, error);
  res.status(status).json({
    error: known ? error.message : `Failed to ${operation}`,
    ...(known && error.code ? { code: error.code } : {}),
    ...(known && error.data ? error.data : {}),
  });
}

function collectionDependencies(deps) {
  return {
    firestore: deps.firestore ?? db,
    requirePrincipalFn: deps.requirePrincipalFn ?? requirePrincipal,
    isActiveFn: deps.isActiveFn ?? isApprovedActiveAccount,
    registryFn: deps.registryFn ?? defaultRegistry,
    authorizeFn: deps.authorizeFn ?? authorizeMediaSource,
    documentIdField: deps.documentIdField ?? FieldPath.documentId(),
    timestampFn: deps.timestampFn ?? ((seconds, nanoseconds) =>
      new Timestamp(seconds, nanoseconds)),
    log: deps.log ?? logger,
  };
}

function createCmsListMediaCollectionsHandler(deps = {}) {
  const runtime = collectionDependencies(deps);
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const actor = await requireCollectionActor(
        runtime.firestore,
        req,
        runtime.requirePrincipalFn,
        runtime.isActiveFn,
      );
      const request = parseListCollectionsRequest(req.body, actor.uid);
      const page = await readCollectionPage(
        runtime.firestore,
        actor,
        request,
        runtime.documentIdField,
        runtime.timestampFn,
      );
      const records = page.documents.map((document) => ({
        document,
        collection: assertCollectionAccess(actor, storedCollectionOrThrow(document)),
      }));
      const collections = await presentCollections({
        ...runtime,
        actor,
        records,
      });
      res.status(200).json({
        success: true,
        collections,
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      });
    } catch (error) {
      respondWithError(res, runtime.log, "list media collections", error);
    }
  };
}

function createCmsListMediaCollectionItemsHandler(deps = {}) {
  const runtime = collectionDependencies(deps);
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const actor = await requireCollectionActor(
        runtime.firestore,
        req,
        runtime.requirePrincipalFn,
        runtime.isActiveFn,
      );
      const request = parseListCollectionItemsRequest(req.body, actor.uid);
      const collectionRef = collectionReference(runtime.firestore, request.collectionId);
      const snapshot = await collectionRef.get();
      const collection = assertCollectionAccess(actor, storedCollectionOrThrow(snapshot));
      const candidatePage = await readCollectionItemCandidates(
        runtime.firestore,
        actor,
        collectionRef,
        request,
        runtime.documentIdField,
        runtime.timestampFn,
      );
      const page = await resolveCollectionItems({
        ...runtime,
        actor,
        collection,
        candidates: candidatePage.candidates,
        limit: request.limit,
      });
      const hasMore = page.consumed < candidatePage.candidates.length ||
        candidatePage.hasMoreCandidates;
      const last = page.consumed > 0
        ? candidatePage.candidates[page.consumed - 1].document
        : null;
      const nextCursor = hasMore && last
        ? encodeCursor(
          { uid: actor.uid, collectionId: request.collectionId, kind: "items" },
          last,
          "addedAt",
        )
        : null;
      const [presentedCollection] = await presentCollections({
        ...runtime,
        actor,
        records: [{ document: snapshot, collection }],
      });
      res.status(200).json({
        success: true,
        collection: presentedCollection,
        items: page.items,
        nextCursor,
        hasMore: nextCursor !== null,
      });
    } catch (error) {
      respondWithError(res, runtime.log, "list media collection items", error);
    }
  };
}

function createCmsMutateMediaCollectionHandler(deps = {}) {
  const runtime = collectionDependencies(deps);
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseMutateCollectionRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await requireCollectionActor(
        runtime.firestore,
        req,
        runtime.requirePrincipalFn,
        runtime.isActiveFn,
      );
      if (request.action === "update" && request.coverRef) {
        await readAuthorizedCollection(runtime.firestore, actor, request.collectionId);
        await assertItemsAvailable({
          ...runtime,
          actor,
          refs: [request.coverRef],
        });
      }
      const result = await mutateCollection({
        firestore: runtime.firestore,
        actor,
        request,
        serverTimestampFn: deps.serverTimestampFn,
      });
      const snapshot = await collectionReference(runtime.firestore, result.collectionId).get();
      const collection = assertCollectionAccess(actor, storedCollectionOrThrow(snapshot));
      const [presented] = await presentCollections({
        ...runtime,
        actor,
        records: [{ document: snapshot, collection }],
      });
      res.status(200).json({
        success: true,
        changed: result.changed,
        replayed: result.replayed,
        collection: presented,
      });
    } catch (error) {
      respondWithError(res, runtime.log, "change media collection", error);
    }
  };
}

function createCmsSetMediaCollectionItemsHandler(deps = {}) {
  const runtime = collectionDependencies(deps);
  const verifyAppCheckFn = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  return async (req, res) => {
    try {
      if (!requirePost(req, res)) return;
      const request = parseSetCollectionItemsRequest(req.body);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await requireCollectionActor(
        runtime.firestore,
        req,
        runtime.requirePrincipalFn,
        runtime.isActiveFn,
      );
      let resolved;
      if (request.present) {
        await readAuthorizedCollection(runtime.firestore, actor, request.collectionId);
        resolved = await assertItemsAvailable({
          ...runtime,
          actor,
          refs: request.refs,
        });
      }
      const result = await mutateCollectionItems({
        firestore: runtime.firestore,
        actor,
        request,
        serverTimestampFn: deps.serverTimestampFn,
      });
      const { changedRefs, ...response } = result;
      let projection = {};
      try {
        if (changedRefs !== undefined) projection = await projectChangedRefs({
          ...runtime,
          actor,
          changedRefs,
          resolved,
        });
      } catch (error) {
        // Membership has committed. Keep the success receipt but omit optional Undo details.
        runtime.log.error("Media collection changed refs unavailable", error);
      }
      res.status(200).json({ success: true, ...response, ...projection });
    } catch (error) {
      respondWithError(res, runtime.log, "change media collection items", error);
    }
  };
}

const functionOptions = { cors: true, maxInstances: 10, timeoutSeconds: 30 };
const cmsListMediaCollections = cmsOnRequest(
  { ...functionOptions, cpu: 1, concurrency: 80 },
  createCmsListMediaCollectionsHandler(),
);
const cmsListMediaCollectionItems = cmsOnRequest(
  { ...functionOptions, cpu: 1, concurrency: 80 },
  createCmsListMediaCollectionItemsHandler(),
);
const cmsMutateMediaCollection = cmsOnRequest(
  functionOptions,
  createCmsMutateMediaCollectionHandler(),
);
const cmsSetMediaCollectionItems = cmsOnRequest(
  functionOptions,
  createCmsSetMediaCollectionItemsHandler(),
);

module.exports = {
  ACCESS_DENIED_MESSAGE,
  COLLECTIONS_COLLECTION,
  COLLECTION_ITEMS_COLLECTION,
  COLLECTION_REQUESTS_COLLECTION,
  COLLECTION_CONFLICT_MESSAGE,
  COLLECTION_NOT_FOUND_MESSAGE,
  ITEM_UNAVAILABLE_MESSAGE,
  MAX_COLLECTIONS_JSON_BYTES,
  MediaCollectionRejection,
  assertCollectionAccess,
  assertItemsAvailable,
  cmsListMediaCollectionItems,
  cmsListMediaCollections,
  cmsMutateMediaCollection,
  cmsSetMediaCollectionItems,
  createCmsListMediaCollectionItemsHandler,
  createCmsListMediaCollectionsHandler,
  createCmsMutateMediaCollectionHandler,
  createCmsSetMediaCollectionItemsHandler,
  mutateCollection,
  mutateCollectionItems,
  presentCollections,
  readCollectionItemCandidates,
  readCollectionPage,
  resolveCollectionItems,
};
