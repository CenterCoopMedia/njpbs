// After a release, an open tab still asks for the previous build's page files, which no longer
// exist. Browsers and Vite word that failure differently, so match each known form.
const STALE_MODULE_MESSAGES = [
  /error loading dynamically imported module/i, // Firefox
  /failed to fetch dynamically imported module/i, // Chromium
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite, when a lazy page's stylesheet is gone
];

const MARKER_PREFIX = "njpbs:stale-module-reload:";

export function isStaleModuleError(error: unknown): boolean {
  return error instanceof Error && STALE_MODULE_MESSAGES.some((pattern) => pattern.test(error.message));
}

// Reload once per loaded build and missing file. A second failure in the same build shows the
// error panel instead of looping. After a reload the tab runs the new build, so a failure after a
// later release gets its own attempt even when the browser names no file (Safari).
// Returns the marker key when a reload should start, else null.
export function staleModuleReloadKey(
  error: unknown,
  storage: Pick<Storage, "getItem"> | null,
  loadedBuild: string | null,
): string | null {
  if (!storage || !isStaleModuleError(error)) return null;
  const message = (error as Error).message;
  const file = message.match(/https?:\/\/\S+|\/assets\/\S+/)?.[0] ?? "unnamed";
  const key = `${MARKER_PREFIX}${loadedBuild ?? "unknown"}:${file}`;
  try {
    return storage.getItem(key) === null ? key : null;
  } catch {
    return null;
  }
}

// Records the attempt, then reloads. Returns false without reloading when the marker cannot be
// written, because nothing would then stop the next failure from reloading again.
export function markAndReload(storage: Pick<Storage, "setItem">, key: string, reload: () => void): boolean {
  try {
    storage.setItem(key, "1");
  } catch {
    return false;
  }
  reload();
  return true;
}
