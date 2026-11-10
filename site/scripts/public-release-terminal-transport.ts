import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { originFor } from "../../packages/content-core/src/public-release-routing";
import { isPublicPairRequestPath } from "../../workers/src/public-release-view-reader";
import type { PairViewStore } from "./public-release-pair-view-storage";
import type { PublicReleaseCanonicalIngress } from "./public-release-publication-terminal";
import work from "../../functions/lib/public-release-pair-work.js";

/** No credentials or caller-selected destination. Only the explicitly enabled
 * container's private egress interceptor can answer this fixed host. */
export function publicReleaseTerminalTransport(environment: PublicReleasePair["environment"]): {
  store: PairViewStore; ingress: PublicReleaseCanonicalIngress;
} {
  const origin = originFor(environment), base = "http://pair-terminal.internal";
  const unavailable = (): never => { throw new work.PairExecutionError("storage-unavailable"); };
  return {
    store: {
      async get(key) {
        if (!/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) unavailable();
        let response: Response;
        try { response = await fetch(`${base}/objects/${key}`, { redirect: "error", signal: AbortSignal.timeout(30_000) }); }
        catch { return unavailable(); }
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); return unavailable(); }
        const size = Number(response.headers.get("content-length"));
        let customMetadata: Record<string, string>;
        try { customMetadata = JSON.parse(response.headers.get("x-pair-metadata") ?? "null"); }
        catch { await response.body?.cancel().catch(() => {}); return unavailable(); }
        if (!response.headers.has("content-length") || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 ||
            !customMetadata || typeof customMetadata !== "object" || Array.isArray(customMetadata) ||
            Object.values(customMetadata).some(value => typeof value !== "string") || !response.body && size !== 0) {
          await response.body?.cancel().catch(() => {}); return unavailable();
        }
        return { size, customMetadata, body: response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
      },
      async put() { return unavailable(); },
    },
    ingress: {
      async prove(request, expectedBodyDigest, expected) {
        const url = new URL(request.url);
        let path: string;
        try { path = decodeURI(url.pathname); } catch { return unavailable(); }
        if (request.method !== "GET" || url.origin !== origin || url.search || url.hash || url.username || url.password ||
            !isPublicPairRequestPath(path) || path.startsWith("/_pair-") || new URL(`${origin}${path}`).pathname !== url.pathname ||
            !/^[a-f0-9]{64}$/.test(expectedBodyDigest) || ![200, 302, 308, 410].includes(expected.status)) unavailable();
        const query = new URLSearchParams({ path, digest: expectedBodyDigest, status: String(expected.status) });
        return fetch(`${base}/prove?${query}`, { redirect: "manual", signal: request.signal });
      },
    },
  };
}
