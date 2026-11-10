import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { captureOwnedPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import legacy from "../../functions/lib/public-deployment.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { readPublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { startPublicReleasePairServer } from "../../site/scripts/public-release-pair-server";
import { publishedPageRead, retainedHomeSources } from "../../site/tests/fixtures/published-pages/fixtures";
import { openStagedPublicReleasePairReplayTargets } from "../../site/scripts/public-release-pair-replay-storage";
import { readPublicReleasePairClaimJson } from "../../site/scripts/public-release-pair-view-storage";
import { pairStorageRpc } from "../../publisher/pair-storage-rpc";
import { frozenReplayScheduleFixture } from "../helpers/public-release-replay-inputs";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
let pair: ReturnType<typeof releasePair>, base: string;
beforeAll(async () => {
  const directory = new URL("../../site/.public-post-renderer/", import.meta.url);
  const seal = await readFile(new URL("pair-renderer-release.json", directory));
  const compiled = JSON.parse(seal.toString("utf8"));
  pair = { ...releasePair("a", compiled.rendererSha), rendererDigest: sha(seal) };
  base = work.publicReleasePairPath(pair.pairId);
  db = isolatedFirestore("public-release-pair-executor.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-executor-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-executor" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const objects = await store.list();
  if (objects.objects.length) await store.delete(objects.objects.map(object => object.key));
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
});
afterAll(async () => { await runtime?.dispose(); });

async function prepare(withAliases = false, sourceOperationId = "executor-operation", warningRecords = false, originalPair = pair,
  pageRead?: ReturnType<typeof publishedPageRead>, homeSources?: ReturnType<typeof retainedHomeSources>, frozenFiles?: Map<string, Uint8Array>) {
  const captured = capturedPairInput(pair, { sourceOperationId });
  const publishedRead = pageRead ?? JSON.parse(new TextDecoder().decode(captured.files[0].bytes));
  if (!pageRead) publishedRead.document.publishAt = publishedRead.document.published.publishedAt;
  if (pageRead) {
    captured.files[1].bytes = encode(pageRead.page);
    captured.scope.snapshotDigest = sha(captured.files[1].bytes);
    captured.root.scope = captured.scope;
    captured.root.source = { kind: "page", id: pageRead.page.pageId };
  }
  if (warningRecords) publishedRead.joinedRecords = Array.from({ length: 80 }, (_, index) => ({
    id: `unapproved-sponsor-${index}`, type: "sponsor" }));
  // Independent published-source fixture: strip draft fields before capture.
  const request = { schemaVersion: 1, read: publishedRead, homeSourcesFile: homeSources ? "home.json" : null, resources: [] };
  const provenance = { schemaVersion: 1, pair: originalPair, rendererSha: originalPair.commitSha,
    readerContractDigest: originalPair.readerContractDigest, readerReceiptDigest: originalPair.readerReceiptDigest };
  const files = [{ name: "reader-provenance.json", bytes: encode(provenance), dependencies: [] },
    { name: "context.json", bytes: encode(request), dependencies: ["reader-provenance.json"] },
    { name: "snapshot.json", bytes: captured.files[1].bytes, dependencies: ["context.json"] }];
  if (homeSources) files.push({ name: "home.json", bytes: encode(homeSources), dependencies: [] });
  for (const [name, bytes] of frozenFiles ?? []) files.push({ name, bytes, dependencies: [] });
  const plan = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), snapshotDigest: captured.scope.snapshotDigest,
    renderedAt: "2026-10-28T04:00:00.000Z", routes: [{ path: pageRead ? pageRead.page.path : "/posts/shadow-fixture/", method: "GET", renderer: pageRead ? "page" : "post",
      inputFile: "context.json", dependencies: files.map(file => ({ name: file.name, digest: sha(file.bytes) })).sort((a, b) => a.name < b.name ? -1 : 1) }],
    expectedOutputs: [{ path: pageRead ? pageRead.page.path : "/posts/shadow-fixture/", status: 200, contentType: "text/html; charset=utf-8" }] };
  if (withAliases) {
    for (const [name, renderer, path, read, status] of [
      ["alias.json", "redirect", "/old-story/", { kind: "redirect", path: "/old-story/", location: "/posts/shadow-fixture/" }, 308],
      ["withdrawn.json", "withdrawal", "/withdrawn-story/", { kind: "withdrawn", path: "/withdrawn-story/" }, 410],
    ] as const) {
      const bytes = encode({ schemaVersion: 1, read, homeSourcesFile: null, resources: [] });
      files.push({ name, bytes, dependencies: ["context.json", "snapshot.json"] });
      plan.routes.push({ path, method: "GET", renderer, inputFile: name,
        dependencies: [...plan.routes[0].dependencies, { name, digest: sha(bytes) }].sort((a, b) => a.name < b.name ? -1 : 1) });
      plan.expectedOutputs.push({ path, status, contentType: "text/html; charset=utf-8" });
    }
    plan.routes.sort((a, b) => a.path < b.path ? -1 : 1);
    plan.expectedOutputs.sort((a, b) => a.path < b.path ? -1 : 1);
  }
  files.push({ name: "render-plan.json", bytes: encode(plan), dependencies: files.map(file => file.name).sort() });
  files.sort((a, b) => a.name < b.name ? -1 : 1);
  const root = { ...captured.root, entryFiles: ["render-plan.json", "snapshot.json"], files: files.map(file => ({
    name: file.name, digest: sha(file.bytes), bytes: file.bytes.byteLength,
    objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${sha(file.bytes)}.json`, dependencies: file.dependencies })) };
  async function* stream() { for (const file of files) yield file; }
  const receipt = await capturePublicReleasePairInput({ firestore: db, store, pair, plan: root,
    expectedSource: root.source, expectedCursor: root.cursor, files: stream() });
  const taskInput = { ...captured.scope, inputManifestDigest: receipt.receipt.inputManifestDigest };
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair, input: taskInput }));
  return { taskId, root, inputManifestDigest: receipt.receipt.inputManifestDigest };
}
const executor = (overrides = {}) => createPublicReleasePairExecutor({ firestore: db, store, pair, ...overrides });
const run = (operations = executor()) => runPublicReleasePairWorkOnce({ firestore: db, pair, ...operations });

it("keeps ordinary projector refusals classified as render failures before sandboxing", async () => {
  const read = publishedPageRead("schedule", pair.commitSha);
  (read as any).kind = "invalid-reader-result";
  const value = await prepare(false, "invalid-page-read", false, pair, read);
  expect(await run()).toBe("retry-recorded");
  expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.lastFailure).toBe("render-failed");
  expect((await db.collection(`${base}/receipts`).get()).empty).toBe(true);
});

it.each(["missing", "corrupt"])("records a named %s frozen Schedule packet failure under its original claim before the child runs", async mode => {
  const original = releasePair("b", "b".repeat(40)), frozen = await frozenReplayScheduleFixture(original.commitSha);
  const read = publishedPageRead("schedule", original.commitSha);
  Object.assign(read, { schedule: frozen.schedule }); Object.assign(read.sourceSeal, { codeGeneration: 5 });
  const pdf = frozen.roster.find(file => file.name === "schedule-packet/pdf")!;
  if (mode === "missing") frozen.files.delete(pdf.chunkFiles[0]);
  else frozen.files.set(pdf.chunkFiles[0], encode({ bodyBase64: "YmFk" }));
  const value = await prepare(false, `schedule-${mode}`, false, original, read, undefined, frozen.files);
  expect(await run()).toBe("retry-recorded");
  const task = (await db.doc(`${base}/work/${value.taskId}`).get()).data()!;
  expect(task.lastFailure).toBe(`replay-frozen-schedule-${mode === "missing" ? "missing" : "mismatch"}`);
  expect(task.identity.inputManifestDigest).toBe(value.inputManifestDigest);
  expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
  expect((await db.collection(`${base}/receipts`).get()).empty).toBe(true);
});

it("renders an OLD frozen Schedule packet with the real NEW private compiled entry in the offline sandbox", async () => {
  const original = releasePair("b", "b".repeat(40)), frozen = await frozenReplayScheduleFixture(original.commitSha);
  const read = publishedPageRead("schedule", original.commitSha);
  Object.assign(read, { schedule: frozen.schedule }); Object.assign(read.sourceSeal, { codeGeneration: 5 });
  const value = await prepare(false, "schedule-replay", false, original, read, undefined, frozen.files);
  expect(await run()).toBe("complete");
  const receipt = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const staged = (await db.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!;
  const outputs = [];
  for await (const output of readPublicReleasePairView({ store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) outputs.push(output);
  expect(outputs[0].path).toBe("/schedule/");
  expect(new TextDecoder().decode(outputs[0].body)).toContain("A published heading");
  const proof = await openStagedPublicReleasePairReplayTargets({ firestore: db, store, pair, identity: receipt.identity,
    claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest });
  const targets = []; for await (const target of proof.targets()) targets.push(target);
  expect(targets[0].receipt.source.rendererSha).toBe(original.commitSha);
  expect(targets[0].receipt.target.rendererSha).toBe(pair.commitSha);
});

it("renders the actual compiled Post in the offline sandbox, reads back local R2, and stages exactly one original receipt", async () => {
  const value = await prepare();
  expect(await run()).toBe("complete");
  const receipt = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const staged = (await db.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!;
  expect(staged.outputCount).toBe(1);
  expect(staged.identity.snapshotDigest).toBe(value.root.scope.snapshotDigest);
  expect(staged.identity.inputManifestDigest).toBe(value.inputManifestDigest);
  expect(staged.identity.snapshotDigest).not.toBe(staged.identity.inputManifestDigest);
  const outputs = [];
  for await (const output of readPublicReleasePairView({ store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) outputs.push(output);
  expect(outputs.map(output => output.path)).toEqual(["/posts/shadow-fixture/"]);
  const html = new TextDecoder().decode(outputs[0].body);
  expect(html).toContain("A published fixture");
  expect(html).not.toContain("Private working title");
  expect(outputs[0].headers["x-njpbs-html-sha256"]).toBe(sha(outputs[0].body));
  expect((await db.collection(`${base}/staging`).get()).empty).toBe(true);
  await executor().recover();
  expect(await run()).toBe("idle");
  expect((await db.collection(`${base}/receipts`).get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(legacy.initialPublicDeploymentPointer());
});

it.each(["missing", "corrupt"])("refuses %s dependencies before producing a view or a completed receipt", async mode => {
  const value = await prepare(), dependency = value.root.files.find(file => file.name === "context.json")!;
  if (mode === "missing") await store.delete(dependency.objectKey);
  else {
    const before = await store.get(dependency.objectKey), bytes = new Uint8Array(await before!.arrayBuffer()); bytes[0] ^= 1;
    await store.put(dependency.objectKey, bytes, { customMetadata: before!.customMetadata });
  }
  expect(await run()).toBe("retry-recorded");
  expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
  expect((await db.collection(`${base}/receipts`).get()).empty).toBe(true);
  const objects = await store.list({ prefix: `release-pairs/${pair.pairId}/` });
  expect(objects.objects).toEqual([]);
  expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.lastFailure).toBe("input-unavailable");
});

it("recovers a crash after completion from the original claim's immutable manifest without rendering or double settlement", async () => {
  const value = await prepare(), operations = executor();
  await expect(run({ ...operations, stage: async () => { throw new Error("injected crash after commit"); } })).rejects.toThrow("injected crash");
  const before = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  expect((await db.collection(`${base}/staging`).get()).size).toBe(1);
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: value.taskId });
  expect(claim).toBe(null);
  const retained = await store.list({ prefix: `release-pairs/${pair.pairId}/` });
  const restarted = executor();
  await restarted.recover(); await restarted.recover();
  expect((await db.doc(`${base}/receipts/${value.taskId}`).get()).data()).toEqual(before);
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
  expect((await db.collection(`${base}/staging`).get()).empty).toBe(true);
  expect((await store.list({ prefix: `release-pairs/${pair.pairId}/` })).objects.map(item => item.key)).toEqual(retained.objects.map(item => item.key));
});

it("resumes an interrupted uncompleted task only on its original pair and frozen pack, in a new claim-isolated prefix", async () => {
  const value = await prepare();
  const old = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: value.taskId, now: Date.now() - 61_000 });
  // Simulated container crash: the durable lease expires, no source recapture.
  const oldPrefix = old!.outputPrefix;
  expect(await run()).toBe("complete");
  const receipt = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  expect(receipt.identity.inputManifestDigest).toBe(value.inputManifestDigest);
  expect(receipt.claimDigest).not.toBe(protocol.publicReleaseDigest(old!.token));
  expect((await store.list({ prefix: oldPrefix })).objects).toEqual([]);
  expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.attempts).toBe(2);
});

it("private storage rejects a superseded claim and a second claim writing the first claim's views", async () => {
  const value = await prepare(), old = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: value.taskId, now: Date.now() - 61_000 });
  const next = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: value.taskId });
  const bytes = encode({ output: "owned" }), bodydigest = sha(bytes);
  const authority = { pair, read: async (name: string) => (await db.doc(name).get()).data() ?? null,
    due: () => work.readPublicReleasePairWork({ firestore: db, pair }) };
  const put = (prefix: string, claimdigest: string) => pairStorageRpc(new Request(`http://pair-storage.internal/${prefix}objects/${bodydigest}`, {
    method: "PUT", body: bytes, headers: { "content-length": String(bytes.byteLength), "if-none-match": "*",
      "x-pair-metadata": JSON.stringify({ schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), taskid: value.taskId, claimdigest, bodydigest }) } }), store, authority);
  expect((await put(old!.outputPrefix, protocol.publicReleaseDigest(old!.token))).status).toBe(403);
  expect((await put(old!.outputPrefix, protocol.publicReleaseDigest(next!.token))).status).toBe(403);
  expect((await put(next!.outputPrefix, protocol.publicReleaseDigest(next!.token))).status).toBe(201);
  expect((await store.list({ prefix: old!.outputPrefix })).objects).toEqual([]);
});

it("rechecks the actual compiled graph seal after registered pair and input authority succeed", async () => {
  const original = pair;
  try {
    pair = { ...pair, rendererDigest: "f".repeat(64) };
    await db.doc(base).set(pair);
    const value = await prepare();
    expect(await run()).toBe("retry-recorded");
    expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.lastFailure).toBe("byte-mismatch");
    expect((await db.collection(`${base}/receipts`).get()).empty).toBe(true);
  } finally { pair = original; }
});
it("writes and reads back a zero-byte withdrawal body through private storage, including a null request stream", async () => {
  const value = await prepare(), claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: value.taskId });
  const bodydigest = sha(new Uint8Array()), claimdigest = protocol.publicReleaseDigest(claim!.token);
  const readNames: string[] = [];
  const authority = { pair, read: async (name: string) => { readNames.push(name); return (await db.doc(name).get()).data() ?? null; } };
  const key = `${claim!.outputPrefix}objects/${bodydigest}`;
  const request = new Request(`http://pair-storage.internal/${key}`, { method: "PUT", headers: {
    "content-length": "0", "if-none-match": "*", "x-pair-metadata": JSON.stringify({ schemaversion: "2",
      pairdigest: protocol.publicReleaseDigest(pair), taskid: value.taskId, claimdigest, bodydigest }) } });
  expect(request.body).toBe(null);
  expect((await pairStorageRpc(request, store, authority)).status).toBe(201);
  const object = await store.get(key);
  expect(object!.size).toBe(0);
  expect(sha(new Uint8Array(await object!.arrayBuffer()))).toBe(bodydigest);
  expect(readNames.length).toBe(5); // lifecycle+billing, task+journal, final lease
});

it("stages the complete expected Post, retained redirect and withdrawal output set", async () => {
  const value = await prepare(true);
  expect(await run()).toBe("complete");
  const receipt = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const staged = (await db.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!;
  const outputs = [];
  for await (const output of readPublicReleasePairView({ store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
    manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) outputs.push(output);
  expect(outputs.map(output => [output.path, output.status, output.bytes === 0])).toEqual([
    ["/old-story/", 308, true], ["/posts/shadow-fixture/", 200, false], ["/withdrawn-story/", 410, true],
  ]);
  expect(outputs[0].headers.location).toBe("/posts/shadow-fixture/");
  expect(staged.outputCount).toBe(3);
});

it("bounds a poisoned staging item without starving later work, and repairs only the original retained receipt", async () => {
  let now = Date.now();
  const operations = executor({ clock: () => now });
  const bad = await prepare(false, "poisoned-operation");
  await expect(run({ ...operations, stage: async () => { throw new Error("injected crash"); } })).rejects.toThrow("injected crash");
  const receipt = (await db.doc(`${base}/receipts/${bad.taskId}`).get()).data()!;
  const objects = await store.list({ prefix: `release-pairs/${pair.pairId}/${bad.taskId}/claims/` });
  const body = objects.objects.find(object => object.key.includes("/objects/"))!;
  const original = await store.get(body.key), bytes = new Uint8Array(await original!.arrayBuffer());
  await store.delete(body.key);
  await operations.recover();
  expect((await db.doc(`${base}/staging/${bad.taskId}`).get()).data()!.attempts).toBe(1);
  const good = await prepare(false, "later-operation");
  expect(await run(operations)).toBe("complete");
  expect((await db.doc(`${base}/work/${good.taskId}`).get()).data()!.status).toBe("complete");
  now += 60_001; await operations.recover();
  now += 120_001; await operations.recover();
  expect((await db.doc(`${base}/staging/${bad.taskId}`).get()).exists).toBe(false);
  expect((await db.doc(`${base}/stagingFailures/${bad.taskId}`).get()).data()).toMatchObject({ attempts: 3, status: "quarantined" });
  expect((await db.doc(`${base}/receipts/${bad.taskId}`).get()).data()).toEqual(receipt);
  await expect(operations.retryQuarantined(bad.taskId)).rejects.toThrow();
  await store.put(body.key, bytes, { customMetadata: original!.customMetadata });
  const server = await startPublicReleasePairServer({ firestore: db, pair, ...operations, host: "127.0.0.1", port: 0 });
  try {
    const address = server.address;
    if (!address || typeof address === "string") throw new Error("Missing private test address");
    const origin = `http://127.0.0.1:${address.port}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${origin}/retry-staging`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: bad.taskId }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "staged", taskId: bad.taskId });
      await server.waitForCurrentWork(); // A lost successful response is idempotent.
    }
  } finally { await server.close(); }
  expect((await db.doc(`${base}/stagingFailures/${bad.taskId}`).get()).exists).toBe(false);
  expect((await db.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!.claimDigest).toBe(receipt.claimDigest);
  expect((await db.doc(`${base}/work/${bad.taskId}`).get()).data()!.attempts).toBe(1);
});

it("does not consume or quarantine a completed view during a multi-minute transport outage", async () => {
  let now = Date.now(), unavailable = false;
  const observed: PairViewStore = { put: (...args) => store.put(...args), get: key => {
    if (unavailable) throw new work.PairExecutionError("storage-unavailable");
    return store.get(key);
  } };
  const operations = executor({ clock: () => now, store: observed }), value = await prepare();
  await expect(run({ ...operations, stage: async () => { throw new Error("injected crash"); } })).rejects.toThrow();
  const original = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data();
  unavailable = true;
  for (let minute = 0; minute < 4; minute++) {
    await operations.recover(); now += 60_001;
    expect((await db.doc(`${base}/staging/${value.taskId}`).get()).data()).toMatchObject({ attempts: 0, lastFailure: "storage-unavailable" });
    expect((await db.collection(`${base}/stagingFailures`).get()).empty).toBe(true);
  }
  unavailable = false;
  await operations.recover();
  expect((await db.collection(`${base}/staging`).get()).empty).toBe(true);
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
  expect((await db.doc(`${base}/receipts/${value.taskId}`).get()).data()).toEqual(original);
  expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.attempts).toBe(1);
});
it("renders valid published content despite ordinary library warnings beyond the former child output cap", async () => {
  await prepare(false, "warning-operation", true);
  expect(await run()).toBe("complete");
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
});


it.each(["post", "page"] as const)("renders OLD %s input with NEW sealed code and durably binds both identities to actual G output", async kind => {
  const originalPair = releasePair("b", "b".repeat(40));
  const read = kind === "page" ? publishedPageRead("about", originalPair.commitSha) : undefined;
  const before = JSON.stringify(read);
  const value = await prepare(false, `cross-source-${kind}`, false, originalPair, read);
  expect(await run()).toBe("complete");
  expect(JSON.stringify(read)).toBe(before);
  const completed = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const proof = (await db.doc(`${base}/renderTargets/${completed.manifestDigest}`).get()).data()!;
  expect(proof).toMatchObject({ status: "staged", snapshotDigest: value.root.scope.snapshotDigest,
    inputManifestDigest: value.inputManifestDigest, targetCount: 1 });
  const root = await readPublicReleasePairClaimJson({ store, pair, identity: completed.identity,
    claimDigest: completed.claimDigest, descriptor: proof.descriptor, limit: 256 * 1024 }) as any;
  const page = await readPublicReleasePairClaimJson({ store, pair, identity: completed.identity,
    claimDigest: completed.claimDigest, descriptor: root.pages[0], limit: 256 * 1024 }) as any;
  const target = page.targets[0];
  expect(target.receipt.source.pair).toEqual(protocol.publicReleasePairReference(originalPair));
  expect(target.receipt.source.rendererSha).toBe(originalPair.commitSha);
  expect(target.receipt.target.rendererSha).toBe(pair.commitSha);
  expect(target.receipt.target.rendererDigest).toBe(pair.rendererDigest);
  expect(target.receipt.target.projection.target.rendererSha).toBe(pair.commitSha);
  const staged = (await db.doc(`${base}/views/${completed.manifestDigest}`).get()).data()!;
  for await (const output of readPublicReleasePairView({ store, pair, identity: completed.identity, claimDigest: completed.claimDigest,
    manifestDigest: completed.manifestDigest, manifestBytes: staged.manifestBytes })) {
    expect(target.bodyDigest).toBe(sha(output.body));
    expect(output.headers["x-njpbs-renderer-sha"]).toBe(pair.commitSha);
  }
  const opened = await openStagedPublicReleasePairReplayTargets({ firestore: db, store, pair, identity: completed.identity,
    claimDigest: completed.claimDigest, viewManifestDigest: completed.manifestDigest });
  const verified = [];
  for await (const member of opened.targets()) verified.push(member);
  expect(verified).toEqual([target]);
  await executor().recover();
  expect((await db.doc(`${base}/renderTargets/${completed.manifestDigest}`).get()).data()).toEqual(proof);
});

it("recovers completed NEW-source output and target proof under the original claim after a staging crash", async () => {
  const value = await prepare(false, "cross-source-crash", false, releasePair("b", "b".repeat(40)));
  await expect(run({ ...executor(), stage: async () => { throw new Error("crash before provenance staging"); } })).rejects.toThrow();
  const completed = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  expect((await db.doc(`${base}/replayClaims/${completed.claimDigest}`).get()).exists).toBe(true);
  expect((await db.collection(`${base}/renderTargets`).get()).empty).toBe(true);
  await executor().recover(); await executor().recover();
  expect((await db.doc(`${base}/renderTargets/${completed.manifestDigest}`).get()).data()!.claimDigest).toBe(completed.claimDigest);
  expect((await db.doc(`${base}/receipts/${value.taskId}`).get()).data()).toEqual(completed);
  expect((await db.collection(`${base}/staging`).get()).empty).toBe(true);
});

it.each(["schedule", "live"])("records a named refusal for missing frozen OLD %s packets without producing views", async pageId => {
  const original = releasePair("b", "b".repeat(40));
  const value = await prepare(false, `unsupported-${pageId}`, false, original, publishedPageRead(pageId, original.commitSha));
  expect(await run()).toBe("retry-recorded");
  expect((await db.doc(`${base}/work/${value.taskId}`).get()).data()!.lastFailure).toBe("replay-frozen-schedule-missing");
  expect((await db.collection(`${base}/receipts`).get()).empty).toBe(true);
  expect((await store.list({ prefix: `release-pairs/${pair.pairId}/` })).objects).toEqual([]);
});

it("refuses a lost or corrupt target proof during original-claim recovery without certifying G", async () => {
  const value = await prepare(false, "lost-provenance", false, releasePair("b", "b".repeat(40)));
  await expect(run({ ...executor(), stage: async () => { throw new Error("crash"); } })).rejects.toThrow();
  const completed = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const binding = (await db.doc(`${base}/replayClaims/${completed.claimDigest}`).get()).data()!;
  await store.delete(binding.descriptor.key);
  await executor().recover();
  expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
  expect((await db.collection(`${base}/renderTargets`).get()).empty).toBe(true);
  expect((await db.doc(`${base}/staging/${value.taskId}`).get()).data()!.attempts).toBe(1);
});

it("finishes the original target proof after a crash between G staging and proof staging", async () => {
  const value = await prepare(false, "after-G-crash", false, releasePair("b", "b".repeat(40)));
  await expect(run({ ...executor(), stage: async receipt => {
    await stagePublicReleasePairView({ firestore: db, store, pair, ...receipt });
    throw new Error("crash after G");
  } })).rejects.toThrow("crash after G");
  const completed = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const staged = (await db.doc(`${base}/views/${completed.manifestDigest}`).get()).data();
  expect(staged).toBeDefined();
  expect((await db.collection(`${base}/renderTargets`).get()).empty).toBe(true);
  await executor().recover();
  expect((await db.doc(`${base}/views/${completed.manifestDigest}`).get()).data()).toEqual(staged);
  expect((await db.doc(`${base}/renderTargets/${completed.manifestDigest}`).get()).data()!.claimDigest).toBe(completed.claimDigest);
  expect((await db.collection(`${base}/staging`).get()).empty).toBe(true);
});

it("renders OLD Home inputs and retained provider bytes with NEW compiled code without relabeling them", async () => {
  const original = releasePair("b", "b".repeat(40)), read = publishedPageRead("home", original.commitSha), home = retainedHomeSources(original.commitSha);
  const before = JSON.stringify({ read, home });
  const value = await prepare(false, "cross-source-home", false, original, read, home);
  expect(await run()).toBe("complete");
  expect(JSON.stringify({ read, home })).toBe(before);
  const completed = (await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!;
  const opened = await openStagedPublicReleasePairReplayTargets({ firestore: db, store, pair, identity: completed.identity,
    claimDigest: completed.claimDigest, viewManifestDigest: completed.manifestDigest });
  expect(opened.record.targetCount).toBe(1);
});

it("cannot stage a second claim using the first claim's target proof objects", async () => {
  const receipts = [];
  for (const name of ["proof-owner", "proof-borrower"]) {
    const value = await prepare(false, name, false, releasePair("b", "b".repeat(40)));
    await expect(run({ ...executor(), stage: async () => { throw new Error("crash"); } })).rejects.toThrow();
    receipts.push((await db.doc(`${base}/receipts/${value.taskId}`).get()).data()!);
  }
  const first = (await db.doc(`${base}/replayClaims/${receipts[0].claimDigest}`).get()).data()!;
  await db.doc(`${base}/replayClaims/${receipts[1].claimDigest}`).update({ descriptor: first.descriptor });
  await executor().recover();
  expect((await db.doc(`${base}/renderTargets/${receipts[0].manifestDigest}`).get()).exists).toBe(true);
  expect((await db.doc(`${base}/views/${receipts[1].manifestDigest}`).get()).exists).toBe(false);
  expect((await db.doc(`${base}/renderTargets/${receipts[1].manifestDigest}`).get()).exists).toBe(false);
});

it("executes the real source owner's frozen capture with original registered reader provenance", async () => {
  const original = releasePair("b", "b".repeat(40));
  await work.registerPublicReleasePair({ firestore: db, pair: original });
  await db.doc("system/publicDeployment").set({ ...legacy.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "original-reader-release", activeCommitSha: original.commitSha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "original-reader-release" });
  const head = log.initialPublicReleaseChangeHead("f".repeat(64));
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const code = publicReleaseBaselineCodeFixture(db, original.commitSha);
  await baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch: "executor-source" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true,
    pair: protocol.publicReleasePairReference(original), head, logEpoch: "executor-source" });
  const fixture = capturedPairInput(pair), source = JSON.parse(new TextDecoder().decode(fixture.files[0].bytes));
  const operationId = "actual-source-owner-capture";
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId,
      contextRevision: source.document.published.sourceVersion, changes: [{ kind: "post", id: source.document.id, action: "publish", sourceVersion: source.document.published.sourceVersion,
        snapshot: source.document.published }] });
    append();
    transaction.set(db.doc(`cmsPosts/${source.document.id}`), { ...source.document, status: "published",
      publishAt: source.document.published.publishedAt, publiclyVisible: true, version: source.document.published.sourceVersion });
    transaction.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: source.document.published.sourceVersion });
  });
  const captured = await captureOwnedPublicReleasePairInput({ firestore: db, pair, providerStore: store, store,
    sourceOperationId: operationId });
  expect(captured.root.files.some(file => file.name === "reader-provenance.json")).toBe(true);
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db,
    transaction, pair, input: { ...captured.receipt.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
  expect(await run()).toBe("complete");
  const completed = (await db.doc(`${base}/receipts/${taskId}`).get()).data()!;
  const opened = await openStagedPublicReleasePairReplayTargets({ firestore: db, store, pair, identity: completed.identity,
    claimDigest: completed.claimDigest, viewManifestDigest: completed.manifestDigest });
  const members = [];
  for await (const member of opened.targets()) members.push(member);
  expect(members).toHaveLength(1);
  expect(members[0].receipt.source.pair).toEqual(protocol.publicReleasePairReference(original));
  expect(members[0].receipt.target.pair).toEqual(protocol.publicReleasePairReference(pair));
});
