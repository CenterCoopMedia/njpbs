import { FirebaseTokenError, verifyFirebaseIdToken } from "./firebase-auth";

export interface ReaderBridgeTarget {
  version: 1 | 2;
  functionsUrl: string;
  gatewayReaderDigest: string;
}
const MAX_BYTES = 2 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;

/** Mount only inside the existing CMS origin/CORS/AppCheck/rate gates. There is
 * no default route, binding, flag or target. The Functions bridge rechecks fresh
 * staff permissions, revocation and both nonrenewable leases on every request.
 */
export function createCmsReaderBridge({ targets, projectId, readEdgeSecret,
  request = fetch, verifyToken = verifyFirebaseIdToken,
}: {
  targets: readonly ReaderBridgeTarget[];
  projectId: string;
  readEdgeSecret: () => string;
  request?: typeof fetch;
  verifyToken?: typeof verifyFirebaseIdToken;
}) {
  if (!["njpbs-site", "njpbs-site-dev"].includes(projectId) || !targets.length || targets.length > 2 || new Set(targets.map(t => t.version)).size !== targets.length) {
    throw new Error("Versioned CMS reader configuration refused");
  }
  const routes = new Map<string, Readonly<ReaderBridgeTarget>>(targets.map(target => {
    const url = new URL(target.functionsUrl);
    if (![1, 2].includes(target.version) || !digest.test(target.gatewayReaderDigest) || url.protocol !== "https:" ||
        url.username || url.password || url.port || url.search || url.hash ||
        url.hostname !== `us-central1-${projectId}.cloudfunctions.net` || !/^\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      throw new Error("Versioned CMS reader configuration refused");
    }
    return [`/api/cms/v${target.version}/reader`, Object.freeze({ ...target })] as const;
  }));
  return async (incoming: Request, context?: { requestId: string; clientIp: string | null }): Promise<Response | null> => {
    const url = new URL(incoming.url), target = routes.get(url.pathname);
    if (!target) return null;
    const refused = (status: number) => Response.json({ error: "Versioned CMS reader unavailable" }, {
      status, headers: { "cache-control": "private, no-store" },
    });
    if (!context || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.requestId) ||
        context.clientIp !== null && (typeof context.clientIp !== "string" || !/^[a-fA-F0-9:.]{2,64}$/.test(context.clientIp))) return refused(503);
    if (url.search || incoming.method !== "POST" || !incoming.headers.get("content-type")?.startsWith("application/json")) return refused(400);
    const authorization = incoming.headers.get("authorization");
    const token = /^Bearer ([^\s]{1,16384})$/.exec(authorization ?? "")?.[1];
    if (!token) return refused(401);
    try { await verifyToken(token, projectId); } catch (error) { return refused(error instanceof FirebaseTokenError ? 401 : 503); }
    // Bound actual streamed bytes even if Content-Length is missing or false.
    const reader = incoming.body?.getReader();
    if (!reader) return refused(400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length; if (length > MAX_BYTES) return refused(413);
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value: { version?: unknown; action?: unknown; endpoint?: unknown };
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return refused(400); }
    if (!value || value.version !== target.version) return refused(400);
    try {
      const edge = readEdgeSecret(); if (!edge || /[\r\n]/.test(edge)) return refused(503);
      // Forward only named headers; never accept client reader/edge stamps.
      const upstream = await request(target.functionsUrl, {
        method: "POST", redirect: "error", signal: incoming.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "x-njpbs-cms-edge": edge, "x-njpbs-cms-reader": target.gatewayReaderDigest,
          "x-njpbs-request-id": context.requestId,
          ...(context.clientIp ? { "x-njpbs-client-ip": context.clientIp } : {}),
          ...(incoming.headers.has("x-firebase-appcheck") ? { "x-firebase-appcheck": incoming.headers.get("x-firebase-appcheck")! } : {}),
        }, body: bytes,
      });
      if (upstream.headers.has("x-njpbs-gateway-reader") && upstream.headers.get("x-njpbs-gateway-reader") !== target.gatewayReaderDigest) {
        await upstream.body?.cancel(); return refused(503);
      }
      const headers = new Headers({ "cache-control": "private, no-store", "x-njpbs-gateway-reader": target.gatewayReaderDigest });
      for (const key of ["content-type", "retry-after", "x-njpbs-functions-reader"]) {
        const value = upstream.headers.get(key); if (value) headers.set(key, value);
      }
      // Only the authenticated preview handler can wake its accepted queue.
      // The mount consumes these private headers before replying to the browser.
      if (value.action === "request" && value.endpoint === "cmsPreview") {
        for (const key of ["x-njpbs-preview-wake", "x-njpbs-preview-pair"]) {
          const header = upstream.headers.get(key); if (header) headers.set(key, header);
        }
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch { return refused(503); }
  };
}
