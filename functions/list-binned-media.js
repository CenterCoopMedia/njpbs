"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can, hasCapability } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { mediaAssetSummary } = require("./lib/media-library");
const { MAX_MEDIA_SCAN, SUMMARY_FIELDS, setPrivateNoStore } = require("./list-media");
const logger = require("firebase-functions/logger");

function createCmsListBinnedMediaHandler(deps = {}) {
  const { firestore = db, requirePrincipalFn = requirePrincipal, log = logger } = deps;
  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4096);
      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "media.manage")) {
        return res.status(403).json({ error: "You do not have permission to list binned images." });
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some((key) => !["page", "pageSize"].includes(key))) {
        return res.status(400).json({ error: "The bin request accepts only page and pageSize." });
      }
      const page = body.page ?? 1;
      const pageSize = body.pageSize ?? 30;
      if (!Number.isSafeInteger(page) || page < 1 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ error: "Use a positive page and pageSize from 1 to 100." });
      }
      // Like the active library, fail explicitly beyond the bounded server scan.
      // Authorization precedes every response count and page selection.
      const snapshot = await firestore.collection("media_assets")
        .where("lifecycle", "in", ["tombstoned", "purging"])
        .orderBy("purgeAfter", "asc")
        .select(...SUMMARY_FIELDS, "purgeAfter", "tombstonedAt", "tombstonedBy")
        .limit(MAX_MEDIA_SCAN + 1).get();
      if (snapshot.size > MAX_MEDIA_SCAN) {
        return res.status(503).json({ error: "The image bin needs indexed paging before it can list more assets." });
      }
      const records = snapshot.docs.flatMap((document) => {
        const stored = document.data();
        if (stored.kind !== "image" || !can(user.principal, "media.manage")) return [];
        const summary = mediaAssetSummary(document.id, { ...stored, lifecycle: "active" });
        if (!summary) return [];
        return [{ ...summary, lifecycle: stored.lifecycle,
          purgeAfter: stored.purgeAfter, tombstonedAt: stored.tombstonedAt ?? null,
          tombstonedBy: stored.tombstonedBy ?? null }];
      }).sort((left, right) => left.purgeAfter.localeCompare(right.purgeAfter) || left.id.localeCompare(right.id));
      const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
      const currentPage = Math.min(page, pageCount);
      const pageRecords = records.slice((currentPage - 1) * pageSize, currentPage * pageSize);
      const canViewUsers = hasCapability(user.principal, "users.view");
      // Match source-media-uploader's permission, deduplication and name limits.
      const uids = canViewUsers ? [...new Set(pageRecords.map(record => record.tombstonedBy)
        .filter(uid => typeof uid === "string" && uid && !uid.includes("/")))] : [];
      const names = new Map(await Promise.all(uids.map(async uid => {
        try {
          const snapshot = await firestore.collection("users").doc(uid).get();
          const name = snapshot.exists ? snapshot.data()?.displayName : null;
          return [uid, typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null];
        } catch {
          // Optional actor details must not prevent staff from restoring images.
          return [uid, null];
        }
      })));
      return res.status(200).json({ success: true, total: records.length,
        page: currentPage, pageCount,
        records: pageRecords.map((record) => {
          const presented = { ...record,
            tombstonedByName: names.get(record.tombstonedBy) ?? null };
          delete presented.tombstonedBy;
          return presented;
        }) });
    } catch (error) {
      const status = error.status || (error.code === 9 || error.code === "failed-precondition" ? 503 : 500);
      if (status >= 500) log.error("cmsListBinnedMedia failed", error);
      return res.status(status).json({ error: error.status ? error.message : "Failed to list binned images" });
    }
  };
}

const cmsListBinnedMedia = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30 }, createCmsListBinnedMediaHandler(),
);

module.exports = { cmsListBinnedMedia, createCmsListBinnedMediaHandler };
