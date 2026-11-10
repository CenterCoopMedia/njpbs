import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { createRequire } from "node:module";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import historical from "../../functions/lib/public-release-historical-state.js";
import evidence from "../../functions/lib/public-release-change-evidence.js";
import sourceBody from "../../functions/lib/public-release-source-body.js";
import protocol from "../../functions/lib/public-release-pair.js";
const pair = releasePair(), epoch = "epoch-fixture";
const scheduleReader = createRequire(import.meta.url)("../../functions/lib/no-build-page-schedule-reader.js");
const fixture = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
let db: ReturnType<typeof isolatedFirestore>;
let codeBoundary: Awaited<ReturnType<typeof import("./background-storage-fixture")["backgroundStorageFixture"]>> | undefined;
afterAll(async () => { await codeBoundary?.close(); });
beforeAll(() => { db = isolatedFirestore("public-release-change-baseline.test.ts"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "fixture-release", activeCommitSha: pair.commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-release" });
  await work.registerPublicReleasePair({ firestore: db, pair });
  const head = log.initialPublicReleaseChangeHead("f".repeat(64));
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("cmsPosts/story").set({ ...fixture, id: "story", version: 9, privateWorking: "must not be captured" });
  await db.doc("cmsPosts/draft").set({ version: 11, title: "Private draft", status: "draft" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: epoch, pair: pairReference(pair), head });
});
const capture = () => {
  const code = publicReleaseBaselineCodeFixture(db, pair.commitSha);
  return baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch: epoch });
};
const read = (digest: string) => db.runTransaction(transaction => baseline.assertReadPublicReleaseChangeBaselineInTransaction({ firestore: db, transaction, logBaselineDigest: digest }), { readOnly: true });
async function publish(id: string, title: string, visible = true) {
  const snapshot = { ...fixture.published, sourceVersion: title === "First" ? 10 : 11, metadata: { ...fixture.published.metadata, title } };
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: id,
      changes: [producer.publicContentChange("cmsPosts", "story", { published: snapshot }, visible)] });
    write(); transaction.set(db.doc("cmsPosts/story"), { ...fixture, version: snapshot.sourceVersion, published: snapshot, publiclyVisible: visible });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: snapshot.sourceVersion });
  });
}
it("creates one immutable epoch receipt with all public bodies and no draft state", async () => {
  const one = await capture(), opened = await read(one.logBaselineDigest);
  expect(opened.receipt).toEqual(one.receipt);
  expect(one.logBaselineDigest).not.toBe(one.receipt.baselineCursor.baselineDigest);
  expect(one.sourceMembers.some(row => row.id === "draft")).toBe(false);
  expect(one.sourceMembers.find(row => row.id === "story")).toMatchObject({ collection: "cmsPosts", publicRevision: 7 });
  const bodies = (await db.collection("system/publicReleaseChanges/bodies").get()).docs.map(row => row.data().json).join("");
  expect(bodies).not.toContain("must not be captured");
  expect(bodies).not.toContain("Private working title");
  await expect(capture()).rejects.toThrow();
});
it("retains original CODE with the default transport when every built-in frame is unowned", async () => {
  expect((await db.collection("cmsPages").get()).empty).toBe(true);
  const fixture = publicReleaseBaselineCodeFixture(db, pair.commitSha);
  const reader = vi.spyOn(scheduleReader, "createPageCurrentCodeContextReader").mockReturnValue(async () => fixture.qualified);
  try {
    const captured = await baseline.capturePublicReleaseChangeBaseline({ firestore: db, logEpoch: epoch });
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ request: undefined, rendererSha: pair.commitSha }));
    const state = await historical.reconstructPublicReleaseState({ firestore: db, logBaselineDigest: captured.logBaselineDigest });
    expect(state.documents.get("system/publicReleaseHistoricalCode").reference).toEqual(fixture.qualified.reference);
    const code = await import("../../functions/lib/public-release-historical-code.js");
    expect(await code.default.readRetainedPublicReleaseCode({ firestore: db, descriptor: state.documents.get("system/publicReleaseHistoricalCode") })).toEqual(fixture.qualified);
  } finally { reader.mockRestore(); }
});
it("ignores working edits over retained snapshots when deriving the source census", async () => {
  const census = () => db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const one = await census();
  await db.doc("cmsPosts/story").update({ version: 999, title: "New private draft", privateWorking: "changed" });
  await db.doc("cmsPosts/draft").update({ version: 12, title: "Another private draft" });
  expect((await census()).sourceMemberCensusDigest).toBe(one.sourceMemberCensusDigest);
});
it("reconstructs an older accepted state after supersession solely from immutable bodies", async () => {
  const receipt = await capture();
  await publish("operation-one", "First");
  await publish("operation-two", "Second");
  await db.doc("cmsPosts/story").delete();
  const state = await historical.reconstructPublicReleaseState({ firestore: db, sourceOperationId: "operation-one" });
  expect(state.documents.get("cmsPosts/story").published.metadata.title).toBe("First");
  expect(state.cursor.sequence).toBe(1);
  expect(state.logBaselineDigest).toBe(receipt.logBaselineDigest);
  expect(state.originalPair).toEqual(pair);
  const pending = (await db.doc("system/publicReleaseChanges/captures/operation-one").get()).data();
  expect(pending).toMatchObject({ status: "pending", sequence: 1, logEpoch: epoch, retention: { minimumDays: 30, allEnrolledPairsMustPass: true, deletion: "audited-operator-only" } });
});
it("refuses any missing member body or contiguous entry, including withdrawals", async () => {
  await capture(); await publish("operation-one", "First"); await publish("operation-two", "Second", false);
  const entry = (await db.doc("system/publicReleaseChanges/entries/0000000000000002").get()).data();
  const verified = await db.runTransaction(transaction => evidence.assertReadPublicReleaseChangeEvidenceInTransaction({ firestore: db, transaction, entry }), { readOnly: true });
  expect(verified.members[0].body.documents[0].data.publiclyVisible).toBe(false);
  await db.doc("system/publicReleaseChanges/entries/0000000000000001").delete();
  await expect(historical.reconstructPublicReleaseState({ firestore: db, sourceOperationId: "operation-two" })).rejects.toThrow();
  await db.doc(`system/publicReleaseChanges/bodies/${verified.members[0].contentDigest}`).delete();
  await expect(db.runTransaction(transaction => evidence.assertReadPublicReleaseChangeEvidenceInTransaction({ firestore: db, transaction, entry }), { readOnly: true })).rejects.toThrow();
});
it("refuses excessive historical changes by name before loading the baseline bodies or log pages", async () => {
  await capture();
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).update({ sequence: 10_001, lastDigest: "a".repeat(64) });
  await db.doc("system/publicReleaseChanges/operations/too-many").set({ sequence: 10_001 });
  const forbidden: string[] = [];
  const guarded = new Proxy(db, { get(target, key) {
    if (key === "doc") return (path: string) => {
      if (/publicReleaseChanges\/(?:bodies|entries)\//.test(path)) { forbidden.push(path); throw new Error("Limit must refuse before materialization"); }
      return target.doc(path);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(historical.reconstructPublicReleaseState({ firestore: guarded, sourceOperationId: "too-many" }))
    .rejects.toMatchObject({ code: "historical-source-changes-limit", details: { used: 10_001, limit: 10_000 } });
  expect(forbidden).toEqual([]);
});
it("refuses a missing global epoch receipt and a substituted baseline body", async () => {
  await expect(historical.reconstructPublicReleaseState({ firestore: db })).rejects.toThrow();
  const captured = await capture();
  await db.doc(`system/publicReleaseChanges/bodies/${captured.sourceMembers[0].contentDigest}`).update({ json: "{}" });
  await expect(read(captured.logBaselineDigest)).rejects.toThrow();
});

it("keeps original baseline bodies immutable across provider and Schedule changes", async () => {
  await db.doc("system/publicDeployment/contexts/public").update({ externalInputs: { retained: "original" } });
  await capture();
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "provider-refresh",
      changes: [{ kind: "provider", id: "external", action: "dependency", sourceVersion: 1, snapshot: { retained: "new" } }] });
    write(); transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 2, externalInputs: { retained: "new" } });
  });
  const state = await historical.reconstructPublicReleaseState({ firestore: db, sourceOperationId: "provider-refresh" });
  expect(state.documents.get("system/publicDeployment/contexts/public").externalInputs).toEqual({ retained: "new" });
  for (const [digest, body] of state.sourceBodies) {
    expect(createHash("sha256").update(sourceBody.publicReleaseSnapshotJson(body, 2_000_000)).digest("hex")).toBe(digest);
  }
  const original = [...state.sourceBodies.values()].find(body => body.id.startsWith("authority-") &&
    body.documents.some(document => document.path === "system/publicDeployment/contexts/public"));
  expect(original?.documents[0].data.externalInputs).toEqual({ retained: "original" });
});

it("retains large allowed snapshots in atomic verified chunks without lowering publication admission", async () => {
  const document = { ...fixture, published: { ...fixture.published, metadata: { ...fixture.published.metadata, title: "é".repeat(270_000) } } };
  await db.doc("cmsPosts/story").set(document);
  const initial = await capture();
  expect((await read(initial.logBaselineDigest)).sourceMembers).toEqual(initial.sourceMembers);
  const snapshot = { ...document.published, sourceVersion: 10 };
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "large-publication",
      changes: [producer.publicContentChange("cmsPosts", "story", { published: snapshot })] });
    write(); transaction.set(db.doc("cmsPosts/story"), { ...document, published: snapshot });
  });
  const entry = (await db.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data();
  const accepted = await db.runTransaction(transaction => evidence.assertReadPublicReleaseChangeEvidenceInTransaction({ firestore: db, transaction, entry }), { readOnly: true });
  expect(accepted.members[0].snapshot).toEqual(snapshot);
  expect(accepted.members[0].body.documents[0].data.published).toEqual(snapshot);
  const bodies = await db.collection("system/publicReleaseChanges/bodies").get(), chunks = await db.collection("system/publicReleaseChanges/bodyChunks").get();
  expect(chunks.size).toBeGreaterThan(0);
  await expect(db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "aborted-large-publication",
      changes: [producer.publicContentChange("cmsPosts", "story", { published: { ...snapshot, sourceVersion: 11 } })] });
    write(); throw new Error("Abort publication");
  })).rejects.toThrow("Abort publication");
  expect((await db.collection("system/publicReleaseChanges/bodies").get()).size).toBe(bodies.size);
  expect((await db.collection("system/publicReleaseChanges/bodyChunks").get()).size).toBe(chunks.size);
  const stored = (await db.doc(`system/publicReleaseChanges/bodies/${accepted.members[0].contentDigest}`).get()).data()!;
  await db.doc(`system/publicReleaseChanges/bodyChunks/${stored.chunks[0]}`).delete();
  await expect(historical.reconstructPublicReleaseState({ firestore: db, sourceOperationId: "large-publication" })).rejects.toThrow();
});

it("includes public voiceover metadata while excluding private voiceover source fields", async () => {
  await db.doc("media_assets/voice-one").set({ source: "voiceover", lifecycle: "active", privateNarration: "Private source" });
  await db.doc("media_assets_public/voice-one").set({ mimeType: "audio/mpeg", altText: "Public credit" });
  const captured = await capture();
  expect(captured.sourceMembers.some(member => member.collection === "media_assets_public" && member.id === "voice-one")).toBe(true);
  const state = await historical.reconstructPublicReleaseState({ firestore: db, logBaselineDigest: captured.logBaselineDigest });
  expect(state.documents.get("media_assets/voice-one")).toMatchObject({ source: "voiceover", lifecycle: "active" });
  expect(state.documents.get("media_assets/voice-one")).not.toHaveProperty("privateNarration");
});

it("materializes a complete frozen historical Post pack after newer publication and live source removal", async () => {
  const { schedulePacketFixture } = await import("./page-schedule-packet-fixture");
  const { backgroundStorageFixture } = await import("./background-storage-fixture");
  codeBoundary ??= await backgroundStorageFixture("njpbs-dev-public-artifacts");
  const packet = await schedulePacketFixture({ firestore: db, rendererSha: pair.commitSha, generation: 1, boundary: codeBoundary, includeHomeSources: true });
  try {
  const sourceFirestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  await db.doc("system/publicDeployment/noBuildPages/capability").update({ dataHubReportingVersion: 1 });
  const extraSnapshot = { ...fixture.published, metadata: { ...fixture.published.metadata, slug: "unchanged-story", title: "Unchanged" } };
  await db.doc("cmsPosts/unchanged").set({ ...fixture, published: extraSnapshot });
  for (const [id, slug] of [["unchanged", "unchanged-story"], ["other-art", "other-art-story"]]) {
    const assetId = `art-${id}`, url = `https://media.njpbs.org/cms-media/${assetId}/original.png`;
    const art = { url, mimeType: "image/png", width: 1200, height: 800, altText: "Immutable fixture art" };
    await db.doc(`media_assets/${assetId}`).set({ ...art, source: "site_seed", lifecycle: "active" });
    await db.doc(`media_assets_public/${assetId}`).set(art);
    await db.doc(`cmsPosts/${id}`).set({ ...fixture, published: { ...fixture.published,
      metadata: { ...fixture.published.metadata, slug, title: slug }, blocks: [{ id: "photo", type: "image", visible: true, order: 0, data: { assetId, alt: art.altText } }] } });
  }
  await db.doc("cmsPosts/withdrawn").set({ ...fixture, publiclyVisible: false,
    published: { ...fixture.published, metadata: { ...fixture.published.metadata, slug: "withdrawn-story" } } });
  await db.doc("system/publicDeployment/noBuildPostOwners/withdrawn").set({ ownedSlugs: ["withdrawn-story"], visible: false });
  const initialBaseline = await baseline.capturePublicReleaseChangeBaseline({ firestore: sourceFirestore, logEpoch: epoch, currentCodeRequest: packet.request }); await publish("operation-one", "First"); await publish("operation-two", "Second");
  await db.doc("cmsPosts/story").delete();
  const { captureHistoricalPublicReleasePairInput, captureHistoricalPublicReleasePairBaselineInput, capturePublicReleasePairCodePackBaselineInput } = await import("../../site/scripts/public-release-pair-source-owner");
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  const store = {
    async put(key: string, bytes: Uint8Array, options: any) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: options.customMetadata }); },
    async get(key: string) { const object = objects.get(key); return object ? { size: object.bytes.length, customMetadata: object.metadata,
      body: new Response(object.bytes).body! } : null; },
  };
  const forbidden: string[] = [];
  const guarded = new Proxy(db, { get(target, key) {
    if (key === "projectId") return "njpbs-site-dev";
    if (key === "doc") return (path: string) => { if (/^(cmsPosts|cmsPages|cmsSettings|media_assets|cmsAuthorProfilesPublic)\//.test(path)) {
      forbidden.push(path); throw new Error("Mutable CMS source read"); } return target.doc(path); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path");
  const { publicReleaseCodePackFixture } = await import("../helpers/public-release-code-pack");
  const { publicReleasePairSourceInputsBytes } = await import("../../site/scripts/public-release-pair-source-inputs");
  const { derivePublicReleasePairCodePack } = await import("../../site/scripts/public-release-pair-code-pack");
  const directory = await mkdtemp(path.join(tmpdir(), "historical-code-pack-"));
  const artifacts = await publicReleaseCodePackFixture(directory, "b".repeat(40), publicReleasePairSourceInputsBytes(initialBaseline.receipt, initialBaseline.logBaselineDigest));
  const built = await derivePublicReleasePairCodePack(artifacts);
  const targetPair = { ...releasePair("b", "b".repeat(40)), rendererDigest: artifacts.pair.rendererDigest,
    codeAssetManifestDigest: built.manifest.codeAssetManifestDigest };
  await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
  const providerStore = { put: async () => { throw new Error("Read only"); }, async get(key: string) {
    const bytes = packet.boundary.objects.get(key); return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null; } };
  const imageRequests: string[] = [];
  const frozenOptions = { firestore: guarded, store, pair: targetPair, providerStore, resourceRequest: async (url: any) => {
    imageRequests.push(String(url)); return new Response("immutable image bytes", { headers: { "content-type": "image/png" } });
  } };
  const codeInput = await capturePublicReleasePairCodePackBaselineInput({ ...frozenOptions,
    logBaselineDigest: initialBaseline.logBaselineDigest, codePackArtifacts: artifacts });
  expect(codeInput.root.entryFiles).toEqual(["code-pack.json", "snapshot.json"]);
  expect(codeInput.root.cursor.sequence).toBe(0);
  const { openFrozenPublicReleasePairCodePack } = await import("../../site/scripts/public-release-pair-code-pack-storage");
  const accesses: string[] = [];
  const counted = { ...store, async get(key: string) { accesses.push(key); return store.get(key); } };
  const lazy = await openFrozenPublicReleasePairCodePack({ firestore: db, store: counted, pair: targetPair });
  const chunkKeys = new Set(lazy.root.files.filter(file => file.name.startsWith("code-pack/")).map(file => file.objectKey));
  expect(accesses.filter(key => chunkKeys.has(key))).toEqual([]);
  const first = lazy.manifest.members.find(member => member.path === "/index.html")!;
  expect(await lazy.readMember(first.path)).toEqual(new TextEncoder().encode("<html>Baseline fallback</html>"));
  expect(accesses.filter(key => chunkKeys.has(key))).toHaveLength(1);
  const chunkKey = accesses.find(key => chunkKeys.has(key))!, storedChunk = objects.get(chunkKey)!;
  objects.set(chunkKey, { ...storedChunk, bytes: new TextEncoder().encode("corrupt") });
  await expect(lazy.readMember(first.path)).rejects.toThrow();
  expect(new TextDecoder().decode(await lazy.readMember("/brand/logo.svg"))).toBe("<svg/>");
  objects.set(chunkKey, storedChunk);
  await expect(lazy.readMember("/not-in-pack.js")).rejects.toThrow();
  await rm(directory, { recursive: true, force: true });
  const captureStarted = performance.now();
  const frozen = await captureHistoricalPublicReleasePairInput({ ...frozenOptions, sourceOperationId: "operation-one" });
  const captureMs = performance.now() - captureStarted;
  expect(forbidden).toEqual([]);
  expect(frozen.root.cursor.sequence).toBe(1);
  expect(frozen.root.files.some(file => file.name === "source-census.json")).toBe(true);
  expect(frozen.root.files.filter(file => file.name.startsWith("sources/")).length).toBeGreaterThan(1);
  const readJson = (name: string) => JSON.parse(Buffer.from(objects.get(frozen.root.files.find(file => file.name === name)!.objectKey)!.bytes).toString());
  const plan = readJson("render-plan.json"), read = readJson(plan.routes[0].inputFile);
  const aggregate = readJson("aggregate-render-plan.json");
  expect(frozen.headroom.checks.changes.used).toBe(1);
  expect(frozen.headroom.checks.rootFiles.used).toBe(frozen.root.files.length);
  expect(frozen.headroom.checks.censusBytes.used).toBe(frozen.root.files.find(file => file.name === "source-census.json")!.bytes);
  expect(frozen.root).not.toHaveProperty("headroom");
  process.stdout.write("Historical aggregate fixture measurement " + JSON.stringify({ routes: aggregate.routes.length,
    planBytes: frozen.root.files.find(file => file.name === "aggregate-render-plan.json")!.bytes,
    frozenFileCount: frozen.root.files.length, captureMs: Number(captureMs.toFixed(2)) }) + "\n");
  expect(aggregate).toMatchObject({ schemaVersion: 1, kind: "pair-aggregate-render-plan", cursor: frozen.root.cursor, renderedAt: plan.renderedAt });
  expect(plan.routes.map((route: any) => route.path)).toEqual(["/posts/shadow-fixture/"]);
  expect(aggregate.expectedOutputs).toEqual(expect.arrayContaining([
    { path: "/posts/unchanged-story/", status: 200, contentType: "text/html; charset=utf-8" },
    { path: "/posts/withdrawn-story/", status: 410, contentType: "text/html; charset=utf-8" },
  ]));
  const overlap = aggregate.routes.find((route: any) => route.path === plan.routes[0].path);
  expect(frozen.root.files.find(file => file.name === overlap.inputFile)!.digest).toBe(frozen.root.files.find(file => file.name === plan.routes[0].inputFile)!.digest);
  expect(frozen.root.files.find(file => file.name === "source-dependencies.json")!.dependencies).toContain("aggregate-render-plan.json");
  expect(imageRequests.sort()).toEqual(["art-other-art", "art-unchanged"].map(id => `https://media.njpbs.org/cms-media/${id}/original.png`).sort());
  for (const path of ["/posts/unchanged-story/", "/posts/other-art-story/"]) {
    const route = aggregate.routes.find((route: any) => route.path === path), request = readJson(route.inputFile);
    expect(request.resources).toHaveLength(1);
    expect(route.dependencies.filter((dependency: any) => dependency.name.startsWith("resources/")).map((dependency: any) => dependency.name))
      .toEqual(request.resources.map((resource: any) => resource.file));
  }
  for (const route of aggregate.routes) expect(route.dependencies.some((file: any) => file.name === frozen.root.snapshotFile)).toBe(true);
  expect(createHash("sha256").update(objects.get(frozen.root.files.find(file => file.name === frozen.root.snapshotFile)!.objectKey)!.bytes).digest("hex")).toBe(frozen.root.scope.snapshotDigest);
  expect(frozen.root.entryFiles).toContain("source-dependencies.json");
  expect(plan.routes.every((route: any) => route.dependencies.every((file: any) => !file.name.startsWith("sources/")))).toBe(true);
  expect(frozen.root.files.find(file => file.name === "authority.json")!.dependencies).toEqual([]);
  expect(read.read.document.published.metadata.title).toBe("First");
  const search = readJson("search-inputs.json");
  expect(search).toMatchObject({ cursor: frozen.root.cursor, entryDigest: readJson("authority.json").entry.entryDigest,
    projection: { renderedAt: plan.renderedAt, codeSource: { reference: packet.reference } } });
  expect(search.projection.documents).toEqual(readJson("source-census.json").documents.map(({ path, contentDigest }: any) => ({ path, contentDigest })));
  const searchRow = (await db.doc("system/publicReleaseChanges/operations/operation-one/evidence/searchInputs").get()).data();
  expect(searchRow?.searchInputDigest).toBe(search.searchInputDigest);
  expect(Object.values((await db.doc("system/publicReleaseChanges/captures/operation-one").get()).data()!.packs)[0]).toMatchObject({ searchInputDigest: search.searchInputDigest });
  expect(readJson("reader-provenance.json")).toMatchObject({ pair, rendererSha: pair.commitSha,
    readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest });
  expect(readJson("authority.json").members).toMatchObject([{ change: { id: "story" }, paths: ["/posts/shadow-fixture/"], withdrawnPaths: [] }]);
  expect((await db.doc("system/publicReleaseChanges/captures/operation-one").get()).data()?.status).toBe("pending");
  // A second coordinator epoch over the same head cannot reuse a build sealed
  // against the first baseline, even when the target pair is unchanged.
  const second = await baseline.capturePublicReleaseChangeBaseline({ firestore: sourceFirestore, logEpoch: "second-epoch", currentCodeRequest: packet.request });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).update({ logEpoch: "second-epoch" });
  await expect(captureHistoricalPublicReleasePairBaselineInput({ firestore: db, store, pair: targetPair,
    logBaselineDigest: second.logBaselineDigest })).rejects.toMatchObject({ code: "pair-source-inputs-mismatch" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).update({ logEpoch: epoch });
  const member = (await db.doc(producer.publicReleaseMemberPath("operation-one", "post", "story")).get()).data()!;
  await db.doc(`system/publicReleaseChanges/bodies/${member.contentDigest}`).delete();
  const reopened = await captureHistoricalPublicReleasePairInput({ ...frozenOptions, sourceOperationId: "operation-one",
    resourceRequest: async () => { throw new Error("Original source transport expired"); } });
  expect(reopened.idempotent).toBe(true); expect(reopened.receipt).toEqual(frozen.receipt);
  expect(reopened.headroom.checks.transactionMs.used).toBeNull();
  expect(reopened.headroom.checks.rootFiles.used).toBe(frozen.headroom.checks.rootFiles.used);
  const extraRoute = aggregate.routes.find((route: any) => route.path === "/posts/unchanged-story/");
  const extraFile = frozen.root.files.find(file => file.name === extraRoute.inputFile)!;
  const retainedInput = objects.get(extraFile.objectKey)!;
  objects.delete(extraFile.objectKey);
  await expect(captureHistoricalPublicReleasePairInput({ ...frozenOptions, sourceOperationId: "operation-one" }))
    .rejects.toMatchObject({ code: "input-unavailable" });
  objects.set(extraFile.objectKey, retainedInput);
  await db.doc("system/publicReleaseChanges/captures/operation-one").update({ status: "failed" });
  await expect(captureHistoricalPublicReleasePairInput({ ...frozenOptions, sourceOperationId: "operation-one" }))
    .rejects.toMatchObject({ code: "historical-capture-failed" });
  } finally { await packet.close(); }
});

it("runs the source-input operator CLI before a frozen build and refuses changed bytes", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const path = await import("node:path");
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const sourceInputs = await import("../../site/scripts/public-release-pair-source-inputs");
  const captured = await capture(), directory = await mkdtemp(path.join(tmpdir(), "pair-input-source-"));
  const invoke = () => promisify(execFile)(path.resolve("site/node_modules/.bin/tsx"), ["site/scripts/public-release-pair-source-inputs.ts",
    "--project", (db as any).projectId, "--log-epoch", epoch, "--directory", directory], { cwd: process.cwd(), env: process.env });
  try {
    await invoke();
    const file = path.join(directory, "pair-source-inputs.json");
    expect(new Uint8Array(await readFile(file))).toEqual(sourceInputs.publicReleasePairSourceInputsBytes(captured.receipt, captured.logBaselineDigest));
    await invoke(); await writeFile(file, "changed");
    await expect(invoke()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("pair-source-inputs-mismatch") });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("captures and replays historical Schedule and prepared Program art after the original sources disappear", async () => {
  const { schedulePacketFixture } = await import("./page-schedule-packet-fixture");
  const { default: snapshots } = await import("../../functions/lib/publish-snapshot.js");
  const { captureHistoricalPublicReleasePairBaselineInput, capturePublicReleasePairCodePackBaselineInput } = await import("../../site/scripts/public-release-pair-source-owner");
  const { publicReleaseCodePackFixture } = await import("../helpers/public-release-code-pack");
  const { publicReleasePairSourceInputsBytes } = await import("../../site/scripts/public-release-pair-source-inputs");
  const { derivePublicReleasePairCodePack } = await import("../../site/scripts/public-release-pair-code-pack");
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), path = await import("node:path");
  const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const { frozenReplayProgramRead } = await import("../helpers/public-release-replay-inputs");
  const programRead = frozenReplayProgramRead(pair.commitSha), program = programRead.documents[0], art = programRead.assets[0];
  Object.assign(program.published, { publishedBy: "original-editor" });
  await db.doc(`cmsPosts/${program.id}`).set(program);
  const { default: media } = await import("../../functions/lib/media-contract.js");
  const privateArt = { ...art, altText: "Frozen Program art", lifecycle: "active", source: "site_seed" };
  await db.doc(`media_assets/${art.id}`).set(privateArt);
  await db.doc(`media_assets_public/${art.id}`).set(media.mediaProjection(privateArt));
  await db.doc("system/publicDeployment/noBuildRecordOwners/one").set({ schemaVersion: 1, family: "programs", documentId: program.id,
    visible: true, ownedPaths: ["/programs/one/", "/shows/one/"] });
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "schedule", version: 1,
    title: "Schedule", blocks: [] }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  await db.doc("cmsPages/schedule").set({ version: 1, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published });
  const { backgroundStorageFixture } = await import("./background-storage-fixture");
  codeBoundary ??= await backgroundStorageFixture("njpbs-dev-public-artifacts");
  const packet = await schedulePacketFixture({ firestore, rendererSha: pair.commitSha, generation: 1, includeHomeSources: true, boundary: codeBoundary, programRead });
  const directory = await mkdtemp(path.join(tmpdir(), "full-baseline-code-pack-"));
  try {
    await db.doc("system/publicDeployment/noBuildPages/capability").update({ dataHubReportingVersion: 1 });
    const actual = await baseline.capturePublicReleaseChangeBaseline({ firestore, logEpoch: epoch, currentCodeRequest: packet.request });
    const artifacts = await publicReleaseCodePackFixture(directory, "b".repeat(40), publicReleasePairSourceInputsBytes(actual.receipt, actual.logBaselineDigest));
    const inventory = await derivePublicReleasePairCodePack(artifacts);
    const targetPair = { ...releasePair("b", "b".repeat(40)), rendererDigest: artifacts.pair.rendererDigest, codeAssetManifestDigest: inventory.manifest.codeAssetManifestDigest };
    await work.registerPublicReleasePair({ firestore: db, pair: targetPair });
    const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
    const store = { async put(key: string, bytes: Uint8Array, options: any) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: options.customMetadata }); },
      async get(key: string) { const value = objects.get(key); return value ? { size: value.bytes.length, customMetadata: value.metadata, body: new Response(value.bytes).body! } : null; } };
    const providerStore = { put: async () => { throw new Error("Read only"); }, async get(key: string) {
      const bytes = packet.boundary.objects.get(key); return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null; } };
    packet.refuseCode(); const requests = packet.codeRequests();
    await capturePublicReleasePairCodePackBaselineInput({ firestore, pair: targetPair, store, providerStore, logBaselineDigest: actual.logBaselineDigest, codePackArtifacts: artifacts });
    const captured = await captureHistoricalPublicReleasePairBaselineInput({ firestore, pair: targetPair, store, providerStore,
      logBaselineDigest: actual.logBaselineDigest, currentCodeRequest: packet.request,
      resourceRequest: async () => { throw new Error("Prepared catalog capture must not fetch any image URL"); } });
    expect(packet.codeRequests()).toBe(requests);
    const read = (name: string) => JSON.parse(Buffer.from(objects.get(captured.root.files.find(file => file.name === name)!.objectKey)!.bytes).toString());
    const plan = read("render-plan.json");
    const aggregate = read("aggregate-render-plan.json");
    expect(aggregate.routes.map((route: any) => route.inputFile)).toEqual(plan.routes.map((route: any) => route.inputFile));
    expect(captured.root.files.some(file => file.name.startsWith("aggregate/routes/"))).toBe(false);
    const authority = read("authority.json");
    expect(authority.globalPaths).toEqual(plan.expectedOutputs.map((output: any) => output.path));
    expect(authority.members.filter((member: any) => !["post", "page", "record"].includes(member.change.kind))
      .every((member: any) => member.pathScope === "global" && member.paths.length === 0)).toBe(true);
    expect(plan.expectedOutputs).toEqual(expect.arrayContaining([
      { path: "/", status: 200, contentType: "text/html; charset=utf-8" },
      { path: "/_home-sources.json", status: 200, contentType: "application/json; charset=utf-8" },
      { path: "/schedule/", status: 200, contentType: "text/html; charset=utf-8" },
      { path: "/programs/one/", status: 200, contentType: "text/html; charset=utf-8" },
      { path: "/shows/one/", status: 200, contentType: "text/html; charset=utf-8" },
      { path: "/shows/", status: 200, contentType: "text/html; charset=utf-8" },
    ]));
    expect(read("provider-inputs.json").files).toEqual(expect.arrayContaining([expect.objectContaining({ name: "schedule-packet/pdf" })]));
    expect(read("code-source.json").reference.publication.commitSha).toBe(pair.commitSha);
    expect(read("search-inputs.json").projection.providerInputs.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "schedule-packet/pdf", contentType: "application/pdf" }) ]));
    const scheduleRoute = plan.routes.find((route: any) => route.path === "/schedule/");
    expect(read(scheduleRoute.inputFile).read.schedule.receipt.code.commitSha).toBe(pair.commitSha);
    expect(read("source-census.json")).toMatchObject({ schemaVersion: 1, kind: "pair-public-source-census", cursor: actual.receipt.baselineCursor });
    // Replay this original H claim after both mutable source and original
    // provider objects are gone. Only the captured claim's frozen bytes remain.
    await db.doc("cmsPages/schedule").delete();
    await db.doc("system/publicDeployment/contexts/public").update({ externalInputs: null });
    for (const file of Object.values(packet.packet.files) as { key: string }[]) packet.boundary.objects.delete(file.key);
    const { projectPublicReleasePairReplay, parsePublicReleasePairReplayTargetReceipt } = await import("../../site/scripts/public-release-pair-replay");
    const file = captured.root.files.find(file => file.name === scheduleRoute.inputFile)!;
    const provenanceFile = captured.root.files.find(file => file.name === "reader-provenance.json")!;
    const replayContext = { pair: targetPair, identity: { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(targetPair),
      ...captured.root.scope, inputManifestDigest: captured.receipt.inputManifestDigest }, route: scheduleRoute,
      request: read(scheduleRoute.inputFile), provenance: read("reader-provenance.json"), inputDigest: file.digest,
      provenanceDigest: provenanceFile.digest, renderedAt: plan.renderedAt,
      readFrozenFile: async (name: string) => {
        const member = captured.root.files.find(file => file.name === name)!;
        const bytes = objects.get(member.objectKey)!.bytes;
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(member.digest);
        return bytes;
      } };
    const replayed = await projectPublicReleasePairReplay(replayContext);
    expect(replayed.content.target.rendererSha).toBe(targetPair.commitSha);
    expect((replayed.content as any).schedule.receipt.code.commitSha).toBe(pair.commitSha);
    expect(replayed.receipt.source.pair).toEqual(protocol.publicReleasePairReference(pair));
    expect(parsePublicReleasePairReplayTargetReceipt(replayed.receipt, replayContext)).toEqual(replayed.receipt);
    const recordRoute = plan.routes.find((route: any) => route.path === "/programs/one/");
    expect(recordRoute).toBeDefined();
    const recordFile = captured.root.files.find(file => file.name === recordRoute.inputFile)!;
    const recordContext = { ...replayContext, route: recordRoute, request: read(recordRoute.inputFile), inputDigest: recordFile.digest };
    expect(recordContext.request.resources).toEqual([]);
    const record = await projectPublicReleasePairReplay(recordContext);
    expect((record.content as any).programImageDescriptors).toEqual(packet.codeContext.programImageDescriptors);
    expect((record.content as any).programImageDescriptors.files).toHaveLength(3);
    expect(record.content.target.rendererSha).toBe(targetPair.commitSha);
    expect(parsePublicReleasePairReplayTargetReceipt(record.receipt, recordContext)).toEqual(record.receipt);
    expect(packet.codeRequests()).toBe(requests);
  } finally { await packet.close(); await rm(directory, { recursive: true, force: true }); }
});

it("bounds outbox retries and preserves a terminal failed capture without latest-source fallback", async () => {
  await capture(); await publish("operation-one", "First");
  const { processPublicReleaseCaptureOutboxOperation } = await import("../../site/scripts/public-release-pair-source-owner");
  const store = { async get() { throw new Error("No pack installed"); }, async put() { throw new Error("No writes expected"); } };
  let now = Date.now();
  const options = { firestore: db, pair, store, sourceOperationId: "operation-one", now: () => now };
  const first = await processPublicReleaseCaptureOutboxOperation(options);
  expect(first).toMatchObject({ status: "pending", attempts: 1, failure: "incomplete-code-pack" });
  expect(await processPublicReleaseCaptureOutboxOperation(options)).toMatchObject({ status: "pending" });
  for (let attempt = 2; attempt <= 4; attempt++) {
    now += 16 * 60_000;
    expect(await processPublicReleaseCaptureOutboxOperation(options)).toMatchObject({ status: attempt === 4 ? "failed" : "pending", attempts: attempt });
  }
  await expect(processPublicReleaseCaptureOutboxOperation(options)).rejects.toMatchObject({ code: "historical-capture-failed" });
});
it.each(["changes", "rootFiles", "censusBytes", "transactionMs", "readMs"] as const)("retains the named %s limit in the actual capture outbox", async metric => {
  await capture(); await publish("operation-one", "First");
  const { processPublicReleaseCaptureOutboxOperation } = await import("../../site/scripts/public-release-pair-source-owner");
  const module = createRequire(import.meta.url)("../../functions/lib/public-release-source-limits.js");
  const error = new module.HistoricalSourceLimitError(metric, module.historicalSourceHeadroom().checks[metric].limit + 1);
  const budget = vi.spyOn(module, "historicalSourceReadBudget").mockReturnValue({ check() {},
    read: async () => { throw error; }, usage: () => ({ transactionMs: 0, readMs: 0 }) });
  try {
    const store = { get: async () => { throw new Error("No source fallback"); }, put: async () => { throw new Error("No writes expected"); } };
    const result = await processPublicReleaseCaptureOutboxOperation({ firestore: db, pair, store, sourceOperationId: "operation-one" });
    const permanent = ["changes", "rootFiles", "censusBytes"].includes(metric);
    expect(result).toMatchObject({ status: permanent ? "failed" : "pending", attempts: 1, failure: error.code });
    const outbox = (await db.doc("system/publicReleaseChanges/captures/operation-one").get()).data()!;
    expect(Object.values(outbox.packs)[0]).toMatchObject({ status: result.status, failure: error.code, attempts: 1 });
  } finally { budget.mockRestore(); }
});
