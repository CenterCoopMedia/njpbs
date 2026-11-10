"use strict";

// Staff deactivation is one server-owned boundary: Firestore authority is removed
// and audited first, then Firebase Auth is disabled and its refresh tokens are
// revoked. A partial Auth failure leaves CMS access denied and returns a retryable
// error so the same request can finish session reconciliation without a second audit.

const { cmsOnRequest } = require("./lib/cms-edge");
const { randomUUID } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue } = require("firebase-admin/firestore");
const { Filter } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requireSuperAdmin, ForbiddenError } = require("./lib/auth");
const { adminLogEntry } = require("./lib/audit");
const { accessTierReadsActive } = require("./lib/access-tier-activation");
const { administrativeRoleFromUserDoc } = require("./lib/principal");
const { revocationSeconds, syncStaffAuth } = require("./lib/staff-auth-sync");
const {
  deactivateStaffLinkage,
  staffRecordRef,
  withdrawProfileForDeactivation,
} = require("./lib/author-profile-store");

const MAX_UID_LENGTH = 128;
const ADMIN_ALLOWED_ORIGINS = Object.freeze([
  "https://admin.njpbs.org",
  /^https:\/\/(?:[a-z0-9-]+\.)?njpbs-admin\.pages\.dev$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/,
]);

class StaffDeactivationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StaffDeactivationError";
    this.status = status;
  }
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function normalizeTargetUid(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UID_LENGTH ||
    value !== value.trim()
  ) {
    throw new StaffDeactivationError(
      400,
      "targetUid must be a bounded non-empty string",
    );
  }
  return value;
}

function normalizedGrants(value) {
  return Array.isArray(value) ? value : [];
}

function profileNeedsDeactivation(profile) {
  return (
    profile.active !== false ||
    Object.hasOwn(profile, "accessTier") ||
    (profile.role ?? null) !== null ||
    normalizedGrants(profile.grants).length > 0
  );
}

async function deactivateProfile({
  firestore,
  actor,
  targetUid,
  source,
  nowIso = new Date().toISOString(),
  offboardingId = randomUUID(),
}) {
  const actorRef = firestore.collection("users").doc(actor.uid);
  const targetRef = firestore.collection("users").doc(targetUid);
  const activeSuperAdmins = firestore
    .collection("users")
    .where(Filter.or(Filter.where("role", "==", "super_admin"), Filter.where("accessTier", "==", "owner")));

  return firestore.runTransaction(async (transaction) => {
    const [actorSnapshot, targetSnapshot, superAdminSnapshot, staffSnapshot] =
      await Promise.all([
        transaction.get(actorRef),
        transaction.get(targetRef),
        transaction.get(activeSuperAdmins),
        transaction.get(staffRecordRef(firestore, targetUid)),
      ]);

    const tiersActive = await accessTierReadsActive(firestore, transaction);
    if (
      !actorSnapshot.exists ||
      actorSnapshot.data().active === false ||
      administrativeRoleFromUserDoc(actorSnapshot.data(), tiersActive) !== "super_admin"
    ) {
      throw new ForbiddenError("Super admin access required");
    }
    if (!targetSnapshot.exists) {
      throw new StaffDeactivationError(404, "Target user not found");
    }

    const profile = targetSnapshot.data();
    const changed = profileNeedsDeactivation(profile);

    /**
     * The byline linkage row is part of the account state, so it goes inactive in
     * the same commit that removes CMS authority -- otherwise `cmsStaffRecords`
     * keeps saying "active" for a disabled account, and the person can never
     * correct it, because every self-service endpoint refuses a deactivated
     * account before it reaches the resync. Repair-first, like the store's own
     * resync: it runs even when the user document already needed no change, so a
     * half-failed earlier offboarding is finished rather than reported as done.
     */
    const linkageDeactivated = () =>
      deactivateStaffLinkage(transaction, firestore, {
        snapshot: staffSnapshot,
        uid: targetUid,
        nowIso,
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        source,
      });

    if (!changed) {
      await linkageDeactivated();
      transaction.update(targetRef, { offboarding: { id: offboardingId, step: "public_profile" } });
      return { alreadyInactive: true, offboardingId };
    }

    if (administrativeRoleFromUserDoc(profile, tiersActive) === "super_admin") {
      const otherActiveSuperAdmins = superAdminSnapshot.docs.filter(
        (snapshot) =>
          snapshot.id !== targetUid && administrativeRoleFromUserDoc(snapshot.data(), tiersActive) === "super_admin",
      );
      if (otherActiveSuperAdmins.length === 0) {
        throw new StaffDeactivationError(
          409,
          "Cannot remove the last active super admin",
        );
      }
    }

    const before = {
      active: profile.active !== false,
      role: profile.role ?? null,
      grants: normalizedGrants(profile.grants),
      ...(Object.hasOwn(profile, "accessTier") ? { accessTier: profile.accessTier } : {}),
    };
    const after = { active: false, role: null, grants: [] };
    await linkageDeactivated();
    transaction.update(targetRef, {
      ...after,
      offboarding: { id: offboardingId, step: "public_profile" },
      ...(Object.hasOwn(profile, "accessTier") ? { accessTier: FieldValue.delete() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      firestore.collection("admin_logs").doc(),
      adminLogEntry({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "staff.deactivate",
        target: targetUid,
        before,
        after,
        source,
      }),
    );
    return { alreadyInactive: false, offboardingId };
  });
}

// A delayed request cannot overwrite a newer offboarding or reactivation.
async function setOffboardingStep(firestore, uid, id, step) {
  const ref = firestore.collection("users").doc(uid);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const user = snapshot.data();
    if (!snapshot.exists || user.active !== false || user.offboarding?.id !== id) {
      throw new StaffDeactivationError(409, "This account changed during offboarding. Review its current status");
    }
    transaction.update(ref, { offboarding: { id, step } });
  });
}

function createDeactivateStaffHandler(deps = {}) {
  const {
    firestore = db,
    authClient = getAuth(),
    requireSuperAdminFn = requireSuperAdmin,
    deactivateProfileFn = deactivateProfile,
    withdrawAuthorProfileFn = withdrawProfileForDeactivation,
    now = () => FieldValue.serverTimestamp(),
    nowIso = () => new Date().toISOString(),
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const actor = await requireSuperAdminFn(req);
      const targetUid = normalizeTargetUid(req.body?.targetUid);
      if (targetUid === actor.uid) {
        throw new ForbiddenError("Cannot deactivate your own staff account");
      }

      const outcome = await deactivateProfileFn({
        firestore,
        actor,
        targetUid,
        source: getClientIp(req),
        nowIso: nowIso(),
      });

      // Removing CMS authority does not by itself take the person off the public
      // site, so the public author snapshot is withdrawn here, in the same
      // request. It runs after the Firestore authority change and before session
      // revocation: by this point users/{uid} is already inactive, so a publish
      // racing this withdrawal fails its own active-account check instead of
      // re-publishing the snapshot behind us. The authorId, the slug, and the
      // working profile all survive -- deactivation is a publishing decision, not
      // an erasure, and past bylines still have to resolve to one identity.
      let publicProfileWithdrawn = false;
      try {
        const withdrawal = await withdrawAuthorProfileFn({
          firestore,
          uid: targetUid,
          requireInactiveAccount: true,
          nowIso: nowIso(),
          actorUid: actor.uid,
          actorEmail: actor.email ?? null,
          source: getClientIp(req),
        });
        publicProfileWithdrawn = withdrawal.withdrawn === true;
      } catch (error) {
        // Fail loud and retryable rather than reporting a clean deactivation.
        // CMS access is already gone, but a public profile left standing is the
        // visible half of this operation, so the operator has to know to retry.
        log.error("deactivateStaff public profile withdrawal failed", error);
        res.status(503).json({
          error:
            "CMS access is disabled, but the public author profile must be withdrawn on retry",
          uid: targetUid,
          cmsAccessDisabled: true,
        });
        return;
      }

      await setOffboardingStep(firestore, targetUid, outcome.offboardingId, "sign_in_and_sessions");
      // Auth follows the stored account state. If an Owner reactivated the
      // account after this request's commit, that newer state wins.
      let authUserMissing = false;
      try {
        const signInAllowed = await syncStaffAuth({ firestore, authClient, uid: targetUid, now });
        if (signInAllowed) {
          res.status(409).json({ error: "This account was reactivated during offboarding", uid: targetUid });
          return;
        }
      } catch (error) {
        if (error?.code === "auth/user-not-found") {
          authUserMissing = true;
        } else {
          log.error("deactivateStaff session revocation failed", error);
          res.status(503).json({
            error: "CMS access is disabled, but session revocation must be retried",
            uid: targetUid,
            cmsAccessDisabled: true,
          });
          return;
        }
      }

      await setOffboardingStep(firestore, targetUid, outcome.offboardingId, "complete");
      res.status(200).json({
        success: true,
        uid: targetUid,
        alreadyInactive: outcome.alreadyInactive,
        authUserMissing,
        publicProfileWithdrawn,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        typeof error?.status === "number" ? error.status : 500;
      if (status >= 500) log.error("deactivateStaff failed", error);
      res.status(status).json({
        error:
          status < 500
            ? error.message
            : "Failed to deactivate staff account",
      });
    }
  };
}

const deactivateStaff = cmsOnRequest(
  { cors: ADMIN_ALLOWED_ORIGINS },
  createDeactivateStaffHandler(),
);

module.exports = {
  ADMIN_ALLOWED_ORIGINS,
  MAX_UID_LENGTH,
  StaffDeactivationError,
  createDeactivateStaffHandler,
  deactivateProfile,
  deactivateStaff,
  normalizeTargetUid,
  profileNeedsDeactivation,
  revocationSeconds,
};
