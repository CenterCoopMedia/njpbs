"use strict";

// Server-side principal resolution (#529): the CommonJS counterpart of
// admin/src/lib/principal.ts. The two exist for the same reason as the rbac
// mirror -- Firebase uploads `functions/` as its own CommonJS bundle and cannot
// import the TypeScript module -- and admin/tests/principal-parity.test.ts pins
// them to each other.
//
// One deliberate divergence, asserted in that parity test: this copy drops every
// grant from a deactivated account. The browser copy has no such rule because it
// only decides which controls to draw, and the account it reads is the signed-in
// user's own. This copy decides real access, so it matches isAdmin, which has
// always refused `active === false`.
//
// After server-only activation, a present accessTier is authoritative and must be valid and active. Documents
// without it keep their legacy role and grants. Profile text carries no authority.

// Top-level roles live in `role` and are always unscoped; editor and contributor
// live in `grants` with their section scope. That is the shape roles.js writes.
//
// Three rules keep this from widening authority by accident:
//   - `role` admits only the top-level tiers. A stored `role: "editor"` is not a
//     grant, so it confers nothing, matching isAdmin and cmsAssignContent.
//   - `grants` never admits those top-level tiers. A malformed or migrated grant
//     entry cannot turn section-scoped storage into admin authority.
//   - A present `sections` value that is not an array becomes an empty scope, and
//     only an absent field means an intentional site-wide grant. A malformed
//     scope has to stay scoped-to-nothing: widening it into site-wide authority
//     is the one mistake this function must never make.
const { userDocUsesAccessTier } = require("./access-tier-activation");
const TOP_LEVEL_ROLES = new Set(["admin", "super_admin"]);
const { isAccessTier, TIER_ROLES } = require("./rbac");

function normalizeGrantSections(sections) {
  if (sections === undefined) return undefined;
  return Array.isArray(sections)
    ? sections.filter((section) => typeof section === "string")
    : [];
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizeGrants(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (grant) =>
        isPlainObject(grant) &&
        typeof grant.role === "string" &&
        !TOP_LEVEL_ROLES.has(grant.role),
    )
    .map((grant) => {
      const normalized = { role: grant.role };
      const sections = normalizeGrantSections(grant.sections);
      if (sections !== undefined) normalized.sections = sections;
      return normalized;
    });
}

/**
 * Resolve a principal from the trusted user document.
 *
 * @param {string} uid
 * @param {object|null|undefined} doc the stored users/{uid} document
 * @returns {{id: string, grants: Array<{role: string, sections?: string[]}>}}
 */
function principalFromUserDoc(uid, doc, tiersActive = false) {
  const principal = { id: uid, grants: [] };
  if (!isPlainObject(doc)) return principal;
  // An inactive account keeps its identity and loses every grant, so a
  // deactivated editor is denied by the same capability check as everyone else.
  if (doc.active === false) return principal;

  if (tiersActive && Object.hasOwn(doc, "accessTier")) {
    if ((doc.active === undefined || doc.active === true) && isAccessTier(doc.accessTier)) {
      principal.grants.push({ role: TIER_ROLES[doc.accessTier], tier: doc.accessTier });
    }
    return principal;
  }

  if (TOP_LEVEL_ROLES.has(doc.role)) {
    principal.grants.push({ role: doc.role });
  }
  principal.grants.push(...normalizeGrants(doc.grants));

  return principal;
}

/** Privileged readers must honor the authoritative tier before legacy role data. */
function administrativeRoleFromUserDoc(doc, tiersActive = false) {
  const principal = principalFromUserDoc("authorization", doc, tiersActive);
  return principal.grants.find((grant) => TOP_LEVEL_ROLES.has(grant.role))?.role ?? null;
}

function accessStateFromUserDoc(doc) {
  return JSON.stringify({
    tierPresent: Object.hasOwn(doc, "accessTier"),
    accessTier: typeof doc.accessTier === "string" ? doc.accessTier : null,
    role: typeof doc.role === "string" ? doc.role : null,
    grants: normalizeGrants(doc.grants),
    active: doc.active !== false,
  });
}

async function principalFromStoredUserDoc(firestore, uid, doc, transaction) {
  return principalFromUserDoc(uid, doc, await userDocUsesAccessTier(firestore, doc, transaction));
}

async function administrativeRoleFromStoredUserDoc(firestore, doc, transaction) {
  return administrativeRoleFromUserDoc(doc, await userDocUsesAccessTier(firestore, doc, transaction));
}

// Media admission uses the same registry as section validation on saves and
// role grants. Read it afresh for scoped actors; site-wide grants need no query.
// Write owners can include the registry read in their transaction.
async function registeredPrincipalFromUserDoc(firestore, uid, doc, transaction, tiersActive) {
  const principal = tiersActive === undefined
    ? await principalFromStoredUserDoc(firestore, uid, doc, transaction)
    : principalFromUserDoc(uid, doc, tiersActive);
  if (!principal.grants.some((grant) => Array.isArray(grant.sections) && grant.sections.length > 0)) {
    return principal;
  }
  const { readRegisteredSectionIds } = require("./content-sections");
  const { withRegisteredMediaSections } = require("./rbac");
  const registered = await readRegisteredSectionIds(firestore, transaction);
  return withRegisteredMediaSections(principal, registered);
}

// The resolver is exported to match admin/src/lib/principal.ts's surface. The
// normalizer helpers are also exported (#828) so functions/roles.js, the write
// side, requires this exact implementation instead of carrying its own copy --
// the failure mode a byte-for-byte duplicate invites is silent drift between
// what gets written and what gets trusted on read.
module.exports = {
  principalFromUserDoc,
  administrativeRoleFromUserDoc,
  principalFromStoredUserDoc,
  administrativeRoleFromStoredUserDoc,
  accessStateFromUserDoc,
  registeredPrincipalFromUserDoc,
  isPlainObject,
  normalizeGrantSections,
  normalizeGrants,
};
