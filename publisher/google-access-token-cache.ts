const MAX_ENTRIES = 8;
const REFRESH_MARGIN_MS = 60_000;
const MAX_LIFETIME_SECONDS = 3_600;

type Entry = { startedAt: number; expiresAt: number; token: string };
const entries = new Map<string, Entry>();

/** In-isolate reuse for the fixed Google datastore scope. Fingerprints include
 * the project and complete credential so rotation cannot reuse an older token.
 * Only resolved strings are shared; pending I/O belongs to its own request. */
export async function cachedDatastoreToken(account: string, projectId: string,
  mint: () => Promise<{ value: string; expiresIn: unknown }>): Promise<string> {
  const fingerprint = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`google-datastore-v1:${projectId}:${account}`));
  const key = Array.from(new Uint8Array(fingerprint), byte => byte.toString(16).padStart(2, "0")).join("");
  const startedAt = Date.now();
  const cached = entries.get(key);
  if (cached && startedAt >= cached.startedAt && startedAt < cached.expiresAt) return cached.token;
  entries.delete(key);
  // A concurrent caller mints independently, retaining its own abort deadline.
  const { value, expiresIn } = await mint();
  if (typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn > 0) {
    const expiresAt = startedAt + Math.min(expiresIn, MAX_LIFETIME_SECONDS) * 1000 - REFRESH_MARGIN_MS;
    if (Date.now() >= startedAt && Date.now() < expiresAt) {
      entries.set(key, { startedAt, expiresAt, token: value });
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    }
  }
  return value; // An unknown lifetime is never guessed.
}
