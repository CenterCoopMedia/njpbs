import work from "../../functions/lib/public-release-pair-work.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import proofParser from "../../functions/lib/no-build-post-static-proof.js";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt";
import { validateContentBaseline } from "../../packages/content-core/src/public-content-baseline";
import { decodePublicReleasePairCodePackChunk, PAIR_CODE_PACK_CHUNK_BYTES } from "./public-release-pair-code-pack-chunks";
import type { StaticPostProof } from "./prepare-static-post-proof";
export const PAIR_STATIC_SOURCE_FILE = "static-source.json";
const BASELINE_FILE = "static-source/baseline.json";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class PairStaticSourceError extends work.PairExecutionError {
  constructor(readonly reason: "pair-static-source-missing" | "pair-static-source-mismatch") {
    super(reason === "pair-static-source-missing" ? "input-unavailable" : "byte-mismatch"); this.name = "PairStaticSourceError";
  }
}
function mismatch(): never { throw new PairStaticSourceError("pair-static-source-mismatch"); }
function exact(value: any, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...fields].sort().join()) mismatch();
}
export function soleStaticPostOwner(documents: ReadonlyMap<string, any>) {
  const rows = [...documents].filter(([path, value]) => /^system\/publicDeployment\/noBuildPostOwners\/[A-Za-z0-9_-]+$/.test(path) && value?.operationId);
  const legacy = documents.get("system/publicDeployment/noBuildPosts/current");
  if (legacy?.operationId && !rows.some(([, state]) => state.postId === legacy.postId)) rows.push(["system/publicDeployment/noBuildPosts/current", legacy]);
  return rows.length === 1 && rows[0][1].mode === "static" ? { path: rows[0][0], state: rows[0][1] } : null;
}
export const staticSourceBaselineFile = BASELINE_FILE;
export function staticProofArtifactFile(path: string) {
  return path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
}
/** The immutable H descriptor retains OLD receipts verbatim. It certifies
 * source provenance only; it is never a NEW publication or target identity. */
export async function openFrozenPublicReleasePairStaticSource({ documents, originalPublication, readFrozenFile }: {
  documents: ReadonlyMap<string, any>; originalPublication: unknown;
  readFrozenFile(name: string): Promise<Uint8Array>;
}) {
  const owner = soleStaticPostOwner(documents);
  if (!owner) return null;
  const read = async (name: string) => {
    try { return await readFrozenFile(name); } catch { throw new PairStaticSourceError("pair-static-source-missing"); }
  };
  let descriptor: any, baseline;
  try {
    descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(PAIR_STATIC_SOURCE_FILE)));
    exact(descriptor, ["schemaVersion", "kind", "ownerPath", "proof", "publication", "baselineFile", "files"]);
    if (descriptor.schemaVersion !== 1 || descriptor.kind !== "pair-static-source" || descriptor.ownerPath !== owner.path || descriptor.baselineFile !== BASELINE_FILE) mismatch();
    const publication = canonicalPublicationReceipt(descriptor.publication), original = canonicalPublicationReceipt(originalPublication);
    // A retained static artifact can differ from the immutable CODE baseline
    // while using the same renderer. The live static reader binds the owner,
    // actual proof files and renderer; it does not retag CODE's artifact seals.
    if (publication.commitSha !== original.commitSha || owner.state.rendererSha !== publication.commitSha || owner.state.generation !== publication.generation) mismatch();
    const proof = proofParser.projectStaticProof(descriptor.proof) as StaticPostProof;
    if (!isDeepStrictEqual(proof, proofParser.projectStaticProof(owner.state.staticProof)) || proof.postId !== owner.state.postId || proof.operationId !== owner.state.operationId) mismatch();
    baseline = await validateContentBaseline(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(BASELINE_FILE))), publication);
    const table = new Map(baseline.files.map(file => [file.path, file]));
    for (const file of proof.files) if (file.path !== "/_publication.json") {
      const artifact = table.get(staticProofArtifactFile(file.path));
      if (!artifact || artifact.bytes !== file.bytes || artifact.digest !== file.digest) mismatch();
    }
    if (!Array.isArray(descriptor.files) || descriptor.files.length !== 2) mismatch();
    const bodies = new Map<string, Uint8Array>();
    for (const [index, path] of ["/_content-status.json", "/_publication.json"].entries()) {
      const file = descriptor.files[index]; exact(file, ["path", "bytes", "digest", "chunkFiles"]);
      const sealed = proof.files.find(file => file.path === path);
      if (!sealed || file.path !== path || file.bytes !== sealed.bytes || file.digest !== sealed.digest || !Array.isArray(file.chunkFiles) ||
          file.chunkFiles.length !== Math.max(1, Math.ceil(file.bytes / PAIR_CODE_PACK_CHUNK_BYTES))) mismatch();
      const parts: Uint8Array[] = [];
      for (let chunk = 0; chunk < file.chunkFiles.length; chunk++) {
        const name = `static-source/objects/${file.digest}/${String(chunk).padStart(4, "0")}.json`;
        if (file.chunkFiles[chunk] !== name) mismatch();
        parts.push(decodePublicReleasePairCodePackChunk(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(name))),
          Math.min(PAIR_CODE_PACK_CHUNK_BYTES, file.bytes - chunk * PAIR_CODE_PACK_CHUNK_BYTES)));
      }
      const bytes = new Uint8Array(Buffer.concat(parts));
      if (bytes.length !== file.bytes || hash(bytes) !== file.digest) mismatch(); bodies.set(path, bytes);
    }
    const publicationBytes = bodies.get("/_publication.json")!, statusBytes = bodies.get("/_content-status.json")!;
    if (!isDeepStrictEqual(canonicalPublicationReceipt(JSON.parse(Buffer.from(publicationBytes).toString("utf8"))), publication)) mismatch();
    const status = JSON.parse(Buffer.from(statusBytes).toString("utf8"));
    if (status?.schemaVersion !== 1 || status.buildBatchId !== publication.buildBatchId || status.generation !== publication.generation ||
        status.commitSha !== publication.commitSha || !Array.isArray(status.routes) || status.routes.length > 10_000 ||
        !isDeepStrictEqual(status.collections, ["cmsPages", "cmsPosts"])) mismatch();
    const key = createHash("sha256").update(`cmsPosts/${proof.postId}`).digest("hex");
    const routes = status.routes.filter((row: any) => row?.contentKey === key || proof.ownedSlugs.some(slug => row?.path === `/posts/${slug}/`));
    if (proof.visible ? routes.length !== 1 || routes[0].path !== `/posts/${proof.slug}/` || routes[0].contentKey !== key || routes[0].sourceVersion !== proof.sourceVersion : routes.length !== 0) mismatch();
    return { owner, proof, publication, baseline, publicationBytes, statusBytes,
      publicationDigest: hash(publicationBytes), statusDigest: hash(statusBytes), proofDigest: hash(new TextEncoder().encode(JSON.stringify(proof))) };
  } catch (error) {
    if (error instanceof PairStaticSourceError) throw error;
    return mismatch();
  }
}
