import { PAIR_OPERATOR_CAPTURE_PATH, PAIR_OPERATOR_PROVE_PATH } from "../../packages/content-core/src/private-pair-http.mjs";

/** No in-process success callback: both operations use authenticated HTTPS.
 * credentials() supplies CF-Access-Client-Id/Secret only at request time. */
export function createPrivatePairOperatorClient({ origin, credentials }: {
  origin: string; credentials(): Promise<HeadersInit>;
}) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Private pair operator refused");
  const call = async (path: string, body: unknown, signal?: AbortSignal) => {
    try {
      const headers = new Headers(await credentials());
      if (!headers.get("CF-Access-Client-Id") || !headers.get("CF-Access-Client-Secret")) throw new Error();
      headers.set("content-type", "application/json");
      const encoded = JSON.stringify(body);
      headers.set("content-length", String(new TextEncoder().encode(encoded).byteLength));
      const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: encoded,
        redirect: "manual", cache: "no-store", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]) });
      if (response.headers.get("cache-control") !== "private, no-store") {
        await response.body?.cancel(); throw new Error();
      }
      return response;
    } catch { throw new Error("Private pair operator unavailable"); }
  };
  return {
    async prove({ path, bodyDigest, status, signal }: { path: string; bodyDigest: string; status: 200 | 302 | 308 | 410; signal?: AbortSignal }) {
      const response = await call(PAIR_OPERATOR_PROVE_PATH, { path, bodyDigest, status }, signal);
      if (response.status !== status) { await response.body?.cancel(); throw new Error("Private pair proof unavailable"); }
      return response;
    },
    async captureRecovery(signal?: AbortSignal) {
      const response = await call(PAIR_OPERATOR_CAPTURE_PATH, {}, signal);
      await response.body?.cancel();
      if (response.status !== 204) throw new Error("Private pair recovery capture unavailable");
    },
  };
}
