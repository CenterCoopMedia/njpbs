import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { publicReleaseCodePackFixture } from "../helpers/public-release-code-pack";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { backgroundStorageFixture } from "../functions/background-storage-fixture";
import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import deployment from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import { publicReleasePairSourceInputsBytes } from "../../site/scripts/public-release-pair-source-inputs";
import { derivePublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack";
import { capturePublicReleasePairCodePackBaselineInput } from "../../site/scripts/public-release-pair-source-owner";
import { openFrozenPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-storage";
import { openStagedPublicReleasePairCodePack, publicReleasePairStagedCodePackPath } from "../../site/scripts/public-release-pair-code-pack-executor";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { readPublicReleasePairView, writePublicReleasePairView, type PairViewOutputInput } from "../../site/scripts/public-release-pair-view-storage";
import views from "../../functions/lib/public-release-pair-view.js";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { preparePublicReleasePairNamespacesReadback, openStagedPublicReleasePairSearchNamespace, openStagedPublicReleasePairContentFeedNamespace,
  openPublicReleasePairSearchNamespaceSelection, openPublicReleasePairContentFeedNamespaceSelection } from "../../site/scripts/public-release-pair-namespace-storage";
import { createExternalContentStaticFeed, type ExternalContentManifest } from "../../site/src/lib/external-content-feed";
import { pairStorageRpc } from "../../publisher/pair-storage-rpc";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import { openFrozenPublicReleasePairCatalogImages, preparePublicReleasePairCatalogImagesReadback, openStagedPublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-image-storage";
import catalogCodec from "../../functions/lib/public-release-pair-catalog-images.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const oldPair = releasePair(), epoch = "executor-code-pack-epoch";
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let packet: Awaited<ReturnType<typeof schedulePacketFixture>>;
let directory: string;
beforeAll(async () => {
  db = isolatedFirestore("pair-code-pack-executor");
  boundary = await backgroundStorageFixture("njpbs-dev-public-artifacts");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-code-pack", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-code-pack" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
async function reset() {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const objects = await store.list(); if (objects.objects.length) await store.delete(objects.objects.map(row => row.key));
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "old-code", activeCommitSha: oldPair.commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-code" });
  await work.registerPublicReleasePair({ firestore: db, pair: oldPair });
  const head = log.initialPublicReleaseChangeHead("f".repeat(64));
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const fixture = JSON.parse(await readFile(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
  await db.doc("cmsPosts/story").set({ ...fixture, id: "story", version: 9 });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: epoch, pair: pairReference(oldPair), head });
  packet = await schedulePacketFixture({ firestore: db, rendererSha: oldPair.commitSha, generation: 1, boundary, attachExternalInputs: false });
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-code-pack-test-"));
}
beforeEach(reset);
afterAll(async () => { await boundary?.close(); await runtime?.dispose(); });
import { afterEach } from "vitest";
afterEach(async () => { await packet?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function prepare(extraDist: Record<string, string> = {}) {
  const sourceDb = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const global = await baseline.capturePublicReleaseChangeBaseline({ firestore: sourceDb, logEpoch: epoch, currentCodeRequest: packet.request });
  const artifacts = await publicReleaseCodePackFixture(directory, "b".repeat(40), publicReleasePairSourceInputsBytes(global.receipt, global.logBaselineDigest), extraDist);
  const built = await derivePublicReleasePairCodePack(artifacts);
  const pair = { ...releasePair("b", artifacts.pair.commitSha), rendererDigest: artifacts.pair.rendererDigest, codeAssetManifestDigest: built.manifest.codeAssetManifestDigest };
  await work.registerPublicReleasePair({ firestore: db, pair });
  const frozen = await capturePublicReleasePairCodePackBaselineInput({ firestore: db, store, pair, logBaselineDigest: global.logBaselineDigest, codePackArtifacts: artifacts });
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
    input: { ...frozen.root.scope, inputManifestDigest: frozen.receipt.inputManifestDigest } }));
  const base = work.publicReleasePairPath(pair.pairId);
  const operations = createPublicReleasePairExecutor({ firestore: db, store, pair });
  return { pair, frozen, taskId, base, operations, global, sourceDb, run: (overrides = operations) => runPublicReleasePairWorkOnce({ firestore: db, pair, ...overrides }) };
}

it("copies the actual source-owner frozen code pack into G and proves every member without compiling or mutable reads", async () => {
  const value = await prepare(), before = (await db.doc("system/publicDeployment").get()).data();
  packet.refuseCode();
  await db.doc("cmsPosts/story").delete();
  expect(await value.run()).toBe("complete");
  const source = await openFrozenPublicReleasePairCodePack({ firestore: db, store, pair: value.pair });
  const opened = await openStagedPublicReleasePairCodePack({ firestore: db, store, pair: value.pair });
  const receipt = (await db.doc(`${value.base}/receipts/${value.taskId}`).get()).data()!;
  expect(opened.record.claimDigest).toBe(receipt.claimDigest);
  expect(opened.record.inputManifestDigest).toBe(value.frozen.receipt.inputManifestDigest);
  expect(receipt.identity.snapshotDigest).not.toBe(receipt.identity.inputManifestDigest);
  for (const member of source.manifest.members) {
    const bytes = await opened.readMember(member.path);
    expect(bytes).toEqual(await source.readMember(member.path));
    expect(hash(bytes)).toBe(member.sha256);
  }
  await opened.verifyAll();
  await value.operations.recover(); expect(await value.run()).toBe("idle");
  expect((await db.collection(`${value.base}/receipts`).get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});

it.each(["missing", "mismatch"])("refuses a %s frozen code chunk before settlement", async mode => {
  const value = await prepare(), dependency = value.frozen.root.files.find(file => file.name.startsWith("code-pack/"))!;
  if (mode === "missing") await store.delete(dependency.objectKey);
  else {
    const original = await store.get(dependency.objectKey);
    await store.put(dependency.objectKey, "{}", { customMetadata: original!.customMetadata });
  }
  expect(await value.run()).toBe("retry-recorded");
  expect((await db.collection(`${value.base}/receipts`).get()).empty).toBe(true);
  expect((await db.collection(`${value.base}/views`).get()).empty).toBe(true);
  expect((await db.doc(publicReleasePairStagedCodePackPath(value.pair)).get()).exists).toBe(false);
});

it("resumes a post-completion crash under the original owner without rewriting or double settlement", async () => {
  const value = await prepare();
  await expect(value.run({ ...value.operations, stage: async () => { throw new Error("post-completion crash"); } })).rejects.toThrow("post-completion crash");
  const receipt = (await db.doc(`${value.base}/receipts/${value.taskId}`).get()).data()!;
  const objects = (await store.list({ prefix: `release-pairs/${value.pair.pairId}/` })).objects.map(row => row.key);
  const restarted = createPublicReleasePairExecutor({ firestore: db, store, pair: value.pair });
  await restarted.recover(); await restarted.recover();
  expect((await db.doc(`${value.base}/receipts/${value.taskId}`).get()).data()).toEqual(receipt);
  expect((await db.collection(`${value.base}/views`).get()).size).toBe(1);
  expect((await store.list({ prefix: `release-pairs/${value.pair.pairId}/` })).objects.map(row => row.key)).toEqual(objects);
  expect((await db.collection(`${value.base}/staging`).get()).empty).toBe(true);
  await (await openStagedPublicReleasePairCodePack({ firestore: db, store, pair: value.pair })).verifyAll();
});

it("never lets a second claim write the original claim's code-pack view objects", async () => {
  const value = await prepare();
  const old = await work.claimPublicReleasePairWork({ firestore: db, pair: value.pair, taskId: value.taskId, now: Date.now() - 61_000 });
  const next = await work.claimPublicReleasePairWork({ firestore: db, pair: value.pair, taskId: value.taskId });
  const bytes = new TextEncoder().encode("sealed member"), bodydigest = hash(bytes);
  const authority = { pair: value.pair, read: async (name: string) => (await db.doc(name).get()).data() ?? null,
    due: () => work.readPublicReleasePairWork({ firestore: db, pair: value.pair }) };
  const put = (prefix: string, claimdigest: string) => pairStorageRpc(new Request(`http://pair-storage.internal/${prefix}objects/${bodydigest}`, {
    method: "PUT", body: bytes, headers: { "content-length": String(bytes.length), "if-none-match": "*",
      "x-pair-metadata": JSON.stringify({ schemaversion: "2", pairdigest: protocol.publicReleaseDigest(value.pair), taskid: value.taskId, claimdigest, bodydigest }) } }), store, authority);
  expect((await put(old!.outputPrefix, protocol.publicReleaseDigest(old!.token))).status).toBe(403);
  expect((await put(old!.outputPrefix, protocol.publicReleaseDigest(next!.token))).status).toBe(403);
  expect((await put(next!.outputPrefix, protocol.publicReleaseDigest(next!.token))).status).toBe(201);
  expect((await store.list({ prefix: old!.outputPrefix })).objects).toEqual([]);
});

it.each(["missing", "corrupt", "transport"])("refuses a declared G body %s without confusing it with absence", async mode => {
  const value = await prepare(); expect(await value.run()).toBe("complete");
  const receipt = (await db.doc(`${value.base}/receipts/${value.taskId}`).get()).data()!;
  const staged = (await db.doc(`${value.base}/views/${receipt.manifestDigest}`).get()).data()!;
  let bodyKey = "";
  for await (const output of readPublicReleasePairView({ store, pair: value.pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) if (output.path === "/brand/logo.svg") bodyKey = output.objectKey;
  const guarded = { put: store.put.bind(store), async get(key: string) {
    if (key === bodyKey && mode === "transport") throw new Error("R2 unavailable");
    return store.get(key);
  } };
  const opened = await openStagedPublicReleasePairCodePack({ firestore: db, store: guarded, pair: value.pair });
  if (mode === "missing") await store.delete(bodyKey);
  else if (mode === "corrupt") {
    const original = await store.get(bodyKey); await store.put(bodyKey, "bad", { customMetadata: original!.customMetadata });
  }
  await expect(opened.readMember("/brand/logo.svg")).rejects.toThrow(mode === "transport" ? "R2 unavailable" : undefined);
  await expect(opened.readMember("/not-sealed.svg")).rejects.toThrow();
});

async function namespaces(extra = 0, items = 21) {
  // Historical namespace inputs now also require the full aggregate source
  // census. Reuse its real Schedule/Home/Program authority instead of seeding
  // an incomplete old CODE fixture; namespace assertions remain unchanged.
  await packet.close();
  const value = await publicReleasePairCompositeFixture({ firestore: db, store, directory });
  packet = value.packet;
  const { content, taskId } = value;
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair: value.pair, taskId });
  if (!claim) throw new Error("Fixture claim unavailable");
  const feed: ExternalContentManifest = { apiVersion: 1, title: "NJ PBS released content", homeUrl: "https://njpbs.org/", feedUrl: "https://njpbs.org/api/v1/content.json",
    rssUrl: "https://njpbs.org/feeds/news.xml", items: Array.from({ length: items }, (_, index) => ({ id: `post:${index}`, type: "post", sourceId: `post-${index}`,
      sourceVersion: 1, url: `https://njpbs.org/posts/story-${index}/`, locale: "en", title: `Story ${index}`, summary: "Public summary", contentHtml: "<p>Public</p>",
      publishedAt: "2026-10-28T04:00:00.000Z", modifiedAt: "2026-10-28T04:00:00.000Z", authors: [], categories: [], tags: [] })) };
  const output = createExternalContentStaticFeed(feed), bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
  const files = [{ path: "/api/v1/content.json", mime: "application/json; charset=utf-8", bytes: bytes(output.index) },
    ...output.pages.map(page => ({ path: `/api/v1/content/${page.page}.json`, mime: "application/json; charset=utf-8", bytes: bytes(page) })),
    { path: "/pagefind/pagefind-entry.json", mime: "application/json; charset=utf-8", bytes: bytes({ version: "sealed" }) },
    { path: "/pagefind/pagefind.js", mime: "application/javascript; charset=utf-8", bytes: new TextEncoder().encode("export{}") },
    ...Array.from({ length: extra }, (_, index) => ({ path: `/pagefind/fragment-${String(index).padStart(6, "0")}.pf_fragment`, mime: "application/octet-stream", bytes: new TextEncoder().encode("fragment") }))]
    .sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
  const owner = { firestore: db, store, pair: value.pair, identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token) };
  async function* outputs(): AsyncIterable<PairViewOutputInput> { for (const file of files) yield { path: file.path, status: 200, bytes: file.bytes,
    headers: { "content-type": file.mime, "x-njpbs-renderer-sha": value.pair.commitSha, "cache-control": "no-store" } }; }
  const rendered = await writePublicReleasePairView({ ...owner, cursor: content.root.cursor, outputs: outputs(), deriveNamespaces: true });
  await work.settlePublicReleasePairWork({ firestore: db, pair: value.pair, taskId, token: claim.token, manifestDigest: rendered.manifestDigest });
  const bound = { ...owner, viewManifestDigest: rendered.manifestDigest };
  const verifier = await preparePublicReleasePairNamespacesReadback(bound);
  const staged = await stagePublicReleasePairView({ ...owner, manifestDigest: rendered.manifestDigest, verify: verifier });
  await verifier.persist(staged.record);
  return { owner: bound, rendered, files, verifier, staged };
}
it.each(["search", "feed"])("opens every staged %s member and proves typed out-of-set absence", async kind => {
  const value = await namespaces();
  const opened = await (kind === "search" ? openStagedPublicReleasePairSearchNamespace : openStagedPublicReleasePairContentFeedNamespace)(value.owner);
  await opened.verifyAll();
  for (const member of opened.manifest.members) {
    const actual = await opened.readMember(member.path); expect(actual.kind).toBe("member");
    if (actual.kind === "member") expect(hash(actual.body)).toBe(member.sha256);
  }
  expect(await opened.readMember(kind === "search" ? "/pagefind/old-fragment.pf_fragment" : "/api/v1/content/999.json")).toMatchObject({ kind: "absent" });
  expect(opened.proof.cursor).toEqual(value.rendered.root.cursor);
  expect(opened.proof.namespaceManifestDigest).not.toBe(opened.proof.namespaceRootDigest);
  await value.verifier.persist(value.staged.record);
});
it.each(["search", "feed"].flatMap(kind => ["missing", "corrupt", "transport"].map(mode => [kind, mode])))("refuses declared %s member %s rather than granting absence", async (kind, mode) => {
  const value = await namespaces(), target = kind === "search" ? "/pagefind/pagefind.js" : "/api/v1/content/1.json";
  const file = value.files.find(file => file.path === target)!, key = views.publicReleasePairViewObjectKey(value.owner.pair, value.owner.identity, value.owner.claimDigest, hash(file.bytes));
  const guarded = { put: store.put.bind(store), async get(name: string) { if (name === key && mode === "transport") throw new Error("R2 transport failure"); return store.get(name); } };
  const opened = await (kind === "search" ? openStagedPublicReleasePairSearchNamespace : openStagedPublicReleasePairContentFeedNamespace)({ ...value.owner, store: guarded });
  if (mode === "missing") await store.delete(key);
  if (mode === "corrupt") { const old = await store.get(key); await store.put(key, "bad", { customMetadata: old!.customMetadata }); }
  await expect(opened.readMember(target)).rejects.toThrow(mode === "transport" ? "R2 transport failure" : undefined);
});
it.each(["search", "feed"])("rejects a %s namespace manifest/roster mismatch before reading any namespace body", async kind => {
  const value = await namespaces(), link = value.rendered.root.namespaces![kind === "search" ? "search" : "contentFeed"];
  const old = await store.get(link.descriptor.key), raw = JSON.parse(await old!.text()); raw.members.pop();
  await store.put(link.descriptor.key, JSON.stringify(raw), { customMetadata: old!.customMetadata });
  const read: string[] = [], guarded = { put: store.put.bind(store), async get(key: string) { read.push(key); return store.get(key); } };
  await expect((kind === "search" ? openStagedPublicReleasePairSearchNamespace : openStagedPublicReleasePairContentFeedNamespace)({ ...value.owner, store: guarded })).rejects.toThrow();
  const namespaceFiles = value.files.filter(file => file.path.startsWith(kind === "search" ? "/pagefind/" : "/api/v1/content/"));
  expect(namespaceFiles.some(file => read.includes(views.publicReleasePairViewObjectKey(value.owner.pair, value.owner.identity, value.owner.claimDigest, hash(file.bytes))))).toBe(false);
});
describe("namespace metadata scaling", () => {
  let small: number;
  async function reads(extra: number) {
    const value = await namespaces(extra), read: string[] = [];
    expect(value.rendered.root.pages).toHaveLength(extra ? 2 : 1);
    const counted = { put: store.put.bind(store), async get(key: string) { read.push(key); return store.get(key); } };
    const opened = await openStagedPublicReleasePairSearchNamespace({ ...value.owner, store: counted });
    expect((await opened.readMember("/pagefind/pagefind.js")).kind).toBe("member");
    return read.length;
  }
  beforeAll(async () => {
    await reset();
    small = await reads(0);
    await packet.close(); await rm(directory, { recursive: true, force: true });
  });
  it("keeps per-request R2 reads bounded when the namespace grows across G metadata pages", async () => {
    const large = await reads(257);
    expect(large).toBeLessThanOrEqual(small + 1); expect(large).toBeLessThan(40);
  });
});
it.each(["search", "feed"])("opens the actual baseline %s selection without fabricating an incremental namespace receipt", async kind => {
  const value = await prepare(); expect(await value.run()).toBe("complete");
  const receipt = (await db.doc(`${value.base}/receipts/${value.taskId}`).get()).data()!;
  const owner = { firestore: db, store, pair: value.pair, identity: receipt.identity, claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest };
  const opened = await (kind === "search" ? openPublicReleasePairSearchNamespaceSelection : openPublicReleasePairContentFeedNamespaceSelection)(owner);
  expect(opened.selectionKind).toBe("code-pack");
  expect(opened.record.kind).toBe("pair-code-pack-staged-baseline");
  expect(opened.record.claimDigest).toBe(receipt.claimDigest);
  await opened.verifyAll();
  expect(await opened.readMember(kind === "search" ? "/pagefind/old.pf_fragment" : "/api/v1/content/999.json")).toMatchObject({ kind: "absent" });
});
it("never changes an incremental selection into a baseline after its descriptor disappears", async () => {
  const value = await namespaces();
  await store.delete(value.rendered.root.namespaces!.search.descriptor.key);
  await expect(openPublicReleasePairSearchNamespaceSelection(value.owner)).rejects.toThrow();
});
async function catalog(extraDist: Record<string, string> = {}) {
  const value = await prepare(extraDist); expect(await value.run()).toBe("complete");
  const read = frozenReplayProgramRead(oldPair.commitSha), encoded = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const request = { schemaVersion: 1, read, homeSourcesFile: null, resources: [] };
  const provenance = { schemaVersion: 1, pair: oldPair, rendererSha: oldPair.commitSha, readerContractDigest: oldPair.readerContractDigest, readerReceiptDigest: oldPair.readerReceiptDigest };
  const files = [{ name: "read.json", bytes: encoded(request), dependencies: ["reader-provenance.json", "snapshot.json"] },
    { name: "reader-provenance.json", bytes: encoded(provenance), dependencies: [] }, { name: "snapshot.json", bytes: encoded(read.documents[0].published), dependencies: [] }];
  const scope = { kind: "qualification" as const, sourceOperationId: "catalog-input", sourceVersion: 7, contextSequence: value.frozen.root.cursor.sequence,
    snapshotDigest: hash(files.find(file => file.name === "snapshot.json")!.bytes) };
  const plan = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(value.pair), snapshotDigest: scope.snapshotDigest, renderedAt: "2026-10-28T04:00:00.000Z",
    routes: [{ path: "/programs/one/", method: "GET", renderer: "record", inputFile: "read.json", dependencies: files.map(file => ({ name: file.name, digest: hash(file.bytes) })).sort((a, b) => a.name < b.name ? -1 : 1) }],
    expectedOutputs: [{ path: "/programs/one/", status: 200, contentType: "text/html; charset=utf-8" }] };
  files.push({ name: "render-plan.json", bytes: encoded(plan), dependencies: files.map(file => file.name).sort() });
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  const root = { ...value.frozen.root, source: { kind: "record" as const, id: "one" }, scope, entryFiles: ["render-plan.json", "snapshot.json"],
    files: files.map(file => ({ name: file.name, digest: hash(file.bytes), bytes: file.bytes.length, dependencies: file.dependencies,
      objectKey: `release-pair-inputs/v2/${value.pair.pairId}/objects/${hash(file.bytes)}.json` })) };
  async function* inputFiles() { yield* files; }
  const captured = await capturePublicReleasePairInput({ firestore: db, store, pair: value.pair, plan: root, expectedSource: root.source, expectedCursor: root.cursor, files: inputFiles() });
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair: value.pair,
    input: { ...scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair: value.pair, taskId }); if (!claim) throw new Error("Missing claim");
  const sourceOwner = { firestore: db, store, pair: value.pair, identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token) };
  const source = await openFrozenPublicReleasePairCatalogImages(sourceOwner);
  async function* outputs(): AsyncIterable<PairViewOutputInput> {
    for (const member of source.manifest.members) yield { path: member.path, status: 200, bytes: await source.readMember(member.path),
      headers: { "content-type": member.mime, "x-njpbs-renderer-sha": value.pair.commitSha, "cache-control": "no-store" } };
    yield { path: "/programs/one/", status: 200, bytes: new TextEncoder().encode("<main>Frozen program</main>"),
      headers: { "content-type": "text/html; charset=utf-8", "x-njpbs-renderer-sha": value.pair.commitSha, "cache-control": "no-store" } };
  }
  const rendered = await writePublicReleasePairView({ ...sourceOwner, cursor: root.cursor, outputs: outputs(), catalogImages: source.manifest });
  await work.settlePublicReleasePairWork({ firestore: db, pair: value.pair, taskId, token: claim.token, manifestDigest: rendered.manifestDigest });
  const owner = { ...sourceOwner, viewManifestDigest: rendered.manifestDigest };
  const verifier = await preparePublicReleasePairCatalogImagesReadback(owner);
  const staged = await stagePublicReleasePairView({ ...owner, manifestDigest: rendered.manifestDigest, verify: verifier });
  await verifier.persist(staged.record);
  return { owner, source, rendered };
}
it.each(["absent", "identical"])("stages and opens exact catalog images %s from the NEW baseline", async mode => {
  const value = await catalog(mode === "identical" ? { "_astro/art.png": "abc" } : {});
  const opened = await openStagedPublicReleasePairCatalogImages(value.owner); await opened.verifyAll();
  expect(opened.manifest.members).toHaveLength(3);
  for (const member of opened.manifest.members) expect((await opened.readMember(member.path)).body).toEqual(await value.source.readMember(member.path));
  expect(opened.manifest.catalogs[0].rendererSha).toBe(oldPair.commitSha);
  const retained = db.doc("fixture/catalog-retained"); await retained.set({ manifest: opened.manifest });
  const roundTrip = (await retained.get()).data()!.manifest;
  await db.runTransaction(transaction => catalogCodec.assertReadPublicReleasePairCatalogImagesInTransaction({ ...value.owner, transaction,
    manifest: roundTrip, manifestDigest: opened.proof.descriptor.digest }), { readOnly: true });
  await expect(opened.readMember("/_astro/client.js")).rejects.toMatchObject({ reason: "catalog-unlisted" });
});
it("refuses different bytes at an existing baseline image path", async () => {
  await expect(catalog({ "_astro/art.png": "different baseline bytes" })).rejects.toMatchObject({ reason: "catalog-baseline-collision" });
});
it.each(["missing", "corrupt", "transport"])("refuses declared catalog image %s during requested actual byte read", async mode => {
  const value = await catalog(), member = value.source.manifest.members[0];
  const key = views.publicReleasePairViewObjectKey(value.owner.pair, value.owner.identity, value.owner.claimDigest, member.sha256);
  const guarded = { put: store.put.bind(store), async get(name: string) { if (mode === "transport" && name === key) throw new Error("Catalog R2 unavailable"); return store.get(name); } };
  const opened = await openStagedPublicReleasePairCatalogImages({ ...value.owner, store: guarded });
  if (mode === "missing") await store.delete(key);
  if (mode === "corrupt") { const old = await store.get(key); await store.put(key, "bad", { customMetadata: old!.customMetadata }); }
  await expect(opened.readMember(member.path)).rejects.toThrow(mode === "transport" ? "Catalog R2 unavailable" : undefined);
});
