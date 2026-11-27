// After a release, an open tab still asks for the previous build's page files, which no longer
// exist. Browsers word that failure differently, so match each known form.
const STALE_MODULE_MESSAGES = [
  /error loading dynamically imported module/i, // Firefox
  /failed to fetch dynamically imported module/i, // Chromium
  /importing a module script failed/i, // Safari
];

const MARKER_PREFIX = "njpbs:stale-module-reload:";

export function isStaleModuleError(error: unknown): boolean {
  return error instanceof Error && STALE_MODULE_MESSAGES.some((pattern) => pattern.test(error.message));
}

// Reload once per missing file. The marker is keyed by the file named in the error, so a second
// failure for the same file shows the error panel instead of looping, while a later release (new
// file names) can still reload. Returns the marker key when a reload should start, else null.
export function staleModuleReloadKey(
  error: unknown,
  storage: Pick<Storage, "getItem"> | null,
): string | null {
  if (!storage || !isStaleModuleError(error)) return null;
  const message = (error as Error).message;
  const key = MARKER_PREFIX + (message.match(/https?:\/\/\S+/)?.[0] ?? message);
  try {
    return storage.getItem(key) === null ? key : null;
  } catch {
    return null;
  }
}

// Records the attempt before reloading. If the marker cannot be written, no reload happens,
// because nothing would stop the next failure from reloading again.
export function markAndReload(storage: Pick<Storage, "setItem">, key: string, reload: () => void): void {
  try {
    storage.setItem(key, "1");
  } catch {
    return;
  }
  reload();
}
