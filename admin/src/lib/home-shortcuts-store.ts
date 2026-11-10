import { deleteField, doc, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import { eligibleHomeShortcuts, resolveHomeShortcuts, type HomeShortcutId } from "./home-shortcuts";
import { accessTierReadsActive } from "./access-tier-activation";
import { principalFromUserDoc, type CmsUserDoc } from "./principal";

/** Own account preferences, shared through the same profile listener as the rail. */
export async function saveHomeShortcuts(userId: string, ids: readonly HomeShortcutId[] | null): Promise<void> {
  try {
    const reference = doc(db, "users", userId);
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("Account unavailable");
      const profile = snapshot.data() as CmsUserDoc;
      const tiersActive = Object.hasOwn(profile, "accessTier") ? await accessTierReadsActive(db, transaction) : false;
      const principal = principalFromUserDoc(userId, profile, tiersActive);
      const value = ids === null ? deleteField() : resolveHomeShortcuts(ids, eligibleHomeShortcuts(principal)).map((action) => action.id);
      transaction.update(reference, { "preferences.homeShortcuts": value });
    });
  } catch {
    throw new Error("Your Home shortcuts could not be saved. Try again.");
  }
}
