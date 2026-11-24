import { deleteField, doc, getDocFromServer, runTransaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  parseMediaCollectionPins,
  readLegacyMediaCollectionPins,
  setMediaCollectionPinned,
  type MediaCollectionPins,
} from "./media-collection-pins";

export async function loadMediaCollectionPins(userId: string, profile: unknown): Promise<MediaCollectionPins> {
  const snapshot = await getDocFromServer(doc(db, "mediaCollectionPins", userId));
  return snapshot.exists() ? parseMediaCollectionPins(snapshot.data()) : readLegacyMediaCollectionPins(profile);
}

export async function saveMediaCollectionPin(
  userId: string,
  collectionId: string,
  pinned: boolean,
): Promise<MediaCollectionPins> {
  try {
    return await runTransaction(db, async transaction => {
      const pinsRef = doc(db, "mediaCollectionPins", userId);
      const profileRef = doc(db, "users", userId);
      const [snapshot, profile] = await Promise.all([transaction.get(pinsRef), transaction.get(profileRef)]);
      if (!profile.exists()) throw new Error("Staff profile is unavailable");
      const pins = setMediaCollectionPinned(
        snapshot.exists() ? parseMediaCollectionPins(snapshot.data()) : readLegacyMediaCollectionPins(profile.data()),
        collectionId,
        pinned,
      );
      transaction.set(pinsRef, pins);
      if (profile.get("preferences.mediaCollectionPins") !== undefined) {
        transaction.update(profileRef, "preferences.mediaCollectionPins", deleteField());
      }
      return pins;
    });
  } catch {
    throw new Error("Your collection pin could not be saved. Try again.");
  }
}
