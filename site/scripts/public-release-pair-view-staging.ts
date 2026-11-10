import { createHash } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewOutput } from "../../functions/lib/public-release-pair-view";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { readPublicReleasePairView, type PairViewStore } from "./public-release-pair-view-storage";

function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
async function rootBytes(store: PairViewStore, key: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const object = await store.get(key);
  if (!object) refuse();
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > view.VIEW_ROOT_BYTES_LIMIT) refuse();
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > object.size) refuse();
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (size !== object.size) refuse();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Durable private byte readback only. No candidate selection, fresh ownership
 * claim, capability grant or public settlement is made by this record. */
export async function stagePublicReleasePairView({ firestore, store, pair: rawPair, identity: rawIdentity,
  claimDigest, manifestDigest, signal, verify }: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair;
    identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal;
    verify?: { output(output: PairViewOutput & { body: Uint8Array }): Promise<void>; complete(): Promise<void> } }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(manifestDigest)) refuse();
  const taskId = protocol.publicReleaseDigest(identity), manifestKey =
    `${view.publicReleasePairViewPrefix(pair, identity, claimDigest)}views/${manifestDigest}.json`;
  const assertOwner = (transaction: Transaction) =>
    work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair, taskId, claimDigest, manifestDigest });
  // Refuse disabled/retired/uncompleted work before any storage read, then
  // recheck authority transactionally after the real byte readback.
  await firestore.runTransaction(assertOwner, { readOnly: true });
  const bytes = await rootBytes(store, manifestKey, signal);
  if (createHash("sha256").update(bytes).digest("hex") !== manifestDigest) refuse();
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse(); }
  const root = view.parsePublicReleasePairViewRoot(decoded, pair);
  if (root.claimDigest !== claimDigest || protocol.publicReleaseDigest(root.identity) !== taskId) refuse();
  const proof = createHash("sha256").update("private-pair-view-readback-v2\n").update(manifestDigest + "\n");
  let outputCount = 0, outputBytes = 0;
  for await (const output of readPublicReleasePairView({ store, pair, identity, claimDigest,
    manifestDigest, manifestBytes: bytes.byteLength, signal })) {
    await verify?.output(output);
    outputCount++; outputBytes += output.bytes;
    proof.update(JSON.stringify([output.path, output.status, protocol.publicReleaseDigest(output.headers),
      output.bodyDigest, output.bytes, output.objectKey]) + "\n");
  }
  await verify?.complete();
  if (outputCount !== root.outputCount || outputBytes !== root.outputBytes) refuse();
  const record = Object.freeze({ schemaVersion: 2 as const, status: "staged" as const, pairDigest: protocol.publicReleaseDigest(pair),
    taskId, identity, claimDigest, manifestDigest, manifestKey, manifestBytes: bytes.byteLength,
    outputCount, outputBytes, cursor: root.cursor, readbackDigest: proof.digest("hex") });
  signal?.throwIfAborted();
  return firestore.runTransaction(async transaction => {
    await assertOwner(transaction);
    const ref = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${manifestDigest}`);
    const before = await transaction.get(ref);
    signal?.throwIfAborted();
    if (before.exists) {
      if (protocol.publicReleaseDigest(before.data()) !== protocol.publicReleaseDigest(record)) refuse();
      return { idempotent: true, record };
    }
    transaction.create(ref, record);
    return { idempotent: false, record };
  });
}
