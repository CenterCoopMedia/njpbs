import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import source from "../../functions/lib/no-build-record-source.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import media from "../../functions/lib/media-contract.js";
import replacements from "../../functions/lib/media-replacement.js";
import { recordDocument, asset, now } from "../../site/tests/fixtures/published-records/fixtures";
import { projectPublishedRecordRead } from "../../site/src/lib/published-record-render";

const sha = "a".repeat(40);
const app = initializeApp({ projectId: "njpbs-site-dev" }, "record-source-local-fixture");
const db = getFirestore(app);
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sha,
  activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release",
  newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" };
const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType,
  width: asset.width, height: asset.height, altText: "Public art", privateNote: "PRIVATE media note" };
function document(kind: "program" | "event", id = `${kind}-one`) {
  const value = recordDocument(kind, id);
  value.published = snapshots.createPublishedSnapshot({ collection: "cmsPosts",
    document: { ...value.published.metadata, version: 7 }, publishedBy: "PRIVATE editor UID",
    publishedAt: "2026-10-10T12:00:00.000Z" });
  return { ...value, privateNote: "PRIVATE working note" };
}
function read(family = "programs", options = {}) {
  return db.runTransaction(transaction => source.readPendingRecordFamilyInTransaction({
    firestore: db, transaction, family, rendererSha: sha, now, ...options }), { readOnly: true });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator.");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await Promise.all([
    db.doc("system/publicDeployment").set(pointer),
    db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 }),
    db.doc("media_assets/record-art").set(art),
    db.doc("media_assets_public/record-art").set(media.mediaProjection(art)),
  ]);
});
afterAll(async () => { await deleteApp(app); });

it.each(["program", "event"] as const)("projects the immutable %s family without working fields or actors", async kind => {
  const value = document(kind);
  await db.doc(`cmsPosts/${kind}-one`).set(value);
  const family = kind === "program" ? "programs" : "events";
  const pending = await read(family);
  expect(pending.read).toMatchObject({ kind: "published-record-family", family, complete: true,
    documents: [{ id: `${kind}-one`, version: 7, published: { metadata: { title: `Published ${kind}` } } }],
    sourceSeal: { contextRevision: 4, rendererSha: sha } });
  expect(pending.sources[0]).toMatchObject({ documentId: `${kind}-one`, sourceVersion: 7 });
  expect(JSON.stringify(pending.read)).not.toContain("PRIVATE");
  expect(JSON.stringify(pending.read)).not.toContain("publishedBy");
  const projected = await projectPublishedRecordRead(pending.read, `/${family}/current-${kind}-one/`, sha, now);
  expect(projected?.target).toMatchObject({ documentId: `${kind}-one`, sourceVersion: 7 });
  expect(kind === "program" ? projected?.programs[0].keyArt?.url : projected?.events[0].image?.url).toBe(asset.url);
  const first = JSON.stringify(pending.read);
  await db.doc(`cmsPosts/${kind}-one`).update({ title: "PRIVATE later draft", version: 10 });
  expect(JSON.stringify((await read(family)).read)).toBe(first);
});

it("keeps families separate and provides a complete empty roster", async () => {
  await db.doc("cmsPosts/event-one").set(document("event"));
  expect((await read()).read.documents).toEqual([]);
  expect((await read()).sources).toEqual([]);
  expect((await read("events")).read.documents).toHaveLength(1);
});

it.each([
  { publiclyVisible: false }, { deleted: true },
  { status: "published", publishAt: "2027-01-01T00:00:00.000Z" },
])("omits records the existing build visibility and clock exclude: %j", async patch => {
  await db.doc("cmsPosts/program-one").set({ ...document("program"), ...patch });
  expect((await read()).read.documents).toEqual([]);
});

it("refuses canonical and retained-slug collisions before prospective acceptance", async () => {
  await db.doc("cmsPosts/program-one").set(document("program"));
  const next = document("program", "program-two");
  next.published.metadata.previousSlugs = ["earlier-program-one"];
  await expect(read("programs", { nextDocument: next, documentId: "program-two" })).rejects.toThrow("routes collide");
  const unchanged = await db.doc("cmsPosts/program-two").get();
  expect(unchanged.exists).toBe(false);
});

it("validates a new prospective Program in the same full family roster", async () => {
  const next = document("program");
  const result = await read("programs", { nextDocument: next, documentId: "program-one" });
  expect(result.sources.map(entry => entry.documentId)).toEqual(["program-one"]);
  expect(result.read.documents).toHaveLength(1);
  expect((await db.doc("cmsPosts/program-one").get()).exists).toBe(false);
});

it.each([{ version: 6 }, { publicSourceVersion: 8 }, { publicSourceVersion: "7" }])(
  "refuses an inconsistent immutable source floor: %j", async patch => {
    await db.doc("cmsPosts/program-one").set({ ...document("program"), ...patch });
    await expect(read()).rejects.toThrow("source version");
  });

it("refuses a release mismatch and invalid family before returning preparation input", async () => {
  await expect(read("programs", { rendererSha: "b".repeat(40) })).rejects.toThrow("code release");
  await expect(read("posts")).rejects.toThrow("Invalid family");
  await expect(read("programs", { now: new Date("bad") })).rejects.toThrow("Invalid family");
});

it("refuses a process environment that differs from its database", async () => {
  const previous = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
  try {
    process.env.CMS_DEPLOYMENT_ENVIRONMENT = "production";
    await expect(read()).rejects.toThrow("publication environment differs");
  } finally {
    if (previous === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT;
    else process.env.CMS_DEPLOYMENT_ENVIRONMENT = previous;
  }
});

it("refuses pending replacements, absent private media and stale public media", async () => {
  await db.doc("cmsPosts/program-one").set(document("program"));
  const lock = replacements.mediaReplacementRef(db, asset.id);
  await lock.set({ status: "pending" });
  await expect(read()).rejects.toThrow("replacement");
  await lock.delete();
  await db.doc("media_assets_public/record-art").update({ url: "https://media.njpbs.org/wrong.gif" });
  await expect(read()).rejects.toThrow("public projection");
  await db.doc("media_assets_public/record-art").set(media.mediaProjection(art));
  await db.doc("media_assets/record-art").delete();
  await expect(read()).rejects.toThrow("cannot enter public content");
});

it("requires the current deployment lifecycle fence for uploaded art", async () => {
  await db.doc("cmsPosts/program-one").set(document("program"));
  await db.doc("media_assets/record-art").update({ source: "upload" });
  await expect(read()).rejects.toThrow();
  await db.doc("system/publicDeployment").update({ mediaLifecycleReady: true });
  expect((await read()).read.assets[0].url).toBe(asset.url);
});

it("refuses an over-limit family instead of returning a partial roster", async () => {
  // The compiled family contract admits at most 1,000 records. Include retained
  // invisible rows: a truncated query cannot establish complete ownership.
  for (let start = 0; start < 1001; start += 500) {
    const batch = db.batch();
    for (let index = start; index < Math.min(start + 500, 1001); index++) {
      batch.set(db.doc(`cmsPosts/retained-${index}`), { publiclyVisible: false, published: { metadata: { type: "program" } } });
    }
    await batch.commit();
  }
  await expect(read()).rejects.toThrow("family exceeds the input limit");
});
