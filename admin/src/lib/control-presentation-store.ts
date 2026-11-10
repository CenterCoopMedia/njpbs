import { doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { ControlPresentation } from "./control-presentation";

export async function saveControlPresentation(
  userId: string,
  value: ControlPresentation,
): Promise<void> {
  try {
    await updateDoc(doc(db, "users", userId), {
      "preferences.display.controlPresentation": value,
    });
  } catch {
    throw new Error("Your display preference could not be stored. Try again.");
  }
}
