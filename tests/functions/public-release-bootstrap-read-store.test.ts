import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { initialPublicReleaseControlsFixture } from "../helpers/initial-public-release-controls";
import { createBootstrapReadStore } from "../../site/scripts/public-release-bootstrap-read-store";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";

let app: App, firestore: Firestore, r2: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
let f: Awaited<ReturnType<typeof initialPublicReleaseControlsFixture>>;
const bytes = new TextEncoder().encode('{"immutable":"bootstrap fixture"}'), digest = createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the loopback demo emulator");
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development"); app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-store"); firestore = getFirestore(app);
  r2 = await publicReleaseR2Fixture("bootstrap-read-store");
});
afterAll(async () => { await r2?.runtime.dispose(); if (app) await deleteApp(app); vi.unstubAllEnvs(); });
beforeEach(async () => {
  for (const collection of ["system", "cmsDeploymentReceipts", "cmsReaderCompatibilityReceipts", "admin_logs"]) await firestore.recursiveDelete(firestore.collection(collection));
  f = await initialPublicReleaseControlsFixture(firestore);
});
function keys(pair = f.pair) {
  return [`release-pair-inputs/v2/${pair.pairId}/objects/${digest}.json`, `release-pair-inputs/v2/${pair.pairId}/manifests/${digest}.json`,
    `release-pairs/${pair.pairId}/${"a".repeat(64)}/claims/${"b".repeat(64)}/objects/${digest}`,
    `release-pair-replay/v2/${p.publicReleaseDigest(pair)}/pages/${digest}.json`,
    `release-pair-replay/v2/${p.publicReleaseDigest(pair)}/selections/${digest}.json`,
    `release-pair-qualifications/v1/${p.publicReleaseDigest(pair)}/${"c".repeat(64)}/roots/${digest}.json`,
    `release-pair-qualifications/v1/${p.publicReleaseDigest(pair)}/${"c".repeat(64)}/pages/${digest}.json`];
}
async function seedObjects() {
  for (const pair of [f.pair, f.recoveryPair]) for (const key of keys(pair))
    await r2.store.put(key, bytes, { customMetadata: { pairdigest: p.publicReleaseDigest(pair), bodydigest: digest } });
}
function wrapper() {
  const get = vi.fn(r2.store.get.bind(r2.store));
  return { get, store: createBootstrapReadStore({ firestore, attempt: f.attempt, objects: { get }, enabled: true }) };
}
it.each(["schema-one", "epoch-one"])("reads both pairs' immutable namespaces under %s authority with real SDK/R2", async mode => {
  await seedObjects(); if (mode === "epoch-one") await f.convert();
  const { get, store } = wrapper();
  for (const pair of [f.pair, f.recoveryPair]) for (const key of keys(pair)) {
    const object = await store.get(key); expect(object?.size).toBe(bytes.length);
    expect(await new Response(object!.body).text()).toBe(new TextDecoder().decode(bytes));
    expect(object!.customMetadata).toEqual({ pairdigest: p.publicReleaseDigest(pair), bodydigest: digest });
  }
  expect(get).toHaveBeenCalledTimes(14);
  expect((await firestore.doc("system/publicReleaseAdmissions/controls/bootstrapFence").get()).data()!.status).toBe("closed");
});
it("defaults off and refuses writes or unsupported keys with zero object calls", async () => {
  const { get, store } = wrapper(), off = createBootstrapReadStore({ firestore, attempt: f.attempt, objects: { get } });
  await expect(off.get(keys()[0])).rejects.toThrow();
  await expect(store.put(keys()[0], bytes, {} as any)).rejects.toThrow();
  for (const key of ["public/latest.json", "release-pairs/", keys()[0] + "?list=true", keys()[0].replace(digest, "bad"),
    keys()[0].replace(f.pair.pairId, "foreign:pair"), "../" + keys()[0]]) await expect(store.get(key)).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
it.each(["fence", "writer", "controls", "enrollment", "source", "pins", "producer", "adoption", "pair", "billing"])("refuses %s drift before any object read", async fault => {
  if (fault === "fence") await firestore.doc("system/publicReleaseAdmissions/controls/bootstrapFence").update({ status: "open" });
  if (fault === "writer") await firestore.doc("system/publicDeployment/releaseWriter/fence").delete();
  if (fault === "controls") await firestore.doc(`system/publicReleaseAdmissions/bootstrapControls/${f.attempt.operationId}`).delete();
  if (fault === "enrollment") await firestore.doc("system/publicReleaseChanges/enrollment/initial").delete();
  if (fault === "source") await firestore.doc("cmsDeploymentReceipts/functions").update({ state: "in_progress" });
  if (fault === "pins") await firestore.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  if (fault === "producer") await firestore.doc("system/publicReleaseChangeLog").update({ enabled: true });
  if (fault === "adoption") await firestore.doc("system/publicReleaseAdmissions/controls/adoption").update({ enabled: true });
  if (fault === "pair") await firestore.doc(`${work.publicReleasePairPath(f.recoveryPair.pairId)}/controls/runtime`).update({ status: "retired" });
  if (fault === "billing") await firestore.doc("system/billing").set({ disabled: true });
  const { get, store } = wrapper(); await expect(store.get(keys()[0])).rejects.toThrow(); expect(get).not.toHaveBeenCalled();
});
it("rechecks closed authority after the actual object GET and refuses drift", async () => {
  await seedObjects();
  const get = vi.fn(async (key: string) => { const object = await r2.store.get(key);
    await firestore.doc("system/publicReleaseAdmissions/controls/adoption").update({ enabled: true }); return object; });
  const store = createBootstrapReadStore({ firestore, attempt: f.attempt, objects: { get }, enabled: true });
  await expect(store.get(keys()[0])).rejects.toThrow(); expect(get).toHaveBeenCalledTimes(1);
});
it.each(["size", "metadata", "hash"])("refuses object %s mismatch without returning bytes", async fault => {
  const cancel = vi.fn(), metadata = vi.fn(() => ({ pairdigest: p.publicReleaseDigest(f.pair), bodydigest: fault === "metadata" ? "a".repeat(64) : digest }));
  const get = vi.fn(async () => ({ size: fault === "size" ? 16 * 1024 * 1024 + 1 : 1,
    get customMetadata() { return metadata(); }, body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([0])); if (fault === "hash") controller.close();
    }, cancel }) }));
  const store = createBootstrapReadStore({ firestore, attempt: f.attempt, objects: { get }, enabled: true, signal: AbortSignal.timeout(1000) });
  await expect(store.get(keys()[0])).rejects.toThrow("Bootstrap immutable storage read was refused");
  expect(cancel).toHaveBeenCalledTimes(fault === "hash" ? 0 : 1);
  if (fault === "size") expect(metadata).not.toHaveBeenCalled();
});
it.each(["before", "after-hit", "after-miss"])("bounds a stalled real SDK authority response %s the object read", async point => {
  await seedObjects();
  let release!: () => void, started!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { started = resolve; });
  const database = new Proxy(firestore, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const number = ++reads, result = await (target.runTransaction.bind(target) as any)(...args);
      if (number === (point === "before" ? 1 : 2)) { started(); await held; }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const get = vi.fn(async (key: string) => point === "after-miss" ? null : r2.store.get(key)), controller = new AbortController();
  const store = createBootstrapReadStore({ firestore: database, attempt: f.attempt, objects: { get }, enabled: true, signal: controller.signal });
  const result = store.get(keys()[0]);
  await observed;
  const abort = setTimeout(() => controller.abort(), 100);
  let expired: ReturnType<typeof setTimeout> | undefined;
  try {
    const ceiling = new Promise<never>((_resolve, reject) => { expired = setTimeout(() => reject(new Error("SDK read still pending after caller deadline")), 500); });
    await expect(Promise.race([result, ceiling])).rejects.toThrow("Private pair read deadline");
    expect(get).toHaveBeenCalledTimes(point === "before" ? 0 : 1);
  } finally { clearTimeout(abort); if (expired) clearTimeout(expired); release(); }
});
it("bounds a stalled object GET, forwards its signal and cancels a late returned body", async () => {
  let started!: () => void, release!: () => void, canceled!: () => void;
  const observed = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const cancellation = new Promise<void>(resolve => { canceled = resolve; }), controller = new AbortController();
  let propagated: AbortSignal | undefined;
  const objects = { get: vi.fn(), getWithSignal: vi.fn(async (_key: string, signal: AbortSignal) => {
    propagated = signal; started(); await held;
    return { size: 0, customMetadata: {}, body: new ReadableStream<Uint8Array>({ cancel() { canceled(); } }) };
  }) };
  const store = createBootstrapReadStore({ firestore, attempt: f.attempt, objects, enabled: true, signal: controller.signal });
  const result = store.get(keys()[0]); await observed; controller.abort();
  await expect(result).rejects.toThrow("Private pair read deadline"); expect(propagated?.aborted).toBe(true); expect(objects.get).not.toHaveBeenCalled();
  release(); await cancellation; expect(objects.getWithSignal).toHaveBeenCalledTimes(1);
});
