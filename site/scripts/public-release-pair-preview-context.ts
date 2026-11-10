import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import { openPublicReleasePairSourceDocuments } from "./public-release-pair-source-documents";
import { parsePublicReleasePairReplayProvenance } from "./public-release-pair-replay";
import { PAIR_CODE_PACK_CHUNK_BYTES, decodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack";
import { assertContextMatchesPublication } from "../src/lib/retained-public-context";
import { assertHomeSourcePublication } from "../src/lib/home-editorial-catalog";
import type { HomeSourceSnapshot } from "../src/lib/home-sources";

const require = createRequire(import.meta.url), output = require("../../functions/lib/cms-pair-editorial-context.js");
const { validateCurrentCodeReference } = require("../../functions/lib/current-public-code-source.js");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new Error("Frozen paired editorial source is unavailable"); }
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) refuse();
}
const json = (bytes: Uint8Array): any => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

export type PairPreviewContextOutput = {
  pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string;
  root: PairInputRoot; readFrozenFile(name: string): Promise<Uint8Array>; homeSourceBytes: Uint8Array; renderedAt: string;
};
/** This is an immutable source DTO, not recreated CODE or a public receipt.
 * Only original H data and the actual rendered Home output may enter it. */
export async function derivePairPreviewContextSource(input: PairPreviewContextOutput) {
  const { pair, root, identity, readFrozenFile: read } = input;
  if (root.pairDigest !== protocol.publicReleaseDigest(pair) || identity.inputManifestDigest !== hash(Buffer.from(JSON.stringify(root))) ||
      root.cursor.sequence !== identity.contextSequence || !root.files.some(f => f.name === "source-census.json")) refuse();
  const { documents } = await openPublicReleasePairSourceDocuments(root, read);
  const provenance = parsePublicReleasePairReplayProvenance(json(await read("reader-provenance.json")));
  if (provenance.pair.environment !== pair.environment) refuse();
  const descriptor = json(await read("code-source.json"));
  exact(descriptor, ["schemaVersion", "reference", "sha256", "bytes", "chunkFiles"]);
  if (descriptor.schemaVersion !== 1 || !hex(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 1 || descriptor.bytes > output.MAX_BYTES || !Array.isArray(descriptor.chunkFiles) ||
      descriptor.chunkFiles.length !== Math.ceil(descriptor.bytes / PAIR_CODE_PACK_CHUNK_BYTES) || new Set(descriptor.chunkFiles).size !== descriptor.chunkFiles.length) refuse();
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < descriptor.chunkFiles.length; index++) {
    if (descriptor.chunkFiles[index] !== `code-source/objects/${String(index).padStart(4, "0")}.json`) refuse();
    chunks.push(decodePublicReleasePairCodePackChunk(json(await read(descriptor.chunkFiles[index])),
      Math.min(PAIR_CODE_PACK_CHUNK_BYTES, descriptor.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES)));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) refuse();
  const qualified = json(bytes), reference = validateCurrentCodeReference(qualified.reference);
  if (!same(reference, descriptor.reference) || !same(reference.publication, qualified.publication) || reference.publication.commitSha !== provenance.rendererSha) refuse();
  assertContextMatchesPublication(qualified.publicContext, qualified.publication);
  const rawHome = json(input.homeSourceBytes);
  const homeSources = assertHomeSourcePublication(rawHome as HomeSourceSnapshot, rawHome.publication);
  if (homeSources.publication?.commitSha !== provenance.rendererSha) refuse();
  const programImageDescriptors = qualified.originalProgramImageCatalog ?? qualified.publicContext.programImageDescriptors;
  const source = { schemaVersion: 2, kind: "pair-editorial-context-source", pair: protocol.publicReleasePairReference(pair),
    pairDigest: protocol.publicReleaseDigest(pair), identity, claimDigest: input.claimDigest, viewManifestDigest: input.viewManifestDigest,
    cursor: root.cursor, renderedAt: input.renderedAt, sourcePair: protocol.publicReleasePairReference(provenance.pair),
    originalCode: { reference, qualifiedCodeDigest: descriptor.sha256,
      ...(programImageDescriptors === undefined ? {} : { programImageDescriptors }) },
    documents: [...documents].filter(([path]) => /^(cmsPages|cmsPosts|cmsAuthorProfilesPublic|cmsSettings|media_assets_public|cmsVersionHistory)\//.test(path))
      .sort(([a], [b]) => a < b ? -1 : 1).map(([path, data]) => ({ path, data })), homeSources };
  return output.parsePairEditorialContextSource(source, pair);
}
export async function retainPairPreviewContext({ firestore, ...input }: PairPreviewContextOutput & { firestore: Firestore }) {
  const source = await derivePairPreviewContextSource(input);
  return output.writePairEditorialContext({ firestore, pair: input.pair, source });
}

/** At most one side write plus the newest pending view. Public work never
 * awaits retries. Transient SDK/RPC failures get three idempotent attempts;
 * a newer view supersedes retries. Coalescing bounds memory during an outage. */
export function createPairPreviewContextSideWriter<T>(write: (input: T) => Promise<unknown>,
  onFailure: () => void = () => console.warn("pair-preview-context-retention-failed")) {
  let running = false, pending: { input: T } | undefined;
  const transient = (error: unknown) => {
    const value = error as { code?: unknown; name?: unknown } | undefined;
    return [4, 8, 10, 14, "storage-unavailable", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(value?.code as number | string)
      || value?.name === "TimeoutError" || error instanceof TypeError;
  };
  const failed = () => {
    // Never include exception messages, document bodies or credentials. A
    // broken diagnostic must remain as optional as the retention itself.
    try { onFailure(); } catch { /* Publication does not depend on diagnostics. */ }
  };
  const start = () => {
    if (running || !pending) return;
    running = true;
    const job = pending; pending = undefined;
    void Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await write(job.input); return; }
        catch (error) {
          if (attempt === 2 || !transient(error) || pending) { failed(); return; }
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          if (pending) { failed(); return; }
        }
      }
    }).catch(failed).finally(() => {
      running = false; start();
    });
  };
  return (input: T): void => { pending = { input }; start(); };
}
