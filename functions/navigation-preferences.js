"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { admin, db } = require("./lib/firebase");
const { verifyAuthToken, verifyAppCheckToken, AuthError, ForbiddenError } = require("./lib/auth");
const { SESSION_EXPIRED_CODE } = require("./lib/session-refusal");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { hasExactKeys, parseNavigationPreferences, parseOwnedShareIds } = require("./lib/navigation-preferences");
const logger = require("firebase-functions/logger");

const MAX_NAVIGATION_REQUEST_BYTES = 32 * 1024;
const REQUEST_ERROR = "Use save with valid navigation, or reset without additional fields.";
const SHARE_TARGET_ERROR = "Share one of your top-level planks or spans.";
const SHARE_ID = /^custom:[A-Za-z0-9_-]{1,73}$/;
const STAFF_NAME = "Staff member";

function parseRequest(body) {
  if (hasExactKeys(body, ["action"]) && body.action === "reset") return { action: "reset" };
  if (hasExactKeys(body, ["action", "itemId", "shared"]) && body.action === "share" &&
      typeof body.itemId === "string" && SHARE_ID.test(body.itemId) &&
      (body.shared === true || body.shared === false)) {
    return { action: "share", itemId: body.itemId, shared: body.shared };
  }
  if (hasExactKeys(body, ["action", "navigation"], ["sharedItemIds"]) && body.action === "save") {
    const navigation = parseNavigationPreferences(body.navigation);
    const sharedItemIds = navigation ? parseOwnedShareIds(body.sharedItemIds, navigation.custom) : null;
    if (navigation && sharedItemIds !== null) return { action: "save", navigation, sharedItemIds };
  }
  throw new JsonRequestError(400, REQUEST_ERROR);
}

function requireCurrentSession(snapshot, caller) {
  if (!snapshot.exists) throw new ForbiddenError("An approved staff profile is required.");
  const profile = snapshot.data();
  const active = Object.hasOwn(profile, "active") ? profile.active : true;
  const validAfter = Object.hasOwn(profile, "tokensValidAfter") ? profile.tokensValidAfter : 0;
  if (active !== true) throw new ForbiddenError("The staff account is inactive.");
  if (!Number.isFinite(validAfter) || !Number.isFinite(caller.authTime) || caller.authTime <= 0 || caller.authTime <= validAfter) {
    throw new ForbiddenError("The staff session has expired. Sign in again.");
  }
}

function normalizeStaffName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 100) : null;
}

// Auth displayName first, then the staff profile name. Never the request body.
async function resolveOwnerName(uid, profile, getAuthUser) {
  let authName = null;
  try {
    const record = await getAuthUser(uid);
    authName = normalizeStaffName(record && record.displayName);
  } catch (error) {
    if (!error || error.code !== "auth/user-not-found") throw error;
  }
  return authName || normalizeStaffName(profile && profile.displayName) || STAFF_NAME;
}

function shareDocument(ownerUid, ownerName, item, status, removedReason) {
  const document = {
    ownerUid,
    ownerName,
    status,
    item,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (status === "removed") document.removedReason = removedReason;
  return document;
}

function sameShare(existing, ownerUid, ownerName, item, status, removedReason) {
  if (!existing || existing.ownerUid !== ownerUid || existing.ownerName !== ownerName || existing.status !== status) return false;
  if ((existing.removedReason ?? null) !== (status === "removed" ? removedReason : null)) return false;
  return JSON.stringify(existing.item) === JSON.stringify(item);
}

function queueShare(writes, existing, id, ownerUid, ownerName, item, status, removedReason) {
  if (sameShare(existing, ownerUid, ownerName, item, status, removedReason)) return;
  writes.push({ id, data: shareDocument(ownerUid, ownerName, item, status, removedReason) });
}

// One toggle writes one document. It does not refresh the owner's other shares.
function planOneShareWrite({ owned, item, itemId, shared, ownerUid, ownerName }) {
  const writes = [];
  const existing = owned.get(itemId);
  if (shared) queueShare(writes, existing, itemId, ownerUid, ownerName, item, "active");
  else if (existing && existing.status === "active") {
    queueShare(writes, existing, itemId, ownerUid, ownerName, existing.item, "removed", "unshared");
  }
  return writes;
}

// Active shares store the current item. A removed share keeps the last shared body.
function planShareWrites({ owned, customById, intent, ownerUid, ownerName, reset }) {
  const writes = [];
  const activeIds = new Set();
  // An empty list is a real intent: unshare every owned item. It is not "omitted".
  if (!reset && intent !== undefined) for (const id of intent) activeIds.add(id);
  if (!reset && intent === undefined) {
    for (const [id, existing] of owned) {
      if (existing.status === "active" && customById.has(id)) activeIds.add(id);
    }
  }
  for (const id of activeIds) {
    queueShare(writes, owned.get(id), id, ownerUid, ownerName, customById.get(id), "active");
  }
  for (const [id, existing] of owned) {
    if (activeIds.has(id)) continue;
    if (reset || !customById.has(id)) {
      queueShare(writes, existing, id, ownerUid, ownerName, existing.item, "removed", "deleted");
      continue;
    }
    // An already removed share stays as stored. A later private edit must not enter the tombstone.
    if (intent !== undefined && existing.status === "active") {
      queueShare(writes, existing, id, ownerUid, ownerName, existing.item, "removed", "unshared");
    }
  }
  return writes;
}

function createCmsSetNavigationPreferencesHandler(deps = {}) {
  const {
    firestore = db,
    verifyAuthTokenFn = verifyAuthToken,
    verifyAppCheckTokenFn = verifyAppCheckToken,
    getAuthUser = (uid) => admin.auth().getUser(uid),
    log = logger,
  } = deps;
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, MAX_NAVIGATION_REQUEST_BYTES);
      await verifyAppCheckTokenFn(req.headers?.["x-firebase-appcheck"]);
      const caller = await verifyAuthTokenFn(req.headers?.authorization);
      if (typeof caller.uid !== "string" || !caller.uid || caller.uid.includes("/")) {
        throw new ForbiddenError("An approved staff profile is required.");
      }
      const request = parseRequest(req.body);
      const userRef = firestore.collection("users").doc(caller.uid);
      const shareQuery = firestore.collection("navigationShares").where("ownerUid", "==", caller.uid);
      await firestore.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        requireCurrentSession(userSnap, caller);
        const shareSnap = await transaction.get(shareQuery);
        const owned = new Map();
        shareSnap.forEach((entry) => {
          const data = entry.data();
          if (data && data.ownerUid === caller.uid) owned.set(entry.id, data);
        });
        if (request.action === "share") {
          const navigation = parseNavigationPreferences(userSnap.data()?.preferences?.navigation);
          const item = navigation?.custom?.find((entry) => entry.id === request.itemId);
          if (!item) throw new JsonRequestError(400, SHARE_TARGET_ERROR);
          if (!owned.has(request.itemId)) {
            const snap = await transaction.get(firestore.collection("navigationShares").doc(request.itemId));
            if (snap.exists && snap.data()?.ownerUid !== caller.uid) {
              const noun = item.kind === "section" ? "span" : "plank";
              throw new JsonRequestError(409, `This ${noun} is already shared by another account.`);
            }
          }
          const existing = owned.get(request.itemId);
          const willWrite = request.shared || existing?.status === "active";
          const ownerName = willWrite ? await resolveOwnerName(caller.uid, userSnap.data(), getAuthUser) : null;
          const writes = planOneShareWrite({
            owned, item, itemId: request.itemId, shared: request.shared, ownerUid: caller.uid, ownerName,
          });
          for (const write of writes) transaction.set(firestore.collection("navigationShares").doc(write.id), write.data);
          return;
        }
        const custom = request.action === "reset" ? [] : request.navigation.custom;
        const customById = new Map(custom.map((item) => [item.id, item]));
        const intent = request.action === "save" ? request.sharedItemIds : undefined;
        if (intent !== undefined) {
          for (const id of intent) {
            if (owned.has(id)) continue;
            const snap = await transaction.get(firestore.collection("navigationShares").doc(id));
            if (snap.exists && snap.data()?.ownerUid !== caller.uid) {
              const noun = customById.get(id)?.kind === "section" ? "span" : "plank";
              throw new JsonRequestError(409, `This ${noun} is already shared by another account.`);
            }
          }
        }
        const needsName = owned.size > 0 || (intent !== undefined && intent.length > 0);
        const ownerName = needsName ? await resolveOwnerName(caller.uid, userSnap.data(), getAuthUser) : null;
        const writes = planShareWrites({
          owned, customById, intent, ownerUid: caller.uid, ownerName, reset: request.action === "reset",
        });
        transaction.set(userRef, {
          preferences: { navigation: request.action === "reset" ? admin.firestore.FieldValue.delete() : request.navigation },
        }, { mergeFields: ["preferences.navigation"] });
        for (const write of writes) transaction.set(firestore.collection("navigationShares").doc(write.id), write.data);
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) log.error("cmsSetNavigationPreferences failed", error);
      return res.status(status).json({
        error: status < 500 ? error.message : "Navigation could not be saved.",
        ...(error instanceof AuthError && error.code === SESSION_EXPIRED_CODE ? { code: SESSION_EXPIRED_CODE,
          ...(error.reason === "token_expired" ? { reason: error.reason } : {}) } : {}),
      });
    }
  };
}

const cmsSetNavigationPreferences = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30 },
  createCmsSetNavigationPreferencesHandler(),
);

module.exports = { cmsSetNavigationPreferences, createCmsSetNavigationPreferencesHandler };
