import type { Principal, RoleGrant } from "../../../packages/content-core/src/rbac";
import { isAccessTier, TIER_ROLES } from "../../../packages/content-core/src/rbac";

export type UserDocRole = "super_admin" | "admin" | null;

/**
 * After server-only activation, a present accessTier is authoritative and must be valid and active. Documents
 * without it keep their legacy role and grants. Profile text carries no authority.
 * Firestore rules protect authorization fields from client writes.
 */
export interface CmsUserDoc {
  active?: boolean;
  email?: string | null;
  role?: UserDocRole;
  grants?: unknown;
  /** Authoritative single site-wide level; a present invalid value denies access. */
  accessTier?: unknown;
  displayName?: string | null;
  preferences?: unknown;
  offboarding?: unknown;
}

const TOP_LEVEL_ROLES = new Set(["admin", "super_admin"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function normalizeGrantSections(sections: unknown): string[] | undefined {
  // Omitted or undefined sections preserve an intentional site-wide grant.
  // Arrays stay scoped after filtering to strings. Present non-arrays become
  // an empty scope so malformed grants never widen into site-wide authority.
  if (sections === undefined) return undefined;
  return Array.isArray(sections)
    ? sections.filter((section): section is string => typeof section === "string")
    : [];
}

export function normalizeGrants(value: unknown): RoleGrant[] {
  if (!Array.isArray(value)) return [];

  // Legacy administrative roles are authoritative only in `role`. Rejecting them here keeps
  // a malformed or migrated grant entry from conferring admin capabilities.
  return value
    .filter(
      (grant): grant is Record<string, unknown> & { role: string } =>
        isPlainObject(grant) &&
        typeof grant.role === "string" &&
        !TOP_LEVEL_ROLES.has(grant.role),
    )
    .map((grant) => {
      const normalizedGrant: RoleGrant = {
        role: grant.role as RoleGrant["role"],
      };
      const sections = normalizeGrantSections(grant.sections);
      if (sections !== undefined) normalizedGrant.sections = sections;
      return normalizedGrant;
    });
}

/** Compare the access observed in a row with the server's current access before replacement. */
export function accessStateFromUserDoc(doc: CmsUserDoc): string {
  return JSON.stringify({
    tierPresent: Object.hasOwn(doc, "accessTier"),
    accessTier: typeof doc.accessTier === "string" ? doc.accessTier : null,
    role: typeof doc.role === "string" ? doc.role : null,
    grants: normalizeGrants(doc.grants),
    active: doc.active !== false,
  });
}

/**
 * Resolve trusted legacy role and grants until server-only activation enables
 * accessTier. Profile text, job titles and bylines carry no authorization weight.
 */
export function principalFromUserDoc(
  uid: string,
  doc: CmsUserDoc | null | undefined,
  tiersActive = false,
): Principal {
  const grants: RoleGrant[] = [];

  if (tiersActive && doc && Object.hasOwn(doc, "accessTier")) {
    if ((doc.active !== undefined && doc.active !== true) || !isAccessTier(doc.accessTier)) return { id: uid, grants };
    return { id: uid, grants: [{ role: TIER_ROLES[doc.accessTier], tier: doc.accessTier }] };
  }

  if (
    doc?.role !== null &&
    doc?.role !== undefined &&
    TOP_LEVEL_ROLES.has(doc.role)
  ) {
    grants.push({ role: doc.role });
  }

  grants.push(...normalizeGrants(doc?.grants));

  return { id: uid, grants };
}
