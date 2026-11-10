"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { ID_PATTERN, parseSourceMediaAsset } = require("./lib/source-media-contract");
const { runtimeRegistry, runtimeAwsConfig } = require("./lib/media-source-runtime");
const { FUNCTION_SERVICE_ACCOUNT, respondWithError } = require("./source-media");
const { createOriginalStorage, refreshOriginal, requestOriginalRestore, noticesFor } = require("./lib/source-originals");
const logger = require("firebase-functions/logger");

const problem = (status, message) => Object.assign(new Error(message), { status });
function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !["status", "restore", "notices", "dismiss"].includes(value.action) ||
      (typeof value.sourceId !== "string" || !ID_PATTERN.test(value.sourceId))) throw problem(400, "Original request is invalid");
  const fields = ["action", "sourceId", ...(["status", "restore"].includes(value.action) ? ["assetId"] : value.action === "dismiss" ? ["noticeId"] : [])];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      (["status", "restore"].includes(value.action) && (typeof value.assetId !== "string" || !ID_PATTERN.test(value.assetId))) ||
      (value.action === "dismiss" && !/^[a-f0-9]{64}$/.test(value.noticeId ?? ""))) throw problem(400, "Original request is invalid");
  return value;
}

function createOriginalHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  let defaultStorage;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      validateBoundedJsonRequest(req, 4096);
      const request = parseRequest(req.body);
      if (["restore", "dismiss"].includes(request.action)) {
        await (deps.verifyAppCheck ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      }
      const actor = await (deps.requirePrincipal ?? requirePrincipal)(req);
      const source = (deps.registry ?? runtimeRegistry)().get(request.sourceId);
      // Restore has the same account, role and archive-category gate as Download original.
      // requestOriginalRestore adds video management for a paid DEEP_ARCHIVE restore.
      await (deps.authorize ?? authorizeMediaSource)({ firestore, actor, source, operation: "read" });
      const notices = noticesFor(firestore, actor.uid);
      if (request.action === "notices") {
        const snapshot = await notices.where("sourceId", "==", source.id).limit(10).get();
        return res.status(200).json({ success: true, notices: snapshot.docs.map(doc => doc.data()) });
      }
      if (request.action === "dismiss") {
        const ref = notices.doc(request.noticeId);
        if ((await ref.get()).data()?.sourceId !== source.id) throw problem(404, "Restore notice not found");
        await ref.delete();
        return res.status(200).json({ success: true });
      }
      const snapshot = await firestore.collection("mediaSourceAssets").doc(request.assetId).get();
      const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
      if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) {
        throw problem(404, "Media asset not found");
      }
      const storage = deps.storage ?? (defaultStorage ??= createOriginalStorage(runtimeAwsConfig()));
      const args = { firestore, storage, source, asset, actor, fresh: true };
      const original = request.action === "restore" ? await requestOriginalRestore(args) : await refreshOriginal(args);
      return res.status(200).json({ success: true, original });
    } catch (error) {
      respondWithError(res, deps.log ?? logger, "check or restore original", error);
    }
  };
}

const cmsSourceMediaOriginal = cmsOnRequest({ cors: true, timeoutSeconds: 30, maxInstances: 10,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT }, createOriginalHandler());
module.exports = { cmsSourceMediaOriginal, createOriginalHandler, parseRequest };
