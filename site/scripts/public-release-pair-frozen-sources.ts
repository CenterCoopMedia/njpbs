import { freezePublicReleasePairStaticSource } from "./public-release-pair-static-source-storage";
import { soleStaticPostOwner, PairStaticSourceError } from "./public-release-pair-static-source";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { HistoricalPublicReleaseState } from "../../functions/lib/public-release-historical-state";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { PAIR_CODE_PACK_CHUNK_BYTES, encodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack";
import { assertContextMatchesPublication } from "../src/lib/retained-public-context";
const require = createRequire(import.meta.url), hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(): never { throw Object.assign(new Error("Frozen public source dependency is unavailable"), { code: "historical-source-dependency-missing" }); }
async function objectBytes(store: Pick<PairViewStore, "get">, key: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted(); const value = await store.get(key);
  if (!value || value.size < 0 || value.size > limit) refuse();
  const chunks: Uint8Array[] = [], reader = value.body.getReader(); let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > value.size) refuse(); chunks.push(part.value); signal?.throwIfAborted(); } }
  finally { void reader.cancel().catch(() => {}); }
  if (size !== value.size) refuse(); return new Uint8Array(Buffer.concat(chunks));
}
/** Freeze exact immutable receipts' bytes, including raw packet exports. The
 * cache only serves these names; it never reads a mutable provider/latest key. */
export async function freezePublicReleaseSourceDependencies(options: { firestore: Firestore; state: HistoricalPublicReleaseState;
  providerStore: PairViewStore; codeStore?: PairViewStore; contentStore?: Pick<PairViewStore, "get">; pair?: { environment: "development" | "production" }; signal?: AbortSignal }) {
  const files = new Map<string, Uint8Array>(), cache = new Map<string, Uint8Array>();
  const chunk = (prefix: string, bytes: Uint8Array) => {
    const names = [];
    for (let index = 0; index < Math.max(1, Math.ceil(bytes.length / PAIR_CODE_PACK_CHUNK_BYTES)); index++) {
      const name = `${prefix}/${String(index).padStart(4, "0")}.json`;
      files.set(name, encodePublicReleasePairCodePackChunk(bytes.subarray(index * PAIR_CODE_PACK_CHUNK_BYTES, (index + 1) * PAIR_CODE_PACK_CHUNK_BYTES))); names.push(name);
    }
    return names;
  };
  const external = options.state.documents.get("system/publicDeployment/contexts/public")?.externalInputs ?? null;
  const retainedHome = options.state.documents.get("cmsBackgroundOutputs/home")?.retainedSource ?? null;
  const roster: any[] = [];
  const retain = async (name: string, receipt: any) => {
    if (!receipt || typeof receipt.key !== "string" || !/^post-background-v1\/[A-Za-z0-9_./-]+$/.test(receipt.key) ||
        receipt.key.split("/").some((part: string) => [".", "..", ""].includes(part)) || !/^[a-f0-9]{64}$/.test(receipt.digest ?? "") ||
        !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > 16 * 1024 * 1024) refuse();
    const bytes = cache.get(receipt.key) ?? await objectBytes(options.providerStore, receipt.key, 16 * 1024 * 1024, options.signal);
    if (bytes.length !== receipt.size || hash(bytes) !== receipt.digest) refuse(); cache.set(receipt.key, bytes);
    roster.push({ name, key: receipt.key, digest: receipt.digest, bytes: receipt.size, contentType: receipt.contentType ?? "application/json",
      chunkFiles: chunk(`provider-inputs/objects/${receipt.digest}`, bytes) });
  };
  if (external) {
    if (!external.files || typeof external.files !== "object" || Object.keys(external.files).length > 100) refuse();
    for (const [name, receipt] of Object.entries(external.files).sort(([a], [b]) => a < b ? -1 : 1)) await retain(name, receipt);
    if (external.schedulePacket) for (const name of ["json", "pdf"]) await retain(`schedule-packet/${name}`, external.schedulePacket.files?.[name]);
  }
  if (retainedHome) await retain("retained-home", retainedHome.file);
  if (roster.length) files.set("provider-inputs.json", new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, externalInputs: external, retainedHome, files: roster })));
  let qualifiedCode: any;
  const descriptor = options.state.documents.get("system/publicReleaseHistoricalCode");
  if (descriptor) {
    qualifiedCode = await require("../../functions/lib/public-release-historical-code.js").readRetainedPublicReleaseCode({ firestore: options.firestore, descriptor,
      readCodeBytes: options.codeStore ? (key: string) => objectBytes(options.codeStore!, key, 16 * 1024 * 1024, options.signal) : undefined });
    assertContextMatchesPublication(qualifiedCode.publicContext, qualifiedCode.publication);
    const bytes = new TextEncoder().encode(JSON.stringify(qualifiedCode));
    files.set("code-source.json", new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, reference: qualifiedCode.reference,
      sha256: hash(bytes), bytes: bytes.length, chunkFiles: chunk("code-source/objects", bytes) })));
  }
  if (soleStaticPostOwner(options.state.documents)) {
    if (!qualifiedCode || !options.contentStore || !options.pair) throw new PairStaticSourceError("pair-static-source-missing");
    await freezePublicReleasePairStaticSource({ state: options.state, originalPublication: qualifiedCode.publication,
      environment: options.pair.environment, files, chunk, readContentObject: async (key, limit) => {
        try { return await objectBytes(options.contentStore!, key, limit, options.signal); }
        catch { throw new PairStaticSourceError("pair-static-source-missing"); }
      } });
  }
  const providerStore: PairViewStore = { put: async () => { refuse(); }, async get(key) {
    const bytes = cache.get(key); if (!bytes) refuse();
    return { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! };
  } };
  return { files, qualifiedCode, providerStore, readProviderInput: async (key: string) => { const bytes = cache.get(key); if (!bytes) refuse(); return bytes; } };
}

/** Full current document map plus its immutable baseline and contiguous history.
 * Each bodyFile is canonical raw public-source JSON, named by contentDigest. */
export function publicReleasePairFrozenSourceCensus(state: HistoricalPublicReleaseState) {
  return { schemaVersion: 1, kind: "pair-public-source-census", baseline: { logBaselineDigest: state.logBaselineDigest,
    receipt: state.receipt, sourceMembers: state.baselineMembers }, cursor: state.cursor,
    documents: [...state.sourceMembers].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, contentDigest]) => ({ path, contentDigest, bodyFile: `sources/${contentDigest}.json` })),
    changes: state.accepted.map(value => ({ entry: value.entry,
      members: value.members.map(member => ({ change: member.change, contentDigest: member.contentDigest, bodyFile: `sources/${member.contentDigest}.json` })) })) };
}
