"use strict";

// Deployment-safe CommonJS mirror of the capability decision core in
// packages/content-core/src/rbac.ts. Firebase uploads `functions/` as its own
// CommonJS source bundle, so the write-path boundaries cannot import that
// TypeScript module directly. The parity test in site/tests/rbac-parity.test.ts
// pins the tables and every decision result to the canonical implementation.
//
// Same one rule as the canonical module: authorization asks "does this principal
// hold capability X on this resource," never "is the role string 'editor'." Every
// decision is deny-by-default. This module reads no database and verifies no
// token; the caller resolves a principal server-side (lib/auth.js
// requirePrincipal) from the trusted user document and live section registry.

const ALL_CAPABILITIES = Object.freeze([
  "guide.view",
  "content.view",
  "content.create",
  "content.edit.own",
  "content.edit.any",
  "content.publish",
  "content.unpublish",
  "content.delete",
  "datasets.approve",
  "media.audio.read",
  "media.image.read",
  "media.video.read",
  "media.upload",
  "media.manage",
  "media.video.manage",
  "submissions.review",
  "reports.view",
  "schedule.manage",
  "members.view",
  "settings.manage",
  "analytics.view",
  "profiles.manage",
  "users.view",
  "users.manage",
  "audit.view",
  "roles.grant",
]);

const ROLE_CAPABILITIES = Object.freeze({
  staff: Object.freeze(["guide.view", "media.audio.read", "media.video.read", "reports.view"]),
  contributor: Object.freeze([
    "guide.view",
    "content.create",
    "content.edit.own",
    "media.audio.read",
    "media.video.read",
    "reports.view",
  ]),
  editor: Object.freeze([
    "guide.view",
    "content.create",
    "content.edit.own",
    "content.edit.any",
    "content.publish",
    "datasets.approve",
    "content.unpublish",
    "media.audio.read",
    "media.video.read",
    "media.upload",
    "media.manage",
    "media.video.manage",
    "submissions.review",
    "reports.view",
  ]),
  admin: Object.freeze([
    "guide.view",
    "content.create",
    "content.edit.own",
    "content.edit.any",
    "content.publish",
    "datasets.approve",
    "content.unpublish",
    "content.delete",
    "media.audio.read",
    "media.video.read",
    "media.upload",
    "media.manage",
    "media.video.manage",
    "submissions.review",
    "reports.view",
    "schedule.manage",
    "members.view",
    "settings.manage",
    "analytics.view",
    "profiles.manage",
    "users.view",
    "users.manage",
    "audit.view",
  ]),
  super_admin: Object.freeze([...ALL_CAPABILITIES]),
});

const ACCESS_TIERS = Object.freeze(["viewer", "contributor", "editor", "publisher", "admin", "owner"]);
const VIEWER_CAPABILITIES = Object.freeze([
  "guide.view", "content.view", "media.image.read", "media.audio.read", "media.video.read", "reports.view",
]);
const CONTRIBUTOR_CAPABILITIES = Object.freeze([
  ...VIEWER_CAPABILITIES, "content.create", "content.edit.own", "media.upload", "media.manage", "media.video.manage",
]);
const EDITOR_CAPABILITIES = Object.freeze([
  ...CONTRIBUTOR_CAPABILITIES, "content.edit.any", "submissions.review",
]);
const PUBLISHER_CAPABILITIES = Object.freeze([
  ...EDITOR_CAPABILITIES, "content.publish", "content.unpublish", "content.delete", "datasets.approve",
]);
const TIER_CAPABILITIES = Object.freeze({
  viewer: VIEWER_CAPABILITIES,
  contributor: CONTRIBUTOR_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  publisher: PUBLISHER_CAPABILITIES,
  admin: Object.freeze([...PUBLISHER_CAPABILITIES, "schedule.manage", "members.view", "settings.manage", "analytics.view",
    "profiles.manage", "users.view", "users.manage", "audit.view"]),
  owner: Object.freeze([...ALL_CAPABILITIES]),
});
const TIER_ROLES = Object.freeze({
  viewer: "staff", contributor: "contributor", editor: "editor", publisher: "editor", admin: "admin", owner: "super_admin",
});

function isAccessTier(value) {
  return typeof value === "string" && Object.hasOwn(TIER_CAPABILITIES, value);
}

function capabilitiesForGrant(grant) {
  if (grant?.tier !== undefined) {
    return isAccessTier(grant.tier) && grant.sections === undefined ? TIER_CAPABILITIES[grant.tier] : [];
  }
  return capabilitiesForRole(grant?.role);
}

// Section-scopable vs global, mirroring CAPABILITY_SCOPES. The canonical module
// gets a compile error when a capability is added without a scope; a plain object
// cannot, so the parity test pins the split through decision results instead.
const CAPABILITY_SCOPES = Object.freeze({
  "guide.view": "section",
  "content.view": "global",
  "content.create": "section",
  "content.edit.own": "section",
  "content.edit.any": "section",
  "content.publish": "section",
  "content.unpublish": "section",
  "content.delete": "section",
  "datasets.approve": "global",
  "media.audio.read": "global",
  "media.image.read": "global",
  "media.video.read": "global",
  "media.video.manage": "global",
  "reports.view": "section",
  "analytics.view": "global",
  "profiles.manage": "global",
  "submissions.review": "global",
  "media.upload": "global",
  "media.manage": "global",
  "schedule.manage": "section",
  "members.view": "global",
  "settings.manage": "global",
  "users.view": "global",
  "users.manage": "global",
  "audit.view": "global",
  "roles.grant": "global",
});

// Media is site-wide even when supplied by a valid area grant. This exception
// affects media only; site administration still requires an unscoped grant.
const SITE_WIDE_MEDIA_CAPABILITIES = new Set([
  "media.audio.read",
  "media.video.read",
  "media.video.manage",
  "media.upload",
  "media.manage",
]);

const SECTION_SCOPED_CAPABILITIES = new Set(
  Object.keys(CAPABILITY_SCOPES).filter(
    (capability) => CAPABILITY_SCOPES[capability] === "section",
  ),
);

// Own-property guard: a persisted or migrated document could carry a role string
// that names an inherited Object member (constructor, toString, __proto__).
// Deny by default -- an unknown role resolves to no capabilities.
function capabilitiesForRole(role) {
  return Object.hasOwn(ROLE_CAPABILITIES, role) ? ROLE_CAPABILITIES[role] : [];
}

// Resolve media scopes against the live registry before capability decisions.
// Keep content scopes intact; an empty media intersection confers no media
// authority. Stored grants remain available for explicit revocation.
function withRegisteredMediaSections(principal, registeredSections) {
  return {
    ...principal,
    grants: (principal?.grants ?? []).map((grant) => grant.sections === undefined
      ? grant
      : {
          ...grant,
          registeredMediaSections: Array.isArray(grant.sections)
            ? grant.sections.filter((section) => typeof section === "string" &&
              section.trim() !== "" && section.trim() === section &&
              registeredSections.has(section))
            : [],
        }),
  };
}

// Whether a single grant can confer a capability at all, ignoring the resource.
// Only an omitted sections field means an intentional site-wide grant; a present
// value that is null, a non-array, or empty confers nothing rather than widening
// into site-wide authority. A scoped grant confers section-scopable powers and
// site-wide media; administrative global capabilities still require an unscoped grant.
function grantHoldsAtCapabilityLevel(grant, capability) {
  if (!capabilitiesForGrant(grant).includes(capability)) return false;
  if (grant.sections === undefined) return true;
  if (!Array.isArray(grant.sections) || grant.sections.length === 0 ||
      !grant.sections.every((section) => typeof section === "string" &&
        section.trim() !== "" && section.trim() === section)) return false;
  if (SITE_WIDE_MEDIA_CAPABILITIES.has(capability) &&
      (!Array.isArray(grant.registeredMediaSections) || grant.registeredMediaSections.length === 0)) return false;
  return SECTION_SCOPED_CAPABILITIES.has(capability) || SITE_WIDE_MEDIA_CAPABILITIES.has(capability);
}

// Coarse membership: could any grant ever confer the capability, ignoring the
// specific resource? Honors scope but not ownership. Use it for UI gating; use
// can() for a real access decision.
function hasCapability(principal, capability) {
  const grants = principal?.grants ?? [];
  return grants.some((grant) => grantHoldsAtCapabilityLevel(grant, capability));
}

// Tests explicit unscoped membership for boundaries such as public submissions.
// Operationally site-wide media can also be conferred by a valid area grant.
function hasGlobalCapability(principal, capability) {
  return (principal?.grants ?? []).some((grant) =>
    grant?.sections === undefined &&
    capabilitiesForGrant(grant).includes(capability));
}

function grantAllows(principal, grant, capability, resource) {
  if (!grantHoldsAtCapabilityLevel(grant, capability)) return false;
  if (SITE_WIDE_MEDIA_CAPABILITIES.has(capability)) return true;

  if (capability === "content.edit.own") {
    // Ownership is required. A scoped grant then also confines it to the grant's
    // sections below -- ownership does not punch through the scope.
    if (!resource || resource.ownerId == null || principal.id == null) return false;
    if (resource.ownerId !== principal.id) return false;
  }

  if (grant.sections !== undefined) {
    // An explicitly unassigned draft grants its owner creation/editing only.
    // A real section always takes precedence; legacy unsectioned records have no marker.
    if (resource?.unassignedDraft === true && resource.section === undefined &&
        typeof principal.id === "string" && resource.ownerId === principal.id &&
        ["content.create", "content.edit.any", "content.edit.own"].includes(capability)) {
      return true;
    }
    // A scoped grant (malformed, empty, and global-capability cases are already
    // rejected above). An unstated resource section cannot be confirmed, so it is
    // denied -- which also closes the create-without-a-section hole.
    if (!resource || resource.section == null) return false;
    return grant.sections.includes(resource.section);
  }

  return true;
}

// The access decision. True when any single grant authorizes the capability on
// the resource. Deny-by-default: no grant, a missing capability, unmet ownership,
// or an out-of-scope (or unstated) section all return false.
function can(principal, capability, resource) {
  const grants = principal?.grants ?? [];
  return grants.some((grant) =>
    grantAllows(principal, grant, capability, resource),
  );
}

// "May this principal edit this content record" -- satisfied by editing any
// content or by owning it. Callers should use this rather than reasoning about
// the two edit capabilities themselves.
function canEditContent(principal, resource) {
  return (
    can(principal, "content.edit.any", resource) ||
    can(principal, "content.edit.own", resource)
  );
}

// The core exports mirror the canonical module. The global-grant helper serves
// the server-only submissions queue. CAPABILITY_SCOPES stays private: the parity
// test pins the scoped/global split through decision results.
module.exports = {
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  ACCESS_TIERS,
  TIER_CAPABILITIES,
  TIER_ROLES,
  isAccessTier,
  capabilitiesForGrant,
  capabilitiesForRole,
  withRegisteredMediaSections,
  hasCapability,
  hasGlobalCapability,
  can,
  canEditContent,
};
