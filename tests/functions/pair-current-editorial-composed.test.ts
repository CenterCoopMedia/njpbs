import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { replayMixedBaselineFixture } from "../helpers/public-release-pair-replay-mixed";
import { releaseSelector } from "../helpers/public-release-pair.js";
import { pair, reader, selector } from "../helpers/cms-preview-pairs.js";
import { openPublicReleasePairCompositeAuthority } from "../../site/scripts/public-release-pair-composite-storage";
import { openPublicReleasePairRenderPlans } from "../../site/scripts/public-release-pair-render-plans";
import { retainPairPreviewContext } from "../../site/scripts/public-release-pair-preview-context";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { createPreviewPairEditorialContextReader, projectPairEditorialPreviewSource } from "../../site/scripts/cms-preview-pair-editorial-context";
const require = createRequire(import.meta.url), protocol = require("../../functions/lib/public-release-pair.js");
const replay = require("../../functions/lib/public-release-pair-replay.js");
const { readPairCurrentEditorial } = require("../../functions/lib/pair-current-editorial-source.js");
it("a real composed witness selects its certified current physical H/G context rather than a same-cursor or CODE context", async () => {
  const firestore = isolatedFirestore("editorial-composed-real"), objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const store: PairViewStore = { async put(key, bytes, options) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); },
    async get(key) { const row = objects.get(key); return row ? { size: row.bytes.length, customMetadata: row.customMetadata,
      body: new Response(new Uint8Array(row.bytes)).body! } : null; } };
  const fixture = await replayMixedBaselineFixture(firestore, store);
  try {
    await fixture.initialize();
    const sealed = await replay.sealPublicReleasePairReplayWitness({ firestore, pair: fixture.pair, completedAt: 1000 });
    const base = require("../../functions/lib/public-release-pair-work.js").publicReleasePairPath(fixture.pair.pairId);
    const head = { pairId: fixture.pair.pairId, viewId: sealed.witnessDigest, manifestDigest: sealed.witness.contentViewDigest, contextSequence: sealed.witness.headCursor.sequence };
    const publicRoot = { ...releaseSelector(), selectedPair: protocol.publicReleasePairReference(fixture.pair),
      recoveryPair: protocol.publicReleasePairReference(fixture.shared.sourcePair), activeCommitSha: fixture.pair.commitSha, contentHead: head };
    await firestore.doc("system/publicDeployment").set(publicRoot);
    await firestore.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: fixture.pair.pairId, status: "retained" });
    await firestore.doc(`${base}/heads/current`).set({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(fixture.pair), contentHead: head });
    const preview = pair("old", "c"), recovery = pair("new", "d");
    await firestore.doc("system/cmsPreviewRuntime").set(selector(preview, recovery));
    for (const p of [preview, recovery]) await firestore.doc(`cmsPreviewPairs/${p.pairId}`).set(p);
    for (const component of ["functions", "cmsApi"]) await firestore.doc(`cmsReaderCompatibilityReceipts/${component}`).set({
      schemaVersion: 2, state: "complete", component, lastComplete: reader(component) });
    const opened = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity: fixture.reference.identity });
    const plans = await openPublicReleasePairRenderPlans(opened.frozen.root, opened.frozen.readFile);
    const home = plans.plan.routes.find(route => route.path === "/_home-sources.json")!;
    const request = JSON.parse(new TextDecoder().decode(await opened.frozen.readFile(home.inputFile)));
    const input = { pair: fixture.pair, identity: fixture.reference.identity, claimDigest: fixture.reference.claimDigest,
      viewManifestDigest: fixture.reference.manifestDigest, root: opened.frozen.root, readFrozenFile: opened.frozen.readFile,
      homeSourceBytes: new TextEncoder().encode(JSON.stringify(request.read)), renderedAt: plans.plan.renderedAt };
    const query = { schemaVersion: 2, mode: "current-editorial-v2", rendererSha: preview.rendererSha, selection: {
      pair: publicRoot.selectedPair, expectedPublicSelectorDigest: protocol.publicReleaseDigest(publicRoot), previewPairId: preview.pairId, previewCandidateReceiptId: null } };
    // CODE exists and the replay is certified. Missing optional side output
    // still refuses, rather than selecting any baseline or mutable source.
    await expect(readPairCurrentEditorial({ firestore, request: query })).rejects.toThrow();
    await retainPairPreviewContext({ firestore, ...input });
    const result = await readPairCurrentEditorial({ firestore, request: query });
    expect(result.reference.manifest.viewManifestDigest).toBe(fixture.reference.manifestDigest);
    expect(result.reference.manifest.viewManifestDigest).not.toBe(fixture.baseline.reference.manifestDigest);
    expect(result.reference.contentHead).toEqual(head);
    const source = JSON.parse(Buffer.from(result.sourceBase64, "base64").toString());
    expect(source.pair).toEqual(publicRoot.selectedPair); expect(source.sourcePair).toEqual(publicRoot.recoveryPair);
    expect(source.homeSources.publication.commitSha).toBe(fixture.shared.sourcePair.commitSha);
    await projectPairEditorialPreviewSource(source, fixture.pair);
    const coverageSource = structuredClone(source);
    coverageSource.documents.push({ path: "cmsSettings/coverage-labels", data: { schemaVersion: 1, version: 2,
      values: { labels: [] }, published: { schemaVersion: 1, sourceVersion: 1, publishedAt: "2026-10-28T03:00:00.000Z",
        values: { labels: [{ id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: false }] } } } });
    coverageSource.documents.sort((a: any, b: any) => a.path < b.path ? -1 : 1);
    expect((await projectPairEditorialPreviewSource(coverageSource, fixture.pair)).settings).toContainEqual({
      settingId: "coverage-labels", sourceVersion: 1, publishedAt: "2026-10-28T03:00:00.000Z",
      labels: [{ id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: false }] });
    const librarySource = structuredClone(source), approved = { id: "preview-sponsor", type: "sponsor", status: "approved", version: 3,
      name: "Frozen approved supporter", href: "https://approved.example.test/" };
    librarySource.documents.push({ path: "cmsPosts/preview-sponsor", data: { ...approved, status: "draft", version: 4,
      name: "Unapproved newer supporter", href: "https://draft.example.test/" } },
    { path: "cmsVersionHistory/release-source-preview-sponsor", data: { collection: "cmsPosts", documentId: "preview-sponsor", action: "approve", after: approved } });
    librarySource.documents.sort((a: any, b: any) => a.path < b.path ? -1 : 1);
    expect((await projectPairEditorialPreviewSource(librarySource, fixture.pair)).recordCards).toContainEqual(expect.objectContaining({
      id: "preview-sponsor", title: "Frozen approved supporter", href: "https://approved.example.test/", sourceVersion: 3 }));
    const transport = require("../../functions/lib/current-public-code-v2.js");
    const legacy = vi.fn(async () => { throw new Error("A schema-two preview must not use legacy aggregate fallback"); });
    const handler = require("../../functions/pair-current-code.js").createPairCurrentCodeHandler({ firestore,
      edge: { readSecret: () => "fixture-private-edge", logger: { warn() {}, error() {} } } });
    const wire = vi.fn(async (_url: string, init: RequestInit) => {
      let status = 200, body: unknown;
      const response = { set() { return response; }, status(value: number) { status = value; return response; },
        json(value: unknown) { body = value; return response; } };
      await handler({ method: "POST", headers: init.headers, is: () => true, body: JSON.parse(String(init.body)) }, response);
      return Response.json(body, { status });
    });
    const readPreview = createPreviewPairEditorialContextReader({ firestore, rendererSha: preview.rendererSha, pairId: preview.pairId, workerVersion: preview.workerVersion,
      target: require("../../functions/lib/publication-target.js").publicationTarget("development"), readSecret: () => "fixture-private-edge",
      createTransport: (options: any) => transport.createPairCurrentCodeTransport({ ...options, request: wire }) });
    const projected = await readPreview(legacy);
    expect(projected.publicContext.posts.some(post => post.title === "A published fixture")).toBe(true);
    expect(projected.publicContext.receipt.commitSha).toBe(fixture.shared.sourcePair.commitSha);
    expect(projected.publicContext.homeSources?.publication?.commitSha).toBe(fixture.shared.sourcePair.commitSha);
    expect(projected.publication.commitSha).toBe(fixture.shared.sourcePair.commitSha);
    projected.publicContext.posts.length = 0;
    expect((await readPreview(legacy)).publicContext.posts.length).toBeGreaterThan(0);
    expect(legacy).not.toHaveBeenCalled();
    const changesRef = firestore.doc("system/publicReleaseChanges"), changes = (await changesRef.get()).data()!;
    await changesRef.update({ sequence: changes.sequence + 1, lastDigest: "a".repeat(64) });
    await expect(readPairCurrentEditorial({ firestore, request: query })).rejects.toMatchObject({ code: "pair_editorial_context_refreshing" });
    await changesRef.set(changes);
    let moved = false;
    const wrapped = { projectId: firestore.projectId, getAll: firestore.getAll.bind(firestore), runTransaction: firestore.runTransaction.bind(firestore),
      doc(path: string) { return path.includes("/chunks/") ? { get: async () => {
        const row = await firestore.doc(path).get();
        if (!moved) { moved = true; await firestore.doc(`${base}/heads/current`).update({ "contentHead.viewId": "f".repeat(64) }); }
        return row;
      } } : firestore.doc(path); } };
    await expect(readPairCurrentEditorial({ firestore: wrapped, request: query })).rejects.toMatchObject({ code: "pair_editorial_context_refreshing" });
    await firestore.doc(`${base}/heads/current`).update({ "contentHead.viewId": head.viewId });
    await firestore.doc(`${base}/heads/current`).update({ "contentHead.viewId": "f".repeat(64) });
    const error = await readPairCurrentEditorial({ firestore, request: query }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty("code", "pair_editorial_context_refreshing");
    await expect(readPreview(legacy)).rejects.toMatchObject({ status: 409 });
  } finally { await fixture.close(); }
}, 60_000);
