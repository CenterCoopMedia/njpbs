"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Filter } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requireSuperAdmin, ForbiddenError, AuthError } = require("./lib/auth");
const { adminLogEntry } = require("./lib/audit");
const { isAccessTier } = require("./lib/rbac");
const { accessTierReadsActive } = require("./lib/access-tier-activation");
const { accessStateFromUserDoc, administrativeRoleFromUserDoc, normalizeGrants } = require("./lib/principal");

class StaffAccessLevelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fail(status, message) {
  return new StaffAccessLevelError(status, message);
}

function safeFailureCode(error) {
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16) return error.code;
  return ["auth/internal-error", "auth/insufficient-permission", "auth/network-request-failed", "auth/invalid-credential", "auth/too-many-requests"]
    .includes(error?.code) ? error.code : "unknown";
}

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !["targetUid", "accessTier", "expectedAccess"].includes(key)) ||
      typeof body.targetUid !== "string" || body.targetUid.length < 1 || body.targetUid.length > 128 ||
      body.targetUid.trim() !== body.targetUid || body.targetUid.includes("/") ||
      !isAccessTier(body.accessTier) || typeof body.expectedAccess !== "string" ||
      body.expectedAccess.length < 1 || body.expectedAccess.length > 24_000) {
    throw fail(400, "Choose a staff member and level from the current directory");
  }
  return body;
}

async function replaceStaffAccess({ firestore, actor, targetUid, accessTier, expectedAccess, source }) {
  if (actor.emailVerified !== true) throw new ForbiddenError("A verified Owner account is required");
  if (targetUid === actor.uid) throw new ForbiddenError("You cannot change your own access level");

  return firestore.runTransaction(async (transaction) => {
    const targetRef = firestore.collection("users").doc(targetUid);
    const [actorSnapshot, targetSnapshot, tiersActive] = await Promise.all([
      transaction.get(firestore.collection("users").doc(actor.uid)),
      transaction.get(targetRef),
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
    if (target.active !== undefined && target.active !== true) throw fail(409, "This staff account is inactive");
    if (accessStateFromUserDoc(target) !== expectedAccess) {
      throw fail(409, "This person's access changed. Review their current row and try again");
    }

    // Include the complete Owner set in the read fence before writing. A concurrent
    // demotion or offboarding retries this transaction with the current authority.
    if (administrativeRoleFromUserDoc(target, true) === "super_admin" && accessTier !== "owner") {
      const owners = await transaction.get(firestore.collection("users").where(Filter.or(
        Filter.where("role", "==", "super_admin"), Filter.where("accessTier", "==", "owner"),
      )));
      if (!owners.docs.some((row) => row.id !== targetUid &&
          administrativeRoleFromUserDoc(row.data(), true) === "super_admin")) {
        throw fail(409, "You cannot remove the last Owner");
      }
    }
    if (target.accessTier === accessTier && target.role == null &&
        Array.isArray(target.grants) && target.grants.length === 0) return { changed: false };

    const before = { role: target.role ?? null, grants: normalizeGrants(target.grants),
      ...(Object.hasOwn(target, "accessTier") ? { accessTier: target.accessTier } : {}) };
    const after = { accessTier, role: null, grants: [] };
    transaction.update(targetRef, { ...after, updatedAt: FieldValue.serverTimestamp() });
    transaction.set(firestore.collection("admin_logs").doc(), adminLogEntry({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: "staff.level.replace",
      target: targetUid, before, after, source,
    }));
    return { changed: true };
  });
}

function createSetStaffAccessLevelHandler({
  firestore = db, authClient = getAuth(), requireSuperAdminFn = requireSuperAdmin,
  log = console,
} = {}) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requireSuperAdminFn(req);
      if (actor.emailVerified !== true) throw new ForbiddenError("A verified Owner account is required");
      const body = validateRequest(req.body);
      if (body.targetUid === actor.uid) throw new ForbiddenError("You cannot change your own access level");
      let targetIdentity;
      try { targetIdentity = await authClient.getUser(body.targetUid); }
      catch (error) {
        if (error?.code === "auth/user-not-found") throw fail(404, "Staff identity not found");
        throw error;
      }
      if (targetIdentity.disabled || targetIdentity.emailVerified !== true) {
        throw fail(409, "A verified, enabled staff identity is required");
      }
      const outcome = await replaceStaffAccess({ firestore, actor, ...body,
        source: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null });
      return res.status(200).json({ success: true, uid: body.targetUid, accessTier: body.accessTier, ...outcome });
    } catch (error) {
      const expected = error instanceof StaffAccessLevelError || error instanceof ForbiddenError || error instanceof AuthError;
      const status = expected ? error.status : 500;
      if (status >= 500) log.error("setStaffAccessLevel failed", { code: safeFailureCode(error) });
      return res.status(status).json({ error: status < 500 ? error.message : "Staff access could not be updated" });
    }
  };
}

const setStaffAccessLevel = cmsOnRequest({ cors: true }, createSetStaffAccessLevelHandler());
module.exports = { validateRequest, replaceStaffAccess, createSetStaffAccessLevelHandler, setStaffAccessLevel };
