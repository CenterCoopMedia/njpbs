import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pair, receipt, selector } from "../helpers/cms-preview-pairs.js";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { createPreviewPairContextReader, readPreviewPairContextAuthority } from "../../site/scripts/cms-preview-pair-context";
import { createPreviewPairEditorialContextReader } from "../../site/scripts/cms-preview-pair-editorial-context";
import { EditorialPreviewContextNotReadyError } from "../../site/scripts/cms-preview-editorial-context";
const require = createRequire(import.meta.url), pairs = require("../../functions/lib/cms-preview-pair.js"), p = require("../../functions/lib/public-release-pair.js");
const work = require("../../functions/lib/public-release-pair-work.js"), { publicationTarget } = require("../../functions/lib/publication-target.js");
const db = isolatedFirestore("cms-preview-pair-context"), old = pair("old"), next = pair("new", "b"), publicPair = { ...releasePair(), environment: "production" };
let root: any, currentReference: any, dto: any, context: any, reference: any, createTransport: any;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const reader = () => createPreviewPairContextReader({ firestore: db, rendererSha: next.rendererSha, pairId: next.pairId,
  workerVersion: next.workerVersion, target: publicationTarget("production"), readSecret: () => "synthetic", createTransport });
beforeEach(async () => {
  await pairs.registerPair(db, old); await pairs.registerPair(db, next);
  await db.doc(pairs.SELECTOR_PATH).set(selector(old, next)); await db.doc("system/billing").set({ disabled: false });
  root = releaseSelector(); await db.doc("system/publicDeployment").set(root);
  await db.doc(work.publicReleasePairPath(publicPair.pairId)).set(publicPair);
  const cutoffAt = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  const bundle = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
    receipt: createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: "cms-11111111111111111111",
      generation: 1, status: "reserved", commitSha: publicPair.commitSha, reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: bundle.receipt.buildBatchId,
    generation: 1, commitSha: publicPair.commitSha, mediaManifestDigest: bundle.receipt.mediaManifestDigest,
    artifactDigest: "d".repeat(64), artifactReceiptDigest: hash(JSON.stringify(bundle.receipt)) };
  dto = { publicContext: bundle, publication };
  currentReference = { schemaVersion: 2, kind: "pair-current-code", rendererSha: next.rendererSha,
    selection: { pair: p.publicReleasePairReference(publicPair), expectedPublicSelectorDigest: p.publicReleaseDigest(root), previewPairId: next.pairId, previewCandidateReceiptId: null },
    pairDigest: p.publicReleaseDigest(publicPair), qualifiedCodeDigest: hash(JSON.stringify(dto)), qualifiedCodeBytes: Buffer.byteLength(JSON.stringify(dto)),
    source: { schemaVersion: 2, kind: "pair", side: p.publicReleasePairReference(publicPair), commitSha: publicPair.commitSha,
      codeAssetManifestDigest: publicPair.codeAssetManifestDigest, publicationDigest: "a".repeat(64) },
    readerDigests: { functions: "c".repeat(64), cmsApi: "d".repeat(64) } };
  reference = vi.fn(async () => structuredClone(currentReference));
  context = vi.fn(async () => ({ reference: structuredClone(currentReference), qualifiedCode: structuredClone(dto) }));
  createTransport = vi.fn(() => ({ readPairCodeReference: reference, readPairCodeContext: context }));
});
it("consumes an explicit version-two DTO across renderer SHAs without forging legacy transport bytes", async () => {
  const result = await reader()(); expect(result.publicContext).toEqual(dto.publicContext); expect(result.publication).toEqual(dto.publication);
  expect(result.codeReferenceV2.rendererSha).toBe(next.rendererSha); expect(result.publication.commitSha).not.toBe(next.rendererSha);
  expect(createTransport.mock.calls[0][0].pairSelection).toEqual(currentReference.selection);
});
it("accepts a stored selector timestamp and sends the normalized digest required by the real CODE authority", async () => {
  await db.doc("system/publicDeployment").set({ ...root, updatedAt: Timestamp.fromMillis(1_780_000_000_000) });
  const stored = (await db.doc("system/publicDeployment").get()).data();
  const normalized = p.parseVersionedPublicDeployment(stored);
  expect(p.publicReleaseDigest(stored)).not.toBe(p.publicReleaseDigest(normalized));
  const authority = await readPreviewPairContextAuthority({ firestore: db, rendererSha: next.rendererSha, pairId: next.pairId,
    workerVersion: next.workerVersion, target: publicationTarget("production"), readSecret: () => "synthetic", createTransport });
  expect(authority.selection.expectedPublicSelectorDigest).toBe(p.publicReleaseDigest(normalized));
  for (const component of ["functions", "cmsApi"]) await db.doc(`${pairs.READER_RECEIPTS}/${component}`).set(receipt(component));
  const { readPairCodeAuthority } = require("../../functions/lib/pair-current-code-source.js");
  const bridge = await db.runTransaction(transaction => readPairCodeAuthority({ firestore: db, transaction,
    request: { rendererSha: next.rendererSha, selection: authority.selection }, now: Date.now(), includeCode: false }), { readOnly: true });
  expect(p.publicReleaseDigest(bridge.publicSelector)).toBe(authority.selection.expectedPublicSelectorDigest);
  expect((await reader()()).publicContext).toEqual(dto.publicContext);
  expect(createTransport.mock.calls[0][0].pairSelection).toEqual(currentReference.selection);
});
it.each([null, "2026-10-28T12:00:00.000Z"])("refuses malformed stored schema-two updatedAt %s before transport", async updatedAt => {
  await db.doc("system/publicDeployment").set({ ...root, updatedAt });
  await expect(reader()()).rejects.toThrow(); expect(createTransport).not.toHaveBeenCalled();
});
it("cache rechecks deployed readers every time, clones returned data and never caches authority", async () => {
  const read = reader(), first = await read(); first.publicContext.posts.push({ poison: true } as any);
  currentReference.readerDigests.functions = "e".repeat(64);
  const second = await read(); expect(second.publicContext).toEqual(dto.publicContext);
  expect(second.codeReferenceV2.readerDigests.functions).toBe("e".repeat(64)); expect(reference).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledOnce();
  await db.doc("system/billing").update({ disabled: true }); await expect(read()).rejects.toThrow();
  expect(reference).toHaveBeenCalledTimes(2);
});
it.each(["selection", "reader", "pair", "renderer", "source"])("refuses changed %s reference before context consumption", async field => {
  if (field === "selection") currentReference.selection.expectedPublicSelectorDigest = "e".repeat(64);
  if (field === "reader") currentReference.readerDigests.functions = "wrong";
  if (field === "pair") currentReference.pairDigest = "e".repeat(64);
  if (field === "renderer") currentReference.rendererSha = old.rendererSha;
  if (field === "source") currentReference.source.commitSha = next.rendererSha;
  await expect(reader()()).rejects.toThrow("context is unavailable"); expect(context).not.toHaveBeenCalled();
});
it("refuses a reader change between reference and full DTO, and validates opaque context", async () => {
  context.mockImplementationOnce(async () => ({ reference: { ...currentReference, readerDigests: { functions: "f".repeat(64), cmsApi: "d".repeat(64) } }, qualifiedCode: dto }));
  await expect(reader()()).rejects.toBeInstanceOf(EditorialPreviewContextNotReadyError);
  dto.publicContext.receipt.commitSha = next.rendererSha; await expect(reader()()).rejects.toThrow();
});
it("refuses public selector drift after the read even when immutable DTO is cached", async () => {
  const read = reader(); await read();
  reference.mockImplementationOnce(async () => { await db.doc("system/publicDeployment").update({ epoch: 2 }); return structuredClone(currentReference); });
  await expect(read()).rejects.toBeInstanceOf(EditorialPreviewContextNotReadyError); expect(context).toHaveBeenCalledOnce();
});
it("recognizes a stale selector rejection by the bridge as a retryable publication race", async () => {
  reference.mockImplementationOnce(async () => { await db.doc("system/publicDeployment").update({ epoch: 2 }); throw new Error("Versioned CODE unavailable"); });
  await expect(reader()()).rejects.toBeInstanceOf(EditorialPreviewContextNotReadyError);
});
it("uses the actual versioned CODE wire client and validates its opaque DTO at the renderer boundary", async () => {
  const { createPairCurrentCodeTransport } = require("../../functions/lib/current-public-code-v2.js");
  dto.reference = { publication: dto.publication, manifest: { schemaVersion: 1, buildBatchId: dto.publication.buildBatchId,
    artifactReceiptDigest: dto.publication.artifactReceiptDigest, sha256: "1".repeat(64), byteLength: 1,
    key: `public-context/${dto.publication.buildBatchId}/${"1".repeat(64)}.json` } };
  const bytes = Buffer.from(JSON.stringify(dto));
  currentReference.qualifiedCodeDigest = hash(bytes.toString("utf8")); currentReference.qualifiedCodeBytes = bytes.length;
  const wire = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); expect(request.selection).toEqual(currentReference.selection);
    expect(new Headers(init.headers).get("x-njpbs-cms-edge")).toBe("synthetic");
    return Response.json(request.mode === "current-code-reference-v2" ? { schemaVersion: 2, kind: "pair-current-code-reference", reference: currentReference }
      : { schemaVersion: 2, kind: "pair-current-code", reference: currentReference, qualifiedCodeBase64: bytes.toString("base64") });
  });
  createTransport = (options: any) => createPairCurrentCodeTransport({ ...options, request: wire });
  const read = reader(), result = await read(); expect(result.publicContext).toEqual(dto.publicContext);
  expect((await read()).codeReferenceV2).toEqual(result.codeReferenceV2); expect(wire).toHaveBeenCalledTimes(3);
});
it("retained preview authority preserves original public OLD CODE between the two separate bootstrap CAS operations", async () => {
  const legacyPublic = { schemaVersion: 1, state: "idle", mediaLifecycleReady: true, activeGeneration: 7,
    activeDeploymentId: "legacy-seven", activeCommitSha: publicPair.commitSha, lastReservedGeneration: 7,
    newestEligibleGeneration: 7, newestEligibleBuildBatchId: "legacy-seven", updatedAt: new Date().toISOString() };
  const previewAuthority = require("../../functions/lib/cms-preview-pair-candidate.js");
  await db.doc("system/publicDeployment").set(legacyPublic);
  await db.doc(`${previewAuthority.POINTERS}/${next.pairId}`).set({ schemaVersion: 1, pairId: next.pairId, pairDigest: pairs.digest(next),
    candidateReceiptId: "renderer-100-1", candidateDigest: "f".repeat(64), runtimeDigest: "f".repeat(64), bootstrapPublicPair: p.publicReleasePairReference(publicPair) });
  // The candidate can be gone/expired after retention; it grants no admission.
  currentReference.selection.expectedPublicSelectorDigest = p.publicReleaseDigest(legacyPublic);
  expect((await reader()()).publicContext).toEqual(dto.publicContext);
  await db.doc(`${previewAuthority.POINTERS}/${next.pairId}`).update({ pairDigest: "0".repeat(64) });
  await expect(reader()()).rejects.toThrow("context is unavailable");
});
it("legacy-root editorial migration composes the existing aggregate reader under v2 CODE and refuses adoption during that read", async () => {
  const previewAuthority = require("../../functions/lib/cms-preview-pair-candidate.js");
  const legacyPublic = { schemaVersion: 1, state: "idle", mediaLifecycleReady: true, activeGeneration: 7,
    activeDeploymentId: "legacy-seven", activeCommitSha: publicPair.commitSha, lastReservedGeneration: 7,
    newestEligibleGeneration: 7, newestEligibleBuildBatchId: "legacy-seven", updatedAt: new Date().toISOString() };
  await db.doc("system/publicDeployment").set(legacyPublic);
  await db.doc(`${previewAuthority.POINTERS}/${next.pairId}`).set({ schemaVersion: 1, pairId: next.pairId, pairDigest: pairs.digest(next),
    candidateReceiptId: "renderer-100-1", candidateDigest: "f".repeat(64), runtimeDigest: "f".repeat(64), bootstrapPublicPair: p.publicReleasePairReference(publicPair) });
  currentReference.selection.expectedPublicSelectorDigest = p.publicReleaseDigest(legacyPublic);
  const read = createPreviewPairEditorialContextReader({ firestore: db, rendererSha: next.rendererSha, pairId: next.pairId,
    workerVersion: next.workerVersion, target: publicationTarget("production"), readSecret: () => "synthetic", createTransport });
  const aggregate = vi.fn(async publication => ({ publicContext: dto.publicContext, publication }));
  expect(await read(aggregate)).toEqual(dto); expect(aggregate).toHaveBeenCalledExactlyOnceWith(dto.publication);
  aggregate.mockImplementationOnce(async publication => { await db.doc("system/publicDeployment").set(root); return { publicContext: dto.publicContext, publication }; });
  await expect(read(aggregate)).rejects.toBeInstanceOf(EditorialPreviewContextNotReadyError);
});
it("editorial pending-source errors refresh while malformed versioned identities remain hard failures", async () => {
  const source = vi.fn().mockRejectedValueOnce(Object.assign(new Error("safe unavailable source"), { code: "pair_editorial_context_refreshing" }))
    .mockResolvedValue({ schemaVersion: 2, kind: "pair-current-editorial", rendererSha: "wrong" });
  createTransport = () => ({ readPairEditorialReference: source });
  const read = createPreviewPairEditorialContextReader({ firestore: db, rendererSha: next.rendererSha, pairId: next.pairId,
    workerVersion: next.workerVersion, target: publicationTarget("production"), readSecret: () => "synthetic",
    createTransport: () => ({ readPairCodeReference: reference, readPairCodeContext: context,
      readPairEditorialReference: source, readPairEditorialContext: vi.fn() }) });
  const legacy = vi.fn();
  await expect(read(legacy)).rejects.toBeInstanceOf(EditorialPreviewContextNotReadyError);
  await expect(read(legacy)).rejects.toThrow("Paired editorial identity differs"); expect(legacy).not.toHaveBeenCalled();
});
