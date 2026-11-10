import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("../../functions/lib/firebase.js");
const db = isolatedFirestore("scheduler-frozen-pending-integration.test.js");
const { createScheduledPublishRunner, MAX_SCHEDULED_CANDIDATE_READS_PER_RUN } = require("../../functions/scheduled-publish.js");
const ownership = require("../../functions/lib/no-build-post-ownership.js");
const deployment = require("../../functions/lib/public-deployment.js");
const release = "a".repeat(40), postId = "pilot-post", instant = "2026-10-13T12:00:00.000Z";
const failures = [];
const quiet = { error(message, details) { failures.push({ message, detail: details?.detail }); }, warn() {}, info() {} };

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo Firestore only");
});
beforeEach(async () => {
  failures.length = 0;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: release,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
  batch.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  batch.set(db.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  batch.set(db.doc(ownership.CAPABILITY_PATH), { schemaVersion: 2, rendererSha: release,
    servingEnabled: true, generation: 1 });
  batch.set(db.doc(`cmsPosts/${postId}`), { id: postId, type: "post", title: "Due cloud story", status: "scheduled",
    publishAt: "2026-10-13T11:00:00.000Z", section: "news", slug: "due-cloud-story", previousSlugs: [],
    date: "2026-10-12", locale: "en", version: 1, createdBy: "fixture-editor", tags: [], categories: [], credits: [], blocks: [] });
  batch.set(db.doc("sections/news"), { label: "News" });
  await batch.commit();
});

it.each(["frozen library", "disabled serializer"])("publishes due cloud content past a capped %s pending backlog without rewriting accepted rows", async mode => {
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: mode === "frozen library" ? "paused" : "ready",
    commitSha: "b".repeat(40), serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" } });
  if (mode === "disabled serializer") await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
  const accepted = Array.from({ length: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN }, (_, index) => {
    const id = `blocked-${String(index).padStart(3, "0")}`, type = mode === "frozen library" ? "program" : "post";
    return { id, type, title: "Retained accepted copy", version: 4, status: "published", publiclyVisible: true,
      publishBuildPending: true, publishBuildQueueId: null,
      published: { sourceVersion: 3, publishedAt: "2026-10-10T12:00:00.000Z", metadata: { type, title: "Retained accepted copy", slug: id }, blocks: [] } };
  });
  const batch = db.batch(); for (const row of accepted) batch.set(db.doc(`cmsPosts/${row.id}`), row); await batch.commit();
  const run = createScheduledPublishRunner({ firestore: db, now: () => instant,
    assertPublishReadyFn: async () => { throw new Error("Cloud work must not require the stopped serializer"); },
    enqueuePublishFn: async () => { throw new Error("Cloud work must not dispatch a legacy batch"); }, log: quiet });
  const result = await run();
  expect(result.publishedCount, JSON.stringify({ failures, dueFailure: (await db.doc(`cmsPosts/${postId}`).get()).data().scheduledPublishFailure })).toBe(1);
  expect(result.changes).toEqual([{ collection: "cmsPosts", id: postId, sourceVersion: 2 }]);
  const owned = (await ownership.readNoBuildPostOwner({ firestore: db, postId })).state;
  const queues = await db.collection("cmsPublishQueue").get();
  expect(queues.size).toBe(1);
  expect(queues.docs[0].id).toBe(owned.operationId);
  expect(queues.docs[0].data()).toMatchObject({ transport: "post-no-build-v1", backgroundRuntime: { owner: "cloudflare", release } });
  expect((await db.doc(`cmsPosts/${postId}`).get()).data()).toMatchObject({ status: "published", published: { sourceVersion: 2 } });
  const retained = await db.getAll(...accepted.map(row => db.doc(`cmsPosts/${row.id}`)));
  expect(retained.map(row => row.data())).toEqual(accepted);
});
