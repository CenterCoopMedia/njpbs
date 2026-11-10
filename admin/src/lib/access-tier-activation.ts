import { doc, getDocFromServer, type Firestore, type Transaction } from "firebase/firestore";

export const ACCESS_TIER_ACTIVATION_PATH = "system/staffAccessActivation";
export function validAccessTierActivation(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receipt.schema === 1 && receipt.state === "active" && receipt.cleanScan === true;
}

export async function accessTierReadsActive(firestore: Firestore, transaction?: Transaction): Promise<boolean> {
  const reference = doc(firestore, ACCESS_TIER_ACTIVATION_PATH);
  const snapshot = transaction ? await transaction.get(reference) : await getDocFromServer(reference);
  return snapshot.exists() && validAccessTierActivation(snapshot.data());
}
