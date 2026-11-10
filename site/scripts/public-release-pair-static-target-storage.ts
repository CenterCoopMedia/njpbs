import { validateContentBaseline, type ContentBaseline } from "../../packages/content-core/src/public-content-baseline";
import { publicationFromPrepared } from "../src/lib/public-publication-receipt";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import codec from "../../functions/lib/public-release-pair-static-target.js";
import proofParser from "../../functions/lib/no-build-post-static-proof.js";
import { assertPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { assertPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import { readPublicReleasePairOutputFile } from "./public-release-pair-output-file";
import { writePublicReleasePairClaimJson, readPublicReleasePairClaimJson, type PairViewStore, type PairClaimJsonDescriptor } from "./public-release-pair-view-storage";
import { recomputePublicReleasePairStaticArtifact, type FrozenStaticSource, type StaticArtifactOutput } from "./public-release-pair-static-artifact";
import { openPublicReleasePairStaticSourceInputs } from "./public-release-pair-static-source-storage";
import { PAIR_CODE_PACK_CHUNK_BYTES, encodePublicReleasePairCodePackChunk, decodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack-chunks";
import { isPairCodePackPath, type PairCodePack } from "./public-release-pair-code-pack";

type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; signal?: AbortSignal };
type CompletedOwner = Owner & { viewManifestDigest: string };
type Alias = { path: string; bytes: number; digest: string; chunks: PairClaimJsonDescriptor[] };
type Artifact = Awaited<ReturnType<typeof recomputePublicReleasePairStaticArtifact>>;
type Root = { schemaVersion: 1; kind: "pair-static-target"; pairDigest: string; taskId: string; identity: PairTaskIdentity;
  inputManifestDigest: string; claimDigest: string; source: { publicationDigest: string; statusDigest: string; proofDigest: string };
  target: { prepared: Artifact["prepared"]; artifact: Artifact["artifact"]; proof: Artifact["proof"]; baseline: ContentBaseline }; aliases: Alias[] };
type Baseline = { manifest: PairCodePack; readMember(path: string): Promise<Uint8Array> };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
function exact(value: any, keys: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) refuse(); }
function original(source: FrozenStaticSource) { return { publicationDigest: source.publicationDigest, statusDigest: source.statusDigest, proofDigest: source.proofDigest }; }
async function parseRoot(raw: any, owner: Owner, source: FrozenStaticSource): Promise<Root> {
  exact(raw, ["schemaVersion", "kind", "pairDigest", "taskId", "identity", "inputManifestDigest", "claimDigest", "source", "target", "aliases"]);
  exact(raw.target, ["prepared", "artifact", "proof", "baseline"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "pair-static-target" || raw.pairDigest !== protocol.publicReleaseDigest(owner.pair) ||
      raw.taskId !== protocol.publicReleaseDigest(owner.identity) || !isDeepStrictEqual(raw.identity, owner.identity) || raw.inputManifestDigest !== owner.identity.inputManifestDigest ||
      raw.claimDigest !== owner.claimDigest || !isDeepStrictEqual(raw.source, original(source))) refuse();
  const prepared = assertPreparedPublicWorkerArtifact(raw.target.prepared), artifact = assertPublicArtifactInventoryReceipt(raw.target.artifact), proof = proofParser.projectStaticProof(raw.target.proof);
  if (prepared.commitSha !== owner.pair.commitSha || artifact.commitSha !== prepared.commitSha || artifact.buildBatchId !== prepared.buildBatchId ||
      artifact.generation !== prepared.generation || artifact.mediaManifestDigest !== prepared.mediaManifestDigest || hash(JSON.stringify(artifact)) !== prepared.artifactReceiptDigest ||
      !isDeepStrictEqual(proofParser.staticProofInput(proof), proofParser.staticProofInput(source.proof)) ||
      proof.files.find(file => file.path === "/_publication.json")?.digest !== prepared.publicationReceiptDigest ||
      !Array.isArray(raw.aliases) || raw.aliases.length > view.VIEW_OUTPUT_LIMIT) refuse();
  const baseline = await validateContentBaseline(raw.target.baseline, publicationFromPrepared(prepared));
  const publicationFile = proof.files.find(file => file.path === "/_publication.json")!;
  if (baseline.files.length + 1 !== prepared.artifactFileCount || baseline.files.reduce((sum, file) => sum + file.bytes, publicationFile.bytes) !== prepared.artifactBytes) refuse();
  let previous = "";
  const aliases = raw.aliases.map((alias: any) => {
    exact(alias, ["path", "bytes", "digest", "chunks"]);
    if (!isPairCodePackPath(`${alias.path}index.html`) || alias.path <= previous || !alias.path.endsWith("/") ||
        !Number.isSafeInteger(alias.bytes) || alias.bytes < 1 || alias.bytes > view.BODY_BYTES_LIMIT || !/^[a-f0-9]{64}$/.test(alias.digest) ||
        !Array.isArray(alias.chunks) || alias.chunks.length !== Math.ceil(alias.bytes / PAIR_CODE_PACK_CHUNK_BYTES)) refuse();
    previous = alias.path; return alias as Alias;
  });
  return { ...raw, identity: owner.identity, target: { prepared, artifact, proof, baseline }, aliases };
}
/** Private supplemental bytes and the existing live producer's full receipt
 * have one original claim. The G manifest seals this descriptor's digest. */
export async function writePublicReleasePairStaticTarget(owner: Owner, source: FrozenStaticSource, artifact: Artifact,
  aliases: readonly { path: string; read(): Promise<Uint8Array> }[]) {
  const retained: Alias[] = [];
  for (const alias of [...aliases].sort((a, b) => a.path < b.path ? -1 : 1)) {
    const bytes = await alias.read(); if (!bytes.length || bytes.length > view.BODY_BYTES_LIMIT) refuse();
    const chunks: PairClaimJsonDescriptor[] = [];
    for (let offset = 0; offset < bytes.length; offset += PAIR_CODE_PACK_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + PAIR_CODE_PACK_CHUNK_BYTES);
      chunks.push(await writePublicReleasePairClaimJson({ ...owner,
        value: JSON.parse(new TextDecoder().decode(encodePublicReleasePairCodePackChunk(part))), limit: view.BODY_BYTES_LIMIT }));
    }
    retained.push({ path: alias.path, bytes: bytes.length, digest: hash(bytes), chunks });
  }
  const publication = publicationFromPrepared(artifact.prepared);
  const baseline = await validateContentBaseline({ schemaVersion: 1, publication, files: artifact.files }, publication);
  const root = await parseRoot({ schemaVersion: 1, kind: "pair-static-target", pairDigest: protocol.publicReleaseDigest(owner.pair),
    taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity, inputManifestDigest: owner.identity.inputManifestDigest, claimDigest: owner.claimDigest,
    source: original(source), target: { prepared: artifact.prepared, artifact: artifact.artifact, proof: artifact.proof, baseline }, aliases: retained }, owner, source);
  const descriptor = await writePublicReleasePairClaimJson({ ...owner, value: root, limit: view.BODY_BYTES_LIMIT });
  return { root, descriptor };
}
/** Commit before task settlement, after the actual view digest is known. */
export async function recordPublicReleasePairStaticTargetClaim(owner: CompletedOwner, descriptor: PairClaimJsonDescriptor) {
  if (!descriptor || !/^[a-f0-9]{64}$/.test(descriptor.digest) || descriptor.key !== view.publicReleasePairViewObjectKey(owner.pair, owner.identity, owner.claimDigest, descriptor.digest) ||
      !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > view.BODY_BYTES_LIMIT) refuse();
  const taskId = protocol.publicReleaseDigest(owner.identity), base = work.publicReleasePairPath(owner.pair.pairId);
  const record = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(owner.pair), identity: owner.identity, taskId,
    claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest, descriptor };
  await owner.firestore.runTransaction(async transaction => {
    const ref = owner.firestore.doc(codec.publicReleasePairStaticTargetClaimPath(owner.pair, owner.claimDigest));
    const [task, journal, before] = await transaction.getAll(owner.firestore.doc(`${base}/work/${taskId}`),
      owner.firestore.doc(`${base}/journals/${owner.pair.publisher.journalNamespace}`), ref);
    const current = task.data(), job = journal.data()?.job;
    if (current?.status !== "running" || current.claimDigest !== owner.claimDigest || current.leaseUntil <= Date.now() ||
        protocol.publicReleaseDigest(current.identity) !== taskId || job?.taskId !== taskId || job.claimDigest !== owner.claimDigest || job.leaseUntil !== current.leaseUntil) refuse();
    owner.signal?.throwIfAborted();
    if (before.exists) { if (!isDeepStrictEqual(before.data(), record)) refuse(); } else transaction.create(ref, record);
  });
  return record;
}
export async function readPublicReleasePairStaticTargetClaim(owner: CompletedOwner, source: FrozenStaticSource, targetDigest: string) {
  const raw = (await owner.firestore.doc(codec.publicReleasePairStaticTargetClaimPath(owner.pair, owner.claimDigest)).get()).data();
  if (!raw) refuse();
  exact(raw, ["schemaVersion", "pairDigest", "identity", "taskId", "claimDigest", "viewManifestDigest", "descriptor"]);
  if (raw.schemaVersion !== 1 || raw.pairDigest !== protocol.publicReleaseDigest(owner.pair) || raw.taskId !== protocol.publicReleaseDigest(owner.identity) ||
      !isDeepStrictEqual(raw.identity, owner.identity) || raw.claimDigest !== owner.claimDigest || raw.viewManifestDigest !== owner.viewManifestDigest || raw.descriptor?.digest !== targetDigest) refuse();
  const descriptor = raw.descriptor as PairClaimJsonDescriptor;
  const root = await parseRoot(await readPublicReleasePairClaimJson({ ...owner, descriptor, limit: view.BODY_BYTES_LIMIT }), owner, source);
  const aliases = root.aliases.map(alias => ({ path: alias.path, async read() {
    const chunks = [];
    for (let index = 0; index < alias.chunks.length; index++) chunks.push(decodePublicReleasePairCodePackChunk(
      await readPublicReleasePairClaimJson({ ...owner, descriptor: alias.chunks[index], limit: view.BODY_BYTES_LIMIT }),
      Math.min(PAIR_CODE_PACK_CHUNK_BYTES, alias.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES)));
    const bytes = new Uint8Array(Buffer.concat(chunks)); if (bytes.length !== alias.bytes || hash(bytes) !== alias.digest) refuse();
    return bytes;
  } }));
  return { root, descriptor, aliases };
}
/** Verify the complete full-artifact recipe against G's actual body pass.
 * Recovery uses the completed original owner and private alias dependencies;
 * it never runs a renderer, claims work or settles a publication again. */
export async function retainStaticArtifactOutput(directory: string, ordinal: number,
  output: { path: string; status: number; body: Uint8Array; headers?: Readonly<Record<string, string>> }): Promise<() => Promise<StaticArtifactOutput>> {
  const file = path.join(directory, "bodies", String(ordinal));
  const metadata = { path: output.path, status: output.status, headers: output.headers && { ...output.headers } };
  await writeFile(file, output.body, { flag: "wx", mode: 0o600 });
  return async () => ({ ...metadata, bytes: await readPublicReleasePairOutputFile(file, view.BODY_BYTES_LIMIT) });
}

export async function preparePublicReleasePairStaticTargetReadback(owner: CompletedOwner, frozen: { root: PairInputRoot; readFile(name: string): Promise<Uint8Array> },
  baseline: Baseline, renderedAt: string, targetDigest?: string) {
  const { documents, source } = await openPublicReleasePairStaticSourceInputs(frozen.root, frozen.readFile);
  if (!source) { if (targetDigest !== undefined) refuse(); return null; }
  if (!targetDigest) refuse();
  const target = await readPublicReleasePairStaticTargetClaim(owner, source, targetDigest);
  const directory = await mkdtemp(path.join(os.tmpdir(), "njpbs-static-readback-")), outputs: Array<{ path: string; read(): Promise<StaticArtifactOutput> }> = [];
  await mkdir(path.join(directory, "bodies"), { mode: 0o700 });
  let complete = false;
  return {
    async output(output: { path: string; status: number; body: Uint8Array; headers?: Readonly<Record<string, string>> }) {
      outputs.push({ path: output.path, read: await retainStaticArtifactOutput(directory, outputs.length, output) });
    },
    async complete() {
      const actual = await recomputePublicReleasePairStaticArtifact({ pair: owner.pair, identity: owner.identity, source, documents, renderedAt,
        baseline: baseline.manifest, readBaseline: path => baseline.readMember(path), outputs, aliases: target.aliases,
        directory: path.join(directory, "artifact"), verifyReceipts: true, signal: owner.signal });
      const publication = publicationFromPrepared(actual.prepared), baselineManifest = await validateContentBaseline({ schemaVersion: 1, publication, files: actual.files }, publication);
      if (!isDeepStrictEqual(target.root.target, { prepared: actual.prepared, artifact: actual.artifact, proof: actual.proof, baseline: baselineManifest })) refuse();
      complete = true;
    },
    async persist(staged: { readbackDigest: string }) {
      if (!complete) refuse();
      const row = codec.parsePublicReleasePairStaticTargetProof({ schemaVersion: 1, kind: "pair-static-target-proof", status: "staged",
        pairDigest: protocol.publicReleaseDigest(owner.pair), taskId: protocol.publicReleaseDigest(owner.identity), identity: owner.identity,
        claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest, viewReadbackDigest: staged.readbackDigest,
        inputManifestDigest: owner.identity.inputManifestDigest, descriptor: target.descriptor, sourcePublicationDigest: source.publicationDigest,
        sourceStatusDigest: source.statusDigest, targetPublicationDigest: target.root.target.prepared.publicationReceiptDigest,
        targetStatusDigest: target.root.target.proof.files.find(file => file.path === "/_content-status.json")!.digest },
      owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest, targetDigest, staged.readbackDigest);
      await owner.firestore.runTransaction(async transaction => {
        await work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: row.taskId, manifestDigest: owner.viewManifestDigest });
        const base = work.publicReleasePairPath(owner.pair.pairId), ref = owner.firestore.doc(codec.publicReleasePairStaticTargetProofPath(owner.pair, owner.viewManifestDigest));
        const [before, viewRow] = await transaction.getAll(ref, owner.firestore.doc(`${base}/views/${owner.viewManifestDigest}`));
        const actual = viewRow.data();
        if (actual?.status !== "staged" || actual.claimDigest !== owner.claimDigest || actual.readbackDigest !== row.viewReadbackDigest || !isDeepStrictEqual(actual.identity, owner.identity)) refuse();
        owner.signal?.throwIfAborted(); if (before.exists) { if (!isDeepStrictEqual(before.data(), row)) refuse(); } else transaction.create(ref, row);
      });
      return row;
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
