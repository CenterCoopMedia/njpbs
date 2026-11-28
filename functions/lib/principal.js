"use strict";

// Server-side principal resolution (#529): the CommonJS counterpart of
// admin/src/lib/principal.ts. The two exist for the same reason as the rbac
// mirror -- Firebase uploads `functions/` as its own CommonJS bundle and cannot
// import the TypeScript module -- and admin/tests/principal-parity.test.ts pins
// them to each other.
//
// A user's access comes only from a valid `accessTier` on an active account, once the
// server-only activation receipt exists. A document without a tier, or with an invalid
// one, has no access. Stored `role` and `grants` fields confer nothing. Profile text
// carries no authority.

const { userDocUsesAccessTier } = require("./access-tier-activation");
const { isAccessTier, TIER_ROLES } = require("./rbac");
const ADMINISTRATIVE_ROLES = new Set(["admin", "super_admin"]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Resolve a principal from the trusted user document.
 *
 * @param {string} uid
 * @param {object|null|undefined} doc the stored users/{uid} document
 * @returns {{id: string, grants: Array<{role: string, tier: string}>}}
 */
function principalFromUserDoc(uid, doc, tiersActive = false) {
  const principal = { id: uid, grants: [] };
  if (!isPlainObject(doc)) return principal;
  // An inactive account keeps its identity and has no grant.
  if (tiersActive && isAccessTier(doc.accessTier) && (doc.active === undefined || doc.active === true)) {
    principal.grants.push({ role: TIER_ROLES[doc.accessTier], tier: doc.accessTier });
  }
  return principal;
}

/** The administrative role (admin or super_admin) the user's tier confers, or null. */
function administrativeRoleFromUserDoc(doc, tiersActive = false) {
  const principal = principalFromUserDoc("authorization", doc, tiersActive);
  return principal.grants.find((grant) => ADMINISTRATIVE_ROLES.has(grant.role))?.role ?? null;
}

function accessStateFromUserDoc(doc) {
  return JSON.stringify({
    tierPresent: Object.hasOwn(doc, "accessTier"),
    accessTier: typeof doc.accessTier === "string" ? doc.accessTier : null,
    active: doc.active !== false,
  });
}

async function principalFromStoredUserDoc(firestore, uid, doc, transaction) {
  return principalFromUserDoc(uid, doc, await userDocUsesAccessTier(firestore, doc, transaction));
}

async function administrativeRoleFromStoredUserDoc(firestore, doc, transaction) {
  return administrativeRoleFromUserDoc(doc, await userDocUsesAccessTier(firestore, doc, transaction));
}

// Tier grants are site-wide, so no section registry read is needed. Callers that
// pass a known tiersActive value skip the activation read.
async function registeredPrincipalFromUserDoc(firestore, uid, doc, transaction, tiersActive) {
  return tiersActive === undefined
    ? principalFromStoredUserDoc(firestore, uid, doc, transaction)
    : principalFromUserDoc(uid, doc, tiersActive);
}

module.exports = {
  principalFromUserDoc,
  administrativeRoleFromUserDoc,
  principalFromStoredUserDoc,
  administrativeRoleFromStoredUserDoc,
  accessStateFromUserDoc,
  registeredPrincipalFromUserDoc,
};
