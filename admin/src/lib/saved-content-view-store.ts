import { doc, getDoc, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  SavedContentViewValidationError,
  applySavedContentViewMutation,
  parseSavedContentViews,
  type SavedContentViewMutation,
  type SavedContentView,
} from "./saved-content-views";

function savedViewValue(data: Record<string, unknown>): unknown {
  const preferences = data.preferences;
  if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences)) {
    return undefined;
  }
  return (preferences as Record<string, unknown>).contentLibraryViews;
}

export async function loadContentLibraryViews(userId: string): Promise<SavedContentView[]> {
  try {
    const snapshot = await getDoc(doc(db, "users", userId));
    if (!snapshot.exists()) return [];
    return parseSavedContentViews(savedViewValue(snapshot.data() as Record<string, unknown>));
  } catch {
    throw new Error("Your saved views could not be loaded.");
  }
}

export async function mutateContentLibraryViews(
  userId: string,
  mutation: SavedContentViewMutation,
): Promise<SavedContentView[]> {
  try {
    return await runTransaction(db, async (transaction) => {
      const profileRef = doc(db, "users", userId);
      const snapshot = await transaction.get(profileRef);
      // Profile creation is server-owned admission. A missing row must stay
      // missing instead of letting this preference write recreate it through a
      // field-scoped merge.
      if (!snapshot.exists()) {
        throw new Error("Staff profile is unavailable");
      }
      const current = savedViewValue(
        snapshot.data() as Record<string, unknown>,
      );
      const next = applySavedContentViewMutation(current, mutation);
      // A field-scoped merge cannot replace identity, role, grants, or unrelated
      // preferences. Reading inside the transaction and applying one intent
      // preserves unrelated same-account changes from other tabs or devices.
      transaction.set(
        profileRef,
        { preferences: { contentLibraryViews: next } },
        { mergeFields: ["preferences.contentLibraryViews"] },
      );
      return next;
    });
  } catch (error) {
    // The pure mutation boundary names refusals an editor can act on. Preserve only that
    // explicit safe class; Firestore/network details remain behind the generic store error.
    if (error instanceof SavedContentViewValidationError) throw error;
    throw new Error("Your saved views could not be stored.");
  }
}
