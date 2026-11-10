import {
  collection,
  getDocs,
  type Firestore,
} from "firebase/firestore";
import { principalFromUserDoc, type CmsUserDoc } from "./principal";
import { accessTierReadsActive } from "./access-tier-activation";
import { hasCapability } from "../../../packages/content-core/src/rbac";

export interface AssignableUser {
  id: string;
  label: string;
}

export function isAssignableUserDoc(user: CmsUserDoc, tiersActive = false): boolean {
  if (tiersActive && Object.hasOwn(user, "accessTier")) {
    return hasCapability(principalFromUserDoc("assignment", user, tiersActive), "content.create");
  }
  if (user.role === "admin" || user.role === "super_admin") return true;
  return (
    Array.isArray(user.grants) &&
    user.grants.some(
      (grant) =>
        grant !== null &&
        typeof grant === "object" &&
        !Array.isArray(grant) &&
        ("role" in grant) &&
        (grant.role === "editor" || grant.role === "contributor"),
    )
  );
}

export function assignableUserLabel(id: string, user: CmsUserDoc): string {
  const displayName =
    typeof user.displayName === "string" && user.displayName.trim()
      ? user.displayName.trim()
      : null;
  const email =
    typeof user.email === "string" && user.email.trim()
      ? user.email.trim()
      : null;
  if (displayName && email) return `${displayName} (${email})`;
  return displayName ?? email ?? id;
}

export async function loadAssignableUsers(
  firestore: Firestore,
): Promise<AssignableUser[]> {
  const snapshot = await getDocs(collection(firestore, "users"));
  const tiersActive = snapshot.docs.some((document) => Object.hasOwn(document.data(), "accessTier"))
    ? await accessTierReadsActive(firestore) : false;
  return snapshot.docs
    .map((userDocument) => ({
      id: userDocument.id,
      user: userDocument.data() as CmsUserDoc,
    }))
    .filter(({ user }) => isAssignableUserDoc(user, tiersActive))
    .map(({ id, user }) => ({ id, label: assignableUserLabel(id, user) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
