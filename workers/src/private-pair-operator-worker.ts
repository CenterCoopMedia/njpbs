import { authorizePrivatePairRequest, privatePairResponse, readPrivatePairBody, type PrivatePairAccessEnvironment } from "./private-pair-access";
import { PAIR_OPERATOR_PROVE_PATH, PAIR_OPERATOR_CAPTURE_PATH, PAIR_READER_REQUEST_LIMIT } from "../../packages/content-core/src/private-pair-http";

export type PrivatePairOperatorEnvironment = PrivatePairAccessEnvironment & {
  PAIR_PROOF_ORIGIN?: string;
  PAIR_READER_ACCESS_JSON?: string;
  PAIR_INGRESS_PROOF: {
    prove(request: Request, digest: string, expected: { status: 200 | 302 | 308 | 410 }): Promise<Response>;
    captureRecovery(): Promise<void>;
  };
};
/** Operator-only bridge to the existing ingress authority. It has no selector,
 * arbitrary service name, storage binding, install or publication operation. */
export default { async fetch(request: Request, env: PrivatePairOperatorEnvironment): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || path !== PAIR_OPERATOR_PROVE_PATH && path !== PAIR_OPERATOR_CAPTURE_PATH) return privatePairResponse(404);
  try {
    const readers = JSON.parse(env.PAIR_READER_ACCESS_JSON ?? "null");
    if (!Array.isArray(readers) || readers.length !== 2 || readers.some(reader => !reader ||
        typeof reader !== "object" || Object.keys(reader).sort().join(",") !== "audience,clientId" ||
        !/^[a-f0-9]{64}$/.test(reader.audience) || !/^[a-zA-Z0-9]+\.access$/.test(reader.clientId) ||
        reader.audience === env.PAIR_ACCESS_AUDIENCE || reader.clientId === env.PAIR_ACCESS_CLIENT_ID)) return privatePairResponse(403);
    if (!await authorizePrivatePairRequest(request, env)) return privatePairResponse(403);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readPrivatePairBody(request, PAIR_READER_REQUEST_LIMIT)));
    if (!value || typeof value !== "object" || Array.isArray(value)) return privatePairResponse(400);
    if (path === PAIR_OPERATOR_CAPTURE_PATH) {
      if (Object.keys(value).length) return privatePairResponse(400);
      await env.PAIR_INGRESS_PROOF.captureRecovery();
      return privatePairResponse(204);
    }
    if (Object.keys(value).sort().join(",") !== "bodyDigest,path,status" ||
        typeof value.path !== "string" || value.path.length > 1024 ||
        !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(value.path) ||
        value.path.split("/").some((part: string) => part === "." || part === "..") ||
        !/^[a-f0-9]{64}$/.test(value.bodyDigest) || ![200, 302, 308, 410].includes(value.status) ||
        !["https://dev-public.example.org", "https://njpbs.org"].includes(env.PAIR_PROOF_ORIGIN ?? "")) return privatePairResponse(400);
    const proof = await env.PAIR_INGRESS_PROOF.prove(new Request(`${env.PAIR_PROOF_ORIGIN}${value.path}`), value.bodyDigest, { status: value.status });
    // Preserve the actual proof headers and bytes, including native 308/410.
    const headers = new Headers(proof.headers);
    headers.set("cache-control", "private, no-store");
    return new Response(proof.body, { status: proof.status, headers });
  } catch { return privatePairResponse(503); }
} };
