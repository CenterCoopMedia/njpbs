import { isExactHttpsUrl } from "../../packages/content-core/src/exact-https-url";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { readPublicReleasePairView, type PairViewStore } from "./public-release-pair-view-storage";
import { createPrivatePairReaderClient } from "./public-release-pair-reader-client";
import { PAIR_READER_BYTES_LIMIT, PAIR_READER_PATHS_LIMIT, PAIR_READER_REPLY_LIMIT,
  same, canonicalPath, isReaderNamespacePath, compareReaderPaths, type ReaderNamespaceAbsence, type ReaderSeals } from "./public-release-pair-reader-contract";
import type { QualificationAbsenceEvidence } from "./public-release-pair-qualification-evidence";
import { PairQualificationError, QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";
export type QualificationView = Readonly<{ identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; manifestBytes: number }>;
export type ExpectedQualifiedOutput = Readonly<{ bodyDigest: string; status?: 200 | 302 | 308 | 410;
  mime?: string; bytes?: number; location?: string | null;
  /** Additional semantic validation runs only after actual HTTP bytes match. */
  verifyBody?: (bytes: Uint8Array) => void }>;
export type DeclaredQualifiedOutput = Readonly<{ status: 200 | 302 | 308 | 410; mime: string; bodyDigest?: string; bytes?: number }>;
export type QualifiedByteEvidence = Readonly<{ path: string; manifestDigest: string; claimDigest: string;
  inputManifestDigest: string; bodyDigest: string; bytes: number; status: 200 | 302 | 308 | 410;
  headersDigest: string; requestDigest: string }>;
function mismatch(): never { throw new PairQualificationError("reader-mismatch"); }
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Private byte verification only. Expected selection comes from the replay
 * owner's verified inventory, never a largest-cursor query or caller hints.
 * The caller must check completed/staged owners and live validators before and
 * after this operation before persisting any qualification receipt. */
export async function verifyPairViewRemoteBytes({ pair, store, selectedView: rawView, expected: rawExpected, inventory: rawInventory, seals, credentials,
  stagedReadbackDigest, evidence, signal }: { pair: PublicReleasePair; store: PairViewStore; selectedView: QualificationView;
  expected: ReadonlyMap<string, ExpectedQualifiedOutput>; inventory?: ReadonlyMap<string, DeclaredQualifiedOutput>; seals: ReaderSeals; credentials: () => Promise<HeadersInit>;
  stagedReadbackDigest: string; evidence: (row: QualifiedByteEvidence) => Promise<void>; signal: AbortSignal;
}) {
  pair = protocol.parsePublicReleasePair(pair);
  const selectedView = Object.freeze({ ...rawView, identity: view.parseViewIdentity(rawView.identity, pair) });
  const expected = new Map([...rawExpected].map(([path, value]) => [path, Object.freeze({ ...value })]));
  const inventory = rawInventory && new Map([...rawInventory].map(([path, value]) => [path, Object.freeze({ ...value })]));
  if (inventory && (!inventory.size || inventory.size > QUALIFICATION_ROUTE_LIMIT ||
      [...inventory].some(([path, value]) => !canonicalPath(path) || ![200, 302, 308, 410].includes(value.status) ||
        typeof value.mime !== "string" || !value.mime || value.bodyDigest !== undefined && !digest(value.bodyDigest) ||
        value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > view.BODY_BYTES_LIMIT)))) mismatch();
  if (!digest(stagedReadbackDigest) || !digest(selectedView.claimDigest) || !digest(selectedView.manifestDigest) ||
      !Number.isSafeInteger(selectedView.manifestBytes) || selectedView.manifestBytes < 1 ||
      selectedView.manifestBytes > view.VIEW_ROOT_BYTES_LIMIT || !expected.size || expected.size > QUALIFICATION_ROUTE_LIMIT ||
      [...expected].some(([path, value]) => !canonicalPath(path) || !digest(value.bodyDigest) ||
        value.status !== undefined && ![200, 302, 308, 410].includes(value.status) ||
        value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > view.BODY_BYTES_LIMIT) ||
        value.mime !== undefined && (typeof value.mime !== "string" || !value.mime.length) ||
        value.verifyBody !== undefined && typeof value.verifyBody !== "function" ||
        value.location !== undefined && value.location !== null && !(canonicalPath(value.location) || value.status === 302 && isExactHttpsUrl(value.location, 2048)))) mismatch();
  const client = createPrivatePairReaderClient({ pair, seals, credentials });
  type StoredOutput = ReturnType<typeof view.parsePublicReleasePairViewOutput> & { body: Uint8Array };
  let pending: StoredOutput[] = [], pendingBytes = 0, pendingEncoded = 5000, outputCount = 0, outputBytes = 0, batches = 0;
  const seen = new Set<string>();
  let inventoryCount = 0;
  const flush = async () => {
    if (!pending.length) return;
    signal.throwIfAborted();
    const reply = await client({ ...selectedView, paths: pending.map(row => row.path), signal });
    if (reply.stagedReadbackDigest !== stagedReadbackDigest) mismatch();
    for (const [index, actual] of reply.outputs.entries()) {
      const wanted = pending[index];
      const bytes = Buffer.from(actual.bodyBase64, "base64");
      if (actual.path !== wanted.path || actual.status !== wanted.status || !same(actual.headers, wanted.headers) ||
          actual.bodyDigest !== wanted.bodyDigest || actual.bytes !== wanted.bytes ||
          Buffer.compare(bytes, Buffer.from(wanted.body.buffer, wanted.body.byteOffset, wanted.body.byteLength)) !== 0) mismatch();
      expected.get(wanted.path)!.verifyBody?.(new Uint8Array(bytes));
      await evidence(Object.freeze({ path: wanted.path, manifestDigest: selectedView.manifestDigest, claimDigest: selectedView.claimDigest,
        inputManifestDigest: selectedView.identity.inputManifestDigest, bodyDigest: actual.bodyDigest,
        bytes: actual.bytes, status: actual.status, headersDigest: protocol.publicReleaseDigest(actual.headers), requestDigest: reply.requestDigest }));
      outputCount++; outputBytes += actual.bytes;
    }
    batches++; pending = []; pendingBytes = 0; pendingEncoded = 5000;
  };
  for await (const output of readPublicReleasePairView({ store, pair, ...selectedView, signal })) {
    signal.throwIfAborted();
    if (inventory) {
      const declared = inventory.get(output.path);
      if (!declared || declared.status !== output.status || declared.mime !== output.headers["content-type"] ||
          declared.bodyDigest !== undefined && declared.bodyDigest !== output.bodyDigest ||
          declared.bytes !== undefined && declared.bytes !== output.bytes) mismatch();
      inventoryCount++;
    }
    const wanted = expected.get(output.path);
    if (!wanted) continue;
    if (seen.has(output.path) || wanted.bodyDigest !== output.bodyDigest ||
        wanted.status !== undefined && wanted.status !== output.status ||
        wanted.bytes !== undefined && wanted.bytes !== output.bytes ||
        wanted.mime !== undefined && wanted.mime !== output.headers["content-type"] ||
        wanted.location !== undefined && wanted.location !== (output.headers.location ?? null)) mismatch();
    const encoded = Math.ceil(output.bytes / 3) * 4 + Buffer.byteLength(JSON.stringify({ ...output, body: undefined })) + 256;
    if (pending.length && (pending.length === PAIR_READER_PATHS_LIMIT || pendingBytes + output.bytes > PAIR_READER_BYTES_LIMIT ||
        pendingEncoded + encoded > PAIR_READER_REPLY_LIMIT)) await flush();
    if (output.bytes > PAIR_READER_BYTES_LIMIT || 5000 + encoded > PAIR_READER_REPLY_LIMIT) mismatch();
    pending.push(output); pendingBytes += output.bytes; pendingEncoded += encoded; seen.add(output.path);
  }
  if (seen.size !== expected.size || inventory && inventoryCount !== inventory.size) mismatch();
  await flush(); signal.throwIfAborted();
  return Object.freeze({ outputCount, outputBytes, batches });
}

/** The replay owner supplies every retired name, including names introduced
 * and removed between baseline and head. A transport refusal never counts as
 * absence. The reader independently opens the original complete namespace. */
export async function verifyPairNamespaceRemoteAbsence({ pair, selectedView, absence: rawAbsence, seals, credentials,
  stagedReadbackDigest, evidence, signal }: { pair: PublicReleasePair; selectedView: QualificationView; absence: ReaderNamespaceAbsence;
  seals: ReaderSeals; credentials: () => Promise<HeadersInit>; stagedReadbackDigest: string;
  evidence: (row: QualificationAbsenceEvidence) => Promise<void>; signal: AbortSignal;
}) {
  pair = protocol.parsePublicReleasePair(pair);
  const reference = Object.freeze({ ...selectedView, identity: view.parseViewIdentity(selectedView.identity, pair) });
  const absence = Object.freeze({ ...rawAbsence, cursor: Object.freeze({ ...rawAbsence.cursor }), paths: Object.freeze([...rawAbsence.paths]) });
  if (!digest(stagedReadbackDigest) || !absence.paths.length || absence.paths.length > QUALIFICATION_ROUTE_LIMIT ||
      absence.paths.some((path, index) => !isReaderNamespacePath(absence.namespace, path) ||
        index > 0 && compareReaderPaths(absence.paths[index - 1], path) >= 0)) mismatch();
  const client = createPrivatePairReaderClient({ pair, seals, credentials });
  let batches = 0;
  for (let offset = 0; offset < absence.paths.length; offset += PAIR_READER_PATHS_LIMIT) {
    signal.throwIfAborted();
    const reply = await client({ ...reference, paths: [], absence: { ...absence, paths: absence.paths.slice(offset, offset + PAIR_READER_PATHS_LIMIT) }, signal });
    if (reply.stagedReadbackDigest !== stagedReadbackDigest || !reply.namespaceAbsence) mismatch();
    for (const row of reply.namespaceAbsence.outputs) await evidence(Object.freeze({ kind: "absence", path: row.path,
      status: 404, bytes: 0, manifestDigest: reference.manifestDigest, claimDigest: reference.claimDigest,
      inputManifestDigest: reference.identity.inputManifestDigest, namespaceRootDigest: absence.namespaceRootDigest,
      namespaceManifestDigest: absence.namespaceManifestDigest, cursor: absence.cursor, requestDigest: reply.requestDigest }));
    batches++;
  }
  signal.throwIfAborted();
  return Object.freeze({ absenceCount: absence.paths.length, batches });
}
