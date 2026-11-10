import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import serving from "../../functions/lib/public-release-serving.js";
import protocol from "../../functions/lib/public-release-pair.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import type { PairReadStore } from "../../workers/src/public-release-view-reader";

let runtime: Miniflare, directory: string, fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>;
let staged: Awaited<ReturnType<typeof stagedPublicReleasePairCompositeFixture>>, store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "unowned-proof", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "unowned-proof" } } } }] });
  store = await runtime.getR2Bucket("CONTENT"); directory = await mkdtemp(path.join(os.tmpdir(), "unowned-proof-"));
  fixture = await publicReleasePairCompositeFixture({ firestore: isolatedFirestore("unowned-proof"), store, directory, content: "baseline" });
  // Real H/G, SDK completion/staging and R2 manifests. The closed-roster helper
  // uses explicit route bodies; this proves confirmation ownership, not SSR.
  staged = await stagedPublicReleasePairCompositeFixture(fixture, store);
  const contentHead = { pairId: fixture.pair.pairId, viewId: "unowned-proof-head", manifestDigest: staged.rendered.manifestDigest,
    contextSequence: staged.claim.identity.contextSequence };
  const selector = { ...releaseSelector(), selectedPair: pairReference(fixture.pair), recoveryPair: pairReference(fixture.sourcePair),
    activeCommitSha: fixture.pair.commitSha, activeDeploymentId: fixture.pair.publicWorker.versionId, contentHead };
  await fixture.firestore.doc("system/publicDeployment").set(selector);
  await fixture.firestore.doc(`${fixture.base}/controls/runtime`).set({ schemaVersion: 2, pairId: fixture.pair.pairId, status: "retained" });
  await fixture.firestore.doc(`${fixture.base}/heads/current`).set({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(fixture.pair), contentHead });
}, 30_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });

const router = (readStore: PairReadStore = store) => {
  const { firestore, pair } = fixture;
  const slot = createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store: readStore,
    getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair, selection, path }) });
  const recovery = createPublicReleaseSlot({ pair: fixture.sourcePair, workerVersionId: fixture.sourcePair.publicWorker.versionId, store: readStore,
    getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: fixture.sourcePair, selection, path }) });
  return createPublicReleaseRouter({ environment: "development", slots: [slot, recovery],
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }) });
};
it.each(["/", "/programs/", "/feeds/news.xml", "/pagefind/pagefind.js"])("confirms exact unowned %s bytes using actual SDK selection and immutable H/G", async path => {
  const expected = staged.outputs.find(row => row.path === path)!;
  expect(expected).toBeDefined();
  const proof = await router().prove(new Request(`https://dev-public.example.org${path}`), hash(expected.bytes));
  expect(proof.status).toBe(200);
  expect(new Uint8Array(await proof.arrayBuffer())).toEqual(expected.bytes);
  expect(proof.headers.get("x-njpbs-publication-operation")).toBe(staged.claim.identity.sourceOperationId);
  expect(proof.headers.get("x-njpbs-release-pair")).toBe(fixture.pair.pairId);
  expect(proof.headers.get("x-njpbs-snapshot-sha256")).toBe(staged.claim.identity.snapshotDigest);
  expect(proof.headers.get("x-njpbs-html-sha256")).toBe(hash(expected.bytes));
});
it("refuses an absent manifest path and a caller's incorrect expected digest", async () => {
  expect((await router().prove(new Request("https://dev-public.example.org/absent-manifest-path/"), "0".repeat(64))).status).toBe(503);
  expect((await router().prove(new Request("https://dev-public.example.org/"), "0".repeat(64))).status).toBe(503);
});
it.each(["GET", "HEAD"])("keeps crafted public %s headers and query out of the private H-read path", async method => {
  const reads: string[] = [], tracked: PairReadStore = { async get(key) { reads.push(key); return store.get(key); } };
  const ingress = router(tracked), expected = staged.outputs.find(row => row.path === "/")!;
  const response = await ingress.fetch(new Request("https://dev-public.example.org/?proof=true&privateProof=true", { method,
    headers: { "x-njpbs-publication-proof": "true", "x-njpbs-proof": "true", "publication-refresh": "true" } }));
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(method === "HEAD" ? new Uint8Array() : expected.bytes);
  expect(response.headers.has("x-njpbs-publication-operation")).toBe(false);
  expect(reads.some(key => key.startsWith("release-pair-inputs/"))).toBe(false);
  expect((await ingress.prove(new Request("https://dev-public.example.org/"), hash(expected.bytes))).status).toBe(200);
  expect(reads).toContain(inputs.publicReleasePairInputRootKey(fixture.pair, staged.claim.identity.inputManifestDigest));
});
it("refuses tampered output bytes before private confirmation", async () => {
  const root = await store.list({ prefix: `release-pairs/${fixture.pair.pairId}/` });
  const expected = staged.outputs.find(row => row.path === "/")!, digest = hash(expected.bytes);
  const object = root.objects.find(row => row.key.includes(`/objects/${digest}`))!;
  expect(object).toBeDefined();
  const original = (await store.get(object.key))!, bytes = await original.arrayBuffer();
  try {
    await store.put(object.key, "tampered public bytes", { customMetadata: original.customMetadata });
    expect((await router().prove(new Request("https://dev-public.example.org/"), digest)).status).toBe(503);
  } finally { await store.put(object.key, bytes, { customMetadata: original.customMetadata }); }
});
it("refuses an H manifest belonging to another pair without granting proof from readable G", async () => {
  const key = inputs.publicReleasePairInputRootKey(fixture.pair, staged.claim.identity.inputManifestDigest);
  const original = (await store.get(key))!, bytes = await original.arrayBuffer(), foreign = JSON.parse(new TextDecoder().decode(bytes));
  foreign.pairDigest = protocol.publicReleaseDigest(releasePair("c", "c".repeat(40)));
  try {
    await store.put(key, JSON.stringify(foreign), { customMetadata: original.customMetadata });
    const expected = staged.outputs.find(row => row.path === "/")!;
    expect((await router().prove(new Request("https://dev-public.example.org/"), hash(expected.bytes))).status).toBe(503);
  } finally { await store.put(key, bytes, { customMetadata: original.customMetadata }); }
});
