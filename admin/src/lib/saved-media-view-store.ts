import { doc, getDoc, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  SavedMediaViewValidationError,
  applySavedMediaViewMutation,
  parseSavedMediaViews,
  type SavedMediaView,
  type SavedMediaViewMutation,
} from "./saved-media-views";

function savedViewValue(data: Record<string, unknown>): unknown {
  const preferences = data.preferences;
  if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences)) {
    return undefined;
  }
  return (preferences as Record<string, unknown>).mediaLibraryViews;
}

export async function loadMediaLibraryViews(userId: string): Promise<SavedMediaView[]> {
  try {
    const snapshot = await getDoc(doc(db, "users", userId));
    if (!snapshot.exists()) return [];
    return parseSavedMediaViews(savedViewValue(snapshot.data() as Record<string, unknown>));
  } catch {
    throw new Error("Your saved views could not be loaded.");
  }
}

export async function mutateMediaLibraryViews(
  userId: string,
  mutation: SavedMediaViewMutation,
): Promise<SavedMediaView[]> {
  try {
    return await runTransaction(db, async (transaction) => {
      const profileRef = doc(db, "users", userId);
      const snapshot = await transaction.get(profileRef);
      if (!snapshot.exists()) {
        throw new Error("Staff profile is unavailable");
      }
      const next = applySavedMediaViewMutation(
        savedViewValue(snapshot.data() as Record<string, unknown>),
        mutation,
      );
      transaction.set(
        profileRef,
        { preferences: { mediaLibraryViews: next } },
        { mergeFields: ["preferences.mediaLibraryViews"] },
      );
      return next;
    });
  } catch (error) {
    if (error instanceof SavedMediaViewValidationError) throw error;
    throw new Error("Your saved views could not be stored.");
  }
}
