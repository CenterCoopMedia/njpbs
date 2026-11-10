import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import protocol from "../../functions/lib/public-release-pair.js";
import { openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { parsePublicReleasePairRenderPlan } from "../../site/scripts/public-release-pair-render-plan";
import { parsePublicReleasePairAggregateRenderPlan } from "../../site/scripts/public-release-pair-aggregate-render-plan";
import { projectPublicReleasePairReplay, isPublicReleasePairProjection } from "../../site/scripts/public-release-pair-replay";
import { preparePublicReleasePairReplayReadback } from "../../site/scripts/public-release-pair-replay-storage";
import { readPublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { openPublicReleasePairCompositeAuthority, openStagedPublicReleasePairComposite, stagePublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { openPublicReleasePairSourceDocuments } from "../../site/scripts/public-release-pair-source-documents";
import { derivePublicReleasePairPublicReceipts } from "../../site/scripts/public-release-pair-public-receipts";
import { deriveFrozenPublicReleasePairCatalogImages, openFrozenPublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-image-storage";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
let runtime: Miniflare;
beforeAll(async () => { runtime = new Miniflare({ workers: [{ config: { name: "composite-source", type: "worker", compatibilityDate: "2026-07-09",
  manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
  env: { CONTENT: { type: "r2", name: "composite-source" } } } }] }); });
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  const store = await runtime.getR2Bucket("CONTENT");
  const listed = await store.list();
  if (listed.objects.length) await store.delete(listed.objects.map(row => row.key));
});
it("exports a real complete same-cursor source fixture with Home/Schedule/Program catalog and an accepted Post", async () => {
  const firestore = isolatedFirestore(`composite-source-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-source-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...fixture.content.root.scope,
      inputManifestDigest: fixture.content.receipt.inputManifestDigest };
    const frozen = await openPublicReleasePairInput({ firestore, store, pair: fixture.pair, identity, expectedSource: fixture.content.root.source, expectedCursor: fixture.content.root.cursor });
    const json = async (name: string) => JSON.parse(new TextDecoder().decode(await frozen.readFile(name)));
    const ordinary = parsePublicReleasePairRenderPlan(await json("render-plan.json"), frozen.root);
    const aggregate = parsePublicReleasePairAggregateRenderPlan(await frozen.readFile("aggregate-render-plan.json"), frozen.root, ordinary);
    expect(aggregate.renderedAt).toBe(ordinary.renderedAt);
    expect(aggregate.expectedOutputs.map(output => output.path)).toEqual(expect.arrayContaining(["/", "/schedule/", "/programs/one/", "/shows/one/"]));
    expect(frozen.root.cursor.sequence).toBe(1);
    expect(frozen.root.files.some(file => file.name === "source-metadata.json")).toBe(true);
    const route = aggregate.routes.find(route => route.path === "/programs/one/")!;
    const requests = fixture.packet.codeRequests();
    await firestore.doc("cmsPosts/one").delete(); await firestore.doc("cmsPosts/story").delete(); fixture.packet.boundary.objects.clear();
    const replay = await projectPublicReleasePairReplay({ pair: fixture.pair, identity, route, request: await json(route.inputFile), provenance: await json("reader-provenance.json"),
      inputDigest: frozen.root.files.find(file => file.name === route.inputFile)!.digest, provenanceDigest: frozen.root.files.find(file => file.name === "reader-provenance.json")!.digest,
      renderedAt: aggregate.renderedAt, readFrozenFile: frozen.readFile });
    expect(replay.content.target.rendererSha).toBe(fixture.pair.commitSha);
    expect((replay.content as any).programImageDescriptors.files).toHaveLength(3);
    expect((replay.content as any).programImageDescriptors.rendererSha).toBe(fixture.sourcePair.commitSha);
    expect(fixture.packet.codeRequests()).toBe(requests);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it("reuses only the exact opened H for catalog derivation and still refuses changed stored input", async () => {
  const firestore = isolatedFirestore(`composite-catalog-reuse-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-catalog-reuse-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...fixture.content.root.scope,
      inputManifestDigest: fixture.content.receipt.inputManifestDigest };
    const owner = { firestore, store, pair: fixture.pair, identity };
    const source = await openPublicReleasePairCompositeAuthority(owner);
    const reused = await deriveFrozenPublicReleasePairCatalogImages(owner, source);
    const separate = await openFrozenPublicReleasePairCatalogImages(owner);
    expect(reused.manifest).toEqual(separate.manifest);
    for (const member of reused.manifest.members) expect(await reused.readMember(member.path)).toEqual(await separate.readMember(member.path));
    for (const changed of [{ ...identity, inputManifestDigest: "f".repeat(64) }, { ...identity, sourceVersion: identity.sourceVersion + 1 }]) {
      await expect(deriveFrozenPublicReleasePairCatalogImages({ ...owner, identity: changed }, source)).rejects.toThrow();
    }
    await expect(deriveFrozenPublicReleasePairCatalogImages({ ...owner, pair: fixture.sourcePair }, source)).rejects.toThrow();
    const route = source.plan.routes.find(route => route.renderer === "record")!;
    const file = source.frozen.root.files.find(file => file.name === route.inputFile)!;
    const original = await store.get(file.objectKey), body = await original!.arrayBuffer();
    try {
      await store.put(file.objectKey, "corrupt", { customMetadata: original!.customMetadata });
      await expect(deriveFrozenPublicReleasePairCatalogImages(owner, source)).rejects.toThrow();
    } finally { await store.put(file.objectKey, body, { customMetadata: original!.customMetadata }); }
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each(["complete", "crash"])("stages the complete real H composite under its original claim after %s", async mode => {
  const firestore = isolatedFirestore(`composite-${mode}-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-stage-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const value = await stagedPublicReleasePairCompositeFixture(fixture, store, mode === "crash");
    const receipt = (await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data();
    if (mode === "crash") {
      await expect(openStagedPublicReleasePairComposite(value.owner)).rejects.toThrow();
      await fixture.operations.recover();
    }
    const opened = await openStagedPublicReleasePairComposite(value.owner);
    await opened.verifyAll();
    expect(opened.manifest.members.map(row => row.role)).toEqual(expect.arrayContaining(["route", "auxiliary", "search", "content-feed", "catalog"]));
    for (const output of value.outputs) expect((await opened.readMember(output.path)).body).toEqual(output.bytes);
    await stagePublicReleasePairComposite(value.owner);
    expect((await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()).toEqual(receipt);
    expect(await work.claimPublicReleasePairWork({ firestore, pair: fixture.pair, taskId: fixture.taskId })).toBeNull();
    await expect(openStagedPublicReleasePairComposite({ ...value.owner, claimDigest: "f".repeat(64) })).rejects.toThrow();
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each(["complete", "failed", "corrupt"])("bounds original H target preparation and drains a %s batch", async mode => {
  const firestore = isolatedFirestore(`composite-target-batch-${mode}-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-target-batch-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const value = await stagedPublicReleasePairCompositeFixture(fixture, store, true);
    const source = await openPublicReleasePairCompositeAuthority(value.owner);
    const projected = source.plan.routes.filter(route => isPublicReleasePairProjection(route.renderer));
    const keys = new Set(projected.map(route => source.frozen.root.files.find(file => file.name === route.inputFile)!.objectKey));
    if (mode === "corrupt") {
      const key = source.frozen.root.files.find(file => file.name === projected[0].inputFile)!.objectKey, original = await store.get(key);
      await store.put(key, "corrupt", { customMetadata: original!.customMetadata });
    }
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const failure = new Error("frozen target read unavailable");
    let reads = 0, active = 0, maximum = 0, settled = false;
    const seen = new Set<string>();
    const observed: PairViewStore = { put: (...args) => store.put(...args), async get(key) {
      if (!keys.has(key)) return store.get(key);
      const ordinal = ++reads; seen.add(key); maximum = Math.max(maximum, ++active); if (seen.size === 4) entered();
      try {
        if (mode === "failed" && ordinal === 1) throw failure;
        await gate; return await store.get(key);
      } finally { active--; }
    } };
    const preparing = preparePublicReleasePairReplayReadback({ ...value.owner, store: observed })
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Target batch did not overlap")), 5_000); })]);
      expect(reads).toBe(4); expect(settled).toBe(false); expect(maximum).toBeLessThanOrEqual(4);
      if (mode === "complete") expect(maximum).toBe(4);
    } finally { clearTimeout(timer); release(); await preparing; }
    const result = await preparing;
    if (mode !== "complete") {
      if (mode === "failed") expect(result).toHaveProperty("error", failure);
      else expect(result).toMatchObject({ error: { code: "input-unavailable" } });
      // A projector can freshly reread its same H dependency. No later route
      // may start after this batch failed, and every read must have drained.
      expect(seen.size).toBe(4); expect(active).toBe(0);
    } else {
      if (!("value" in result)) throw result.error;
      expect(() => result.value.record()).toThrow();
      const paths = new Set(source.plan.routes.map(route => route.path));
      for await (const output of readPublicReleasePairView({ ...value.owner, manifestDigest: value.rendered.manifestDigest, manifestBytes: value.rendered.manifestBytes })) {
        if (paths.has(output.path)) await result.value.output(output);
      }
      await result.value.complete();
      expect(result.value.record().targetCount).toBe(projected.length);
    }
    expect((await firestore.doc(`${fixture.base}/renderTargets/${value.rendered.manifestDigest}`).get()).exists).toBe(false);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each(["missing", "corrupt"])("refuses a %s composite body before staging and after a completed readback", async mode => {
  const firestore = isolatedFirestore(`composite-${mode}-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-refuse-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory });
    const value = await stagedPublicReleasePairCompositeFixture(fixture, store, true), output = value.rendered.root.composite!;
    const key = output.descriptor.key, original = await store.get(key), bytes = await original!.arrayBuffer();
    if (mode === "missing") await store.delete(key);
    else await store.put(key, "corrupt", { customMetadata: original!.customMetadata });
    await expect(stagePublicReleasePairComposite(value.owner)).rejects.toThrow();
    expect((await firestore.doc(`${fixture.base}/compositeViews/${value.rendered.manifestDigest}`).get()).exists).toBe(false);
    await store.put(key, bytes, { customMetadata: original!.customMetadata });
    await stagePublicReleasePairComposite(value.owner);
    const opened = await openStagedPublicReleasePairComposite(value.owner), member = opened.manifest.members.find(row => row.role === "auxiliary")!;
    const bodyKey = view.publicReleasePairViewObjectKey(fixture.pair, value.owner.identity, value.owner.claimDigest, member.sha256);
    if (mode === "missing") await store.delete(bodyKey);
    else { const before = await store.get(bodyKey); await store.put(bodyKey, "corrupt", { customMetadata: before!.customMetadata }); }
    await expect(opened.readMember(member.path)).rejects.toThrow();
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it.each([1, 2] as const)("retains actual producer owner generations after %i operations in immutable H", async ownerOperations => {
  const firestore = isolatedFirestore(`composite-owners-${ownerOperations}-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-owners-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, ownerOperations });
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...fixture.content.root.scope,
      inputManifestDigest: fixture.content.receipt.inputManifestDigest };
    const source = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity });
    await firestore.doc("system/publicDeployment/noBuildPostOwners/story").delete();
    const { documents } = await openPublicReleasePairSourceDocuments(source.frozen.root, source.frozen.readFile);
    expect(documents.get("system/publicDeployment/noBuildPostOwners/story").generation).toBe(ownerOperations + 1);
    const files = await derivePublicReleasePairPublicReceipts({ pair: fixture.pair, documents, targets: [], ownedPaths: new Set(),
      baselinePublication: await source.baseline.readMember("/_publication.json"), baselineStatus: await source.baseline.readMember("/_content-status.json") });
    const publication = JSON.parse(new TextDecoder().decode(files[0].bytes));
    expect(publication.generation).toBe(ownerOperations + 1); expect(publication.commitSha).toBe(fixture.pair.commitSha);
    expect(publication.buildBatchId).toMatch(/^post-[a-f0-9]{64}$/);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it("derives a higher effective capability generation from real immutable H after the live authority is removed", async () => {
  const firestore = isolatedFirestore(`composite-capability-${Date.now()}`), store = await runtime.getR2Bucket("CONTENT"), directory = await mkdtemp(path.join(os.tmpdir(), "composite-capability-"));
  let fixture;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline", ownerOperations: 1, capabilityGeneration: 42 });
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...fixture.content.root.scope,
      inputManifestDigest: fixture.content.receipt.inputManifestDigest };
    const source = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity });
    await firestore.doc("system/publicDeployment/noBuildPosts/capability").delete();
    const { documents } = await openPublicReleasePairSourceDocuments(source.frozen.root, source.frozen.readFile);
    expect(documents.get("system/publicDeployment/noBuildPostOwners/story").generation).toBe(1);
    expect(documents.get("system/publicDeployment/noBuildPosts/capability").generation).toBe(42);
    const files = await derivePublicReleasePairPublicReceipts({ pair: fixture.pair, documents, targets: [], ownedPaths: new Set(),
      baselinePublication: await source.baseline.readMember("/_publication.json"), baselineStatus: await source.baseline.readMember("/_content-status.json") });
    expect(JSON.parse(new TextDecoder().decode(files[0].bytes)).generation).toBe(42);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
