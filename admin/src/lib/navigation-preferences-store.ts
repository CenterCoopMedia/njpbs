import { cmsSetNavigationPreferences, cmsShareNavigationItem } from "./functions";
import { parseNavigationPreferences, type NavigationPreferences } from "./navigation-preferences";

// The CMS API validates custom items before changing only the signed-in owner's
// navigation field. The existing live profile listener updates the rail in every tab.
const FAILED = "Your rail could not be saved. Try again.";
type TokenProvider = (() => Promise<string>) | undefined;

async function writeNavigationField(
  getIdToken: TokenProvider,
  value: NavigationPreferences | null,
  sharedItemIds?: readonly string[],
): Promise<void> {
  try {
    if (!getIdToken) throw new Error("Session is unavailable");
    await cmsSetNavigationPreferences(await getIdToken(), value, sharedItemIds);
  } catch {
    throw new Error(FAILED);
  }
}

export async function saveNavigationPreferences(
  getIdToken: TokenProvider,
  preferences: NavigationPreferences,
  sharedItemIds?: readonly string[],
): Promise<void> {
  const parsed = parseNavigationPreferences(preferences);
  if (!parsed) throw new Error(FAILED);
  await writeNavigationField(getIdToken, parsed, sharedItemIds);
}

/** Reset clears the stored record rather than storing a copy of the default. */
export async function resetNavigationPreferences(getIdToken: TokenProvider): Promise<void> {
  await writeNavigationField(getIdToken, null);
}

/** Toggle one owned plank or span. This request has no navigation snapshot. */
export async function shareNavigationItem(
  getIdToken: TokenProvider,
  itemId: string,
  shared: boolean,
): Promise<void> {
  try {
    if (!getIdToken) throw new Error("Session is unavailable");
    await cmsShareNavigationItem(await getIdToken(), itemId, shared);
  } catch {
    throw new Error(FAILED);
  }
}
