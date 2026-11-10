import { createHash } from "node:crypto";
import { openPublicReleasePairSourceDocuments } from "./public-release-pair-source-documents";
import { decodePublicReleasePairCodePackChunk, PAIR_CODE_PACK_CHUNK_BYTES } from "./public-release-pair-code-pack-chunks";
import historical from "../../functions/lib/public-release-historical-code.js";
import { isDeepStrictEqual } from "node:util";
import proofParser from "../../functions/lib/no-build-post-static-proof.js";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import { baselineManifestKey, baselineObjectKey, BASELINE_MANIFEST_BYTES, validateContentBaseline } from "../../packages/content-core/src/public-content-baseline";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt";
import { publicationTarget } from "../../functions/lib/publication-target";
import type { HistoricalPublicReleaseState } from "../../functions/lib/public-release-historical-state";
import { PAIR_STATIC_SOURCE_FILE, staticSourceBaselineFile, staticProofArtifactFile, soleStaticPostOwner, openFrozenPublicReleasePairStaticSource, PairStaticSourceError } from "./public-release-pair-static-source";
/** Read only immutable original artifact names. Call before H capture; all
 * later render/recovery reads open the retained H files instead of this store. */
export async function freezePublicReleasePairStaticSource({ state, originalPublication, environment, readContentObject, files, chunk }: {
  state: HistoricalPublicReleaseState; originalPublication: unknown; environment: "development" | "production";
  readContentObject(key: string, limit: number): Promise<Uint8Array>;
  files: Map<string, Uint8Array>; chunk(prefix: string, bytes: Uint8Array): string[];
}) {
  const owner = soleStaticPostOwner(state.documents);
  if (!owner) return;
  try {
    const proof = proofParser.projectStaticProof(owner.state.staticProof), codePublication = canonicalPublicationReceipt(originalPublication);
    const target = publicationTarget(environment), publicationFile = proof.files.find(file => file.path === "/_publication.json");
    if (!publicationFile) throw new PairStaticSourceError("pair-static-source-mismatch");
    const publicationBytes = await readContentObject(baselineObjectKey(target, publicationFile.digest), 2048);
    if (publicationBytes.length !== publicationFile.bytes || createHash("sha256").update(publicationBytes).digest("hex") !== publicationFile.digest) throw new PairStaticSourceError("pair-static-source-mismatch");
    const publication = canonicalPublicationReceipt(JSON.parse(Buffer.from(publicationBytes).toString("utf8")));
    if (publication.commitSha !== codePublication.commitSha) throw new PairStaticSourceError("pair-static-source-mismatch");
    const current = await staticReturn.currentStaticInput({ state: owner.state, firestore: { doc: (path: string) => ({ path }) },
      transaction: { get: async (reference: { path: string }) => ({ data: () => state.documents.get(reference.path) }) } } as any);
    if (!isDeepStrictEqual(current, proofParser.staticProofInput(proof))) throw new PairStaticSourceError("pair-static-source-mismatch");
    const manifestBytes = await readContentObject(baselineManifestKey(target, publication), BASELINE_MANIFEST_BYTES);
    const baseline = await validateContentBaseline(JSON.parse(Buffer.from(manifestBytes).toString("utf8")), publication);
    files.set(staticSourceBaselineFile, manifestBytes);
    const table = new Map(baseline.files.map(file => [file.path, file]));
    const retained = [];
    for (const path of ["/_content-status.json", "/_publication.json"]) {
      const file = proof.files.find(file => file.path === path);
      if (!file || path !== "/_publication.json" && table.get(staticProofArtifactFile(path))?.digest !== file.digest) throw new PairStaticSourceError("pair-static-source-mismatch");
      const bytes = path === "/_publication.json" ? publicationBytes : await readContentObject(baselineObjectKey(target, file.digest), proofParser.MAX_FILE_BYTES);
      retained.push({ ...file, chunkFiles: chunk(`static-source/objects/${file.digest}`, bytes) });
    }
    files.set(PAIR_STATIC_SOURCE_FILE, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: "pair-static-source", ownerPath: owner.path,
      proof, publication, baselineFile: staticSourceBaselineFile, files: retained })));
    await openFrozenPublicReleasePairStaticSource({ documents: state.documents, originalPublication,
      readFrozenFile: async name => { const bytes = files.get(name); if (!bytes) throw new PairStaticSourceError("pair-static-source-missing"); return bytes; } });
  } catch (error) {
    if (error instanceof PairStaticSourceError) throw error;
    throw new PairStaticSourceError("pair-static-source-mismatch");
  }
}

/** Reopen only H's authenticated source/canonical CODE pack. This is also used
 * after a crash; no provider or database document supplies renderer input. */
export async function openPublicReleasePairStaticSourceInputs(root: import("../../functions/lib/public-release-pair-input").PairInputRoot,
  readFrozenFile: (name: string) => Promise<Uint8Array>) {
  const { documents } = await openPublicReleasePairSourceDocuments(root, readFrozenFile);
  const owner = soleStaticPostOwner(documents), present = root.files.some(file => file.name === PAIR_STATIC_SOURCE_FILE);
  if (!owner) { if (present) throw new PairStaticSourceError("pair-static-source-mismatch"); return { documents, source: null }; }
  try {
    const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFrozenFile("code-source.json")));
    if (!descriptor || Object.keys(descriptor).sort().join() !== "bytes,chunkFiles,reference,schemaVersion,sha256" || descriptor.schemaVersion !== 1 ||
        !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
        !Array.isArray(descriptor.chunkFiles) || descriptor.chunkFiles.length !== Math.ceil(descriptor.bytes / PAIR_CODE_PACK_CHUNK_BYTES)) throw new PairStaticSourceError("pair-static-source-mismatch");
    const parts: Uint8Array[] = [];
    for (let index = 0; index < descriptor.chunkFiles.length; index++) {
      const name = `code-source/objects/${String(index).padStart(4, "0")}.json`;
      if (descriptor.chunkFiles[index] !== name) throw new PairStaticSourceError("pair-static-source-mismatch");
      parts.push(decodePublicReleasePairCodePackChunk(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFrozenFile(name))),
        Math.min(PAIR_CODE_PACK_CHUNK_BYTES, descriptor.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES)));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== descriptor.bytes || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw new PairStaticSourceError("pair-static-source-mismatch");
    const code = JSON.parse(bytes.toString("utf8"));
    historical.verifyPublicReleaseQualifiedCode(code);
    if (!isDeepStrictEqual(code.reference, descriptor.reference)) throw new PairStaticSourceError("pair-static-source-mismatch");
    return { documents, source: await openFrozenPublicReleasePairStaticSource({ documents, originalPublication: code.publication, readFrozenFile }) };
  } catch (error) {
    if (error instanceof PairStaticSourceError) throw error;
    throw new PairStaticSourceError("pair-static-source-mismatch");
  }
}
