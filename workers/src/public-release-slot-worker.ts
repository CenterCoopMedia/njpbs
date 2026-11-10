import { WorkerEntrypoint } from "cloudflare:workers";
import protocol from "../../functions/lib/public-release-pair.js";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import type { PairServingDecision } from "../../functions/lib/public-release-serving";
import { canonicalReleaseValue } from "../../packages/content-core/src/public-release-routing";
import { createPublicReleaseSlot } from "./public-release-slot";
import type { PairReadStore } from "./public-release-view-reader";
import type { SlotReply } from "./public-release-router";
import { authorizePrivatePairRequest, privatePairResponse, readPrivatePairBody, type PrivatePairAccessEnvironment } from "./private-pair-access";
import { PAIR_READER_PATH, PAIR_READER_REQUEST_LIMIT } from "../../packages/content-core/src/private-pair-http";
import { privatePairReaderInstallation, privatePairReaderDeployment } from "./private-pair-reader-installation";

export type PublicReleaseSlotEnvironment = PrivatePairAccessEnvironment & {
  PUBLIC_PAIR_SLOT_ENABLED?: string; PUBLIC_PAIR_IDENTITY_JSON?: string;
  PAIR_WORKER_VERSION: { id: string }; PAIR_CONTENT: PairReadStore;
  CMS_API: { getReleaseDecision(selection: SelectorReceipt, pair: PublicReleasePair, path: string, budgetMs?: number, proof?: boolean): Promise<PairServingDecision | { kind: "reselect" }> };
  PAIR_READER?: {
    readPrivatePair(request: Request, pair: PublicReleasePair): Promise<Response>;
    readerInstallation(pair: PublicReleasePair): Promise<unknown>;
  };
};
/** Stable fields can be embedded before upload; provider UUID is checked against
 * runtime metadata, never embedded in the version receiving that UUID. */
export function assertEmbeddedPublicSlot(env: PublicReleaseSlotEnvironment, rawPair: PublicReleasePair): PublicReleasePair {
  const pair = protocol.parsePublicReleasePair(rawPair);
  privatePairReaderInstallation(pair, env.PAIR_PRIVATE_ORIGIN ?? "");
  const { versionId, ...publicWorker } = pair.publicWorker;
  const { readerReceiptDigest: _runtimeReceipt, ...stable } = pair;
  if (versionId !== env.PAIR_WORKER_VERSION.id ||
      canonicalReleaseValue(JSON.parse(env.PUBLIC_PAIR_IDENTITY_JSON ?? "null")) !== canonicalReleaseValue({ ...stable, publicWorker })) {
    throw new Error("Private slot identity was refused");
  }
  return pair;
}
export class PublicReleaseSlotEntrypoint extends WorkerEntrypoint<PublicReleaseSlotEnvironment> {
  async readPrivatePairHttp(request: Request) { return readPrivatePairHttp(request, this.env); }
  async readerInstallation() {
    const pair = embeddedReaderPair(this.env);
    const seals = privatePairReaderInstallation(pair, this.env.PAIR_PRIVATE_ORIGIN ?? "");
    if (!this.env.PAIR_READER) throw new Error("Private reader binding unavailable");
    return { seals, publisher: await this.env.PAIR_READER.readerInstallation(pair) };
  }
  async serve(request: Request, selection: SelectorReceipt, rawPair: PublicReleasePair, proof = false, budgetMs = 3_000): Promise<SlotReply> {
    if (this.env.PUBLIC_PAIR_SLOT_ENABLED !== "true") throw new Error("Private slot is disabled");
    const pair = assertEmbeddedPublicSlot(this.env, rawPair);
    return createPublicReleaseSlot({ pair, workerVersionId: this.env.PAIR_WORKER_VERSION.id, store: this.env.PAIR_CONTENT,
      getDecision: (selected, path, remaining) => this.env.CMS_API.getReleaseDecision(selected, pair, path, remaining, proof === true) }).serve(request, selection, proof === true, budgetMs);
  }
}
function embeddedReaderPair(env: PublicReleaseSlotEnvironment): PublicReleasePair {
  const stable = JSON.parse(env.PUBLIC_PAIR_IDENTITY_JSON ?? "null");
  const runtime = { ...stable, publicWorker: { ...stable?.publicWorker, versionId: env.PAIR_WORKER_VERSION.id } };
  const pair = protocol.parsePublicReleasePair({ ...runtime,
    readerReceiptDigest: protocol.publicReleaseDigest(privatePairReaderDeployment(runtime, env.PAIR_PRIVATE_ORIGIN ?? "")) });
  return assertEmbeddedPublicSlot(env, pair);
}
// The serving RPC remains private. This separate, disabled-by-default endpoint
// only reads exact settled G bytes; it cannot invoke serve or select a pair.
export async function readPrivatePairHttp(request: Request, env: PublicReleaseSlotEnvironment): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== PAIR_READER_PATH) return privatePairResponse(404);
  try {
    if (!await authorizePrivatePairRequest(request, env)) return privatePairResponse(403);
    const pair = embeddedReaderPair(env);
    privatePairReaderInstallation(pair, env.PAIR_PRIVATE_ORIGIN!);
    if (!env.PAIR_READER) return privatePairResponse(503);
    const body = await readPrivatePairBody(request, PAIR_READER_REQUEST_LIMIT);
    // Only the body and content type cross the binding. Access credentials,
    // cookies, client routing headers and assertions never enter the container.
    const result = await env.PAIR_READER.readPrivatePair(new Request(`${env.PAIR_PRIVATE_ORIGIN}${PAIR_READER_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body }), pair);
    const headers = new Headers({ "content-type": "application/json", "cache-control": "private, no-store" });
    if (result.status !== 200 || result.headers.get("content-type") !== "application/json" ||
        result.headers.get("cache-control") !== "private, no-store") { await result.body?.cancel(); return privatePairResponse(503); }
    return new Response(result.body, { headers });
  } catch { return privatePairResponse(503); }
}
export default { fetch: readPrivatePairHttp };
