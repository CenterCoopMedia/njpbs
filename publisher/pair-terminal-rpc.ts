import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { isPublicPairRequestPath } from "../workers/src/public-release-view-reader";
import { originFor } from "../packages/content-core/src/public-release-routing";
import { pairBootstrapProofRpc } from "./pair-bootstrap-proof-rpc";

export const PAIR_TERMINAL_HOST = "pair-terminal.internal";
export type PairCanonicalProofBinding = { prove(request: Request, digest: string, expected: { status: 200 | 302 | 308 | 410 }): Promise<Response> };
type Authority = { pair: PublicReleasePair; read(path: string): Promise<Record<string, unknown> | null> };
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const allowedControl = (row: Record<string, unknown> | null, pair: PublicReleasePair) => row &&
  Object.keys(row).sort().join(",") === "pairId,schemaVersion,status" && row.schemaVersion === 2 && row.pairId === pair.pairId &&
  ["candidate", "retained"].includes(String(row.status));

/** Private container egress only. The old storage endpoint is unchanged.
 * This separate endpoint never writes, lists or opens a legacy object. */
export async function pairTerminalRpc(request: Request, bucket: Pick<R2Bucket, "get">, authority: Authority,
  ingress: PairCanonicalProofBinding, options?: Readonly<{ bootstrapProof?: true }>): Promise<Response> {
  if (new URL(request.url).pathname === "/bootstrap-prove")
    return options?.bootstrapProof === true ? pairBootstrapProofRpc(request, authority, ingress) : new Response(null, { status: 403 });
  const refuse = () => new Response(null, { status: 403 }), url = new URL(request.url), pair = authority.pair;
  if (request.method !== "GET" || url.protocol !== "http:" || url.hostname !== PAIR_TERMINAL_HOST || url.port ||
      url.username || url.password || url.hash || !ingress || typeof ingress.prove !== "function") return refuse();
  work.assertPrivatePairResources(pair);
  const [control, billing, root, adoption] = await Promise.all([authority.read(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`),
    authority.read("system/billing"), authority.read("system/publicDeployment"), authority.read("system/publicReleaseAdmissions/controls/adoption")]);
  if (billing?.disabled === true) return new Response(null, { status: 503 });
  if (!allowedControl(control, pair) || adoption?.schemaVersion !== 2 || adoption.enabled !== true ||
      Object.keys(adoption).sort().join(",") !== "enabled,schemaVersion") return refuse();
  const selector = protocol.parseStoredPublicReleaseSelector(root);
  const references = [selector.selectedPair, selector.recoveryPair];
  const pairs = new Map([[pair.pairId, pair]]);
  // These are independent fresh reads inside this GET, never a routing
  // cache. Wait for all and retain the former pair/control error precedence.
  const observed = await Promise.all(references.map(reference => Promise.allSettled([
    authority.read(work.publicReleasePairPath(reference.pairId)),
    reference.pairId === pair.pairId ? Promise.resolve(control) :
      authority.read(`${work.publicReleasePairPath(reference.pairId)}/controls/runtime`),
  ])));
  for (const [index, reference] of references.entries()) {
    const [registered, runtime] = observed[index];
    if (registered.status === "rejected") throw registered.reason;
    const selected = protocol.parsePublicReleasePair(registered.value);
    work.assertPrivatePairResources(selected);
    if (!same(protocol.publicReleasePairReference(selected), reference) || selected.environment !== pair.environment) return refuse();
    if (runtime.status === "rejected") throw runtime.reason;
    if (!allowedControl(runtime.value, selected)) return refuse();
    pairs.set(selected.pairId, selected);
  }
  if (url.pathname === "/prove") {
    if ([...url.searchParams.keys()].sort().join(",") !== "digest,path,status") return refuse();
    const path = url.searchParams.get("path")!, digest = url.searchParams.get("digest")!, status = Number(url.searchParams.get("status"));
    if (!isPublicPairRequestPath(path) || path.startsWith("/_pair-") || !/^[a-f0-9]{64}$/.test(digest) ||
        String(status) !== url.searchParams.get("status") || ![200, 302, 308, 410].includes(status)) return refuse();
    return ingress.prove(new Request(`${originFor(pair.environment)}${path}`, { method: "GET", redirect: "manual", signal: request.signal }),
      digest, { status: status as 200 | 302 | 308 | 410 });
  }
  if (url.search || !url.pathname.startsWith("/objects/")) return refuse();
  const key = url.pathname.slice("/objects/".length);
  if (!/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..")) return refuse();
  const owner = [...pairs.values()].find(side => {
    const input = `release-pair-inputs/v2/${side.pairId}/`, view = `release-pairs/${side.pairId}/`,
      replay = `release-pair-replay/v2/${protocol.publicReleaseDigest(side)}/`;
    return key.startsWith(input) && /^(objects|manifests)\/[a-f0-9]{64}\.json$/.test(key.slice(input.length)) ||
      key.startsWith(view) && /^[a-f0-9]{64}\/claims\/[a-f0-9]{64}\/(objects\/[a-f0-9]{64}|(?:pages|views)\/[a-f0-9]{64}\.json)$/.test(key.slice(view.length)) ||
      key.startsWith(replay) && /^(pages|selections)\/[a-f0-9]{64}\.json$/.test(key.slice(replay.length));
  });
  if (!owner) return refuse();
  const object = await bucket.get(key);
  if (!object) return new Response(null, { status: 404 });
  const objectSize = object.size;
  if (objectSize > 16 * 1024 * 1024) { await object.body.cancel(); return refuse(); }
  return new Response(object.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
    "content-length": String(objectSize), "x-pair-metadata": JSON.stringify(object.customMetadata ?? {}) } });
}
