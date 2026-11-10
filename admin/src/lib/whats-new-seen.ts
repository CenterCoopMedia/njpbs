import latestWhatsNewId from "virtual:whats-new-id";

// The shell imports only the generated "date title" id, without note bodies.
// Equality preserves seen-state IDs and detects a second note on the same date.
export const LATEST_WHATS_NEW_ID = latestWhatsNewId;

// One key per account, so a shared browser shows each staff member the dot once.
const storageKey = (userId: string) => `boardwalk.whatsNew.seen.${userId}`;

// Storage can be missing or throw in a locked-down or private window. Then the dot stays hidden,
// because a dot that never clears is worse than no dot.
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function hasUnreadWhatsNew(userId: string, latest = LATEST_WHATS_NEW_ID): boolean {
  try {
    const store = storage();
    if (!store) return false;
    return store.getItem(storageKey(userId)) !== latest;
  } catch {
    return false;
  }
}

export function markWhatsNewSeen(userId: string, latest = LATEST_WHATS_NEW_ID): void {
  try {
    storage()?.setItem(storageKey(userId), latest);
  } catch {
    // The notes still open; only the dot cannot be remembered.
  }
}
