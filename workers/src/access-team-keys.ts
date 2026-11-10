import { createRemoteJWKSet } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The deployment supplies the issuer; requests cannot choose a signing-key host. */
export function accessTeamKeys(origin: string | undefined, timeoutDuration: number) {
  const url = new URL(origin ?? "");
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("Access issuer configuration is invalid");
  }
  const cacheKey = `${timeoutDuration}:${origin}`;
  let keys = keySets.get(cacheKey);
  if (!keys) {
    keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", url), {
      cacheMaxAge: 5 * 60_000, cooldownDuration: 30_000, timeoutDuration,
    });
    keySets.set(cacheKey, keys);
  }
  return { issuer: origin, keys };
}
