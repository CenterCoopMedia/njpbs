import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { PAIR_STORAGE_BATCH_PATH, PAIR_STORAGE_BATCH_BODY_LIMIT, parsePairStorageBatchRequest,
  encodePairStorageBatchResult, pairStorageBatchMetadata, readPairStorageBatchJson, readPairStorageBytes,
  type PairStorageBatchResult } from "../packages/content-core/src/public-release-storage-batch";

const MAX_BYTES = 16 * 1024 * 1024;
export const PAIR_STORAGE_HOST = "pair-storage.internal";
type Authority = { pair: PublicReleasePair; read(path: string): Promise<Record<string, unknown> | null> };
type Claim = { taskId: string; claimDigest: string };
const refuse = () => new Response(null, { status: 403 });
function storageKey(pair: PublicReleasePair, key: string) {
  const inputPrefix = `release-pair-inputs/v2/${pair.pairId}/`, viewPrefix = `release-pairs/${pair.pairId}/`;
  const input = key.startsWith(inputPrefix) && /^(objects|manifests)\/[a-f0-9]{64}\.json$/.test(key.slice(inputPrefix.length));
  const view = key.startsWith(viewPrefix) ? /^([a-f0-9]{64})\/claims\/([a-f0-9]{64})\/(objects\/[a-f0-9]{64}|(?:pages|views)\/[a-f0-9]{64}\.json)$/.exec(key.slice(viewPrefix.length)) : null;
  return { input, view };
}
async function liveAccess(authority: Authority) {
  const base = work.publicReleasePairPath(authority.pair.pairId);
  const [control, billing] = await Promise.all([authority.read(`${base}/controls/runtime`), authority.read("system/billing")]);
  if (billing?.disabled === true) return new Response(null, { status: 503 });
  if (!control || Object.keys(control).sort().join(",") !== "pairId,schemaVersion,status" ||
      control.schemaVersion !== 2 || control.pairId !== authority.pair.pairId || typeof control.status !== "string" ||
      !["candidate", "retained"].includes(control.status)) return refuse();
}
async function liveClaim(authority: Authority, claim: Claim, now: number) {
  const base = work.publicReleasePairPath(authority.pair.pairId);
  const [task, journal] = await Promise.all([authority.read(`${base}/work/${claim.taskId}`),
    authority.read(`${base}/journals/${authority.pair.publisher.journalNamespace}`)]);
  const job = journal?.job as Record<string, unknown> | undefined;
  return !!task && task.status === "running" && task.claimDigest === claim.claimDigest && Number(task.leaseUntil) > now &&
    protocol.publicReleaseDigest(task.identity) === claim.taskId && job?.taskId === claim.taskId && job.claimDigest === claim.claimDigest &&
    job.leaseUntil === task.leaseUntil;
}
async function validPut(pair: PublicReleasePair, claim: Claim, key: string, bytes: Uint8Array<ArrayBuffer>, metadata: Record<string, string>) {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  return !!metadata && Object.keys(metadata).sort().join(",") === "bodydigest,claimdigest,pairdigest,schemaversion,taskid" &&
    metadata.schemaversion === "2" && metadata.pairdigest === protocol.publicReleaseDigest(pair) && metadata.taskid === claim.taskId &&
    metadata.claimdigest === claim.claimDigest && metadata.bodydigest === digest && (key.endsWith(digest) || key.endsWith(`${digest}.json`));
}
async function putCurrent(bucket: R2Bucket, authority: Authority, claim: Claim, key: string, bytes: Uint8Array<ArrayBuffer>, metadata: Record<string, string>) {
  // Every member retains the original fresh lease check after its body arrived.
  const current = await authority.read(`${work.publicReleasePairPath(authority.pair.pairId)}/work/${claim.taskId}`);
  if (current?.status !== "running" || current.claimDigest !== claim.claimDigest || Number(current.leaseUntil) <= Date.now()) return refuse();
  const result = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: metadata.bodydigest, customMetadata: metadata });
  return new Response(null, { status: result ? 201 : 412 });
}
async function getObject(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (!object) return new Response(null, { status: 404 });
  if (object.size > MAX_BYTES) { await object.body.cancel(); return refuse(); }
  return new Response(object.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
    "content-length": String(object.size), "x-pair-metadata": JSON.stringify(object.customMetadata ?? {}) } });
}
async function batchRpc(request: Request, bucket: R2Bucket, authority: Authority, claim: Claim | null, now: number) {
  const denied = await liveAccess(authority); if (denied) return denied;
  if (claim && !await liveClaim(authority, claim, now)) return refuse();
  const value = await readPairStorageBatchJson(request);
  let items;
  try { items = parsePairStorageBatchRequest(value, !!claim); } catch { return refuse(); }
  for (const item of items) {
    const selected = storageKey(authority.pair, item.key);
    if (!selected.input && !selected.view || claim && (!selected.view || selected.view[1] !== claim.taskId || selected.view[2] !== claim.claimDigest)) return refuse();
  }
  if (claim) {
    const checks = await Promise.allSettled(items.map(item => validPut(authority.pair, claim, item.key, item.body!, item.customMetadata!)));
    for (const check of checks) if (check.status === "rejected" || !check.value) return refuse();
  }
  const results = await Promise.allSettled(items.map(async (item): Promise<PairStorageBatchResult> => {
    const response = claim ? await putCurrent(bucket, authority, claim, item.key, item.body!, item.customMetadata!) : await getObject(bucket, item.key);
    if (response.status !== 200) { await response.body?.cancel(); return { key: item.key, status: response.status }; }
    const size = Number(response.headers.get("content-length")), customMetadata = JSON.parse(response.headers.get("x-pair-metadata")!);
    if (size > PAIR_STORAGE_BATCH_BODY_LIMIT || !pairStorageBatchMetadata(customMetadata)) {
      await response.body?.cancel(); return { key: item.key, status: 413 };
    }
    const body = await readPairStorageBytes(response, PAIR_STORAGE_BATCH_BODY_LIMIT);
    if (!body) throw new Error("Private storage response differs");
    return { key: item.key, status: 200, size, customMetadata, body };
  }));
  // All native reads/writes and body streams have settled, even on failure.
  if (results.some(result => result.status === "rejected")) return new Response(null, { status: 503 });
  const output = results.map(result => (result as PromiseFulfilledResult<PairStorageBatchResult>).value);
  const bytes = new TextEncoder().encode(encodePairStorageBatchResult(output));
  // Automatic JSON compression removes Content-Length during transport. The
  // private codec requires that exact bound before it allocates or decodes.
  return new Response(bytes as BodyInit, { headers: { "content-type": "application/json", "content-encoding": "identity",
    "cache-control": "no-store", "content-length": String(bytes.length) } });
}
/** Called only by Container's private egress interception, never public fetch.
 * Every request freshly checks live authority; batches never cache permission. */
export async function pairStorageRpc(request: Request, bucket: R2Bucket, authority: Authority, now = Date.now()) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.hostname !== PAIR_STORAGE_HOST || url.port || url.search) return refuse();
  const readBatch = url.pathname === `${PAIR_STORAGE_BATCH_PATH}/get`;
  const writeBatch = new RegExp(`^${PAIR_STORAGE_BATCH_PATH}/put/([a-f0-9]{64})/([a-f0-9]{64})$`).exec(url.pathname);
  if (request.method === "POST" && (readBatch || writeBatch)) return batchRpc(request, bucket, authority,
    writeBatch ? { taskId: writeBatch[1], claimDigest: writeBatch[2] } : null, now);
  if (!["GET", "PUT"].includes(request.method)) return refuse();
  const denied = await liveAccess(authority); if (denied) return denied;
  const key = url.pathname.slice(1), selected = storageKey(authority.pair, key);
  if (!selected.input && !selected.view || request.method === "PUT" && !selected.view) return refuse();
  if (request.method === "GET") return getObject(bucket, key);
  const claim = { taskId: selected.view![1], claimDigest: selected.view![2] };
  if (!await liveClaim(authority, claim, now)) return refuse();
  const bytes = await readPairStorageBytes(request, MAX_BYTES);
  if (!bytes) return refuse();
  let metadata: Record<string, string>;
  try { metadata = JSON.parse(request.headers.get("x-pair-metadata") ?? "null"); } catch { return refuse(); }
  if (!await validPut(authority.pair, claim, key, bytes, metadata) || request.headers.get("if-none-match") !== "*") return refuse();
  return putCurrent(bucket, authority, claim, key, bytes, metadata);
}
