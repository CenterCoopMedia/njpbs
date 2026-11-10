import { createCmsReaderBridge } from "./cms-reader-bridge";
import { ENDPOINTS, type EndpointPolicy, type RateClass } from "./config";
import type { verifyFirebaseIdToken } from "./firebase-auth";

export interface CmsReaderMountEnvironment {
  CMS_READER_BRIDGE_ENABLED?: string;
  CMS_READER_BRIDGE_OPERATION_ID?: string;
  CMS_API_WORKER_VERSION?: { id: string };
}
export const READER_POLICY: EndpointPolicy = { contentType: "json", maxBytes: 2 * 1024 * 1024, rateClass: "read" };
const readPolicy: EndpointPolicy = { contentType: "json", maxBytes: 8 * 1024, rateClass: "read" };
const policies: Record<string, EndpointPolicy> = {
  cmsGetPublicPage: readPolicy, cmsGetPublishedSettings: readPolicy, cmsReadPairCurrentCodeV2: readPolicy,
  cmsPreview: ENDPOINTS.cmsPreview, cmsPreviewStatus: ENDPOINTS.cmsPreviewStatus,
};
export function cmsReaderVersion(path: string): 1 | 2 | null {
  return path === "/api/cms/v1/reader" ? 1 : path === "/api/cms/v2/reader" ? 2 : null;
}
const refused = (status = 503) => Response.json({ error: "Versioned CMS reader unavailable" }, {
  status, headers: { "cache-control": "private, no-store" },
});

class ReaderSessionRefused extends Error {
  constructor(readonly reason: unknown) { super("Reader session refused"); }
}

interface MountInput {
  request: Request; body: ArrayBuffer; version: 1 | 2;
  env: CmsReaderMountEnvironment & { FIREBASE_PROJECT_ID: string; FUNCTIONS_ORIGIN: string; CMS_EDGE_ORIGIN_SECRET: string };
  context: { requestId: string; clientIp: string | null };
  fetchOrigin: typeof fetch; verifyToken: typeof verifyFirebaseIdToken;
  checkRate: (rateClass: RateClass) => Promise<Response | null>;
}
function retainedRequestPolicy(envelope: any, version: 1 | 2): EndpointPolicy | Response {
  if (!envelope || envelope.version !== version || !["open", "request"].includes(envelope.action)) return refused(400);
  if (envelope.action === "open") return { ...READER_POLICY, rateClass: "mutation" };
  const policy = typeof envelope.endpoint === "string" && Object.hasOwn(policies, envelope.endpoint) ? policies[envelope.endpoint] : null;
  if (!policy || !envelope.body || typeof envelope.body !== "object" || Array.isArray(envelope.body)) return refused(400);
  return new TextEncoder().encode(JSON.stringify(envelope.body)).length > policy.maxBytes ? refused(413) : policy;
}
async function readGatewayReaderDescriptor({ request, version, env, context, fetchOrigin }: MountInput, functionsUrl: string) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
  const headers = new Headers({ "content-type": "application/json", authorization: request.headers.get("authorization")!,
    "x-njpbs-cms-edge": env.CMS_EDGE_ORIGIN_SECRET, "x-njpbs-request-id": context.requestId });
  if (context.clientIp) headers.set("x-njpbs-client-ip", context.clientIp);
  const appCheck = request.headers.get("x-firebase-appcheck");
  if (appCheck) headers.set("x-firebase-appcheck", appCheck);
  const reply = await fetchOrigin(functionsUrl, { method: "POST", redirect: "error", signal, headers,
    body: JSON.stringify({ version, action: "describe" }) });
  // The refusal body passes through the same size bound as a descriptor.
  if ((!reply.ok && reply.status !== 401) || reply.headers.get("content-type")?.split(";")[0] !== "application/json") {
    await reply.body?.cancel(); throw new Error("Reader descriptor unavailable");
  }
  const stream = reply.body?.getReader();
  if (!stream) throw new Error("Reader descriptor unavailable");
  let text = "", size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await stream.read(); if (part.done) break;
      size += part.value.length; if (size > 1024) throw new Error("Reader descriptor too large");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await stream.cancel(); }
  const descriptor = JSON.parse(text);
  if (reply.status === 401) {
    if (descriptor?.code === "session_expired") throw new ReaderSessionRefused(descriptor.reason);
    throw new Error("Reader descriptor unavailable");
  }
  if (!descriptor || Object.keys(descriptor).sort().join(",") !== "cmsApiReader,cmsApiVersion,functionsReader,operationId,schemaVersion,version" ||
      descriptor.schemaVersion !== 2 || descriptor.version !== version || descriptor.operationId !== env.CMS_READER_BRIDGE_OPERATION_ID ||
      !/^[a-f0-9]{64}$/.test(descriptor.functionsReader) || !/^[a-f0-9]{64}$/.test(descriptor.cmsApiReader) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(descriptor.cmsApiVersion) ||
      descriptor.cmsApiVersion !== env.CMS_API_WORKER_VERSION?.id) {
    throw new Error("Reader descriptor refused");
  }
  return descriptor as { functionsReader: string; cmsApiReader: string };
}

/** Called only after the shared origin/CORS, staff, IP/actor and body gates.
 * The existing endpoint owns descriptor authority. No new config store exists.
 */
export async function dispatchCmsReaderMount(input: MountInput): Promise<Response> {
  const { request, body, version, env, context, fetchOrigin, verifyToken, checkRate } = input;
  try {
    if (env.CMS_READER_BRIDGE_ENABLED !== "true" ||
        !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(env.CMS_READER_BRIDGE_OPERATION_ID ?? "") ||
        !["njpbs-site", "njpbs-site-dev"].includes(env.FIREBASE_PROJECT_ID) ||
        env.FUNCTIONS_ORIGIN !== `https://us-central1-${env.FIREBASE_PROJECT_ID}.cloudfunctions.net`) return refused();
    const envelope = JSON.parse(new TextDecoder().decode(body));
    const policy = retainedRequestPolicy(envelope, version);
    if (policy instanceof Response) return policy;
    if (policy.rateClass !== "read") {
      const limited = await checkRate(policy.rateClass);
      if (limited) return limited;
    }
    const functionsUrl = `${env.FUNCTIONS_ORIGIN}/cmsReaderV${version}`;
    const descriptor = await readGatewayReaderDescriptor(input, functionsUrl);
    const bridge = createCmsReaderBridge({ projectId: env.FIREBASE_PROJECT_ID, readEdgeSecret: () => env.CMS_EDGE_ORIGIN_SECRET,
      targets: [{ version, functionsUrl, gatewayReaderDigest: descriptor.cmsApiReader }], request: fetchOrigin, verifyToken });
    const result = await bridge(new Request(request.url, {
      method: "POST", headers: request.headers, signal: request.signal, body,
    }), context);
    if (!result) return refused();
    if (envelope.action === "request" && result.ok && result.headers.get("x-njpbs-functions-reader") !== descriptor.functionsReader) {
      await result.body?.cancel(); return refused();
    }
    return result;
  } catch (error) {
    if (!(error instanceof ReaderSessionRefused)) return refused();
    return Response.json({ error: "Versioned CMS reader unavailable", code: "session_expired",
      ...(error.reason === "token_expired" ? { reason: error.reason } : {}) }, {
      status: 401, headers: { "cache-control": "private, no-store" },
    });
  }
}
