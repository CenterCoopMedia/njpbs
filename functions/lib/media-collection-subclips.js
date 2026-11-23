"use strict";

const { MediaSourceAccessError, objectKeyWithinSource } = require("./media-sources");
const { ID_PATTERN, parseSourceMediaAsset, sourceMediaFileVersion } = require("./source-media-contract");
const { validateClipRange } = require("./video-clip-contract");
const { subclipState, videoSubclipLibraryRef } = require("./saved-video-subclips");
const { MediaCollectionValidationError } = require("./media-collections");

const unavailable = "The source video for this subclip is no longer available.";
const sourceId = "video-library";

function subclipSourceRef(subclip) {
  return { backend: "s3", sourceId, id: subclip.assetId };
}

async function canAccessSubclipSource({ firestore, actor, registryFn, authorizeFn }, operation = "browse") {
  try {
    await authorizeFn({
      firestore, actor, source: registryFn().get(sourceId), operation,
      isApprovedActiveAccountFn: async () => true,
    });
    return true;
  } catch (error) {
    if (error instanceof MediaSourceAccessError && error.status < 500) return false;
    throw error;
  }
}

function assertCurrentSubclip(state) {
  if (state === "replaced") {
    throw new MediaCollectionValidationError("This subclip belongs to a previous video file.", 409, "subclip_replaced");
  }
  if (state !== "current") {
    throw new MediaCollectionValidationError("This range is unavailable in the current viewing copy.", 409, "subclip_unavailable");
  }
}

async function readOwnedCollectionSubclip({ transaction, firestore, actor, request, registryFn, authorizeFn }) {
  const source = registryFn().get(sourceId);
  if (!source || !await canAccessSubclipSource({ firestore, actor, registryFn, authorizeFn })) {
    throw new MediaCollectionValidationError(unavailable, 404);
  }
  const assetId = request.subclipAssetId;
  const libraryRef = videoSubclipLibraryRef(firestore, actor.uid, sourceId, assetId);
  const [library, snapshot] = await transaction.getAll(libraryRef, firestore.collection("mediaSourceAssets").doc(assetId));
  const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
  if (!asset || asset.sourceId !== sourceId || !objectKeyWithinSource(source, asset.objectKey)) {
    throw new MediaCollectionValidationError(unavailable, 404);
  }
  const saved = library.data()?.subclips?.find(clip => clip.id === request.refs[0].id);
  if (!saved) throw new MediaCollectionValidationError("This saved subclip is no longer available.", 404);
  const subclip = storedCollectionSubclip({ ...saved, assetId });
  const duration = asset.rendition?.state === "ready" ? asset.rendition.web.durationSeconds : undefined;
  assertCurrentSubclip(subclipState(subclip, sourceMediaFileVersion(asset.objectVersionId), duration));
  return subclip;
}

function storedCollectionSubclip(value) {
  if (!value || typeof value.assetId !== "string" || !ID_PATTERN.test(value.assetId) ||
    typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 ||
    typeof value.fileVersion !== "string" || !/^[a-f0-9]{32}$/.test(value.fileVersion)) {
    throw new Error("Media collection has an invalid saved subclip");
  }
  const { assetId, name, fileVersion, inMs, outMs } = value;
  validateClipRange(inMs, outMs);
  return { assetId, name, fileVersion, inMs, outMs };
}

function presentCollectionSubclip(subclip, asset) {
  const duration = asset.viewingCopy?.state === "ready" ? asset.viewingCopy.durationSeconds : undefined;
  const { name, fileVersion, inMs, outMs } = subclip;
  return { name, fileVersion, inMs, outMs, state: subclipState(subclip, asset.fileVersion, duration) };
}

module.exports = {
  assertCurrentSubclip,
  canAccessSubclipSource,
  presentCollectionSubclip,
  readOwnedCollectionSubclip,
  storedCollectionSubclip,
  subclipSourceRef,
};
