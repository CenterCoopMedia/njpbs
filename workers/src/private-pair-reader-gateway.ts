import { PAIR_READER_PATH } from "../../packages/content-core/src/private-pair-http";
import { privatePairResponse } from "./private-pair-access";

export type PrivatePairReaderGatewayEnvironment = {
  PAIR_READER_GATEWAY_ENABLED?: string; PAIR_PRIVATE_ORIGIN?: string;
  PAIR_SLOT_READER: { readPrivatePairHttp(request: Request): Promise<Response> };
};
/** Only this Access-protected gateway receives a hostname. The actual slot
 * keeps no routes or domains and verifies the signed assertion itself. */
export default { async fetch(request: Request, env: PrivatePairReaderGatewayEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (env.PAIR_READER_GATEWAY_ENABLED !== "true" || request.method !== "POST" || url.pathname !== PAIR_READER_PATH ||
      url.protocol !== "https:" || url.origin !== env.PAIR_PRIVATE_ORIGIN || url.search || url.hash) return privatePairResponse(404);
  try {
    const headers = new Headers();
    for (const name of ["cf-access-jwt-assertion", "content-type", "content-length"]) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    return await env.PAIR_SLOT_READER.readPrivatePairHttp(new Request(request, { headers }));
  } catch { return privatePairResponse(503); }
} };
