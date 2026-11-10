"use strict";

// Staff reactivation reverses `deactivateStaff` in the safe order. It requires a
// finished offboarding (disabled identity), revokes refresh tokens again and
// stores that watermark with the audited Firestore change. Firebase Auth then
// follows the stored account state through the shared sync. The old roles,
// grants, public author profile and navigation shares do not come back; the
// Owner chooses one whole-site level.
//
// A server-only `staffReactivations/{uid}` marker records an audited
// reactivation whose Auth step has not finished. Only that marker, at the same
// level and with unchanged access, lets a retry finish the Auth step without a
// second audit. No client rule grants access to that collection.

const { cmsOnRequest } = require("./lib/cms-edge");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requireSuperAdmin, ForbiddenError, AuthError } = require("./lib/auth");
const { adminLogEntry } = require("./lib/audit");
const { isAccessTier } = require("./lib/rbac");
const { accessTierReadsActive } = require("./lib/access-tier-activation");
const { administrativeRoleFromUserDoc, normalizeGrants } = require("./lib/principal");
const { reactivateStaffLinkage, staffRecordRef } = require("./lib/author-profile-store");
const { revocationSeconds, syncStaffAuth } = require("./lib/staff-auth-sync");

const PENDING_COLLECTION = "staffReactivations";

class StaffReactivationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fail(status, message) {
  return new StaffReactivationError(status, message);
}

function safeFailureCode(error) {
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16) return error.code;
  return ["auth/internal-error", "auth/insufficient-permission", "auth/network-request-failed", "auth/invalid-credential", "auth/too-many-requests"]
    .includes(error?.code) ? error.code : "unknown";
}

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["targetUid", "accessTier"].includes(key)) ||
      typeof body.targetUid !== "string" || body.targetUid.length < 1 || body.targetUid.length > 128 ||
      body.targetUid.trim() !== body.targetUid || body.targetUid.includes("/") ||
      !isAccessTier(body.accessTier)) {
    throw fail(400, "Choose an inactive staff member and level from the current directory");
  }
  return body;
}

// The retry case: this Function's own audited reactivation at the same level,
// and nobody has changed the account's access since.
function isPendingRetry(pendingSnapshot, target, accessTier) {
  const pending = pendingSnapshot.exists ? pendingSnapshot.data() : null;
  return pending?.accessTier === accessTier && target.active === true &&
    target.accessTier === accessTier && target.role == null &&
    Array.isArray(target.grants) && target.grants.length === 0;
}

async function reactivateProfile({ firestore, actor, targetUid, accessTier, identityDisabled, tokensValidAfter, source, nowIso }) {
  if (actor.emailVerified !== true) throw new ForbiddenError("A verified Owner account is required");
  if (targetUid === actor.uid) throw new ForbiddenError("You cannot reactivate your own account");

  return firestore.runTransaction(async (transaction) => {
    const targetRef = firestore.collection("users").doc(targetUid);
    const pendingRef = firestore.collection(PENDING_COLLECTION).doc(targetUid);
    const [actorSnapshot, targetSnapshot, staffSnapshot, shareSnapshot, pendingSnapshot, tiersActive] = await Promise.all([
      transaction.get(firestore.collection("users").doc(actor.uid)),
      transaction.get(targetRef),
      transaction.get(staffRecordRef(firestore, targetUid)),
      transaction.get(firestore.collection("navigationShares")
        .where("ownerUid", "==", targetUid).where("status", "==", "active")),
      transaction.get(pendingRef),
      accessTierReadsActive(firestore, transaction),
    ]);
    if (!tiersActive) throw fail(409, "Staff levels have not been activated");
    if (!actorSnapshot.exists ||
        (actorSnapshot.data().active !== undefined && actorSnapshot.data().active !== true) ||
        administrativeRoleFromUserDoc(actorSnapshot.data(), true) !== "super_admin") {
      throw new ForbiddenError("Owner access required");
    }
    if (!targetSnapshot.exists) throw fail(404, "Staff account not found");
    const target = targetSnapshot.data();
    if (target.active !== false) {
      if (isPendingRetry(pendingSnapshot, target, accessTier)) {
        // This request revoked sessions again; keep the stored watermark current.
        if (tokensValidAfter > (Number.isFinite(target.tokensValidAfter) ? target.tokensValidAfter : 0)) {
          transaction.update(targetRef, { tokensValidAfter, updatedAt: FieldValue.serverTimestamp() });
        }
        return { alreadyActive: true, pendingId: pendingSnapshot.data().id };
      }
      throw fail(409, "This staff account is not inactive");
    }
    // deactivateStaff commits before it disables sign-in. An identity that is
    // still enabled means that offboarding has not finished.
    if (!identityDisabled) throw fail(409, "Offboarding did not finish. Retry offboarding, then reactivate");

    const staff = await reactivateStaffLinkage(transaction, firestore, {
      snapshot: staffSnapshot, nowIso, actorUid: actor.uid,
    });
    const before = { active: false, role: target.role ?? null, grants: normalizeGrants(target.grants),
      ...(Object.hasOwn(target, "accessTier") ? { accessTier: target.accessTier } : {}),
      ...(staff ? { staffStatus: staff.before.status } : {}) };
    const after = { active: true, accessTier, role: null, grants: [],
      ...(staff ? { staffStatus: staff.after.status } : {}) };
    // The share cleanup trigger skips an account that is active again, so shares
    // from before offboarding are removed here, with the authority change.
    for (const share of shareSnapshot.docs) {
      transaction.update(share.ref, {
        status: "removed", removedReason: "owner_removed", updatedAt: FieldValue.serverTimestamp(),
      });
    }
    transaction.update(targetRef, {
      active: true, accessTier, role: null, grants: [],
      offboarding: FieldValue.delete(),
      tokensValidAfter: Math.max(tokensValidAfter, Number.isFinite(target.tokensValidAfter) ? target.tokensValidAfter : 0),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const pendingId = pendingRef.parent.doc().id;
    transaction.set(pendingRef, { id: pendingId, accessTier, actorUid: actor.uid, at: nowIso });
    transaction.set(firestore.collection("admin_logs").doc(), adminLogEntry({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: "staff.reactivate",
      target: targetUid, before, after, source,
    }));
    return { alreadyActive: false, pendingId };
  });
}

// Removes the retry marker only if it is still this request's marker, so a
// delayed request cannot remove a newer reactivation's marker.
async function clearPending(firestore, uid, pendingId) {
  const ref = firestore.collection(PENDING_COLLECTION).doc(uid);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && snapshot.data().id === pendingId) transaction.delete(ref);
  });
}

function createReactivateStaffHandler({
  firestore = db, authClient = getAuth(), requireSuperAdminFn = requireSuperAdmin,
  nowIso = () => new Date().toISOString(), now = () => FieldValue.serverTimestamp(), log = console,
} = {}) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requireSuperAdminFn(req);
      if (actor.emailVerified !== true) throw new ForbiddenError("A verified Owner account is required");
      const body = validateRequest(req.body);
      if (body.targetUid === actor.uid) throw new ForbiddenError("You cannot reactivate your own account");
      let identity;
      try { identity = await authClient.getUser(body.targetUid); }
      catch (error) {
        if (error?.code === "auth/user-not-found") throw fail(404, "Staff identity not found");
        throw error;
      }
      if (identity.emailVerified !== true) throw fail(409, "A verified staff identity is required");

      // Revoke again before restoring authority, so the stored watermark rejects
      // every session issued before this request.
      let tokensValidAfter = 0;
      if (identity.disabled === true) {
        await authClient.revokeRefreshTokens(body.targetUid);
        tokensValidAfter = revocationSeconds(await authClient.getUser(body.targetUid));
      }
      const { pendingId, ...outcome } = await reactivateProfile({ firestore, actor, ...body,
        identityDisabled: identity.disabled === true, tokensValidAfter, nowIso: nowIso(),
        source: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null });

      // Sign-in follows the stored state only after the audited change commits.
      let signInAllowed;
      try {
        signInAllowed = await syncStaffAuth({ firestore, authClient, uid: body.targetUid, now });
        if (signInAllowed) await clearPending(firestore, body.targetUid, pendingId);
      } catch (error) {
        log.error("reactivateStaff sign-in sync failed", { code: safeFailureCode(error) });
        return res.status(503).json({
          error: "The account is active, but sign-in may still be off. Retry reactivation at the same level",
          uid: body.targetUid, cmsAccessRestored: true,
        });
      }
      if (!signInAllowed) throw fail(409, "This account was deactivated during reactivation");
      return res.status(200).json({ success: true, uid: body.targetUid, accessTier: body.accessTier, ...outcome });
    } catch (error) {
      const expected = error instanceof StaffReactivationError || error instanceof ForbiddenError || error instanceof AuthError;
      const status = expected ? error.status : 500;
      if (status >= 500) log.error("reactivateStaff failed", { code: safeFailureCode(error) });
      return res.status(status).json({ error: status < 500 ? error.message : "Staff account could not be reactivated" });
    }
  };
}

const reactivateStaff = cmsOnRequest({ cors: true }, createReactivateStaffHandler());
module.exports = { validateRequest, reactivateProfile, createReactivateStaffHandler, reactivateStaff };
