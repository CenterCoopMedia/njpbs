"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can, hasCapability, hasGlobalCapability } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { mediaAssetSummary } = require("./lib/media-library");
const { MAX_MEDIA_SCAN, SUMMARY_FIELDS, setPrivateNoStore } = require("./list-media");
const logger = require("firebase-functions/logger");
const { MEDIA_PURGE_CONTROL_PATH, isImmediatePurgeDelegate } = require("./lib/media-bin");
const { readPurgeDeployment } = require("./lib/media-purge-deployment");

const BIN_FIELDS = [...SUMMARY_FIELDS, "purgeAfter", "tombstonedAt", "tombstonedBy"];

function readAudioBinPage(firestore, assets, page, pageSize) {
  // Audio stays available until restored. Read one page from the deletion-date index.
  const query = assets.where("lifecycle", "==", "tombstoned")
    .where("kind", "==", "audio").where("source", "==", "upload").orderBy("tombstonedAt", "desc");
  return firestore.runTransaction(async transaction => {
    const { count: total } = (await transaction.get(query.count())).data();
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, pageCount);
    const snapshot = await transaction.get(query.offset((currentPage - 1) * pageSize)
      .limit(pageSize).select(...BIN_FIELDS));
    return { snapshot, total, pageCount, currentPage };
  }, { readOnly: true });
}

function createCmsListBinnedMediaHandler(deps = {}) {
  const { firestore = db, requirePrincipalFn = requirePrincipal, log = logger,
    realDeletesEnabled = readPurgeDeployment().realDeletesEnabled } = deps;
  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4096);
      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "media.manage")) {
        return res.status(403).json({ error: "You do not have permission to list binned media." });
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some((key) => !["kind", "page", "pageSize"].includes(key))) {
        return res.status(400).json({ error: "The bin request accepts only kind, page and pageSize." });
      }
      const { kind = "image" } = body;
      const page = body.page ?? 1;
      const pageSize = body.pageSize ?? 30;
      if (kind !== "image" && kind !== "audio") {
        return res.status(400).json({ error: "The bin supports images and uploaded audio." });
      }
      if (!Number.isSafeInteger(page) || page < 1 ||
          !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ error: "Use a positive page and pageSize from 1 to 100." });
      }
      // Authorization precedes every response count and page selection.
      const assets = firestore.collection("media_assets");
      const audioPage = kind === "audio" ? await readAudioBinPage(firestore, assets, page, pageSize) : null;
      const snapshot = audioPage?.snapshot ?? await assets.where("lifecycle", "in", ["tombstoned", "purging"])
        .orderBy("purgeAfter", "asc").select(...BIN_FIELDS)
        .limit(MAX_MEDIA_SCAN + 1).get();
      if (!audioPage && snapshot.size > MAX_MEDIA_SCAN) {
        return res.status(503).json({ error: "The image bin needs indexed paging before it can list more assets." });
      }
      const records = snapshot.docs.flatMap((document) => {
        const stored = document.data();
        if (stored.kind !== kind || !can(user.principal, "media.manage")) return [];
        const summary = mediaAssetSummary(document.id, { ...stored, lifecycle: "active" });
        if (!summary) return [];
        return [{ ...summary, lifecycle: stored.lifecycle,
          purgeAfter: kind === "image" ? stored.purgeAfter : null, tombstonedAt: stored.tombstonedAt ?? null,
          tombstonedBy: stored.tombstonedBy ?? null }];
      });
      const total = audioPage?.total ?? records.length;
      const pageCount = audioPage?.pageCount ?? Math.max(1, Math.ceil(total / pageSize));
      const currentPage = audioPage?.currentPage ?? Math.min(page, pageCount);
      const pageRecords = audioPage ? records : records
        .sort((left, right) => (left.purgeAfter ?? "").localeCompare(right.purgeAfter ?? "") || left.id.localeCompare(right.id))
        .slice((currentPage - 1) * pageSize, currentPage * pageSize);
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
          // Optional actor details must not prevent staff from restoring media.
          return [uid, null];
        }
      })));
      let canDeletePermanently = false;
      if (kind === "image" && realDeletesEnabled && hasGlobalCapability(user.principal, "users.manage")) {
        try {
          const control = (await firestore.doc(MEDIA_PURGE_CONTROL_PATH).get()).data();
          canDeletePermanently = (control?.enabled === undefined || control.enabled === true) &&
            control?.dryRun === false && isImmediatePurgeDelegate(user, control);
        } catch {
          log.warn("Immediate media purge availability could not be read");
        }
      }
      return res.status(200).json({ success: true, total, canDeletePermanently,
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
      return res.status(status).json({ error: error.status ? error.message : "Failed to list binned media" });
    }
  };
}

const cmsListBinnedMedia = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30 }, createCmsListBinnedMediaHandler(),
);

module.exports = { cmsListBinnedMedia, createCmsListBinnedMediaHandler };
