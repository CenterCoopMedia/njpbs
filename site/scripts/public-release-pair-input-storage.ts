import { createHash } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputCursor, PairInputReceipt, PairInputSource } from "../../functions/lib/public-release-pair-input";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import input from "../../functions/lib/public-release-pair-input.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import mediaCoverage from "../../functions/lib/public-release-media-coverage.js";
import views from "../../functions/lib/public-release-pair-view.js";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { readPublicReleasePairVerifiedBytes } from "./public-release-pair-verified-read";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function mismatch(): never { throw new work.PairExecutionError("input-unavailable"); }
function active(signal?: AbortSignal) { signal?.throwIfAborted(); }
function seal(pair: PublicReleasePair, bodyDigest: string) {
  return { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: bodyDigest };
}
async function readInputObject(store: PairViewStore, key: string, size: number,
  expected: Record<string, string>, signal?: AbortSignal) {
  return readPublicReleasePairVerifiedBytes(store, key, size, expected, signal,
    () => readFreshInputObject(store, key, size, expected, signal));
}
async function readFreshInputObject(store: PairViewStore, key: string, size: number,
  expected: Record<string, string>, signal?: AbortSignal) {
  active(signal);
  const stored = await store.get(key);
  if (!stored) mismatch();
  const reader = stored.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    active(signal);
    if (stored.size !== size) mismatch();
    const customMetadata = stored.customMetadata;
    if (Object.entries(expected).some(([name, value]) => customMetadata?.[name] !== value)) mismatch();
    while (true) {
      active(signal);
      const next = await reader.read();
      active(signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > size) mismatch();
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (total !== size) mismatch();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (hash(bytes) !== expected.bodydigest) mismatch();
  return bytes;
}
async function putInputObject(store: PairViewStore, pair: PublicReleasePair, key: string, bytes: Uint8Array, signal?: AbortSignal) {
  active(signal);
  const bodyDigest = hash(bytes), metadata = seal(pair, bodyDigest);
  await store.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: bodyDigest, customMetadata: metadata });
  active(signal);
  await readInputObject(store, key, bytes.byteLength, metadata, signal);
}

/** Capture only private frozen inputs. This creates no task, staff operation,
 * selector or executor, and its cursor is not a fresh-qualification witness. */
export async function capturePublicReleasePairInput({ firestore, store, pair: rawPair, plan,
  expectedCursor, expectedSource, files, signal, bindSourceOperation = false }: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; plan: unknown;
    expectedCursor: PairInputCursor; expectedSource: PairInputSource;
    files: AsyncIterable<{ name: string; bytes: Uint8Array }>; signal?: AbortSignal; bindSourceOperation?: boolean }) {
  active(signal);
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  const root = input.parsePublicReleasePairInputRoot(plan, pair);
  if (protocol.publicReleaseDigest(root.cursor) !== protocol.publicReleaseDigest(expectedCursor) ||
      protocol.publicReleaseDigest(root.source) !== protocol.publicReleaseDigest(input.parsePublicReleasePairInputSource(expectedSource))) mismatch();
  const bytes = encode(root), inputManifestDigest = hash(bytes), manifestKey = input.publicReleasePairInputRootKey(pair, inputManifestDigest);
  const assertOwner = (transaction: Transaction) => work.assertPublicReleasePairInputOwnerInTransaction({
    firestore, transaction, pair, scope: root.scope, inputManifestDigest });
  await firestore.runTransaction(assertOwner, { readOnly: true });
  const inventory = new Map(root.files.map(file => [file.name, file])), seen = new Set<string>(), stored = new Set<string>();
  const proof = createHash("sha256").update("private-pair-input-readback-v2\n").update(inputManifestDigest + "\n");
  let inputBytes = 0;
  let writes: Promise<PromiseSettledResult<void>>[] = [];
  const flush = async () => {
    const batch = writes; writes = [];
    for (const result of await Promise.all(batch)) if (result.status === "rejected") throw result.reason;
  };
  try {
    for await (const file of files) {
      active(signal);
      const expected = inventory.get(file.name);
      if (!expected || seen.has(file.name) || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== expected.bytes) mismatch();
      const captured = new Uint8Array(file.bytes);
      if (hash(captured) !== expected.digest) mismatch();
      // Source/dependency files are bounded JSON, not environment or credential
      // serialization. Approval/completeness belongs to audited source owners.
      try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured)); }
      catch { mismatch(); }
      if (!stored.has(expected.digest)) {
        // Reflect failures immediately, then drain in source order. At most four
        // existing bounded input bodies are resident, including their readbacks.
        writes.push(putInputObject(store, pair, expected.objectKey, captured, signal).then(
          () => ({ status: "fulfilled" as const, value: undefined }), reason => ({ status: "rejected" as const, reason })));
        stored.add(expected.digest);
        if (writes.length === 4) await flush();
      }
      seen.add(file.name); inputBytes += captured.byteLength;
    }
  } catch (error) { await flush(); throw error; }
  await flush();
  if (seen.size !== inventory.size) mismatch();
  // Canonical inventory order makes the readback receipt independent of the
  // source stream's traversal order. Each referenced body has been read back.
  for (const file of root.files) proof.update(JSON.stringify([file.name, file.digest, file.bytes, file.objectKey]) + "\n");
  await putInputObject(store, pair, manifestKey, bytes, signal);
  const receipt: PairInputReceipt = input.parsePublicReleasePairInputReceipt({ schemaVersion: 2, status: "captured",
    pairDigest: protocol.publicReleaseDigest(pair), source: root.source, scope: root.scope, inputManifestDigest, manifestKey,
    manifestBytes: bytes.byteLength, cursor: root.cursor, fileCount: seen.size, inputBytes, readbackDigest: proof.digest("hex") },
  pair, root.scope, inputManifestDigest);
  active(signal);
  return firestore.runTransaction(async transaction => {
    const before = await assertOwner(transaction);
    const sourceRef = firestore.doc(publicReleasePairSourceInputPath(pair, root.scope));
    const sourceRow = bindSourceOperation ? await transaction.get(sourceRef) : null;
    const binding = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), scope: root.scope,
      source: root.source, cursor: root.cursor, inputManifestDigest };
    if (sourceRow?.exists && protocol.publicReleaseDigest(sourceRow.data()) !== protocol.publicReleaseDigest(binding)) mismatch();
    const writeMediaCoverage = await mediaCoverage.preparePairMediaInputCoverageInTransaction({ firestore, transaction, pair, receipt });
    active(signal);
    if (before.receipt) {
      if (protocol.publicReleaseDigest(before.receipt) !== protocol.publicReleaseDigest(receipt)) mismatch();
      writeMediaCoverage();
      if (bindSourceOperation && !sourceRow?.exists) transaction.create(sourceRef, binding);
      return { idempotent: true, receipt, root };
    }
    const receiptDigest = protocol.publicReleaseDigest(receipt);
    if (before.slot && before.slot.receiptDigest !== receiptDigest) mismatch();
    writeMediaCoverage();
    transaction.create(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${inputManifestDigest}`), receipt);
    if (!before.slot) transaction.create(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputScopes/${input.publicReleasePairInputScopeKey(pair, root.scope)}`), {
      schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), scope: root.scope, inputManifestDigest, receiptDigest,
    });
    if (bindSourceOperation && !sourceRow?.exists) transaction.create(sourceRef, binding);
    return { idempotent: false, receipt, root };
  });
}

/** One original frozen pack per pair/work kind and accepted source operation.
 * This binding commits with H's receipt, including after a lost response. */
export function publicReleasePairSourceInputPath(pair: PublicReleasePair, scope: Pick<import("../../functions/lib/public-release-pair-input").PairInputScope, "kind" | "sourceOperationId">) {
  return `${work.publicReleasePairPath(pair.pairId)}/sourceInputs/${protocol.publicReleaseDigest({ kind: scope.kind, sourceOperationId: scope.sourceOperationId })}`;
}

/** Read only the exact captured root named by the task. Files stay lazy and
 * bounded; missing bytes never trigger a mutable database/latest fallback. */
export async function openPublicReleasePairInput({ firestore, store, pair: rawPair, identity: rawIdentity,
  expectedSource, expectedCursor, signal }: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair;
    identity: PairTaskIdentity; expectedSource: PairInputSource; expectedCursor: PairInputCursor; signal?: AbortSignal }) {
  active(signal);
  const pair = protocol.parsePublicReleasePair(rawPair), identity = views.parseViewIdentity(rawIdentity, pair);
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const authority = await firestore.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({
    firestore, transaction, pair, scope, inputManifestDigest: identity.inputManifestDigest }), { readOnly: true });
  const receipt = authority.receipt;
  if (!receipt || protocol.publicReleaseDigest(receipt.cursor) !== protocol.publicReleaseDigest(expectedCursor) ||
      protocol.publicReleaseDigest(receipt.source) !== protocol.publicReleaseDigest(input.parsePublicReleasePairInputSource(expectedSource))) mismatch();
  const bytes = await readInputObject(store, receipt.manifestKey, receipt.manifestBytes, seal(pair, identity.inputManifestDigest), signal);
  const root = input.parsePublicReleasePairInputRoot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pair);
  if (protocol.publicReleaseDigest(root.scope) !== protocol.publicReleaseDigest(scope) ||
      protocol.publicReleaseDigest(root.cursor) !== protocol.publicReleaseDigest(receipt.cursor) ||
      protocol.publicReleaseDigest(root.source) !== protocol.publicReleaseDigest(receipt.source) ||
      root.files.length !== receipt.fileCount || root.files.reduce((sum, file) => sum + file.bytes, 0) !== receipt.inputBytes) mismatch();
  const files = new Map(root.files.map(file => [file.name, file]));
  const readFile = async (name: string) => {
    active(signal);
    const file = files.get(name);
    if (!file) mismatch();
    return readInputObject(store, file.objectKey, file.bytes, seal(pair, file.digest), signal);
  };
  return Object.freeze({ root, receipt, readFile });
}
