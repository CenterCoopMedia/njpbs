"use strict";

const { createHash } = require("node:crypto");
const { cmsOnRequest } = require("./lib/cms-edge");
const { parseMetadataBatchRequest } = require("./lib/source-media-upload-contract");
const {
  commonOptions, makeHandler, sourceMetadataAsset, SourceUploadError, writeSourceMetadata,
} = require("./source-media-uploads");

const COLLECTION = "mediaSourceMetadataBatches";
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const TRANSACTION_OPTIONS = { maxAttempts: 3 };

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pending(item) {
  return item.status === "pending";
}

function batchResult(batch) {
  if (!batch) return { batch: null };
  const { operationKey, startedAt, items } = batch;
  let status = "completed";
  if (items.some(pending)) status = "active";
  else if (items.some(item => item.status === "canceled")) status = "canceled";
  return { batch: { operationKey, startedAt, status, items } };
}

function batchChanged() {
  return new SourceUploadError(409, "The video batch changed. Inspect the latest batch before continuing.");
}

function itemStatus(asset, expectedVersion) {
  if (!asset) return "unavailable";
  if (asset.version !== expectedVersion) return "stale";
  return "pending";
}

async function startBatch(transaction, ref, previous, { firestore, request, source, nowFn }) {
  const { entries, operationKey } = request;
  const fingerprint = digest(entries);
  if (previous?.operationKey === operationKey) {
    if (previous.fingerprint !== fingerprint) throw batchChanged();
    return previous;
  }
  // The key advances with the actor's batch, so a late start cannot replace a newer one.
  if (operationKey !== (previous?.operationKey ?? 0) + 1 || previous?.items.some(pending)) {
    throw batchChanged();
  }

  const assetsRef = firestore.collection("mediaSourceAssets");
  const snapshots = await transaction.getAll(...entries.map(item => assetsRef.doc(item.assetId)));
  const assets = new Map(snapshots.map(snapshot => [snapshot.id, sourceMetadataAsset(snapshot, source)]));
  const items = entries.map(({ assetId, expectedVersion, changes }) => {
    const asset = assets.get(assetId);
    let status = itemStatus(asset, expectedVersion);
    if (status === "pending") {
      if (Object.keys(changes).length) transaction.create(ref.collection("patches").doc(assetId), { changes });
      else status = "unchanged";
    }
    return { assetId, expectedVersion, status, ...(asset ? { name: asset.name, originalName: asset.originalName } : {}) };
  });
  const batch = { operationKey, fingerprint, startedAt: nowFn(), items };
  transaction.set(ref, batch);
  return batch;
}

async function advanceBatch(transaction, ref, batch, { actor, adminLogEntryFn, firestore, request, source, nowFn }) {
  const item = batch.items.find(item => item.assetId === request.assetId);
  if (!item) throw new SourceUploadError(404, "Video is not in this batch");
  if (!pending(item)) return batch;

  const patchRef = ref.collection("patches").doc(item.assetId);
  const assetRef = firestore.collection("mediaSourceAssets").doc(item.assetId);
  const [patch, snapshot] = await Promise.all([transaction.get(patchRef), transaction.get(assetRef)]);
  const current = sourceMetadataAsset(snapshot, source);
  const status = itemStatus(current, item.expectedVersion);
  let result = { ...item, status };
  if (status === "pending") {
    if (!patch.exists) throw new Error("Pending video batch item has no metadata patch");
    const updated = writeSourceMetadata({
      transaction, firestore, ref: assetRef, current, patch: patch.data().changes,
      actor, adminLogEntryFn, now: nowFn(),
    });
    result = { ...item, status: "saved", savedVersion: updated.version };
  }

  // The receipt, patch removal and any asset, audit and search writes commit together.
  const items = batch.items.map(row => row.assetId === item.assetId ? result : row);
  transaction.delete(patchRef);
  transaction.update(ref, { items });
  return { ...batch, items };
}

function cancelBatch(transaction, ref, batch) {
  if (!batch.items.some(pending)) return batch;
  const items = batch.items.map(item => {
    if (!pending(item)) return item;
    transaction.delete(ref.collection("patches").doc(item.assetId));
    return { ...item, status: "canceled" };
  });
  transaction.update(ref, { items });
  return { ...batch, items };
}

async function runMetadataBatch(args) {
  const { actor, firestore, request, source } = args;
  const ref = firestore.collection(COLLECTION).doc(digest([actor.uid, source.id]));
  if (request.action === "inspect") return batchResult((await ref.get()).data());

  const batch = await firestore.runTransaction(async transaction => {
    const current = (await transaction.get(ref)).data();
    if (request.action === "start") return startBatch(transaction, ref, current, args);
    if (current?.operationKey !== request.operationKey) throw batchChanged();
    if (request.action === "cancel") return cancelBatch(transaction, ref, current);
    return advanceBatch(transaction, ref, current, args);
  }, TRANSACTION_OPTIONS);
  return batchResult(batch);
}

function createCmsSourceMediaMetadataBatchHandler(deps) {
  return makeHandler({
    maxBytes: MAX_BATCH_BYTES,
    parse: parseMetadataBatchRequest,
    operation: "metadata",
    run: runMetadataBatch,
    usesUploader: false,
  }, deps);
}

const cmsSourceMediaMetadataBatch = cmsOnRequest(commonOptions, createCmsSourceMediaMetadataBatchHandler());

module.exports = { cmsSourceMediaMetadataBatch, createCmsSourceMediaMetadataBatchHandler };
