import { doc, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  readMediaCollectionPins,
  setMediaCollectionPinned,
  type MediaCollectionPins,
} from "./media-collection-pins";

export async function saveMediaCollectionPin(
  userId: string,
  collectionId: string,
  pinned: boolean,
): Promise<MediaCollectionPins> {
  try {
    return await runTransaction(db, async transaction => {
      const profileRef = doc(db, "users", userId);
      const snapshot = await transaction.get(profileRef);
      if (!snapshot.exists()) throw new Error("Staff profile is unavailable");
      const pins = setMediaCollectionPinned(
        readMediaCollectionPins(snapshot.data()),
        collectionId,
        pinned,
      );
      transaction.set(
        profileRef,
        { preferences: { mediaCollectionPins: pins } },
        { mergeFields: ["preferences.mediaCollectionPins"] },
      );
      return pins;
    });
  } catch {
    throw new Error("Your collection pin could not be saved. Try again.");
  }
}
