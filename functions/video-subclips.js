"use strict";

const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { ID_PATTERN, parseSourceMediaAsset, sourceMediaFileVersion } = require("./lib/source-media-contract");
const { problem, validateClipRange } = require("./lib/video-clip-contract");
const { SUBCLIP_ID_PATTERN, hashSubclipFields, subclipState, videoSubclipLibraryRef } = require("./lib/saved-video-subclips");
const { runtimeRegistry, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");

const MAX_SUBCLIPS = 50;
const actionFields = {
  list: [],
  save: ["name", "fileVersion", "inMs", "outMs"],
  open: ["id", "fileVersion"],
  remove: ["id"],
};

function parseRequest(value) {
  const fields = typeof value?.action === "string" && Object.hasOwn(actionFields, value.action)
    ? actionFields[value.action] : null;
  if (!fields || Array.isArray(value) || value.sourceId !== "video-library" ||
      typeof value.assetId !== "string" || !ID_PATTERN.test(value.assetId) ||
      Object.keys(value).some(key => !["action", "sourceId", "assetId", ...fields].includes(key))) {
    throw problem(400, "Saved subclip request is invalid");
  }
  if (fields.includes("fileVersion") && (typeof value.fileVersion !== "string" || !/^[a-f0-9]{32}$/.test(value.fileVersion))) {
    throw problem(400, "Reopen the video to select its current file version");
  }
  if (fields.includes("id") && (typeof value.id !== "string" || !SUBCLIP_ID_PATTERN.test(value.id))) {
    throw problem(400, "Saved subclip id is invalid");
  }
  if (value.action === "save") {
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name || name.length > 120) throw problem(400, "Use a subclip name of 1 to 120 characters");
    validateClipRange(value.inMs, value.outMs);
    return { ...value, name };
  }
  return value;
}

async function manageSubclips(firestore, source, uid, request) {
  const assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  const libraryRef = videoSubclipLibraryRef(firestore, uid, source.id, request.assetId);
  return firestore.runTransaction(async tx => {
    const [assetSnapshot, librarySnapshot] = await tx.getAll(assetRef, libraryRef);
    const asset = parseSourceMediaAsset(assetSnapshot.id, assetSnapshot.data());
    if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) {
      throw problem(404, "This video is no longer available");
    }
    const fileVersion = sourceMediaFileVersion(asset.objectVersionId);
    const durationSeconds = asset.rendition?.state === "ready" ? asset.rendition.web.durationSeconds : undefined;
    let subclips = librarySnapshot.data()?.subclips ?? [];
    if (request.action === "save" || request.action === "open") {
      if (request.fileVersion !== fileVersion) {
        throw problem(409, "The video file changed. Reopen the video and select the range again.");
      }
      const { name, inMs, outMs } = request;
      const subclip = request.action === "save"
        ? { id: hashSubclipFields([libraryRef.id, fileVersion, name, inMs, outMs]), name, fileVersion, inMs, outMs }
        : subclips.find(clip => clip.id === request.id);
      if (!subclip) throw problem(404, "This saved subclip is no longer available");
      const state = subclipState(subclip, fileVersion, durationSeconds);
      if (state === "replaced") throw problem(409, "This subclip belongs to a previous video file.");
      if (state === "unavailable") throw problem(409, "This range is unavailable in the current viewing copy.");
      if (request.action === "save" && !subclips.some(clip => clip.id === subclip.id)) {
        if (subclips.length >= MAX_SUBCLIPS) throw problem(409, "Remove a saved subclip before saving another for this video.");
        subclips = [subclip, ...subclips];
        tx.set(libraryRef, { assetId: request.assetId, subclips });
      }
    } else if (request.action === "remove" && subclips.some(clip => clip.id === request.id)) {
      subclips = subclips.filter(clip => clip.id !== request.id);
      if (subclips.length) tx.set(libraryRef, { assetId: request.assetId, subclips });
      else tx.delete(libraryRef);
    }
    return subclips.map(clip => ({ ...clip, state: subclipState(clip, fileVersion, durationSeconds) }));
  });
}

function createVideoSubclipsHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4096);
      await (deps.verifyAppCheck ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (deps.requirePrincipal ?? requirePrincipal)(req);
      const request = parseRequest(req.body);
      const source = (deps.registry ?? runtimeRegistry)().get(request.sourceId);
      await authorizeMediaSource({ firestore, actor, source, operation: "browse" });
      const subclips = await manageSubclips(firestore, source, actor.uid, request);
      return res.status(200).json({ success: true, subclips });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) logger.warn("Saved subclip request failed", { status });
      return res.status(status).json({ error: status < 500 ? error.message : "Saved subclip request failed" });
    }
  };
}

const options = { cors: true, maxInstances: 10, timeoutSeconds: 30, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsManageVideoSubclips = cmsOnRequest(options, createVideoSubclipsHandler());

module.exports = { cmsManageVideoSubclips, createVideoSubclipsHandler };
