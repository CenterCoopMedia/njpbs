// Capability-based access control for the NJ PBS newsroom CMS.
//
// The one rule: authorization asks "does this principal hold capability X on this
// resource," never "is the role string 'editor'." That indirection is the whole
// point. Roles are coarse and resolve to capability sets through a single table
// (ROLE_CAPABILITIES), so changing what a role can do is a data edit here, not a
// change to any feature path. Every decision is deny-by-default: can() returns true
// only for an explicit grant. This is the OWASP A01:2021 defense against broken
// access control (deny by default, enforce server-side, enforce record ownership).
//
// This module is the pure decision core. It reads no database and verifies no token:
// the caller resolves a Principal server-side from the trusted user document (or
// verified claims) and passes it in. Wiring that resolution to Firebase Auth is the
// sign-in dependency tracked separately; the decision logic here stands on its own.

/** The five coarse role tiers. Never compared by name in feature code. */
export type Role = "super_admin" | "admin" | "editor" | "contributor" | "staff";

/** Single, site-wide access levels. Legacy role grants retain their existing rules. */
export const ACCESS_TIERS = ["viewer", "contributor", "editor", "publisher", "admin", "owner"] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

/**
 * Every capability, ordered content -> media -> schedule -> members -> settings ->
 * users. This const is the single source of truth: the Capability type is derived from
 * it, so a new permission has to be added here and cannot silently split the two
 * definitions. super_admin is built from this list, so a capability added here is
 * automatically held by super_admin and by nothing else until a role grants it.
 */
export const ALL_CAPABILITIES = [
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
] as const;

/**
 * Discrete verb-on-noun permissions the app checks at request time, derived from
 * ALL_CAPABILITIES so the two never drift. Capability names are the stable contract
 * feature code depends on; roles are an implementation detail of how a principal comes
 * to hold them.
 */
export type Capability = (typeof ALL_CAPABILITIES)[number];

/**
 * The single role -> capability mapping. Editing a role's powers is a data edit to
 * this table and nothing else. Two escalation guards are encoded here and asserted in
 * the tests: roles.grant is held only by super_admin, and users.manage stops at admin.
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // Private guide, read-only station media and the staff member's own reports. This role carries no CMS
  // authoring, publication, media write, settings, audit, or staff-management authority.
  staff: ["guide.view", "media.audio.read", "media.video.read", "reports.view"],

  // Draft and propose only. No publish, no media management, no delete.
  contributor: [
    "guide.view",
    "content.create",
    "content.edit.own",
    "media.audio.read",
    "media.video.read",
    "reports.view",
  ],

  // Create, edit, and publish within optional areas; manage media site-wide. No delete,
  // no schedule, no settings, no user administration.
  editor: [
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
  ],

  // Day-to-day site administration: all content and settings and user management,
  // but not roles.grant or other escalation-guarded fields.
  admin: [
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
  ],

  // Break-glass tier: everything, including granting and revoking roles.
  super_admin: [...ALL_CAPABILITIES],
};

// Joe's October 13 decisions in #2747: six cumulative levels, no area limits,
// media upload and management from Contributor, deletion from Publisher.
const VIEWER_CAPABILITIES: readonly Capability[] = [
  "guide.view", "content.view", "media.image.read", "media.audio.read", "media.video.read", "reports.view",
];
const CONTRIBUTOR_CAPABILITIES: readonly Capability[] = [
  ...VIEWER_CAPABILITIES, "content.create", "content.edit.own", "media.upload", "media.manage", "media.video.manage",
];
const EDITOR_CAPABILITIES: readonly Capability[] = [
  ...CONTRIBUTOR_CAPABILITIES, "content.edit.any", "submissions.review",
];
const PUBLISHER_CAPABILITIES: readonly Capability[] = [
  ...EDITOR_CAPABILITIES, "content.publish", "content.unpublish", "content.delete", "datasets.approve",
];
export const TIER_CAPABILITIES: Record<AccessTier, readonly Capability[]> = {
  viewer: VIEWER_CAPABILITIES,
  contributor: CONTRIBUTOR_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  publisher: PUBLISHER_CAPABILITIES,
  admin: [...PUBLISHER_CAPABILITIES, "schedule.manage", "members.view", "settings.manage", "analytics.view",
    "profiles.manage", "users.view", "users.manage", "audit.view"],
  owner: [...ALL_CAPABILITIES],
};

/** Compatibility names for existing display vocabulary; these names confer no tier powers. */
export const TIER_ROLES: Record<AccessTier, Role> = {
  viewer: "staff", contributor: "contributor", editor: "editor", publisher: "editor", admin: "admin", owner: "super_admin",
};

export function isAccessTier(value: unknown): value is AccessTier {
  return typeof value === "string" && Object.hasOwn(TIER_CAPABILITIES, value);
}

export function capabilitiesForGrant(grant: RoleGrant): readonly Capability[] {
  if (grant.tier !== undefined) {
    return isAccessTier(grant.tier) && grant.sections === undefined ? TIER_CAPABILITIES[grant.tier] : [];
  }
  return capabilitiesForRole(grant.role);
}

/**
 * Every capability classified as section-scopable or global, in one place. Because it
 * is a Record keyed by Capability, adding a capability without classifying it here is a
 * compile error, so the scoped/global split cannot silently drift from the capability
 * list as the model grows. "section" capabilities are the desk-level content,
 * and schedule powers a section scope can confer; "global" capabilities (settings,
 * users, roles, members) administer the whole site and require an unscoped grant.
 * Media capabilities are also global in operation, but valid area grants confer
 * them through the explicit SITE_WIDE_MEDIA_CAPABILITIES exception below.
 */
const CAPABILITY_SCOPES: Record<Capability, "section" | "global"> = {
  // Any real staff or authoring grant opens the organization guide, including a
  // desk-scoped grant. The guide itself does not use the desk as a resource filter.
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
};

// Media is site-wide even when supplied by a valid area grant. This exception
// affects media only; site administration still requires an unscoped grant.
const SITE_WIDE_MEDIA_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "media.audio.read",
  "media.video.read",
  "media.video.manage",
  "media.upload",
  "media.manage",
]);

/**
 * The capabilities a section scope can grant, derived from CAPABILITY_SCOPES so the two
 * cannot drift. content.edit.own is section-scopable here and additionally carries an
 * ownership check in grantAllows.
 */
const SECTION_SCOPED_CAPABILITIES: ReadonlySet<Capability> = new Set(
  (Object.keys(CAPABILITY_SCOPES) as Capability[]).filter(
    (c) => CAPABILITY_SCOPES[c] === "section",
  ),
);

/**
 * One role assignment, optionally scoped to a set of sections. This is the {role,
 * scope} tuple from the design: an unscoped grant (no sections) applies site-wide, a
 * scoped grant limits content to its sections and confers media site-wide. A list lets a
 * user hold different roles in different places (a site-wide admin who is also the
 * news-desk editor) without either role bleeding into the other.
 */
export interface RoleGrant {
  role: Role;
  /** Set only by resolution of a trusted user's accessTier field. */
  tier?: AccessTier;
  /**
   * Sections this grant is scoped to. Absent (the field is not set) means an
   * intentional site-wide, unscoped grant. A present but empty list means scoped to
   * no sections, which confers nothing: an empty list is never widened into site-wide
   * authority, so a malformed "no desks selected" cannot escalate a scoped grant.
   */
  sections?: readonly string[];
  /** Runtime intersection with the live registry; absent or empty denies scoped media. */
  registeredMediaSections?: readonly string[];
}

/**
 * A resolved actor. The caller builds this server-side from the trusted user document
 * and resolves media scopes against the live section registry before admission;
 * a client can never assert its own grants or id. Keep the security grants separate
 * from any display jobTitle/byline: the byline carries no auth weight.
 */
export interface Principal {
  /** Stable user id, used to resolve content.edit.own ownership. */
  id?: string;
  /** Role assignments. A principal is authorized if any single grant authorizes. */
  grants: readonly RoleGrant[];
}

/** The thing being acted on, as far as an access decision needs to know. */
export interface Resource {
  /** id of the principal who owns this resource, for content.edit.own. */
  ownerId?: string;
  /** the section this resource belongs to, for section-scoped grants. */
  section?: string;
  /** Server-verified, owner-only draft that has not selected a section yet. */
  unassignedDraft?: boolean;
}

/** Capabilities a role holds, ignoring resource ownership and section scope. */
export function capabilitiesForRole(role: Role): readonly Capability[] {
  // Own-property guard: a persisted or migrated document could carry a role string that
  // names an inherited Object member (constructor, toString, __proto__). Indexing
  // ROLE_CAPABILITIES with one would return the prototype member, and the .includes()
  // call in grantHoldsAtCapabilityLevel would throw instead of denying. Deny by
  // default: an unknown role resolves to no capabilities.
  return Object.hasOwn(ROLE_CAPABILITIES, role) ? ROLE_CAPABILITIES[role] : [];
}

/**
 * Resolve media scopes against the live registry before capability decisions.
 * Keep content scopes intact; an empty media intersection confers no media
 * authority. Stored grants remain available for explicit revocation.
 */
export function withRegisteredMediaSections(
  principal: Principal,
  registeredSections: ReadonlySet<string>,
): Principal {
  return {
    ...principal,
    grants: (principal.grants ?? []).map((grant) => grant.sections === undefined
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

/**
 * Whether a single grant can confer a capability at all, ignoring the specific
 * resource. An unscoped grant confers everything its role holds. A scoped grant
 * confers section-scopable capabilities and site-wide media; other global
 * capabilities like settings.manage or users.manage are not desk-level powers, so a
 * scoped grant does not confer them even within its sections. This is the single
 * definition of conferral that both hasCapability() and grantAllows() build on, so
 * the coarse UI gate can never promise a capability the access check will refuse.
 */
function grantHoldsAtCapabilityLevel(grant: RoleGrant, capability: Capability): boolean {
  if (!capabilitiesForGrant(grant).includes(capability)) return false;
  // Only an omitted field means an intentional site-wide grant. A present sections
  // value that is null, a non-array, or empty is malformed or scopes to nothing and
  // confers no capability -- deny by default rather than widening it into site-wide
  // authority (a migrated document could carry sections: null).
  if (grant.sections === undefined) return true;
  if (!Array.isArray(grant.sections) || grant.sections.length === 0 ||
      !grant.sections.every((section) => typeof section === "string" &&
        section.trim() !== "" && section.trim() === section)) return false;
  if (SITE_WIDE_MEDIA_CAPABILITIES.has(capability) &&
      (!Array.isArray(grant.registeredMediaSections) || grant.registeredMediaSections.length === 0)) return false;
  // A scoped grant confers section powers and site-wide media. Other global
  // capabilities require a site-wide grant. content.edit.own is section-scopable and
  // additionally carries an ownership check in grantAllows.
  return SECTION_SCOPED_CAPABILITIES.has(capability) || SITE_WIDE_MEDIA_CAPABILITIES.has(capability);
}

/**
 * Coarse capability membership: could any of this principal's grants ever confer the
 * capability, ignoring the specific resource? This honors scope (a scoped grant does
 * not report administrative global capabilities) but not ownership or the resource's
 * section, so it answers "could this principal ever do X," not "may this principal do X to this
 * resource." Use it for UI gating (show or hide a control); use can() for a real
 * access decision.
 */
export function hasCapability(principal: Principal, capability: Capability): boolean {
  return (principal.grants ?? []).some((g) =>
    grantHoldsAtCapabilityLevel(g, capability),
  );
}

/** Whether a single grant, on its own, authorizes the capability on the resource. */
function grantAllows(
  principal: Principal,
  grant: RoleGrant,
  capability: Capability,
  resource: Resource | undefined,
): boolean {
  if (!grantHoldsAtCapabilityLevel(grant, capability)) return false;
  if (SITE_WIDE_MEDIA_CAPABILITIES.has(capability)) return true;

  if (capability === "content.edit.own") {
    // Ownership is required. A scoped grant then also confines it to the grant's
    // sections in the block below -- ownership does not punch through the scope.
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
    // A scoped grant (grantHoldsAtCapabilityLevel already rejected malformed, empty,
    // and administrative-capability cases, so grant.sections is a non-empty array here).
    // Require the resource's section to be stated and in scope -- an unstated section
    // cannot be confirmed, so it is denied (deny by default). This also closes the
    // create-without-a-section hole where a scoped editor could otherwise create in
    // any section by not naming one.
    if (!resource || resource.section == null) return false;
    return grant.sections.includes(resource.section);
  }

  return true;
}

/**
 * The access decision. Returns true when any single grant authorizes the capability
 * on the resource, and false otherwise. Deny-by-default: no grant, a missing
 * capability, unmet ownership, or an out-of-scope (or unstated) section all return
 * false.
 *
 * Resource semantics:
 * - Media capabilities operate site-wide, including from valid area grants.
 * - content.edit.own requires resource.ownerId to match principal.id.
 * - A section-scoped grant confines its section-scoped capabilities to its sections,
 *   and requires the resource's section to be stated. For a record-level decision,
 *   including a create, pass the target section so scope is enforced rather than
 *   silently skipped.
 */
export function can(
  principal: Principal,
  capability: Capability,
  resource?: Resource,
): boolean {
  return (principal.grants ?? []).some((g) =>
    grantAllows(principal, g, capability, resource),
  );
}

/**
 * Convenience for the common "may this principal edit this content record" question,
 * which is satisfied by editing any content (content.edit.any) or by owning it
 * (content.edit.own). Feature code should call this rather than reasoning about the
 * two edit capabilities itself.
 */
export function canEditContent(principal: Principal, resource: Resource): boolean {
  return (
    can(principal, "content.edit.any", resource) ||
    can(principal, "content.edit.own", resource)
  );
}
