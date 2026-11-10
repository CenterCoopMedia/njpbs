// Pure decision logic behind the staff-access confirm flow (#584).
//
// Two questions the access surface asks before a role change applies, both answered
// from the same capability model the rest of the app enforces (rbac.ts), never from a
// second copy of it:
//
//   1. describeAccessChange -- what does this change actually do? "Admin" is a word, not
//      a list; this turns the word back into the list of capabilities it confers, scoped
//      the way rbac would scope it. That list is what the confirm step shows. Granting a
//      top-level role overwrites the target's single top-level role, so when it replaces a
//      more powerful one the impact also names the replacement and lists what it removes,
//      diffed through the same access check.
//   2. assessSelfLockout -- would this change lock the current user out of managing staff
//      access? The server is the real integrity boundary (functions/roles.js refuses
//      every self-revoke, refuses changing your own top-level role, and refuses removing
//      the last super admin). This mirrors those refusals on the client so the control
//      never fires a request the server will reject, and instead explains why up front
//      and names the recovery path.
//
// This module reads no state and calls no network: the component passes in the proposed
// change and the small amount of context the guard needs (who is acting, who is targeted,
// how many super admins exist).

import {
  ALL_CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
  type Capability,
  type Principal,
  type Role,
  type RoleGrant,
} from "../../../packages/content-core/src/rbac";
import { ROLE_TEXT } from "./role-text";

/**
 * Plain-language phrase for every capability, keyed by Capability so a new permission
 * added to the model cannot ship without a label (the Record type makes the omission a
 * compile error, the same discipline rbac.ts uses for its scope table). Each phrase is a
 * verb clause that reads correctly in a list and after "the ability to".
 */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "guide.view": "view the private Boardwalk guide",
  "content.view": "read content across the whole site",
  "media.image.read": "browse Images and documents",
  "content.create": "create content",
  "content.edit.own": "edit their own content",
  "content.edit.any": "edit anyone's content",
  "content.publish": "publish content",
  "content.unpublish": "unpublish content",
  "content.delete": "delete content",
  "datasets.approve": "approve dataset revisions",
  "media.upload": "upload media site-wide",
  "media.manage": "manage the media library site-wide",
  "media.video.read": "browse station videos site-wide",
  "media.video.manage": "manage station videos site-wide",
  "submissions.review": "review public submissions",
  "reports.view": "file and view their own problem reports",
  "analytics.view": "view site analytics",
  "profiles.manage": "manage staff profiles",
  "media.audio.read": "browse station audio site-wide",
  "schedule.manage": "manage the broadcast schedule",
  "members.view": "view member records",
  "settings.manage": "manage site settings",
  "users.view": "view staff accounts",
  "users.manage": "manage staff accounts",
  "audit.view": "view administrative activity",
  "roles.grant": "grant and revoke staff roles",
};

/**
 * The two roles that occupy the single top-level `role` field on a user document, matching
 * the server's TOP_LEVEL_ROLES (functions/roles.js). Granting one overwrites that field
 * rather than adding to the scoped grants array, so a grant of a top-level role can strip
 * capabilities the previous top-level role conferred. This is a structural fact about the
 * data model, not a capability list, so naming the two roles here does not duplicate the
 * capability model the way a hand-maintained capability list would.
 */
const TOP_LEVEL_ROLES: readonly Role[] = ["super_admin", "admin"];

function isTopLevelRole(role: Role): boolean {
  return TOP_LEVEL_ROLES.includes(role);
}

/**
 * A proposed access change, as issued by the staff-access controls. `sections` absent
 * means a site-wide grant or a full-role revoke; a present list means the change is
 * scoped to those sections. This mirrors the grant/revoke payload the functions layer
 * takes, so the same object drives both the impact summary and the request.
 */
export interface AccessChange {
  action: "grant" | "revoke";
  role: Role;
  sections?: readonly string[];
}

/** The plain-language impact of a change, derived from the capability model. */
export interface AccessChangeImpact {
  action: "grant" | "revoke";
  role: Role;
  scope: "site-wide" | "sections";
  sections: readonly string[];
  /**
   * The capabilities this change confers (grant) or takes away (revoke), as phrases. For a
   * grant that replaces a different top-level role, this is the net-new capabilities the
   * requested role adds beyond what the target already held.
   */
  capabilities: readonly string[];
  /**
   * The capabilities this change takes away because it replaces the target's current
   * top-level role with one that confers fewer of them. Empty for a pure gain, a scoped
   * grant, or a revoke (a revoke's losses are already in `capabilities`).
   */
  removedCapabilities: readonly string[];
  /**
   * True when this grant overwrites a different top-level role and, in doing so, removes at
   * least one capability. Drives the confirmation to name the replacement and warn about
   * the loss rather than only describing the requested role.
   */
  replacesRole: boolean;
  /** A short label for the change, e.g. "Grant super admin", "Revoke editor in news". */
  headline: string;
  /** A one-sentence description of the effect, ending before the capability list. */
  summary: string;
}

/**
 * The capabilities a single grant of this role and scope would confer, resolved through
 * the app's own access check. Building a synthetic principal and asking hasCapability for
 * each capability reuses rbac's exact scope rules (a scoped grant reports only
 * area-level capabilities and site-wide media, never global administration), so the
 * summary can never promise a capability the real access decision would refuse.
 */
function capabilitiesConferredBy(
  role: Role,
  sections?: readonly string[],
): Capability[] {
  const grant: RoleGrant = sections === undefined ? { role } : { role, sections };
  const principal: Principal = { grants: [grant] };
  return ALL_CAPABILITIES.filter((capability) =>
    hasCapability(principal, capability),
  );
}

function isScoped(sections: readonly string[] | undefined): sections is readonly string[] {
  return sections !== undefined && sections.length > 0;
}

/**
 * The sections a full-role revoke would actually clear, given what the target holds now.
 *
 * A revoke with no sections asks the server to remove every grant for that role, so its
 * real reach is the target's own grants rather than the whole site: functions/roles.js
 * filters the grants array, it does not reach beyond it. Returning null means site-wide --
 * either the target holds an unscoped grant for the role, or the caller supplied no grants
 * and there is nothing to narrow the phrasing with.
 */
function fullRevokeSections(
  role: Role,
  grants: readonly RoleGrant[] | undefined,
): readonly string[] | null {
  if (grants === undefined) return null;
  const held = grants.filter((grant) => grant.role === role);
  // An unscoped grant is site-wide, so the revoke really does reach the whole site.
  if (held.some((grant) => grant.sections === undefined)) return null;
  const sections: string[] = [];
  for (const grant of held) {
    for (const section of grant.sections ?? []) {
      if (!sections.includes(section)) sections.push(section);
    }
  }
  return sections;
}

/**
 * Whether the server would apply nothing, so the confirmation should say so rather than
 * advertise an effect. Every shape here comes from a row rendered against data that has
 * since moved -- another admin demoted the target, or the grant was already removed:
 *
 *  - a grant of the top-level role the target already holds, which rewrites the field with
 *    the value already in it;
 *  - a revoke of a top-level role the target does not hold, which the server refuses with a
 *    409 rather than clearing whichever role they do hold;
 *  - a full-role revoke of a scoped role the target holds no grants for, which filters an
 *    array that has nothing to filter.
 *
 * A scoped revoke is excluded: it names sections, and the server refuses a section revoke
 * against a site-wide grant rather than quietly doing nothing, so it is never silent.
 */
export function isNoopAccessChange(
  change: AccessChange,
  currentTopLevelRole?: Role | null,
  currentGrants?: readonly RoleGrant[],
): boolean {
  if (isTopLevelRole(change.role)) {
    const current = currentTopLevelRole ?? null;
    return change.action === "grant" ? current === change.role : current !== change.role;
  }
  if (change.action === "revoke" && !isScoped(change.sections) && currentGrants) {
    return !currentGrants.some((grant) => grant.role === change.role);
  }
  return false;
}

/**
 * Turn a proposed change into its plain-language impact: the role's capability list,
 * scoped, plus a headline and one-line summary. For a grant the list is what the person
 * gains; for a revoke it is what the change takes away.
 *
 * `currentTopLevelRole` is the target's existing top-level role (the single `role` field),
 * when known. It matters only for a grant of a top-level role: that grant overwrites the
 * field, so if the target already holds a different top-level role the change can remove
 * capabilities. When it does, the impact names the replacement and lists the removed
 * capabilities so the confirm step warns about the loss instead of only advertising what
 * the requested role enables. The removed/gained split is computed by diffing two
 * synthetic principals -- one for the current role, one for the requested role -- through
 * the same hasCapability the access decision uses, so it can never disagree with it.
 */
export function describeAccessChange(
  change: AccessChange,
  currentTopLevelRole?: Role | null,
  currentGrants?: readonly RoleGrant[],
): AccessChangeImpact {
  const scoped = isScoped(change.sections);
  // A full-role revoke carries no sections because that is how the server is asked to
  // remove every grant for the role, not because the reach is site-wide. Read the reach
  // back off the grants the target actually holds so the confirmation cannot promise to
  // remove editor "across the whole site" from someone who only holds editor in news.
  const heldSections =
    change.action === "revoke" && !scoped && !isTopLevelRole(change.role)
      ? fullRevokeSections(change.role, currentGrants)
      : null;
  const revokeScoped = heldSections !== null && heldSections.length > 0;
  const sections = scoped ? [...change.sections!] : revokeScoped ? [...heldSections] : [];
  const roleLabel = ROLE_TEXT[change.role].name;
  const scopeSuffix = scoped || revokeScoped ? ` in ${sections.join(", ")}` : "";
  const verb = change.action === "grant" ? "Grant" : "Revoke";
  const headline = `${verb} ${roleLabel}${scopeSuffix}`;

  // Only a grant of a top-level role over a different existing top-level role can be a
  // demotion. Scoped grants add to the grants array and replace nothing; revokes are
  // already framed as removals; a grant with no current top-level role (or the same one)
  // adds only. In those cases fall through to the single-list phrasing below. A scoped
  // grant is unaffected by the top-level field, so it is correctly excluded here even when
  // a current top-level role is supplied.
  if (
    change.action === "grant" &&
    isTopLevelRole(change.role) &&
    currentTopLevelRole &&
    currentTopLevelRole !== change.role
  ) {
    const currentCapabilities = capabilitiesConferredBy(currentTopLevelRole);
    const proposedCapabilities = capabilitiesConferredBy(change.role);
    const currentSet = new Set(currentCapabilities);
    const proposedSet = new Set(proposedCapabilities);
    const removed = currentCapabilities.filter((c) => !proposedSet.has(c));

    // Only call it a replacement when the requested role actually takes something away.
    // A demotion-free swap (for example admin -> super admin) is a pure gain and keeps the
    // full-list phrasing below.
    if (removed.length > 0) {
      const gained = proposedCapabilities.filter((c) => !currentSet.has(c));
      return {
        action: change.action,
        role: change.role,
        scope: "site-wide",
        sections: [],
        capabilities: gained.map((capability) => CAPABILITY_LABELS[capability]),
        removedCapabilities: removed.map((capability) => CAPABILITY_LABELS[capability]),
        replacesRole: true,
        headline,
        summary: `Replaces the ${ROLE_TEXT[currentTopLevelRole].name} role with ${roleLabel}.`,
      };
    }
  }

  const capabilities = capabilitiesConferredBy(
    change.role,
    scoped || revokeScoped ? sections : undefined,
  ).map((capability) => CAPABILITY_LABELS[capability]);

  const scopePhrase =
    scoped || revokeScoped ? `in ${sections.join(", ")}` : "across the whole site";
  // Describe what the role can do rather than a net change against the person's other
  // grants. That keeps the summary honest -- "render the grant as the list" (the #584
  // research prescription) without over-claiming a loss the person may still hold through
  // a separate scoped grant. Direction stays in the "Grants"/"Removes" verb and headline.
  const verbPhrase = change.action === "grant" ? "Grants" : "Removes";
  const summary = `${verbPhrase} the ${roleLabel} role ${scopePhrase}, which can:`;

  return {
    action: change.action,
    role: change.role,
    scope: scoped || revokeScoped ? "sections" : "site-wide",
    sections,
    capabilities,
    removedCapabilities: [],
    replacesRole: false,
    headline,
    summary,
  };
}

/** Context the self-lockout guard needs, none of it read from state inside the guard. */
export interface SelfLockoutContext {
  /** The signed-in user making the change, or undefined when it cannot be resolved. */
  actingUserId: string | undefined;
  /** The account the change targets. */
  targetUserId: string;
  change: AccessChange;
  /** How many accounts currently hold site-wide super admin (the roles.grant holders). */
  superAdminCount: number;
}

export type SelfLockoutVerdict =
  | { severity: "ok" }
  | { severity: "blocked"; reason: string };

/**
 * Whether a proposed change would strip the acting user's own access, mirroring the
 * server's self-protection so the control never fires a doomed request. Changes to
 * another account are always ok here -- they cannot lock the actor out, and the confirm
 * step's impact summary already covers over-granting to someone else.
 */
export function assessSelfLockout(context: SelfLockoutContext): SelfLockoutVerdict {
  const { actingUserId, targetUserId, change, superAdminCount } = context;

  if (!actingUserId || targetUserId !== actingUserId) {
    return { severity: "ok" };
  }

  // The role that confers the ability to manage staff access is the one holding
  // roles.grant (super admin), derived from the model rather than matched by name.
  const roleManagesAccess = capabilitiesForRole(change.role).includes("roles.grant");

  if (change.action === "revoke") {
    // The server refuses every self-revoke ("Cannot revoke your own role"). The sharpest
    // case is removing your own access-management role when you are the last holder:
    // nothing could restore it from the UI, so name the recovery path instead of a bare
    // refusal.
    if (roleManagesAccess && superAdminCount <= 1) {
      return {
        severity: "blocked",
        reason:
          "You are the only Site owner, so removing your own Site owner role would leave no one able to manage staff access. Grant Site owner to another staff member first, then ask them to remove yours.",
      };
    }
    return {
      severity: "blocked",
      reason:
        "You cannot change your own roles. Ask another Site owner to make this change.",
    };
  }

  // A self grant of a top-level role would change your own top-level role, which the
  // server refuses ("Cannot change your own top-level role"). This also catches a
  // grant-replacement self-demotion (super admin -> admin), so a last super admin cannot
  // demote themselves out of role management. A scoped editor or contributor grant to
  // yourself is harmless and the server allows it.
  if (isTopLevelRole(change.role)) {
    return {
      severity: "blocked",
      reason:
        "You cannot change your own top-level role. Ask another Site owner to make this change.",
    };
  }

  return { severity: "ok" };
}
