import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { bytesDigest, canonicalPath, compareReaderPaths, exact, readBoundedBody, isReaderNamespacePath } from "./public-release-pair-reader-contract";
import { PairQualificationError } from "./public-release-pair-qualification-authority";
import type { QualifiedByteEvidence } from "./public-release-pair-qualification-bytes";
export type QualificationAbsenceEvidence = Readonly<{ kind: "absence"; path: string; manifestDigest: string; claimDigest: string;
  inputManifestDigest: string; requestDigest: string; status: 404; bytes: 0; namespaceRootDigest: string; namespaceManifestDigest: string;
  cursor: Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }> }>;
export type QualificationEvidence = (QualifiedByteEvidence & Readonly<{ kind: "baseline" | "content" | "overlay" }>) | QualificationAbsenceEvidence;
// Up to 1,024 descriptors retain two path-bearing order keys each. Even
// maximum-length quoted artifact names must fit alongside every descriptor.
export const QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT = 8 * 1024 * 1024;
const PAGE_LIMIT = 256, PAGE_BYTES_LIMIT = 512 * 1024, ROOT_BYTES_LIMIT = QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT, OUTPUT_LIMIT = 200_000;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(): never { throw new PairQualificationError("reader-mismatch"); }
function parseEvidence(value: unknown): QualificationEvidence {
  if (value && typeof value === "object" && "kind" in value && value.kind === "absence") {
    const row = exact(value, ["kind", "path", "manifestDigest", "claimDigest", "inputManifestDigest", "requestDigest", "status", "bytes",
      "namespaceRootDigest", "namespaceManifestDigest", "cursor"]);
    const cursor = exact(row.cursor, ["baselineDigest", "sequence", "lastDigest"]);
    if (!isReaderNamespacePath("/pagefind/", row.path) && !isReaderNamespacePath("/api/v1/content/", row.path) || row.status !== 404 || row.bytes !== 0 ||
        ![row.manifestDigest, row.claimDigest, row.inputManifestDigest, row.requestDigest, row.namespaceRootDigest, row.namespaceManifestDigest,
          cursor.baselineDigest, cursor.lastDigest].every(validDigest) || !Number.isSafeInteger(cursor.sequence) ||
        (cursor.sequence as number) < 0 || cursor.sequence === 0 && cursor.lastDigest !== cursor.baselineDigest) refuse();
    return Object.freeze({ ...row, cursor: Object.freeze({ ...cursor }) }) as QualificationAbsenceEvidence;
  }
  const row = exact(value, ["kind", "path", "manifestDigest", "claimDigest", "inputManifestDigest", "bodyDigest", "bytes", "status", "headersDigest", "requestDigest"]);
  if (typeof row.kind !== "string" || !["baseline", "content", "overlay"].includes(row.kind) || !canonicalPath(row.path) ||
      ![row.manifestDigest, row.claimDigest, row.inputManifestDigest, row.bodyDigest, row.headersDigest, row.requestDigest].every(validDigest) ||
      !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0 || (row.bytes as number) > 16 * 1024 * 1024 ||
      typeof row.status !== "number" || ![200, 302, 308, 410].includes(row.status)) refuse();
  return Object.freeze({ ...row }) as QualificationEvidence;
}
const order = (row: QualificationEvidence) => `${row.kind}:${row.manifestDigest}:${row.claimDigest}:${row.path}`;
export function qualificationEvidencePrefix(pair: PublicReleasePair, qualificationId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(qualificationId)) refuse();
  return `release-pair-qualifications/v1/${protocol.publicReleaseDigest(pair)}/${protocol.publicReleaseDigest({ qualificationId })}/`;
}
async function exactReadback(store: PairViewStore, key: string, bytes: Uint8Array, metadata: Record<string, string>, signal: AbortSignal) {
  signal.throwIfAborted();
  await store.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: bytesDigest(bytes), customMetadata: metadata });
  const object = await store.get(key);
  if (!object) refuse();
  if (object.size !== bytes.byteLength || Object.entries(metadata).some(([name, value]) => object.customMetadata?.[name] !== value)) {
    void object.body.cancel().catch(() => {}); refuse();
  }
  const actual = await readBoundedBody(object.body, bytes.byteLength, signal);
  if (actual.byteLength !== bytes.byteLength || bytesDigest(actual) !== bytesDigest(bytes)) refuse();
}

/** Create-only paged private evidence. A crash can leave only immutable
 * orphan objects. No Firestore record, qualification grant or selection is made. */
export function createQualificationEvidenceWriter({ store, pair: rawPair, qualificationId, witnessDigest, signal }: {
  store: PairViewStore; pair: PublicReleasePair; qualificationId: string; witnessDigest: string; signal: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair), pairDigest = protocol.publicReleaseDigest(pair);
  if (!validDigest(witnessDigest)) refuse();
  const prefix = qualificationEvidencePrefix(pair, qualificationId);
  const pages: Array<{ index: number; digest: string; count: number; bytes: number; first: string; last: string }> = [];
  let pending: QualificationEvidence[] = [], pendingSize = 0, count = 0, totalBytes = 0, prior = "", finished = false;
  const page = () => ({ schemaVersion: 1, kind: "private-pair-qualification-page", pairDigest, witnessDigest,
    qualificationId, index: pages.length, outputs: pending });
  const metadata = (digest: string) => ({ schemaversion: "1", pairdigest: pairDigest, witnessdigest: witnessDigest, bodydigest: digest });
  const flush = async () => {
    if (!pending.length) return;
    signal.throwIfAborted();
    const bytes = encode(page()), digest = bytesDigest(bytes);
    if (bytes.byteLength > PAGE_BYTES_LIMIT || pages.length === 1024) refuse();
    await exactReadback(store, `${prefix}pages/${digest}.json`, bytes, metadata(digest), signal);
    pages.push({ index: pages.length, digest, count: pending.length,
      bytes: pending.reduce((total, row) => total + row.bytes, 0), first: order(pending[0]), last: order(pending.at(-1)!) });
    pending = []; pendingSize = 0;
  };
  return {
    async append(raw: QualificationEvidence) {
      signal.throwIfAborted(); if (finished) refuse();
      const row = parseEvidence(raw), key = order(row), size = encode(row).byteLength;
      if (compareReaderPaths(key, prior) <= 0 || count === OUTPUT_LIMIT || totalBytes + row.bytes > 200 * 1024 ** 3) refuse();
      if (pending.length && (pending.length === PAGE_LIMIT || pendingSize + size + 1 > PAGE_BYTES_LIMIT - 2048)) await flush();
      pending.push(row); pendingSize += size + 1; prior = key; count++; totalBytes += row.bytes;
    },
    async finish() {
      signal.throwIfAborted(); if (finished || !count) refuse(); finished = true;
      await flush();
      const root = Object.freeze({ schemaVersion: 1, kind: "private-pair-qualification-evidence", pairDigest, witnessDigest,
        qualificationId, pages: Object.freeze([...pages]), outputCount: count, outputBytes: totalBytes });
      const bytes = encode(root), evidenceDigest = bytesDigest(bytes), evidenceKey = `${prefix}roots/${evidenceDigest}.json`;
      if (bytes.byteLength > ROOT_BYTES_LIMIT) refuse();
      await exactReadback(store, evidenceKey, bytes, metadata(evidenceDigest), signal);
      signal.throwIfAborted();
      return Object.freeze({ evidenceDigest, evidenceKey, evidenceBytes: bytes.byteLength, outputCount: count, outputBytes: totalBytes });
    },
  };
}

/** Exhaust for complete evidence coverage. This verifies retained proof bytes,
 * never supplies fresh ownership or publication authority. */
export async function* readQualificationEvidence({ store, pair: rawPair, qualificationId, witnessDigest, evidenceDigest,
  evidenceBytes, signal }: { store: PairViewStore; pair: PublicReleasePair; qualificationId: string; witnessDigest: string;
    evidenceDigest: string; evidenceBytes: number; signal: AbortSignal }): AsyncGenerator<QualificationEvidence> {
  const pair = protocol.parsePublicReleasePair(rawPair), pairDigest = protocol.publicReleaseDigest(pair);
  if (!validDigest(witnessDigest) || !validDigest(evidenceDigest) || !Number.isSafeInteger(evidenceBytes) ||
      evidenceBytes < 1 || evidenceBytes > ROOT_BYTES_LIMIT) refuse();
  const prefix = qualificationEvidencePrefix(pair, qualificationId);
  const read = async (key: string, digest: string, limit: number, size?: number) => {
    signal.throwIfAborted(); const object = await store.get(key);
    if (!object) refuse();
    const metadata = { schemaversion: "1", pairdigest: pairDigest, witnessdigest: witnessDigest, bodydigest: digest };
    if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > limit ||
        size !== undefined && object.size !== size || Object.entries(metadata).some(([key, value]) => object.customMetadata?.[key] !== value)) {
      void object.body.cancel().catch(() => {}); refuse();
    }
    const bytes = await readBoundedBody(object.body, object.size, signal);
    if (bytes.byteLength !== object.size || bytesDigest(bytes) !== digest) refuse();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const root = exact(await read(`${prefix}roots/${evidenceDigest}.json`, evidenceDigest, ROOT_BYTES_LIMIT, evidenceBytes),
    ["schemaVersion", "kind", "pairDigest", "witnessDigest", "qualificationId", "pages", "outputCount", "outputBytes"]);
  const pageDescriptors = root.pages;
  if (root.schemaVersion !== 1 || root.kind !== "private-pair-qualification-evidence" || root.pairDigest !== pairDigest ||
      root.witnessDigest !== witnessDigest || root.qualificationId !== qualificationId || !Array.isArray(pageDescriptors) ||
      !pageDescriptors.length || pageDescriptors.length > 1024 || !Number.isSafeInteger(root.outputCount) ||
      (root.outputCount as number) < 1 || (root.outputCount as number) > OUTPUT_LIMIT ||
      !Number.isSafeInteger(root.outputBytes) || (root.outputBytes as number) < 0 || (root.outputBytes as number) > 200 * 1024 ** 3) refuse();
  let count = 0, totalBytes = 0, prior = "";
  for (const [index, rawDescriptor] of pageDescriptors.entries()) {
    const descriptor = exact(rawDescriptor, ["index", "digest", "count", "bytes", "first", "last"]);
    if (descriptor.index !== index || !validDigest(descriptor.digest) || !Number.isSafeInteger(descriptor.count) ||
        (descriptor.count as number) < 1 || (descriptor.count as number) > PAGE_LIMIT || !Number.isSafeInteger(descriptor.bytes) ||
        (descriptor.bytes as number) < 0 || typeof descriptor.first !== "string" || typeof descriptor.last !== "string" ||
        descriptor.first.length > 1200 || descriptor.last.length > 1200 || compareReaderPaths(descriptor.first, prior) <= 0 ||
        compareReaderPaths(descriptor.first, descriptor.last) > 0) refuse();
    const page = exact(await read(`${prefix}pages/${descriptor.digest}.json`, descriptor.digest, PAGE_BYTES_LIMIT),
      ["schemaVersion", "kind", "pairDigest", "witnessDigest", "qualificationId", "index", "outputs"]);
    const outputs = page.outputs;
    if (page.schemaVersion !== 1 || page.kind !== "private-pair-qualification-page" || page.pairDigest !== pairDigest ||
        page.witnessDigest !== witnessDigest || page.qualificationId !== qualificationId || page.index !== index ||
        !Array.isArray(outputs) || outputs.length !== descriptor.count) refuse();
    const rows = outputs.map(parseEvidence);
    const pageBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    if (pageBytes !== descriptor.bytes || order(rows[0]) !== descriptor.first || order(rows.at(-1)!) !== descriptor.last ||
        rows.some((row, index) => index > 0 && compareReaderPaths(order(rows[index - 1]), order(row)) >= 0)) refuse();
    prior = descriptor.last; count += rows.length; totalBytes += pageBytes;
    if (count > OUTPUT_LIMIT || totalBytes > 200 * 1024 ** 3) refuse();
    yield* rows;
  }
  if (count !== root.outputCount || totalBytes !== root.outputBytes) refuse();
}
