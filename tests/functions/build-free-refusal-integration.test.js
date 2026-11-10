import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, expect, it } from "vitest";
import "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import admission from "../../functions/lib/no-build-post-admission.js";
import control from "../../functions/lib/serializer-publication-control.js";
const db = isolatedFirestore("build-free-refusal-integration.test.js");

// The full build is retired, so every refusal here must name its cause and
// leave the record, the queue and the audit log untouched.
const sha = "a".repeat(40);
const now = "2026-10-13T23:00:00.000Z";
const actor = { uid: "sweep-editor", email: "editor@example.test", principal: { id: "sweep-editor", grants: [{ role: "admin" }] } };
const quiet = { info() {}, warn() {}, error() {} };
const offlineBuild = async () => { throw new Error("The full-build transport is offline"); };
const divider = { id: "divider-1", type: "divider", order: 0, visible: true, data: {} };
const embed = { id: "embed-1", type: "embed", order: 1, visible: true, data: { url: "https://example.test/embed" } };
const post = id => ({ id, type: "post", title: `Sweep ${id}`, status: "draft", section: "news", slug: `${id}-story`, date: "2026-10-11",
  locale: "en", previousSlugs: [], version: 1, createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [divider, embed] });
// Both blocks publish now (#3416). A copied legacy Home card remains a real
// refusal, and the acceptance owner supplies its exact message.
const legacyHomeCard = () => db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: {}, blocks: [
  { id: "legacy", visible: true, type: "prose", data: { html: '<a href="/posts/first-story">Copied story</a>' } }] } });
const pointer = () => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
  activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
  lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
async function invoke(handler, body) {
  const response = { code: 200, headersSent: false, status(code) { this.code = code; return this; },
    set() { return this; }, json(value) { this.body = value; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, response);
  return response;
}
const saveHandler = () => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor, now: () => now,
  enablePublishSnapshot: true, assertPublishReadyFn: offlineBuild, log: quiet });
const transitionHandler = () => lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
  now: () => now, log: quiet });
async function untouched(path, before) {
  expect((await db.doc(path).get()).data()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
  expect((await db.collection("admin_logs").get()).size).toBe(0);
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use a local demo Firestore emulator");
  }
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  // Page admission needs the environment bucket; a never-owned Page withdrawal
  // never reaches selection, so only the Post family is admitted here.
  await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 6, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await db.doc(postOwnership.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
  await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  await db.doc("system/publicDeployment").set(pointer());
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc(control.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: false });
  await db.doc("sections/news").set({ label: "News" });
});

it("preserves the legacy Home card reason when refusing a Post publish", async () => {
  await legacyHomeCard();
  await db.doc("cmsPosts/first").set(post("first"));
  const before = (await db.doc("cmsPosts/first").get()).data();
  const result = await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 1, publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error).toBe(
    "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again.");
  await untouched("cmsPosts/first", before);
});
it("refuses the same Post at schedule time instead of at its due time", async () => {
  await legacyHomeCard();
  await db.doc("cmsPosts/first").set(post("first"));
  const before = (await db.doc("cmsPosts/first").get()).data();
  const result = await invoke(saveHandler(), { collection: "cmsPosts", id: "first", baseVersion: 1,
    scheduleAt: "2026-10-14T12:00:00.000Z", document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error).toBe(
    "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again.");
  await untouched("cmsPosts/first", before);
});
it("tells staff to publish a never-owned live Page once before it can be unpublished", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages",
    document: { id: "about", version: 1, title: "About", blocks: [] }, publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: actor.uid });
  await db.doc("cmsPages/about").set({ id: "about", version: 1, status: "published", publiclyVisible: true, title: "About",
    blocks: [], published });
  const before = (await db.doc("cmsPages/about").get()).data();
  const result = await invoke(transitionHandler(), { collection: "cmsPages", id: "about", baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error).toBe(
    "This Page was last published by the retired full-site build, so the new publisher does not own its address yet. Publish it once, then unpublish it.");
  await untouched("cmsPages/about", before);
});
it.each(["program", "event"])("refuses a %s unpublish by naming the kind and what stays live", async type => {
  const document = { id: type, type, title: `Existing ${type}`, version: 1, status: "published", publiclyVisible: true, deleted: false,
    createdBy: actor.uid, published: { sourceVersion: 1, publishedAt: "2026-10-01T12:00:00.000Z",
      metadata: { type, title: `Existing ${type}` }, blocks: [] } };
  await db.doc(`cmsPosts/${type}`).set(document);
  const result = await invoke(transitionHandler(), { collection: "cmsPosts", id: type, baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  const label = type === "program" ? "Program" : "Event";
  expect(result.body.error).toBe(
    `${label} records cannot publish or unpublish since the full-site build was retired on October 13, 2026. Live ${type} pages stay as they are. Ask an administrator.`);
  await untouched(`cmsPosts/${type}`, document);
});
it("retains frozen-kind withdrawal when the serializer is enabled with a cloud primary", async () => {
  await db.doc(control.SERIALIZER_CONTROL_PATH).set({ schemaVersion: 1, enabled: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "cloudflare-publisher" });
  // This record is outside Post admission, as in the serializer-owned main path.
  await db.doc(admission.ADMISSION_PATH).update({ families: { posts: { mode: "ids", ids: ["first"] } } });
  await db.doc("cmsPosts/program").set({ id: "program", type: "program", title: "Existing program", version: 1,
    status: "published", publiclyVisible: true, deleted: false, createdBy: actor.uid,
    published: { sourceVersion: 1, publishedAt: "2026-10-01T12:00:00.000Z",
      metadata: { type: "program", title: "Existing program" }, blocks: [] } });
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => now, log: quiet, enqueuePublishBuildFn: async ({ changes }) => {
      const queueId = "frozen-withdrawal";
      await db.doc(`cmsPublishQueue/${queueId}`).set({ transport: "serializer", changes });
      return { queueId };
    } });
  const result = await invoke(handler, { collection: "cmsPosts", id: "program", baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect((await db.doc("cmsPosts/program").get()).data()).toMatchObject({ status: "draft", publiclyVisible: false, version: 2 });
  const queue = (await db.collection("cmsPublishQueue").get()).docs;
  expect(queue).toHaveLength(1);
  expect(queue[0].data().changes).toEqual([{ collection: "cmsPosts", id: "program", sourceVersion: 1, operation: "withdraw" }]);
});
