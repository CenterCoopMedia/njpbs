import { beforeAll, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { serializerPublishingControl } from "../../scripts/serializer-publishing-control.mjs";
const require = createRequire(import.meta.url);
const { db } = require("../../functions/lib/firebase.js");
const policy = require("../../functions/lib/serializer-publication-control.js");
const { enqueueSerializerBuild } = require("../../functions/lib/cms-publish-serializer-queue.js");
const { readFrozenLibraryPublicationMessage } = require("../../functions/lib/frozen-library-publication.js");
const runtime = require("../../functions/lib/cms-publication-runtime-control.js");
const release = "a".repeat(40), actor = { uid: "fixture-publisher", email: "editor@example.test" };
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo Firestore only");
});
beforeEach(async () => {
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await Promise.all(["cmsPublishQueue", "cmsPosts", "admin_logs"].map(name => db.recursiveDelete(db.collection(name))));
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" } });
});
const read = () => db.runTransaction(transaction => policy.assertSerializerPublicationEnabledInTransaction({
  firestore: db, transaction,
}), { readOnly: true });
const enqueue = extra => enqueueSerializerBuild({ firestore: db, actor, changes: [], source: "fixture", ...extra });
it("keeps current legacy admission when the marker is missing", async () => {
  expect(await read()).toEqual({ schemaVersion: 1, enabled: true });
  expect((await enqueue()).status).toBe("pending");
});
it("refuses new serializer queues when disabled despite the ready primary pin", async () => {
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  await expect(enqueue()).rejects.toThrow("The full-site build was retired on October 13, 2026. This change has no build-free publication path yet.");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
it("keeps an exact reserved job claimable without changing its accepted identity", async () => {
  const queueId = "R".repeat(20), changes = [];
  await db.doc(`cmsPublishQueue/${queueId}`).set({ status: "reserved", transport: "serializer", triggeredBy: actor.uid,
    triggeredByEmail: actor.email, changes });
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  expect((await enqueue({ queueId, queueReserved: true, changes })).status).toBe("pending");
  expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()).toMatchObject({ triggeredBy: actor.uid, changes });
});
it.each([{ schemaVersion: 2, enabled: true }, { schemaVersion: 1, enabled: "true" }])("refuses malformed marker %j before enqueue", async marker => {
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set(marker);
  await expect(enqueue()).rejects.toThrow("Publication control is unavailable");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
it.each([
  ["program", "since the full-site build was retired on October 13, 2026"],
  ["event", "since the full-site build was retired on October 13, 2026"],
  ["sponsor", "Use Approve to publish this Sponsor card. It has no detail page and cannot be scheduled."],
  ["newsletter", "Use Approve to publish this Newsletter card. It has no detail page and cannot be scheduled."],
])("refuses routed %s publication while the ready primary's serializer is disabled", async (type, message) => {
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  expect(await db.runTransaction(transaction => readFrozenLibraryPublicationMessage({ firestore: db, transaction,
    collection: "cmsPosts", document: { type },
  }), { readOnly: true })).toContain(message);
});
it("keeps cloud runtime admission independent of the serializer switch", async () => {
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  const control = await db.runTransaction(transaction => runtime.readCmsPublicationRuntimeControlInTransaction({ firestore: db, transaction }),
    { readOnly: true });
  expect(runtime.assertCmsPublicationCloudAdmission(control, { commitSha: release, serializerId: "cloudflare-publisher" }).phase).toBe("ready");
});
it("reads without changing the marker, then disables it and reports safe before/after values", async () => {
  expect(await serializerPublishingControl({ firestore: db })).toEqual({ applied: false, before: null, after: null });
  expect((await db.doc(policy.SERIALIZER_CONTROL_PATH).get()).exists).toBe(false);
  expect(await serializerPublishingControl({ firestore: db, apply: true })).toEqual({ applied: true, before: null,
    after: { schemaVersion: 1, enabled: false } });
});
it("refuses a new retry reservation while leaving an existing exact reservation resumable", async () => {
  const { reservePublicationRetry } = require("../../functions/lib/publication-recovery.js");
  const changes = [{ collection: "cmsPosts", id: "retained-post", sourceVersion: 1 }];
  const principal = { ...actor, principal: { id: actor.uid, grants: [{ role: "admin" }] } };
  await db.doc("cmsPosts/retained-post").set({ type: "post", section: "news", createdBy: actor.uid, status: "published",
    version: 1, publiclyVisible: true, published: { sourceVersion: 1 } });
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  const retry = () => reservePublicationRetry({ firestore: db, actor: principal, changes,
    baseVersion: 1, source: "fixture", transport: "serializer" });
  await expect(retry()).rejects.toThrow("The full-site build was retired on October 13, 2026. This change has no build-free publication path yet.");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  const queueId = "Q".repeat(20);
  await db.doc(`cmsPublishQueue/${queueId}`).set({ status: "reserved", transport: "serializer", changes,
    triggeredBy: actor.uid, triggeredByEmail: actor.email });
  await db.doc("cmsPosts/retained-post").update({ publishBuildQueueId: queueId });
  expect(await retry()).toMatchObject({ queueId, reserved: true, existing: true });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});
it("refuses a new legacy withdrawal safety reservation while serializer publishing is disabled", async () => {
  const { preparePostWithdrawalBuild } = require("../../functions/lib/transitional-post-withdrawal.js");
  await db.doc(policy.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  await expect(db.runTransaction(transaction => preparePostWithdrawalBuild({ firestore: db, transaction, actor,
    operationId: "P".repeat(20), runtime: { owner: "cloudflare", release },
    change: { collection: "cmsPosts", id: "retained-post", sourceVersion: 1, operation: "withdraw" },
  }))).rejects.toThrow("This Post's public removal needs a background repair that the retired full-site build used to do.");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
