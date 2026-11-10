import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairInputCursor, PairInputReceipt, PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { PAIR_CODE_PACK_FILE, PAIR_CODE_PACK_CHUNK_BYTES, parsePublicReleasePairCodePack,
  publicReleasePairCodePackChunkCount, publicReleasePairCodePackChunkName, decodePublicReleasePairCodePackChunk,
  PairCodePackError } from "./public-release-pair-code-pack";
import { publicReleasePairSourceInputsBytes, PAIR_SOURCE_INPUTS_PACK_PATH, PairSourceInputsError } from "./public-release-pair-source-inputs";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { assertPublicReleasePairContentFeedIndex, PAIR_CONTENT_FEED_INDEX } from "./public-release-pair-content-feed-authority";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fail(): never { throw new PairCodePackError("incomplete-code-pack"); }
export type PairCodePackBaselineReceipt = Readonly<{ schemaVersion: 1; kind: "pair-code-pack-baseline";
  pairDigest: string; commitSha: string; inventoryVersion: 1; codeAssetManifestDigest: string; inputManifestDigest: string;
  codePackManifestDigest: string; codePackManifestKey: string; codePackManifestBytes: number; cursor: PairInputCursor }>;
export const publicReleasePairCodePackBaselinePath = (pair: PublicReleasePair) => `${work.publicReleasePairPath(pair.pairId)}/codePacks/baseline`;
function parseReceipt(value: any, pair: PublicReleasePair): PairCodePackBaselineReceipt {
  const keys = ["schemaVersion", "kind", "pairDigest", "commitSha", "inventoryVersion", "codeAssetManifestDigest", "inputManifestDigest",
    "codePackManifestDigest", "codePackManifestKey", "codePackManifestBytes", "cursor"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join() ||
      value.schemaVersion !== 1 || value.kind !== "pair-code-pack-baseline" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.commitSha !== pair.commitSha || value.inventoryVersion !== 1 || value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
      !/^[a-f0-9]{64}$/.test(value.inputManifestDigest) || !/^[a-f0-9]{64}$/.test(value.codePackManifestDigest) ||
      value.codePackManifestKey !== input.publicReleasePairInputObjectKey(pair, value.codePackManifestDigest) ||
      !Number.isSafeInteger(value.codePackManifestBytes) || value.codePackManifestBytes < 1 || value.codePackManifestBytes > input.INPUT_FILE_BYTES_LIMIT ||
      !value.cursor || Object.keys(value.cursor).sort().join() !== "baselineDigest,lastDigest,sequence" ||
      !/^[a-f0-9]{64}$/.test(value.cursor.baselineDigest) || !/^[a-f0-9]{64}$/.test(value.cursor.lastDigest) ||
      !Number.isSafeInteger(value.cursor.sequence) || value.cursor.sequence < 0 || value.cursor.sequence === 0 && value.cursor.lastDigest !== value.cursor.baselineDigest) fail();
  return Object.freeze({ ...value, cursor: Object.freeze({ ...value.cursor }) });
}
async function openRoot(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; inputManifestDigest: string; signal?: AbortSignal }) {
  const raw = (await options.firestore.doc(`${work.publicReleasePairPath(options.pair.pairId)}/inputs/${options.inputManifestDigest}`).get()).data();
  const scope = input.parsePublicReleasePairInputScope(raw?.scope);
  const receipt = input.parsePublicReleasePairInputReceipt(raw, options.pair, scope, options.inputManifestDigest);
  if (receipt.source.kind !== "inventory" || !scope.sourceOperationId.startsWith("baseline-")) fail();
  return openPublicReleasePairInput({ ...options,
    identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(options.pair), ...scope, inputManifestDigest: options.inputManifestDigest },
    expectedSource: receipt.source, expectedCursor: receipt.cursor });
}
async function verifiedFiles(opened: Awaited<ReturnType<typeof openRoot>>, pair: PublicReleasePair) {
  const codeFile = opened.root.files.find(file => file.name === PAIR_CODE_PACK_FILE); if (!codeFile) fail();
  const bytes = await opened.readFile(PAIR_CODE_PACK_FILE);
  const manifest = parsePublicReleasePairCodePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pair);
  const files = new Map<string, Uint8Array>([[PAIR_CODE_PACK_FILE, bytes]]);
  for (const member of manifest.members) {
    const proof = createHash("sha256"); let size = 0;
    const indexChunks: Uint8Array[] = [];
    for (let index = 0; index < publicReleasePairCodePackChunkCount(member.size); index++) {
      const name = publicReleasePairCodePackChunkName(member, index);
      const encoded = files.get(name) ?? await opened.readFile(name); files.set(name, encoded);
      const body = decodePublicReleasePairCodePackChunk(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)),
        Math.min(PAIR_CODE_PACK_CHUNK_BYTES, member.size - index * PAIR_CODE_PACK_CHUNK_BYTES));
      proof.update(body); size += body.length;
      if (member.path === PAIR_CONTENT_FEED_INDEX) indexChunks.push(body);
    }
    if (size !== member.size || proof.digest("hex") !== member.sha256) fail();
    if (member.path === PAIR_CONTENT_FEED_INDEX) assertPublicReleasePairContentFeedIndex(Buffer.concat(indexChunks), manifest);
  }
  const actualNames = opened.root.files.filter(file => file.name === PAIR_CODE_PACK_FILE || file.name.startsWith("code-pack/")).map(file => file.name).sort();
  if (actualNames.join("\n") !== [...files.keys()].sort().join("\n")) fail();
  return { manifest, files, codeFile };
}
async function verifySourceInputs(opened: Awaited<ReturnType<typeof openRoot>>, manifest: ReturnType<typeof parsePublicReleasePairCodePack>) {
  const baseline = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await opened.readFile("baseline.json")));
  const bytes = publicReleasePairSourceInputsBytes(baseline.receipt, baseline.logBaselineDigest);
  if (opened.root.scope.sourceOperationId !== `baseline-codepack-${baseline.logBaselineDigest}` ||
      protocol.publicReleaseDigest(opened.root.cursor) !== protocol.publicReleaseDigest(baseline.receipt.baselineCursor) ||
      protocol.publicReleaseDigest(baseline.sourceMembers) !== baseline.receipt.sourceMemberCensusDigest) fail();
  const source = manifest.members.find(member => member.path === PAIR_SOURCE_INPUTS_PACK_PATH);
  if (!source) throw new PairSourceInputsError("pair-source-inputs-missing");
  if (source.size !== bytes.length || source.sha256 !== hash(bytes)) throw new PairSourceInputsError("pair-source-inputs-mismatch");
}
/** Create only after H's real complete readback; caller metadata is not proof. */
export async function persistPublicReleasePairCodePackBaseline(options: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; captured: { root: PairInputRoot; receipt: PairInputReceipt }; signal?: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(options.pair);
  const opened = await openRoot({ ...options, pair, inputManifestDigest: options.captured.receipt.inputManifestDigest });
  if (protocol.publicReleaseDigest(opened.receipt) !== protocol.publicReleaseDigest(options.captured.receipt) ||
      protocol.publicReleaseDigest(opened.root) !== protocol.publicReleaseDigest(options.captured.root)) fail();
  const { codeFile, manifest } = await verifiedFiles(opened, pair);
  await verifySourceInputs(opened, manifest);
  const receipt = parseReceipt({ schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: protocol.publicReleaseDigest(pair),
    commitSha: pair.commitSha, inventoryVersion: 1, codeAssetManifestDigest: pair.codeAssetManifestDigest,
    inputManifestDigest: opened.receipt.inputManifestDigest, codePackManifestDigest: codeFile.digest,
    codePackManifestKey: codeFile.objectKey, codePackManifestBytes: codeFile.bytes, cursor: opened.root.cursor }, pair);
  return options.firestore.runTransaction(async transaction => {
    const ref = options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)), before = await transaction.get(ref);
    if (before.exists) { if (protocol.publicReleaseDigest(parseReceipt(before.data(), pair)) !== protocol.publicReleaseDigest(receipt)) fail(); return receipt; }
    transaction.create(ref, receipt); return receipt;
  });
}
export async function readFrozenPublicReleasePairCodePack(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(options.pair), receipt = parseReceipt(
    (await options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).data(), pair);
  const opened = await openRoot({ ...options, pair, inputManifestDigest: receipt.inputManifestDigest });
  const { manifest, files, codeFile } = await verifiedFiles(opened, pair);
  await verifySourceInputs(opened, manifest);
  if (codeFile.digest !== receipt.codePackManifestDigest || codeFile.objectKey !== receipt.codePackManifestKey || codeFile.bytes !== receipt.codePackManifestBytes ||
      protocol.publicReleaseDigest(opened.root.cursor) !== protocol.publicReleaseDigest(receipt.cursor) || hash(files.get(PAIR_CODE_PACK_FILE)!) !== receipt.codePackManifestDigest) fail();
  return { receipt, manifest, files };
}

/** Content rendering consumes the inventory and its original complete H receipt.
 * Binary members belong to the dedicated code-pack task, so ordinary views do
 * not read/copy every static asset again. Qualification still proves G bytes. */
export async function readFrozenPublicReleasePairCodePackManifest(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(options.pair), receipt = parseReceipt(
    (await options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).data(), pair);
  const opened = await openRoot({ ...options, pair, inputManifestDigest: receipt.inputManifestDigest });
  const codeFile = opened.root.files.find(file => file.name === PAIR_CODE_PACK_FILE); if (!codeFile) fail();
  const bytes = await opened.readFile(PAIR_CODE_PACK_FILE);
  if (hash(bytes) !== receipt.codePackManifestDigest || codeFile.objectKey !== receipt.codePackManifestKey || codeFile.bytes !== receipt.codePackManifestBytes ||
      protocol.publicReleaseDigest(opened.root.cursor) !== protocol.publicReleaseDigest(receipt.cursor)) fail();
  const manifest = parsePublicReleasePairCodePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pair);
  await verifySourceInputs(opened, manifest);
  return { receipt, manifest, bytes };
}

/** Open sealed H metadata only. Each member is then read once into a bounded
 * buffer (at most 16 MiB), checking every chunk and the final member digest.
 * No byte cache or eager whole-pack materialization is kept by this opener. */
export async function openFrozenPublicReleasePairCodePack(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(options.pair), receipt = parseReceipt(
    (await options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)).get()).data(), pair);
  const opened = await openRoot({ ...options, pair, inputManifestDigest: receipt.inputManifestDigest });
  const codeFile = opened.root.files.find(file => file.name === PAIR_CODE_PACK_FILE); if (!codeFile) fail();
  const bytes = await opened.readFile(PAIR_CODE_PACK_FILE);
  if (hash(bytes) !== receipt.codePackManifestDigest || codeFile.objectKey !== receipt.codePackManifestKey || codeFile.bytes !== receipt.codePackManifestBytes ||
      protocol.publicReleaseDigest(opened.root.cursor) !== protocol.publicReleaseDigest(receipt.cursor)) fail();
  const manifest = parsePublicReleasePairCodePack(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pair);
  await verifySourceInputs(opened, manifest);
  const roster = new Map(opened.root.files.map(file => [file.name, file]));
  const expected = new Set<string>([PAIR_CODE_PACK_FILE]);
  for (const member of manifest.members) for (let index = 0; index < publicReleasePairCodePackChunkCount(member.size); index++) {
    const name = publicReleasePairCodePackChunkName(member, index), file = roster.get(name);
    const size = Math.min(PAIR_CODE_PACK_CHUNK_BYTES, member.size - index * PAIR_CODE_PACK_CHUNK_BYTES);
    if (!file || file.bytes !== 17 + Math.ceil(size / 3) * 4) fail();
    expected.add(name);
  }
  const actual = opened.root.files.filter(file => file.name === PAIR_CODE_PACK_FILE || file.name.startsWith("code-pack/"));
  if (actual.length !== expected.size || actual.some(file => !expected.has(file.name))) fail();
  const members = new Map(manifest.members.map(member => [member.path, member]));
  let reading = false;
  const readMember = async (path: string) => {
    options.signal?.throwIfAborted();
    const member = members.get(path);
    if (!member || reading) fail();
    reading = true;
    try {
      const body = new Uint8Array(member.size);
      for (let index = 0; index < publicReleasePairCodePackChunkCount(member.size); index++) {
        options.signal?.throwIfAborted();
        const encoded = await opened.readFile(publicReleasePairCodePackChunkName(member, index));
        const chunk = decodePublicReleasePairCodePackChunk(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)),
          Math.min(PAIR_CODE_PACK_CHUNK_BYTES, member.size - index * PAIR_CODE_PACK_CHUNK_BYTES));
        body.set(chunk, index * PAIR_CODE_PACK_CHUNK_BYTES);
      }
      options.signal?.throwIfAborted();
      if (hash(body) !== member.sha256) fail();
      return body;
    } finally { reading = false; }
  };
  return Object.freeze({ receipt, manifest, root: opened.root, readMember });
}
