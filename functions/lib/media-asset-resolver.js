"use strict";

const { hasCapability } = require("./rbac");
const {
  canonicalMediaAssetRef,
  parseMediaAssetRef,
} = require("./media-asset-ref");
const { mediaAssetSummary } = require("./media-library");
const {
  MediaSourceAccessError,
  authorizeMediaSource,
  objectKeyWithinSource,
} = require("./media-sources");
const {
  parseSourceMediaAsset,
  sourceMediaAssetSummary,
} = require("./source-media-contract");
const { enrichSourceMediaUploaders } = require("./source-media-uploader");
const { isAudioReadAdmitted, mayUseMedia } = require("./media-access");

const { originalStatusRef } = require("./source-original-status");
const { originalAvailability } = require("./source-original-state");

const MEDIA_ASSET_UNAVAILABLE_MESSAGE = "Media asset is unavailable";
// The caller verifies the approved active actor once before resolving its sources.
const alreadyApprovedAccount = async () => true;

function defaultRegistry() {
  return require("../source-media").runtimeRegistry();
}

class MediaAssetUnavailableError extends Error {
  constructor(message = MEDIA_ASSET_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "MediaAssetUnavailableError";
    this.status = 404;
  }
}

function isMediaSourceDenial(error) {
  return (
    error instanceof MediaSourceAccessError ||
    error?.name === "MediaSourceAccessError"
  ) && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
}

async function readSnapshots(firestore, references) {
  if (references.length === 0) return [];
  if (typeof firestore.getAll === "function") {
    return firestore.getAll(...references);
  }
  return Promise.all(references.map((reference) => reference.get()));
}

async function sourceAccessById({
  firestore,
  actor,
  refs,
  registry,
  authorizeFn,
}) {
  const sourceIds = [...new Set(
    refs.filter((ref) => ref.backend === "s3").map((ref) => ref.sourceId),
  )];
  const entries = await Promise.all(sourceIds.map(async (sourceId) => {
    const source = registry.get(sourceId);
    try {
      await authorizeFn({
        firestore,
        actor,
        source,
        operation: "browse",
        isApprovedActiveAccountFn: alreadyApprovedAccount,
      });
      return [sourceId, source];
    } catch (error) {
      if (isMediaSourceDenial(error)) return [sourceId, null];
      throw error;
    }
  }));
  return new Map(entries);
}

async function resolveMediaAssets({
  firestore,
  actor,
  refs,
  registryFn = defaultRegistry,
  authorizeFn = authorizeMediaSource,
}) {
  const parsedRefs = refs.map(parseMediaAssetRef);
  const registry = parsedRefs.some((ref) => ref.backend === "s3")
    ? registryFn()
    : new Map();
  const accessBySource = await sourceAccessById({
    firestore,
    actor,
    refs: parsedRefs,
    registry,
    authorizeFn,
  });
  const readableRefs = parsedRefs.filter((ref) =>
    ref.backend === "r2" || accessBySource.get(ref.sourceId));
  const references = readableRefs.map((ref) => ref.backend === "r2"
    ? firestore.collection("media_assets").doc(ref.id)
    : firestore.collection("mediaSourceAssets").doc(ref.id));
  const originalRefs = readableRefs.filter(ref => ref.backend === "s3");
  const snapshots = await readSnapshots(firestore, [...references,
    ...originalRefs.map(ref => originalStatusRef(firestore, ref.id))]);
  const originalStatuses = new Map(originalRefs.map((ref, index) => [ref.id, snapshots[references.length + index]?.data()]));
  const snapshotsByRef = new Map(readableRefs.map((ref, index) => [
    canonicalMediaAssetRef(ref),
    snapshots[index],
  ]));
  const canViewUsers = hasCapability(actor.principal, "users.view");
  const audioReadAdmitted = isAudioReadAdmitted(actor);
  const resolved = parsedRefs.map((ref) => {
    const snapshot = snapshotsByRef.get(canonicalMediaAssetRef(ref));
    if (!snapshot?.exists) return { ref, available: false };
    if (ref.backend === "r2") {
      const summary = mediaAssetSummary(snapshot.id, snapshot.data());
      return summary && mayUseMedia(
        actor.principal, summary.category, summary.kind, audioReadAdmitted,
      )
        ? { ref, available: true, summary }
        : { ref, available: false };
    }
    const source = accessBySource.get(ref.sourceId);
    const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
    if (!source || !asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) return { ref, available: false };
    const original = originalAvailability(originalStatuses.get(asset.id), asset);
    return { ref, available: true, summary: { ...sourceMediaAssetSummary(asset), ...(original ? { original } : {}) } };
  });
  const availableSourceAssets = resolved.flatMap((record) =>
    record.available && record.ref.backend === "s3" ? [record.summary] : []);
  const presentedSourceAssets = await enrichSourceMediaUploaders(
    firestore,
    availableSourceAssets,
    canViewUsers,
  );
  let sourceIndex = 0;
  return resolved.map((record) => {
    if (!record.available || record.ref.backend !== "s3") return record;
    return { ...record, summary: presentedSourceAssets[sourceIndex++] };
  });
}

async function assertMediaAssetAvailable({
  firestore,
  actor,
  ref,
  registryFn = defaultRegistry,
  authorizeFn = authorizeMediaSource,
}) {
  const parsedRef = parseMediaAssetRef(ref);
  if (parsedRef.backend === "r2") {
    const snapshot = await firestore.collection("media_assets").doc(parsedRef.id).get();
    const summary = snapshot.exists ? mediaAssetSummary(snapshot.id, snapshot.data()) : null;
    if (!summary || !mayUseMedia(
      actor.principal, summary.category, summary.kind, isAudioReadAdmitted(actor),
    )) {
      throw new MediaAssetUnavailableError();
    }
    return;
  }
  const source = registryFn().get(parsedRef.sourceId);
  try {
    await authorizeFn({
      firestore,
      actor,
      source,
      operation: "browse",
      isApprovedActiveAccountFn: alreadyApprovedAccount,
    });
  } catch (error) {
    if (isMediaSourceDenial(error)) throw new MediaAssetUnavailableError();
    throw error;
  }
  const snapshot = await firestore.collection("mediaSourceAssets").doc(parsedRef.id).get();
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  if (!source || !asset || asset.sourceId !== source.id ||
    !objectKeyWithinSource(source, asset.objectKey)) {
    throw new MediaAssetUnavailableError();
  }
}

module.exports = {
  MEDIA_ASSET_UNAVAILABLE_MESSAGE,
  MediaAssetUnavailableError,
  assertMediaAssetAvailable,
  resolveMediaAssets,
};
