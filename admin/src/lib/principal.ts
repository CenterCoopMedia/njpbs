import type { Principal, RoleGrant } from "../../../packages/content-core/src/rbac";
import { isAccessTier, TIER_ROLES } from "../../../packages/content-core/src/rbac";

/**
 * A user's access comes only from a valid `accessTier` on an active account, once the
 * server-only activation receipt exists. Stored `role` and `grants` fields confer nothing.
 * Profile text carries no authority. Firestore rules protect authorization fields from
 * client writes.
 */
export interface CmsUserDoc {
  active?: boolean;
  email?: string | null;
  /** Authoritative single site-wide level; a present invalid value denies access. */
  accessTier?: unknown;
  displayName?: string | null;
  preferences?: unknown;
  offboarding?: unknown;
}

/** Compare the access observed in a row with the server's current access before replacement. */
export function accessStateFromUserDoc(doc: CmsUserDoc): string {
  return JSON.stringify({
    tierPresent: Object.hasOwn(doc, "accessTier"),
    accessTier: typeof doc.accessTier === "string" ? doc.accessTier : null,
    active: doc.active !== false,
  });
}

/** Resolve the principal from the trusted user document's access tier. */
export function principalFromUserDoc(
  uid: string,
  doc: CmsUserDoc | null | undefined,
  tiersActive = false,
): Principal {
  const grants: RoleGrant[] = [];
  if (!tiersActive || !doc || (doc.active !== undefined && doc.active !== true) || !isAccessTier(doc.accessTier)) {
    return { id: uid, grants };
  }
  return { id: uid, grants: [{ role: TIER_ROLES[doc.accessTier], tier: doc.accessTier }] };
}
