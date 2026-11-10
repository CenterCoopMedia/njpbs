"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue: FirestoreFieldValue, Filter } = require("firebase-admin/firestore");
const { admin, db } = require("./lib/firebase");
const {
  requireAuth,
  isSuperAdmin,
  requireSuperAdmin,
  ForbiddenError,
} = require("./lib/auth");
const { adminLogEntry } = require("./lib/audit");
const {
  BOOTSTRAP_SUPER_ADMINS,
  exactEmailIsAllowed,
} = require("./lib/staff-admission");
const { unregisteredSections } = require("./lib/content-sections");
// Grant normalization is shared with the reader (#828): principalFromUserDoc in
// lib/principal.js trusts exactly what this module writes, so both sides must
// run the same implementation instead of two copies that could quietly drift.
const { accessTierReadsActive, userDocUsesAccessTier } = require("./lib/access-tier-activation");
const { normalizeGrants, administrativeRoleFromUserDoc, administrativeRoleFromStoredUserDoc } = require("./lib/principal");

const FieldValue = admin.firestore.FieldValue || FirestoreFieldValue;
const TOP_LEVEL_ROLES = Object.freeze(["super_admin", "admin"]);
const GRANT_ROLES = Object.freeze(["staff", "editor", "contributor"]);
const VALID_ROLES = new Set([...TOP_LEVEL_ROLES, ...GRANT_ROLES]);

function isTopLevelRole(role) {
  return TOP_LEVEL_ROLES.includes(role);
}

function isGrantRole(role) {
  return GRANT_ROLES.includes(role);
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function normalizeTargetIdentifier(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw httpError(400, `${fieldName} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw httpError(400, `${fieldName} must be a non-empty string`);
  }

  return trimmed;
}

function normalizeTargetIdentifiers({ targetUid, targetEmail }) {
  return {
    targetUid: normalizeTargetIdentifier(targetUid, "targetUid"),
    targetEmail: normalizeTargetIdentifier(targetEmail, "targetEmail"),
  };
}

async function resolveTarget(
  { targetUid, targetEmail },
  { verifyIdentityPair = false } = {},
) {
  ({ targetUid, targetEmail } = normalizeTargetIdentifiers({
    targetUid,
    targetEmail,
  }));

  // The roster setup shortcut supplies both identifiers: the roster uid proves a CMS
  // profile completed sign-in, while the email lets this boundary verify that exact uid
  // still names the same Firebase Auth identity. Resolving only one side would either
  // grant an orphaned profile (uid only) or select a recreated, unadmitted account (email
  // only). Other role-management calls keep their existing single-identifier behavior.
  if (verifyIdentityPair && targetUid && targetEmail) {
    try {
      const authUser = await getAuth().getUser(targetUid);
      const authEmail = authUser.email?.trim().toLowerCase();
      if (authEmail !== targetEmail.toLowerCase()) {
        throw httpError(409, "Target staff identity no longer matches");
      }
      if (authUser.emailVerified === false || authUser.disabled === true) return null;
      return { uid: targetUid, authUser };
    } catch (err) {
      if (err.code === "auth/user-not-found") return null;
      throw err;
    }
  }
  if (targetUid) return { uid: targetUid, authUser: null };
  if (targetEmail) {
    try {
      const authUser = await getAuth().getUserByEmail(targetEmail);
      return { uid: authUser.uid, authUser };
    } catch (err) {
      if (err.code === "auth/user-not-found") return null;
      throw err;
    }
  }
  return null;
}

function hasValidSections(sections) {
  return (
    Array.isArray(sections) &&
    sections.length > 0 &&
    sections.every(
      (section) => typeof section === "string" && section.trim().length > 0,
    )
  );
}

function normalizeSections(sections) {
  return sections.map((section) => section.trim());
}

function hasNonEmptySections(sections) {
  return Array.isArray(sections) && sections.length > 0;
}

// Top-level roles are always unscoped. Only an absent field, an explicit null, or
// an empty array counts as "no scope"; any other present value (a string, an
// object, a non-empty array) is a malformed scoped payload and must be rejected
// rather than silently widened into a global grant.
function isUnscopedSections(sections) {
  return (
    sections === undefined ||
    sections === null ||
    (Array.isArray(sections) && sections.length === 0)
  );
}

function validateGrantRequest(
  { role, sections, hasSections, siteWide, hasSiteWide },
  res,
) {
  if (!VALID_ROLES.has(role)) {
    res.status(400).json({ error: "Invalid role" });
    return null;
  }

  if (isTopLevelRole(role)) {
    if (hasSiteWide || !isUnscopedSections(sections)) {
      res.status(400).json({
        error: "Top-level roles do not take sections or siteWide",
      });
      return null;
    }

    return [];
  }

  if (hasSiteWide && typeof siteWide !== "boolean") {
    res.status(400).json({ error: "siteWide must be a boolean" });
    return null;
  }

  if (isGrantRole(role)) {
    // A site-wide grant has maximum scope, so it must be explicit instead of the
    // accidental result of a missing sections field. Revoke keeps omission-as-full
    // because a too-wide revoke fails closed; a too-wide grant fails open.
    if (siteWide === true) {
      if (hasSections) {
        res.status(400).json({
          error: "siteWide grants must omit sections",
        });
        return null;
      }

      return undefined;
    }

    if (role === "staff") {
      res.status(400).json({
        error: "Staff guide access must use siteWide: true",
      });
      return null;
    }

    if (!hasValidSections(sections)) {
      res.status(400).json({
        error:
          "Editor and contributor grants require a non-empty sections array or siteWide: true",
      });
      return null;
    }
    return normalizeSections(sections);
  }

  // Unreachable while VALID_ROLES is the union of top-level and grant roles,
  // but falling through must never return undefined: that value means
  // site-wide grant intent, the widest possible scope.
  res.status(400).json({ error: "Invalid role" });
  return null;
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

// Error carrying an HTTP status so a throw inside a transaction maps to the right
// response code in the handler catch block.
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bootstrapTargetMatchesCaller(caller, { targetUid, targetEmail }) {
  if (targetUid && targetUid !== caller.uid) return false;
  if (
    targetEmail &&
    (!caller.email ||
      targetEmail.trim().toLowerCase() !== caller.email.trim().toLowerCase())
  ) {
    return false;
  }
  return true;
}

// Reads the bootstrap allowlist param. An unconfigured param (a fresh preview or
// dev project) must fail closed to an empty list, not throw a 500, so bootstrap can
// still deny cleanly and explain nothing was configured.
function bootstrapAllowlist() {
  try {
    const value = BOOTSTRAP_SUPER_ADMINS.value();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function bootstrapEmailAllowed(email) {
  return exactEmailIsAllowed(email, bootstrapAllowlist());
}

async function bootstrapSuperAdmin(caller, source) {
  const bootstrapRef = db.collection("system").doc("bootstrap");
  const userRef = db.collection("users").doc(caller.uid);
  const auditRef = db.collection("admin_logs").doc();
  const existingSuperAdminQuery = db
    .collection("users")
    .where(Filter.or(Filter.where("role", "==", "super_admin"), Filter.where("accessTier", "==", "owner")));

  await db.runTransaction(async (transaction) => {
    const [bootstrapSnapshot, userSnapshot, existingSuperAdmins] =
      await Promise.all([
        transaction.get(bootstrapRef),
        transaction.get(userRef),
        transaction.get(existingSuperAdminQuery),
      ]);

    if (
      bootstrapSnapshot.exists &&
      bootstrapSnapshot.data().completed === true
    ) {
      throw new ForbiddenError("Bootstrap already completed");
    }

    // Defense in depth: even if the sentinel doc is missing (a restore or manual
    // seed), never mint a second super admin. Bootstrap is only for the very first.
    const tiersActive = await accessTierReadsActive(db, transaction);
    if (existingSuperAdmins.docs.some((doc) => {
      const profile = doc.data();
      return tiersActive && Object.hasOwn(profile, "accessTier")
        ? profile.accessTier === "owner" : profile.role === "super_admin";
    })) {
      throw new ForbiddenError("Bootstrap unavailable: a super admin already exists");
    }

    // The bootstrap caller may already hold a seeded role (for example admin), so
    // record the real prior value rather than assuming null.
    const priorRole = userSnapshot.exists
      ? userSnapshot.data().role ?? null
      : null;

    if (userSnapshot.exists && userSnapshot.data().active === false) {
      throw new ForbiddenError("Staff account is inactive");
    }

    const userUpdate = {
      email: caller.email,
      active: true,
      role: "super_admin",
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (!userSnapshot.exists) {
      userUpdate.displayName = null;
      userUpdate.tokensValidAfter = 0;
      userUpdate.grants = [];
      userUpdate.createdAt = FieldValue.serverTimestamp();
    }

    transaction.set(userRef, userUpdate, { merge: true });
    transaction.set(bootstrapRef, {
      completed: true,
      uid: caller.uid,
      email: caller.email,
      at: FieldValue.serverTimestamp(),
    });
    transaction.set(
      auditRef,
      adminLogEntry({
        actorUid: caller.uid,
        actorEmail: caller.email,
        action: "roles.bootstrap",
        target: caller.uid,
        before: { role: priorRole },
        after: { role: "super_admin" },
        source,
      }),
    );
  });
}

// Reads the super_admin set inside a transaction and refuses the change if the
// target is the only super admin, so the system never drops to zero. The query
// read joins the transaction's read set, so a concurrent demotion of the actor
// forces a retry that then sees the reduced set and rejects. Must be called before
// any write in the transaction.
async function ensureAnotherSuperAdminRemains(transaction, targetUid) {
  const snapshot = await transaction.get(
    db.collection("users").where(Filter.or(Filter.where("role", "==", "super_admin"), Filter.where("accessTier", "==", "owner"))),
  );
  const tiersActive = await accessTierReadsActive(db, transaction);
  const others = snapshot.docs.filter(
    (doc) => doc.id !== targetUid && administrativeRoleFromUserDoc(doc.data(), tiersActive) === "super_admin",
  );
  if (others.length === 0) {
    throw httpError(409, "Cannot remove the last super admin");
  }
}

function nextGrantsWithRole(existingGrants, role, sections) {
  const nextGrants = [];
  let found = false;

  for (const grant of existingGrants) {
    if (grant.role !== role) {
      nextGrants.push(grant);
      continue;
    }

    found = true;
    if (sections === undefined) {
      nextGrants.push({ role });
      continue;
    }

    if (grant.sections === undefined) {
      nextGrants.push(grant);
      continue;
    }

    const mergedSections = [...(Array.isArray(grant.sections) ? grant.sections : [])];
    for (const section of sections) {
      if (!mergedSections.includes(section)) mergedSections.push(section);
    }
    nextGrants.push({ role, sections: mergedSections });
  }

  if (!found) {
    if (sections === undefined) {
      nextGrants.push({ role });
    } else {
      nextGrants.push({ role, sections });
    }
  }

  return nextGrants;
}

function nextGrantsWithoutRole(existingGrants, role, sections) {
  if (!hasNonEmptySections(sections)) {
    return existingGrants.filter((grant) => grant.role !== role);
  }

  const removeSections = new Set(normalizeSections(sections));
  const nextGrants = [];

  for (const grant of existingGrants) {
    if (grant.role !== role) {
      nextGrants.push(grant);
      continue;
    }

    if (grant.sections === undefined) {
      throw httpError(
        400,
        "Site-wide grant cannot be section-revoked; revoke the full grant instead",
      );
    }

    const remainingSections = (Array.isArray(grant.sections)
      ? grant.sections
      : []
    ).filter((section) => !removeSections.has(section));

    if (remainingSections.length > 0) {
      nextGrants.push({ role, sections: remainingSections });
    }
  }

  return nextGrants;
}

async function grantRoleHandler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendError(res, 405, "Method not allowed");
    }

    const caller = await requireAuth(req);
    const body = req.body || {};
    const { targetUid, targetEmail, role, sections, siteWide } = body;
    const validSections = validateGrantRequest(
      {
        role,
        sections,
        hasSections: Object.hasOwn(body, "sections"),
        siteWide,
        hasSiteWide: Object.hasOwn(body, "siteWide"),
      },
      res,
    );
    if (validSections === null) return null;
    // A grant may only name desks in the runtime section registry (#619). Without this a
    // typo becomes a scope that matches no content and silently grants nothing, which
    // reads in the admin UI as a working grant. Revoke deliberately skips the check: a
    // revoke of an unregistered name must still be able to clean up a stale grant.
    if (Array.isArray(validSections) && validSections.length > 0) {
      const unknown = await unregisteredSections(db, validSections);
      if (unknown.length > 0) {
        return sendError(res, 400, `Unknown section: ${unknown.join(", ")}`);
      }
    }
    const target = normalizeTargetIdentifiers({ targetUid, targetEmail });

    const callerIsSuper = await isSuperAdmin(caller.uid, caller.emailVerified, caller.authTime);
    const source = getClientIp(req);

    if (!callerIsSuper) {
      if (
        role !== "super_admin" ||
        !bootstrapTargetMatchesCaller(caller, target)
      ) {
        throw new ForbiddenError("Super admin access required");
      }

      if (!bootstrapEmailAllowed(caller.email)) {
        throw new ForbiddenError("Super admin access required");
      }

      // The allowlist keys on an email address, so the caller must own a verified
      // one. Without this an unverified self-service account on an allowlisted
      // address could claim the one-time super admin role.
      if (!caller.emailVerified) {
        throw new ForbiddenError("Bootstrap requires a verified email");
      }

      await bootstrapSuperAdmin(caller, source);
      return res
        .status(200)
        .json({ success: true, bootstrapped: true, uid: caller.uid });
    }

    if (!target.targetUid && !target.targetEmail) {
      return sendError(res, 400, "Target user required");
    }
    // Both identifiers mark the setup shortcut. It is allowed to turn only the
    // privilege-free profile created by first sign-in into an admin. The transaction
    // re-checks that precondition so a role/grant added after the roster confirmation
    // cannot be overwritten or silently widened.
    const requirePrivilegeFreeTarget = Boolean(
      target.targetUid && target.targetEmail,
    );

    const resolvedTarget = await resolveTarget(target, {
      // Only the roster setup grant sends both identifiers. Revocation must retain its
      // uid-first cleanup path for an orphaned or disabled Auth identity.
      verifyIdentityPair: true,
    });
    if (!resolvedTarget) {
      return sendError(res, 404, "Target user not found");
    }
    const resolvedTargetUid = resolvedTarget.uid;

    // A super admin cannot change their own top-level role through grantRole: a
    // self-demotion (super_admin -> admin) would slip past the self-revoke guard and
    // could lock out all role administration. Section grants to self are harmless.
    if (isTopLevelRole(role) && resolvedTargetUid === caller.uid) {
      throw new ForbiddenError("Cannot change your own top-level role");
    }

    const userRef = db.collection("users").doc(resolvedTargetUid);

    // Read-modify-write inside a transaction so two concurrent grants to the same
    // user cannot clobber each other's grants; the user update and its audit row
    // commit atomically.
    const callerRef = db.collection("users").doc(caller.uid);
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, callerSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(callerRef),
      ]);

      // Re-verify the actor inside the transaction: a revocation that lands after
      // the pre-transaction check must not let a stale caller complete a grant.
      if (
        !callerSnapshot.exists ||
        callerSnapshot.data().active === false ||
        await administrativeRoleFromStoredUserDoc(db, callerSnapshot.data(), transaction) !== "super_admin"
      ) {
        throw new ForbiddenError("Super admin access required");
      }

      const provisioning = !userSnapshot.exists;
      // Addressing a profile by uid is an existing-profile operation. Even when a paired
      // email supplied a verified Auth user, recreating a profile here would bypass the
      // admitted first-sign-in step the uid is meant to prove.
      if (provisioning && target.targetUid) {
        throw httpError(404, "Target user not found");
      }
      if (
        provisioning &&
        (!resolvedTarget.authUser ||
          resolvedTarget.authUser.emailVerified === false)
      ) {
        throw httpError(404, "Target user not found");
      }

      const existing = userSnapshot.exists
        ? userSnapshot.data()
        : { role: null, grants: [] };
      if (await userDocUsesAccessTier(db, existing, transaction)) {
        throw httpError(409, "Use the staff level control to replace this person's access");
      }
      if (userSnapshot.exists && existing.active === false) {
        throw httpError(409, "Target staff account is inactive");
      }
      if (requirePrivilegeFreeTarget) {
        const hasPersistedRole =
          existing.role !== null && existing.role !== undefined;
        const hasPersistedGrants = Array.isArray(existing.grants)
          ? existing.grants.length > 0
          : existing.grants !== null && existing.grants !== undefined;
        if (hasPersistedRole || hasPersistedGrants) {
          throw httpError(
            409,
            "Target staff access changed; review it in the staff table",
          );
        }
      }
      let before;
      let after;
      let update;

      if (isTopLevelRole(role)) {
        // Demoting a super admin (super_admin -> admin) must not remove the last
        // one, including under a concurrent cross-demotion of two super admins.
        if (role !== "super_admin" && existing.role === "super_admin") {
          await ensureAnotherSuperAdminRemains(transaction, resolvedTargetUid);
        }
        before = { role: existing.role ?? null };
        after = { role };
        update = { role, updatedAt: FieldValue.serverTimestamp() };
      } else {
        const existingGrants = normalizeGrants(existing.grants);
        const nextGrants = nextGrantsWithRole(
          existingGrants,
          role,
          validSections,
        );
        before = { grants: existingGrants };
        after = { grants: nextGrants };
        update = { grants: nextGrants, updatedAt: FieldValue.serverTimestamp() };
      }

      if (provisioning) {
        transaction.set(userRef, {
          email: resolvedTarget.authUser.email,
          displayName: resolvedTarget.authUser.displayName ?? null,
          active: true,
          tokensValidAfter: 0,
          role: null,
          grants: [],
          createdAt: FieldValue.serverTimestamp(),
          ...update,
        });
        before = null;
      } else {
        transaction.update(userRef, update);
      }
      transaction.set(
        db.collection("admin_logs").doc(),
        adminLogEntry({
          actorUid: caller.uid,
          actorEmail: caller.email,
          action: provisioning ? "roles.provision" : "roles.grant",
          target: resolvedTargetUid,
          before,
          after,
          source,
        }),
      );
    });

    return res.status(200).json({ success: true, uid: resolvedTargetUid });
  } catch (err) {
    if (res.headersSent) return null;
    console.error("grantRole failed", err);
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to grant role" });
  }
}

async function revokeRoleHandler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendError(res, 405, "Method not allowed");
    }

    const superAdmin = await requireSuperAdmin(req);
    const { targetUid, targetEmail, role, sections } = req.body || {};

    if (!VALID_ROLES.has(role)) {
      return sendError(res, 400, "Invalid role");
    }

    // A section filter, when present, must be a valid non-empty string array.
    // Otherwise a malformed payload (for example sections: "news" from a form
    // serializer, or a null from an unset picker) would fall through to a full
    // grant removal instead of a section-specific one. Omit the sections field
    // entirely (undefined) to revoke the whole grant.
    if (
      isGrantRole(role) &&
      sections !== undefined &&
      !hasValidSections(sections)
    ) {
      return sendError(
        res,
        400,
        "Section filter must be a non-empty array of section names",
      );
    }

    // Top-level roles are unscoped, so a scoped revoke payload is malformed.
    if (isTopLevelRole(role) && !isUnscopedSections(sections)) {
      return sendError(res, 400, "Top-level roles do not take sections");
    }

    const target = normalizeTargetIdentifiers({ targetUid, targetEmail });

    if (!target.targetUid && !target.targetEmail) {
      return sendError(res, 400, "Target user required");
    }

    const resolvedTarget = await resolveTarget(target);
    if (!resolvedTarget) {
      return sendError(res, 404, "Target user not found");
    }
    const resolvedTargetUid = resolvedTarget.uid;

    if (resolvedTargetUid === superAdmin.uid) {
      throw new ForbiddenError("Cannot revoke your own role");
    }

    const userRef = db.collection("users").doc(resolvedTargetUid);
    const source = getClientIp(req);

    // Read-modify-write inside a transaction so concurrent revokes cannot lose
    // grants; the user update and its audit row commit atomically.
    const callerRef = db.collection("users").doc(superAdmin.uid);
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, callerSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(callerRef),
      ]);

      // Re-verify the actor inside the transaction: a revocation that lands after
      // the pre-transaction check must not let a stale caller complete a revoke.
      if (
        !callerSnapshot.exists ||
        callerSnapshot.data().active === false ||
        await administrativeRoleFromStoredUserDoc(db, callerSnapshot.data(), transaction) !== "super_admin"
      ) {
        throw new ForbiddenError("Super admin access required");
      }

      if (!userSnapshot.exists) {
        throw httpError(404, "Target user not found");
      }

      const existing = userSnapshot.data();
      if (await userDocUsesAccessTier(db, existing, transaction)) {
        throw httpError(409, "Use the staff level control to replace this person's access");
      }
      let before;
      let after;
      let update;

      if (isTopLevelRole(role)) {
        // Only clear the field when the target actually holds the named top-level
        // role, so revoking "admin" can never strip a "super_admin".
        if ((existing.role ?? null) !== role) {
          throw httpError(
            409,
            "Target does not hold the specified top-level role",
          );
        }
        // Removing a super admin must not drop the system to zero, including under
        // a concurrent cross-revocation of two super admins.
        if (role === "super_admin") {
          await ensureAnotherSuperAdminRemains(transaction, resolvedTargetUid);
        }
        before = { role: existing.role ?? null };
        after = { role: null };
        update = { role: null, updatedAt: FieldValue.serverTimestamp() };
      } else {
        const existingGrants = normalizeGrants(existing.grants);
        const nextGrants = nextGrantsWithoutRole(existingGrants, role, sections);
        before = { grants: existingGrants };
        after = { grants: nextGrants };
        update = { grants: nextGrants, updatedAt: FieldValue.serverTimestamp() };
      }

      transaction.update(userRef, update);
      transaction.set(
        db.collection("admin_logs").doc(),
        adminLogEntry({
          actorUid: superAdmin.uid,
          actorEmail: superAdmin.email,
          action: "roles.revoke",
          target: resolvedTargetUid,
          before,
          after,
          source,
        }),
      );
    });

    return res.status(200).json({ success: true, uid: resolvedTargetUid });
  } catch (err) {
    if (res.headersSent) return null;
    console.error("revokeRole failed", err);
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to revoke role" });
  }
}

const grantRole = cmsOnRequest({ cors: true }, grantRoleHandler);
const revokeRole = cmsOnRequest({ cors: true }, revokeRoleHandler);

module.exports = { grantRole, revokeRole };
