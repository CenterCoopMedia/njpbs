"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { verifyAuthToken } = require("./lib/auth");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { db } = require("./lib/firebase");
const { isApprovedPreviewStaff } = require("./lib/preview-access");
const { previewExpiryMillis, validPreviewTarget } = require("./lib/preview-target");

async function previewAllowed(firestore, target, now) {
  if (!target || target.schemaVersion !== 1 || typeof target.queueId !== "string" ||
      !/^[A-Za-z0-9]{20}$/.test(target.queueId) ||
      typeof target.persistent !== "boolean") return false;
  const [queue] = await firestore.getAll(firestore.collection("cmsPreviewQueue").doc(target.queueId),
    { fieldMask: ["collection", "pageId", "status", "persistent", "expiresAt", "completedAt"] });
  const job = queue.exists ? queue.data() : null;
  const collection = job?.collection ?? "cmsPages";
  if (!job || job.status !== "ready" || (job.persistent === true) !== target.persistent ||
      !validPreviewTarget(collection, job.pageId)) return false;
  const [record] = await firestore.getAll(firestore.collection(collection).doc(job.pageId),
    { fieldMask: ["status", "deleted"] });
  const stored = record.exists ? record.data() : null;
  if (!stored || stored.deleted || stored.status === "archived") return false;
  const expiry = previewExpiryMillis(job);
  return expiry !== null && expiry > now;
}

// Internal, read-only admission check. The edge secret restricts the caller;
// Firebase revocation and the current staff document determine user access.
function createSiteAccessHandler({ verify = verifyAuthToken, firestore = db, now = Date.now } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).end();
    try {
      const user = await verify(req.headers.authorization, { cacheRevocation: false });
      const snapshot = await firestore.collection("users").doc(user.uid).get();
      const profile = snapshot.exists ? snapshot.data() : null;
      const principal = await principalFromStoredUserDoc(firestore, user.uid, profile);
      const allowed = isApprovedPreviewStaff(user, profile, principal);
      if (Object.hasOwn(req.body ?? {}, "preview")) {
        if (!allowed || !await previewAllowed(firestore, req.body.preview, now())) {
          return res.status(404).end();
        }
        res.set("x-njpbs-preview-access", "1");
        return res.status(204).end();
      }
      return res.status(allowed ? 204 : 403).end();
    } catch (error) {
      return res.status(error?.status === 401 ? 401 : 503).end();
    }
  };
}

exports.createSiteAccessHandler = createSiteAccessHandler;
exports.cmsValidateSiteAccess = cmsOnRequest({ invoker: "public" }, createSiteAccessHandler());
