import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";

const requireModule = createRequire(import.meta.url);
const { assertMediaLifecycleFenceInTransaction, PublicDeploymentFenceError } = requireModule("../../functions/lib/public-deployment-pointer.js");
const { assertPublishedMediaSafe } = requireModule("../../functions/lib/published-media-safety.js");

let db: Firestore;
const POINTER = { schemaVersion: 1, mediaLifecycleReady: true, state: "idle", activeGeneration: 7,
  activeDeploymentId: "44444444-4444-4444-8444-444444444444", activeCommitSha: "b".repeat(40),
  lastReservedGeneration: 9, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "cms-active" };
const batch = (generation: number, status: string) =>
  db.doc(`system/publicDeployment/buildBatches/cms-${generation}`).set({ buildBatchId: `cms-${generation}`, generation, status });
const fence = (pointer: Record<string, unknown> = POINTER, transactional = true) => transactional
  ? db.runTransaction(transaction => assertMediaLifecycleFenceInTransaction({ firestore: db, transaction, pointer }))
  : assertMediaLifecycleFenceInTransaction({ firestore: db, pointer });

beforeAll(() => { db = isolatedFirestore("media-fence-ended-reservation.test.ts") as unknown as Firestore; });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await batch(7, "deployed");
});

it.each(["failed", "superseded", "cancelled", "retired"])("opens when every reservation above the active release ended (%s)", async status => {
  await batch(8, "retired");
  await batch(9, status);
  for (const transactional of [true, false]) {
    expect(await fence(POINTER, transactional)).toEqual({ generation: 7, deploymentId: POINTER.activeDeploymentId, commitSha: POINTER.activeCommitSha });
  }
});

it.each(["reserved", "ready", "deploying", "reconciling", "deployed"])("stays closed while a reservation is %s", async status => {
  await batch(8, "failed");
  await batch(9, status);
  await expect(fence()).rejects.toBeInstanceOf(PublicDeploymentFenceError);
});

it("stays closed for a missing reservation, a newer eligible release or lifecycle not ready", async () => {
  await batch(9, "failed");
  await expect(fence()).rejects.toBeInstanceOf(PublicDeploymentFenceError);
  await batch(8, "failed");
  await expect(fence({ ...POINTER, newestEligibleGeneration: 9, newestEligibleBuildBatchId: "cms-9" })).rejects.toBeInstanceOf(PublicDeploymentFenceError);
  await expect(fence({ ...POINTER, mediaLifecycleReady: false })).rejects.toBeInstanceOf(PublicDeploymentFenceError);
  await batch(10, "failed");
  await expect(fence()).rejects.toBeInstanceOf(PublicDeploymentFenceError);
});

it("lets the site-wide check before every publish pass after a release ended, not while one is in flight", async () => {
  await db.doc("system/publicDeployment").set(POINTER);
  await db.doc("media_assets/upload-one").set({ lifecycle: "active", source: "upload", mimeType: "image/webp", width: 1600, height: 900,
    url: "https://media.njpbs.org/cms-media/news/upload-one/hash.webp", altText: "Studio" });
  await db.doc("media_assets_public/upload-one").set({ url: "https://media.njpbs.org/cms-media/news/upload-one/hash.webp", altText: "Studio",
    mimeType: "image/webp", width: 1600, height: 900 });
  await db.doc("cmsPosts/image-post").set({ status: "published", publishAt: "2026-11-01T12:00:00.000Z",
    published: { metadata: { type: "post", heroImage: "upload-one" }, sourceVersion: 1, blocks: [] } });
  await batch(8, "failed");
  await batch(9, "reserved");
  await expect(assertPublishedMediaSafe({ firestore: db })).rejects.toThrow(/upload-one cannot enter public content/);
  await batch(9, "retired");
  await expect(assertPublishedMediaSafe({ firestore: db })).resolves.toMatchObject({ assetCount: 1 });
});

it("passes a failed batch read through instead of reporting a closed fence", async () => {
  await db.doc("system/publicDeployment").set(POINTER);
  await db.doc("media_assets/upload-one").set({ lifecycle: "active", source: "upload" });
  await db.doc("cmsPosts/image-post").set({ status: "published", publishAt: "2026-11-01T12:00:00.000Z",
    published: { metadata: { type: "post", heroImage: "upload-one" }, sourceVersion: 1, blocks: [] } });
  const unavailable = Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
  const firestore = new Proxy(db, { get: (target, key) => key !== "collection" ? Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key)
    : (path: string) => path === "system/publicDeployment/buildBatches"
      ? { where: () => ({ orderBy: () => ({ get: () => Promise.reject(unavailable) }) }) }
      : target.collection(path) });
  await expect(assertPublishedMediaSafe({ firestore })).rejects.toBe(unavailable);
});
