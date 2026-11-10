import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import { pageDocument } from "./fixtures/home-decision-3441.js";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { startDevelopmentRehearsalHttp } from "../../site/scripts/public-release-rehearsal-http";
import { readOriginalRehearsalProof, verifyOriginalRehearsalProof } from "../../scripts/lib/public-release-rehearsal-proof.mjs";
import { rehearsalHttpHeaders } from "../../scripts/lib/public-release-rehearsal-http-auth.mjs";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission-contract.js";
import serving from "../../functions/lib/public-release-serving.js";
import pages from "../../functions/lib/no-build-page-ownership.js";

const operationId = "R".repeat(20), nativeFetch = globalThis.fetch;
const firestore = isolatedFirestore("rehearsal-original-fact");
const pair = releasePair(), sourcePair = releasePair("b", "b".repeat(40));
const base = work.publicReleasePairPath(pair.pairId), document = pageDocument();
const snapshotDigest = pages.digest(document.published), claimDigest = "d".repeat(64);
const body = new TextEncoder().encode("<!doctype html><html>Original rehearsal source</html>");
const expected = { path: "/contact/", status: 200, bodyDigest: createHash("sha256").update(body).digest("hex"), bytes: body.length };
const selector = { ...releaseSelector(), contentHead: { ...releaseSelector().contentHead, contextSequence: 1 } };
const identity = { schemaVersion: 2, pair: pairReference(pair), kind: "accepted", sourceOperationId: operationId,
  sourceVersion: 7, snapshotDigest, contextSequence: 1, inputManifestDigest: "c".repeat(64) };
const execution = { schemaVersion: 2, pair: pairReference(pair), pairDigest: protocol.publicReleaseDigest(pair), identity,
  taskId: protocol.publicReleaseDigest(identity), inputManifestDigest: identity.inputManifestDigest, claimDigest,
  manifestDigest: selector.contentHead.manifestDigest };
const accepted = { schemaVersion: 2, operationId, source: { kind: "page", id: "contact", family: "pages", action: "publish",
  sourceVersion: 7, snapshotDigest, requiredFeatures: [] }, pair: pairReference(pair), pairDigest: execution.pairDigest,
  epoch: 1, changeSequence: 1, contextRevision: 2, admissionSequence: 1, admittedContractDigest: "b".repeat(64) };
const canonical = { schemaVersion: 2, operationId, selectorDigest: protocol.publicReleaseDigest(selector), proofs: [expected] };
const coverage = { schemaVersion: 2, operationId, admissionDigest: protocol.publicReleaseDigest(accepted), originalExecution: execution };
const receipt = { schemaVersion: 2, kind: "pair-publication-terminal", operationId, admissionDigest: coverage.admissionDigest,
  outcome: "success", selector, selectorDigest: canonical.selectorDigest, originalExecution: execution,
  activation: { kind: "pair-publication", operationId, receiptDigest: "f".repeat(64) },
  coverageDigest: protocol.publicReleaseDigest(coverage), canonicalProofDigest: protocol.publicReleaseDigest(canonical), supersededBy: null };
let runtime: Miniflare, bridges: Awaited<ReturnType<typeof startDevelopmentRehearsalHttp>>, packet: any;

beforeAll(async () => {
  // Explicit SDK boundary records follow the existing terminal and serving
  // contract fixtures. Producer/render/activation tests own their full flows;
  // this reader cannot create a terminal fact or substitute a successful reply.
  const cursor = { baselineDigest: "1".repeat(64), sequence: 1, lastDigest: "2".repeat(64) };
  const batch = firestore.batch(), set = (path: string, value: unknown) => batch.set(firestore.doc(path), value as any);
  set("system/publicDeployment", selector); set(base, pair);
  set(`${base}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  set(`${base}/heads/current`, { schemaVersion: 2, pairDigest: execution.pairDigest, contentHead: selector.contentHead });
  set("system/publicReleaseChanges", { schemaVersion: 2, ...cursor });
  set(`${base}/views/${execution.manifestDigest}`, { schemaVersion: 2, status: "staged", pairDigest: execution.pairDigest,
    taskId: execution.taskId, identity, claimDigest, cursor, manifestDigest: execution.manifestDigest, manifestBytes: 500,
    manifestKey: `release-pairs/${pair.pairId}/${execution.taskId}/claims/${claimDigest}/views/${execution.manifestDigest}.json` });
  set(`${base}/renderTargets/${execution.manifestDigest}`, { schemaVersion: 1, status: "staged", pairDigest: execution.pairDigest,
    identity, taskId: execution.taskId, claimDigest, viewManifestDigest: execution.manifestDigest,
    inputManifestDigest: identity.inputManifestDigest, snapshotDigest, cursor, targetCount: 1,
    descriptor: { digest: "3".repeat(64), bytes: 500, key: `release-pairs/${pair.pairId}/${execution.taskId}/claims/${claimDigest}/objects/${"3".repeat(64)}` } });
  set("cmsPages/contact", document);
  set(`${pages.PAGE_OWNER_COLLECTION}/contact`, { schemaVersion: 1, pageId: "contact", rendererSha: pair.commitSha,
    servingEnabled: true, generation: 7, operationId, sourceVersion: 7, visible: true, path: expected.path,
    ownedPaths: [expected.path], snapshotDigest, runtime: { owner: "cloudflare", release: pair.commitSha } });
  batch.set(pages.pageRouteRef(firestore, expected.path), { schemaVersion: 1, pageId: "contact", path: expected.path });
  set(`${admission.ADMISSIONS}/operations/${operationId}`, accepted);
  set(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`, receipt);
  set(`${admission.ADMISSIONS}/canonicalProofs/${receipt.canonicalProofDigest}`, canonical);
  set(`${admission.ADMISSIONS}/coverageProofs/${receipt.coverageDigest}`, coverage);
  set(`cmsPublishQueue/${operationId}`, { schemaVersion: 2, transport: admission.TRANSPORT, operationId,
    admissionDigest: coverage.admissionDigest, pair: accepted.pair, status: "success", execution,
    terminalReceipt: protocol.publicReleaseDigest(receipt) });
  await batch.commit();
  runtime = new Miniflare({ workers: [{ config: { name: "rehearsal-fact-reader", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "rehearsal-fact-reader" } } } }] });
  const store = await runtime.getR2Bucket("CONTENT");
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    // Only external HTTPS is a network fixture. Root uses the real router;
    // current route/source reads and both private HTTP listeners are real.
    if (url.origin === "https://dev-public.example.org" && url.pathname === expected.path)
      return Promise.resolve(new Response(body, { headers: { "cache-control": "no-store" } }));
    if (url.origin === "https://dev-public.example.org") return router.fetch(new Request(input, init));
    if (url.origin === bridges?.ingressOrigin || url.origin === bridges?.proofOrigin) return nativeFetch(input, init);
    throw new Error("Unexpected rehearsal proof network");
  });
  bridges = await startDevelopmentRehearsalHttp({ projectId: "njpbs-site-dev", operatorOrigin: "https://unused-operator.example.test", authorized: true,
    operatorCredentials: async () => { throw new Error("No operator credential required for the root read"); }, ingressCredentials: async () => ({}) });
  packet = { schemaVersion: 1, projectId: firestore.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    oldPair: sourcePair, newPair: pair, ingressOrigin: bridges.ingressOrigin, proofOrigin: bridges.proofOrigin };
}, 20_000);
afterAll(async () => { await bridges?.close(); vi.unstubAllGlobals(); await runtime?.dispose(); });

const read = () => readOriginalRehearsalProof({ firestore, packet, operationId, path: expected.path });
async function verify(overrides: any = {}) {
  const source = await read(), selection = await serving.readPublicReleaseSelector({ firestore, environment: "development" });
  return verifyOriginalRehearsalProof({ firestore, packet, operation: source.operation,
    proof: expected, selector: selection.selector, httpCredential: bridges.httpCredential, ...overrides });
}

it("reads the original FACT contract and canonical bytes without changing a row", async () => {
  const refs = [firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`)];
  const before = await firestore.getAll(...refs), result = await read();
  expect(result.operation).toMatchObject({ operationId, sourceVersion: 7, acceptedCount: 1, terminalCount: 1,
    claimDigest: receipt.originalExecution.claimDigest, terminalReceiptDigest: protocol.publicReleaseDigest(receipt) });
  expect(result.proof).toEqual(expected);
  const response = await nativeFetch(bridges.ingressOrigin + expected.path, { redirect: "manual",
    headers: rehearsalHttpHeaders(bridges.httpCredential, bridges.ingressOrigin) });
  expect(response.status).toBe(expected.status);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  const after = await firestore.getAll(...refs);
  expect(after.map(row => row.updateTime!.toMillis())).toEqual(before.map(row => row.updateTime!.toMillis()));
  expect(await verify()).toMatchObject({ operationId, canonicalProofDigest: receipt.canonicalProofDigest, coverageDigest: receipt.coverageDigest });
});
it.each(["canonicalProofs", "coverageProofs"])("refuses corrupt original %s without creating a substitute fact", async collection => {
  const digest = collection === "canonicalProofs" ? receipt.canonicalProofDigest : receipt.coverageDigest;
  const ref = firestore.doc(`${admission.ADMISSIONS}/${collection}/${digest}`), original = (await ref.get()).data()!;
  try { await ref.update({ operationId: "different-original" }); await expect(read()).rejects.toThrow(); }
  finally { await ref.set(original); }
});
it("refuses a nonterminal queue even when a copied FACT remains", async () => {
  const ref = firestore.doc(`cmsPublishQueue/${operationId}`), original = (await ref.get()).data()!;
  try { await ref.update({ status: "pending" }); await expect(read()).rejects.toThrow(); }
  finally { await ref.set(original); }
});
it.each(["claim", "source", "body", "path"])("refuses a different %s instead of trusting an adapter's successful reply", async field => {
  const source = await read();
  const operation = { ...source.operation, ...(field === "claim" ? { claimDigest: "0".repeat(64) } : field === "source" ? { sourceVersion: 8 } : {}) };
  const proof = { ...expected, ...(field === "body" ? { bodyDigest: "0".repeat(64) } : field === "path" ? { path: "/absent/" } : {}) };
  await expect(verify({ operation, proof })).rejects.toThrow();
});
it("refuses production identity and an obsolete selector before certification", async () => {
  await expect(readOriginalRehearsalProof({ firestore, packet: { ...packet, schemaVersion: 2, projectId: "njpbs-site", emulatorHost: null }, operationId, path: expected.path })).rejects.toThrow();
  const selection = await serving.readPublicReleaseSelector({ firestore, environment: "development" });
  await expect(verify({ selector: { ...selection.selector, contentHead: { ...selection.selector.contentHead, contextSequence: 0 } } })).rejects.toThrow();
});

it("refuses changed current SDK source ownership even when the original FACT is intact", async () => {
  const ref = firestore.doc("cmsPages/contact"), original = (await ref.get()).data()!;
  try { await ref.update({ "published.sourceVersion": 8 }); await expect(verify()).rejects.toThrow(); }
  finally { await ref.set(original); }
});
