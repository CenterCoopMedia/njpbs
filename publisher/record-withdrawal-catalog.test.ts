import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { publishRecordWithdrawalCatalog } from "./record-withdrawal-catalog";
import { recordWithdrawalManifestKey, readDurableRecordAuthority, validateRecordWithdrawalManifest } from "../workers/src/durable-record-withdrawals";
import { publicationTarget } from "../functions/lib/publication-target.js";
import { createTransitionalPostReadWorker } from "../workers/src/transitional-post-read-worker";
import type { CatalogObservation, CatalogStore } from "./withdrawal-catalog";

const target = publicationTarget("development"), sha = "a".repeat(40), operationId = "A".repeat(20);
const key = recordWithdrawalManifestKey(target.workerName);
let runtime: Miniflare, store: CatalogStore;
function observation(revision = 3): CatalogObservation {
  const marker = { schemaVersion: 1, recordId: "program-one", family: "programs", operationId, sourceVersion: 7, revision,
    ownedPaths: ["/programs/example/", "/programs/former/", "/shows/example/", "/shows/former/"],
    snapshotDigest: "c".repeat(64), contextRevision: revision };
  return { contextRevision: revision, recordFamilies: ["programs"], pointer: { state: "idle", activeCommitSha: sha },
    owners: [{ schemaVersion: 1, documentId: marker.recordId, family: marker.family, operationId, sourceVersion: 7,
      generation: revision, visible: false, ownedPaths: marker.ownedPaths, durableWithdrawal: marker }],
    queues: new Map([[operationId, { transport: "public-context-no-build-v1", status: "pending", recordPublication: {
      ...marker, documentId: marker.recordId, generation: revision, visible: false } }]]),
    posts: new Map([[marker.recordId, { publiclyVisible: false, published: { sourceVersion: 7 } }]]) };
}
const options = () => ({ store, target, account: "unused-fixture-observer", commitSha: sha });
const current = async () => JSON.parse(await (await runtime.getR2Bucket("WITHDRAWALS")).get(key).then(value => value!.text()));
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "record-withdrawal-storage", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response('ok')}}" } } },
    env: { WITHDRAWALS: { type: "r2", name: "withdrawals" } } },
    dev: { outboundService: { type: "fetcher", handler: () => new Response(null, { status: 502 }) } } }] });
  await runtime.ready;
  store = await runtime.getR2Bucket("WITHDRAWALS") as unknown as CatalogStore;
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => { await (await runtime.getR2Bucket("WITHDRAWALS")).delete(key); });

it("retains namespace ownership and every withdrawn canonical, alias and shows path before completion", async () => {
  expect(await readDurableRecordAuthority(store, target.workerName, "/programs/example/")).toEqual({ owned: false, withdrawal: null });
  await publishRecordWithdrawalCatalog(options(), async () => observation());
  for (const path of observation().owners[0].ownedPaths) {
    expect(await readDurableRecordAuthority(store, target.workerName, path)).toMatchObject({ owned: true,
      withdrawal: { recordId: "program-one", operationId, revision: 3 } });
  }
  expect(await readDurableRecordAuthority(store, target.workerName, "/programs/")).toEqual({ owned: true, withdrawal: null });
  expect(await readDurableRecordAuthority(store, target.workerName, "/events/")).toEqual({ owned: false, withdrawal: null });
});
it("retains an earlier tombstone through newer visible publication and cancelled history", async () => {
  await publishRecordWithdrawalCatalog(options(), async () => observation());
  const before = await current(), next = observation();
  next.contextRevision = 4;
  next.owners[0] = { ...next.owners[0], operationId: "B".repeat(20), generation: 5, visible: true };
  next.queues.get(operationId)!.status = "cancelled";
  next.posts.set("program-one", { publiclyVisible: true, published: { sourceVersion: 8 } });
  await publishRecordWithdrawalCatalog(options(), async () => next);
  expect((await current()).withdrawals).toEqual(before.withdrawals);
  next.queues.get(operationId)!.recordPublication.visible = true;
  await expect(publishRecordWithdrawalCatalog(options(), async () => next)).rejects.toThrow();
  expect((await current()).withdrawals).toEqual(before.withdrawals);
});
it("reobserves a failed compare-and-swap and cannot overwrite a newer record removal", async () => {
  await publishRecordWithdrawalCatalog(options(), async () => observation());
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const stale = publishRecordWithdrawalCatalog({ ...options(), store: { get: key => store.get(key),
    async put(key, text, conditions) { ready(); await held; return store.put(key, text, conditions); } } }, async () => observation(4));
  const outcome = expect(stale).rejects.toThrow();
  await started; await publishRecordWithdrawalCatalog(options(), async () => observation(5));
  release(); await outcome;
  expect((await current()).withdrawals[0].revision).toBe(5);
});
it("cannot release an owned namespace even after its final record is removed", async () => {
  await publishRecordWithdrawalCatalog(options(), async () => observation());
  const next = observation(4); next.recordFamilies = []; next.owners = [];
  await expect(publishRecordWithdrawalCatalog(options(), async () => next)).rejects.toThrow();
  expect((await current()).families).toEqual(["programs"]);
});
it("keeps environment keys separate and rejects an unreadable catalog as unknown", async () => {
  expect(recordWithdrawalManifestKey("njpbs-production")).not.toBe(key);
  expect(() => recordWithdrawalManifestKey("unknown")).toThrow();
  await (await runtime.getR2Bucket("WITHDRAWALS")).put(key, "{}");
  await expect(readDurableRecordAuthority(store, target.workerName, "/programs/example/")).rejects.toThrow();
  const valid = { schemaVersion: 1, workerName: target.workerName, contextRevision: 3, families: ["programs"], withdrawals: [] };
  expect(validateRecordWithdrawalManifest(valid, target.workerName)).toEqual(valid);
  for (const patch of [{ families: ["events", "programs"] }, { families: ["programs", "programs"] }, { families: ["sponsors"] },
    { withdrawals: [{ recordId: "program-one", family: "events", operationId, sourceVersion: 7, revision: 3,
      ownedPaths: ["/programs/example/"], verifiedAt: 1234 }] }]) {
    expect(() => validateRecordWithdrawalManifest({ ...valid, ...patch }, target.workerName)).toThrow();
  }
});
it("never serves a withdrawn Record after its catalog becomes malformed", async () => {
  await publishRecordWithdrawalCatalog(options(), async () => observation());
  const valid = JSON.stringify(await current());
  const bucket = await runtime.getR2Bucket("WITHDRAWALS");
  for (const corrupt of ["{}", valid.slice(0, -1), valid.replace('"schemaVersion":1', '"schemaVersion":2'),
    valid.replace(target.workerName, "njpbs-production")]) {
    await bucket.put(key, corrupt);
    for (const ready of [true, false]) {
      const worker = createTransitionalPostReadWorker({ target, rendererSha: sha, rendererReady: true, recordRendererReady: ready,
        cache: { async match() { return undefined; }, async put() {} },
        readRecordAuthority: path => readDurableRecordAuthority(store, target.workerName, path),
        getDecision: async () => { throw new Error("Authority unavailable"); },
        render: async () => "", waitUntil: () => {}, fetchAsset: async () => new Response("Old withdrawn Assets") });
      for (const path of ["/programs/example/", "/programs/former/"]) for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(new Request(target.origin + path, { method }));
        expect(response?.status).toBe(503);
        expect(await response!.text()).not.toContain("Old withdrawn Assets");
      }
    }
  }
});
