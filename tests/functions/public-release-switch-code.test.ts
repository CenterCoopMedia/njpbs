import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, afterEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { publicReleaseCodePackFixture } from "../helpers/public-release-code-pack";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import deployment from "../../functions/lib/public-deployment.js";
import log from "../../functions/lib/public-release-change-log.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import code from "../../functions/lib/public-release-pair-code-reference.js";
import { publicReleasePairSourceInputsBytes } from "../../site/scripts/public-release-pair-source-inputs";
import { derivePublicReleasePairCodePack, publicReleasePairCodePackChunkName } from "../../site/scripts/public-release-pair-code-pack";
import { openFrozenPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-storage";
import { capturePublicReleasePairCodePackBaselineInput } from "../../site/scripts/public-release-pair-source-owner";
import { sealPublicReleasePairCodePublication } from "../../site/scripts/public-release-switch-code";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
let db: ReturnType<typeof isolatedFirestore>;
let directory: string;
const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
const store: PairViewStore = {
  async put(key, bytes, options) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: options.customMetadata }); },
  async get(key) { const object = objects.get(key); return object ? { size: object.bytes.length,
    customMetadata: object.metadata, body: new Response(new Uint8Array(object.bytes)).body! } : null; },
};
beforeAll(() => { db = isolatedFirestore("public-release-switch-code.test.ts"); });
beforeEach(async () => {
  objects.clear();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  directory = await mkdtemp(path.join(tmpdir(), "switch-code-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function prepare() {
  const old = releasePair();
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "old-release", activeCommitSha: old.commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-release" });
  await work.registerPublicReleasePair({ firestore: db, pair: old });
  await db.doc("system/publicReleaseChanges").set(log.initialPublicReleaseChangeHead("f".repeat(64)));
  const fixture = publicReleaseBaselineCodeFixture(db, old.commitSha);
  const captured = await baseline.capturePublicReleaseChangeBaseline({ firestore: fixture.firestore, currentCodeRequest: fixture.request, logEpoch: "code-epoch" });
  await db.doc("system/publicReleaseChangeLog").set({ schemaVersion: 2, enabled: true, logEpoch: "code-epoch",
    pair: protocol.publicReleasePairReference(old), head: log.initialPublicReleaseChangeHead("f".repeat(64)) });
  const artifacts = await publicReleaseCodePackFixture(directory, "b".repeat(40), publicReleasePairSourceInputsBytes(captured.receipt, captured.logBaselineDigest));
  const actualCode = publicReleaseBaselineCodeFixture(db, "b".repeat(40)).qualified;
  const publication = { ...actualCode.publication, artifactDigest: artifacts.preparedArtifact.artifactDigest };
  const publicationBytes = JSON.stringify(publication) + "\n";
  const oldPublicationBytes = await readFile(path.join(directory, "dist/_publication.json"));
  await writeFile(path.join(directory, "dist/_publication.json"), publicationBytes);
  await writeFile(path.join(directory, "public-context.json"), JSON.stringify(actualCode.publicContext), { mode: 0o600 });
  artifacts.preparedArtifact = { ...artifacts.preparedArtifact, ...publication,
    publicationReceiptDigest: createHash("sha256").update(publicationBytes).digest("hex"),
    artifactBytes: artifacts.preparedArtifact.artifactBytes - oldPublicationBytes.length + Buffer.byteLength(publicationBytes) };
  const pack = await derivePublicReleasePairCodePack(artifacts);
  const pair = { ...releasePair("b", "b".repeat(40)), rendererDigest: artifacts.pair.rendererDigest, codeAssetManifestDigest: pack.manifest.codeAssetManifestDigest };
  await work.registerPublicReleasePair({ firestore: db, pair });
  await capturePublicReleasePairCodePackBaselineInput({ firestore: db, pair, store, providerStore: store,
    logBaselineDigest: captured.logBaselineDigest, codePackArtifacts: artifacts });
  return pair;
}
const seal = (pair: ReturnType<typeof releasePair>) => sealPublicReleasePairCodePublication({ firestore: db, store, pair,
  publicContextPath: path.join(directory, "public-context.json") });
it("seals actual retained publication bytes and resolves the same create-only reference on retry", async () => {
  const pair = await prepare();
  const first = await seal(pair);
  expect(first.idempotent).toBe(false);
  expect(first.reference.publicationDigest).toBe(createHash("sha256").update(await readFile(path.join(directory, "dist/_publication.json"))).digest("hex"));
  expect(await seal(pair)).toEqual({ idempotent: true, reference: first.reference });
  const resolved = await db.runTransaction(transaction => code.assertPairCodeReferenceInTransaction({ firestore: db, transaction, reference: first.reference }), { readOnly: true });
  expect(resolved.pair).toEqual(pair);
  expect(resolved.publication.baselineDigest).toBe(protocol.publicReleaseDigest(resolved.baseline));
  await expect(db.runTransaction(transaction => code.assertPairCodeReferenceInTransaction({ firestore: db, transaction,
    reference: { ...first.reference, publicationDigest: "0".repeat(64) } }), { readOnly: true })).rejects.toThrow();
});
it("refuses corrupted retained bytes, even after a prior seal", async () => {
  const pair = await prepare();
  await seal(pair);
  // The actual publication body is a JSON chunk in H's immutable input store.
  const opened = await openFrozenPublicReleasePairCodePack({ firestore: db, store, pair });
  const member = opened.manifest.members.find(member => member.path === "/_publication.json")!;
  const file = opened.root.files.find(file => file.name === publicReleasePairCodePackChunkName(member, 0))!;
  const entry = objects.get(file.objectKey);
  expect(entry).toBeDefined();
  entry!.bytes = new TextEncoder().encode("corrupt");
  await expect(seal(pair)).rejects.toThrow();
});
it("refuses OLD's private context instead of relabeling it as NEW CODE", async () => {
  const pair = await prepare();
  await writeFile(path.join(directory, "public-context.json"), JSON.stringify(publicReleaseBaselineCodeFixture(db, "a".repeat(40)).qualified.publicContext));
  await expect(seal(pair)).rejects.toThrow();
  expect((await db.doc(code.pairCodePublicationPath(pair)).get()).exists).toBe(false);
});
