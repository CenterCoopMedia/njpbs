import { jwtVerify } from "jose";
import { accessTeamKeys } from "./access-team-keys";
export type PrivatePairAccessEnvironment = {
  PAIR_PRIVATE_HTTP_ENABLED?: string; PAIR_PRIVATE_ORIGIN?: string;
  PAIR_ACCESS_AUDIENCE?: string; PAIR_ACCESS_CLIENT_ID?: string;
  CMS_DEV_ACCESS_ORIGIN?: string;
};
export const privatePairResponse = (status: number) => new Response(null, {
  status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
});

/** Access verifies the service-token secret. The Worker independently verifies
 * its signed application assertion and the one permitted machine identity. */
export async function authorizePrivatePairRequest(request: Request, env: PrivatePairAccessEnvironment): Promise<boolean> {
  if (env.PAIR_PRIVATE_HTTP_ENABLED !== "true" || !env.PAIR_PRIVATE_ORIGIN ||
      !/^[a-f0-9]{64}$/.test(env.PAIR_ACCESS_AUDIENCE ?? "") ||
      !/^[a-zA-Z0-9]+\.access$/.test(env.PAIR_ACCESS_CLIENT_ID ?? "")) return false;
  const configured = new URL(env.PAIR_PRIVATE_ORIGIN), url = new URL(request.url);
  if (configured.protocol !== "https:" || configured.origin !== env.PAIR_PRIVATE_ORIGIN ||
      configured.username || configured.password || url.origin !== configured.origin || url.search || url.hash) return false;
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion || assertion.length > 8192) return false;
  try {
    const { issuer, keys } = accessTeamKeys(env.CMS_DEV_ACCESS_ORIGIN, 3_000);
    const { payload } = await jwtVerify(assertion, keys, { algorithms: ["RS256"], issuer,
      audience: env.PAIR_ACCESS_AUDIENCE, requiredClaims: ["exp", "iat", "sub", "common_name"] });
    return payload.type === "app" && payload.sub === "" && !Object.hasOwn(payload, "email") &&
      payload.common_name === env.PAIR_ACCESS_CLIENT_ID && typeof payload.iat === "number" &&
      payload.iat <= Math.floor(Date.now() / 1000);
  } catch { return false; }
}

export async function readPrivatePairBody(request: Request, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (request.headers.get("content-type") !== "application/json") throw new Error("Private request refused");
  const lengthHeader = request.headers.get("content-length");
  if (!lengthHeader || !/^(0|[1-9][0-9]*)$/.test(lengthHeader)) throw new Error("Private request refused");
  const expected = Number(lengthHeader);
  if (!Number.isSafeInteger(expected) || expected > maximumBytes) throw new Error("Private request refused");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3_000)]);
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  if (!reader) throw new Error("Private request refused");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new Error("Private request refused");
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    if (length !== expected) throw new Error("Private request refused");
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
