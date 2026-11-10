import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import "../../functions/lib/firebase.js";
import settings from "../../functions/settings.js";
import legacyPublish from "../../functions/publish.js";
import publication from "../../functions/lib/settings-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import deployment from "../../functions/lib/public-deployment.js";
import aggregatePublication from "../../functions/lib/public-context-publication.js";
import { DEFAULT_SITE_NAVIGATION, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS } from "../../packages/content-core/src/cms-settings";
const db = isolatedFirestore("settings-publication.test.js");

const sha = "a".repeat(40);
const actor = { uid: "settings-fixture", principal: { id: "settings-fixture", grants: [{ role: "admin" }] } };
const fixtures = {
  "site-navigation": DEFAULT_SITE_NAVIGATION,
  "public-site-chrome": DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  "public-homepage-banner": DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
};
const log = { error: vi.fn(), warn: vi.fn() };
const deps = () => ({ firestore: db, requirePrincipalFn: async () => actor, log });
async function call(handler, body) {
  const response = { code: 200, headersSent: false, set() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, response);
  return response;
}
const publish = (id, baseVersion) => call(settings.createCmsPublishSettingsHandler(deps()), {
  id, baseVersion, publicationTransport: "public-context-no-build-v1",
});
const get = id => call(settings.createCmsGetSettingsHandler(deps()), { id });
const queues = () => db.collection("cmsPublishQueue").get();
const currentRevision = async () => (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision;

async function retryState(queueId) {
  const collections = ["cmsSettings", "cmsPublishQueue", "cmsBackgroundOutputs", "cmsVersionHistory", "admin_logs",
    `cmsPublishQueue/${queueId}/backgroundOutputs`, `cmsPublishQueue/${queueId}/backgroundPreparation`];
  const groups = await Promise.all(collections.map(path => db.collection(path).get()));
  const system = await db.getAll(db.doc("system/publicDeployment"), db.doc(context.PUBLIC_CONTEXT_PATH),
    db.doc(aggregatePublication.CURRENT_PATH), db.doc("system/cmsPublicationRuntime"));
  return [...groups.flatMap(group => group.docs), ...system].map(row => ({
    path: row.ref.path, data: row.data(), updateTime: row.updateTime,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator");
});
beforeEach(async () => {
  vi.clearAllMocks();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeCommitSha: sha, activeDeploymentId: "fixture-deployment", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build", mediaLifecycleReady: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  for (const [id, values] of Object.entries(fixtures)) {
    await db.doc(`cmsSettings/${id}`).set({ schemaVersion: 1, values, version: 1 });
  }
});

describe("atomic public settings acceptance", () => {
  it.each(["ready", "paused", "starting"].flatMap(phase => Object.keys(fixtures).map(id => ({ phase, id }))))(
    "publishes $id through the ready cloud pin while the primary publisher is $phase", async ({ phase, id }) => {
      await db.doc("system/cmsPublicationRuntime").update({ phase });
      await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
      const result = await publish(id, 1);
      expect(result.code, JSON.stringify(result.body)).toBe(200);
      expect(result.body.publication).toMatchObject({ status: "pending", transport: "public-context-no-build-v1", rendererSha: sha });
      expect((await db.doc(`cmsPublishQueue/${result.body.publication.queueId}`).get()).data().runtime)
        .toEqual({ owner: "cloudflare", release: sha });
      expect((await db.doc("system/cmsPublicationRuntime").get()).data().phase).toBe(phase);
    });
  it.each(Object.keys(fixtures))("refuses an unmarked %s publish before any publication write", async id => {
    const before = (await db.doc(`cmsSettings/${id}`).get()).data();
    const result = await call(settings.createCmsPublishSettingsHandler(deps()), { id, baseVersion: 1 });
    expect(result.code).toBe(409);
    expect(result.body).toEqual({ code: "settings_publication_client_outdated",
      error: "Boardwalk was updated. Reload this page, then publish again." });
    expect((await db.doc(`cmsSettings/${id}`).get()).data()).toEqual(before);
    expect(await currentRevision()).toBe(1);
    expect((await queues()).size).toBe(0);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
    expect((await db.doc(`cmsSettings/${id}/mediaUsage/published`).get()).exists).toBe(false);
  });
  it.each(Object.keys(fixtures))("accepts %s and its exact cloud work together", async id => {
    const result = await publish(id, 1);
    expect(result.code).toBe(200);
    expect(result.body.publication).toMatchObject({ status: "pending", transport: "public-context-no-build-v1",
      sourceVersion: 1, contextRevision: 2, rendererSha: sha, missingConsumers: publication.REQUIRED_CONSUMERS });
    const rows = await queues();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].id).toBe(result.body.publication.queueId);
    expect(rows.docs[0].data()).toMatchObject({ transport: "public-context-no-build-v1", status: "pending",
      runtime: { owner: "cloudflare", release: sha }, changes: [],
      settingsPublication: { id, sourceVersion: 1, contextRevision: 2,
        snapshotDigest: createHash("sha256").update(JSON.stringify(result.body.settings.published)).digest("hex") } });
    expect(await currentRevision()).toBe(2);
    expect((await db.doc(`cmsSettings/${id}/mediaUsage/published`).get()).exists).toBe(true);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    for (const other of Object.keys(fixtures).filter(other => other !== id)) {
      expect((await db.doc(`cmsSettings/${other}`).get()).data()).not.toHaveProperty("published");
    }
  });

  it("replays a lost response after a later private draft without publishing it", async () => {
    const accepted = await publish("public-site-chrome", 1);
    expect(accepted.code).toBe(200);
    const draft = { ...fixtures["public-site-chrome"], newsletterLabel: "Private unsent label" };
    const saved = await call(settings.createCmsSaveSettingsHandler(deps()), {
      id: "public-site-chrome", baseVersion: 2, values: draft });
    expect(saved.code).toBe(200);
    expect(await currentRevision()).toBe(2);
    const replay = await publish("public-site-chrome", 1);
    expect(replay.code).toBe(200);
    expect(replay.body.changed).toBe(false);
    expect(replay.body.settings).toMatchObject({ version: 3, values: draft, published: accepted.body.settings.published });
    expect(replay.body.publication).toEqual(accepted.body.publication);
    expect((await queues()).size).toBe(1);
    expect(await currentRevision()).toBe(2);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(2);
  });

  it.each(Object.keys(fixtures))("refuses an old client's legacy %s queue retry without changing atomic acceptance", async id => {
    const accepted = await publish(id, 1);
    expect(accepted.code).toBe(200);
    const queueRef = db.doc(`cmsPublishQueue/${accepted.body.publication.queueId}`);
    const before = await queueRef.get();
    const dispatches = [];
    const result = await call(legacyPublish.createCmsPublishHandler({ ...deps(),
      log: { info() {}, warn() {}, error() {} },
      getToken: () => "fixture-legacy-dispatch-token", isWritebackConfigured: true,
      fetchImpl: async (...args) => { dispatches.push(args[0]); return { ok: true, status: 202 }; },
      assertPublishedMediaSafeFn: async () => {},
    }), { changes: [{ collection: "cmsSettings", id, sourceVersion: 1 }] });
    expect(result.code).toBe(409);
    expect(result.body).toEqual({ code: "settings_publication_client_outdated",
      error: "Boardwalk was updated. Reload this page, then publish again." });
    expect(dispatches).toEqual([]);
    expect((await queues()).size).toBe(1);
    const after = await queueRef.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
    expect((await get(id)).body.settings).toEqual(accepted.body.settings);
    expect(await currentRevision()).toBe(2);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("deduplicates the original request and the current unchanged saved version", async () => {
    const first = await publish("public-site-chrome", 1);
    expect(first.code).toBe(200);
    for (const version of [1, 2, 1]) {
      const replay = await publish("public-site-chrome", version);
      expect(replay.code).toBe(200);
      expect(replay.body.publication).toEqual(first.body.publication);
    }
    expect((await queues()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect(await currentRevision()).toBe(2);
  });

  it("keeps a settings acceptance compatible with the retained pure-context guard", async () => {
    const accepted = await publish("public-site-chrome", 1);
    expect(accepted.code).toBe(200);
    const retained = await db.runTransaction(transaction =>
      aggregatePublication.retainedPublicContextQueueIdsInTransaction({ transaction, firestore: db }),
    { readOnly: true });
    expect(retained).toEqual(new Set([accepted.body.publication.queueId]));
    expect((await db.doc(`cmsPublishQueue/${accepted.body.publication.queueId}`).get()).data()).toMatchObject({
      changes: [], settingsPublication: { id: "public-site-chrome", sourceVersion: 1 },
    });
  });

  it.each(["cloud paused", "code release", "source mismatch", "billing", "missing context", "role revoked"])(
    "refuses %s before committing snapshot, queue or audit", async gate => {
      if (gate === "cloud paused") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
      if (gate === "source mismatch") await db.doc("system/cmsPublicationRuntime").update({ "cloud.commitSha": "b".repeat(40) });
      if (gate === "code release") await db.doc("system/publicDeployment").update({ state: "deploying", leaseToken: "fixture-lease",
        leaseAcquiredAt: Timestamp.now(), candidateGeneration: 2, candidateBuildBatchId: "release", candidateCommitSha: "b".repeat(40),
        lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "release",
        predecessorGeneration: 1, predecessorDeploymentId: "fixture-deployment", predecessorCommitSha: sha });
      if (gate === "billing") await db.doc("system/billing").set({ disabled: true });
      if (gate === "missing context") await db.doc(context.PUBLIC_CONTEXT_PATH).delete();
      if (gate === "role revoked") await db.doc(`users/${actor.uid}`).update({ active: false });
      const result = await publish("public-site-chrome", 1);
      expect(result.code).toBeGreaterThanOrEqual(400);
      if (gate === "code release" || gate === "billing") {
        expect(result.code).toBe(409);
        expect(result.body.code).toBe("settings_publication_unavailable");
      }
      expect((await db.doc("cmsSettings/public-site-chrome").get()).data()).not.toHaveProperty("published");
      expect((await queues()).size).toBe(0);
      expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
      expect((await db.collection("admin_logs").get()).size).toBe(0);
    });

  it("keeps completion pending for missing or mixed consumer contexts", async () => {
    const result = await publish("public-site-chrome", 1);
    expect(result.code).toBe(200);
    const ref = db.doc(`cmsPublishQueue/${result.body.publication.queueId}`);
    const exact = { rendererSha: sha, contextRevision: 2, contextDigest: context.publicContextDigest(2), verifiedAt: Date.now() };
    const outputs = Object.fromEntries(publication.REQUIRED_CONSUMERS.slice(3).map(output => [output, exact]));
    await ref.update({ status: "success", aggregateReceipt: { runtime: { owner: "cloudflare", release: sha },
      contextRevision: 2, contextDigest: exact.contextDigest, outputs }, consumerReceipts: { pages: exact, posts: exact } });
    expect((await get("public-site-chrome")).body.publication).toMatchObject({ status: "pending", missingConsumers: ["home"] });
    await ref.update({ "consumerReceipts.home": { ...exact, contextDigest: context.publicContextDigest(3) } });
    expect((await get("public-site-chrome")).body.publication.status).toBe("pending");
    await ref.update({ "consumerReceipts.home": exact });
    expect((await get("public-site-chrome")).body.publication).toMatchObject({ status: "success", missingConsumers: [] });
    await ref.update({ "aggregateReceipt.runtime.release": "b".repeat(40) });
    expect((await get("public-site-chrome")).body.publication.status).toBe("pending");
  });

  it("surfaces an overdue receipt without changing the accepted snapshot", async () => {
    const accepted = await publish("public-site-chrome", 1);
    expect(accepted.code).toBe(200);
    await db.doc(`cmsPublishQueue/${accepted.body.publication.queueId}`).update({
      triggeredAt: Timestamp.fromMillis(Date.now() - publication.PUBLICATION_BUDGET_MS - 1) });
    const loaded = await get("public-site-chrome");
    expect(loaded.body.publication).toMatchObject({ status: "pending", warning: expect.stringMatching(/retry/i) });
    expect(loaded.body.settings.published).toEqual(accepted.body.settings.published);
    expect(await currentRevision()).toBe(2);
  });

  it("retries failed aggregate work under the same snapshot, context and checkpoints", async () => {
    const accepted = await publish("public-site-chrome", 1);
    expect(accepted.code).toBe(200);
    const ref = db.doc(`cmsPublishQueue/${accepted.body.publication.queueId}`);
    const preparation = ref.collection("backgroundPreparation").doc(accepted.body.publication.contextDigest);
    await ref.update({ status: "failed" });
    await preparation.set({ runtime: { owner: "cloudflare", release: sha }, status: "failed", attempts: 4,
      nextAttemptAt: null, claim: null, inputDigest: "c".repeat(64), preparedDigest: "d".repeat(64) });
    await ref.collection("backgroundOutputs").doc("feed").update({ status: "failed", attempts: 4, nextAttemptAt: null });
    const retry = await publish("public-site-chrome", 1);
    expect(retry.code).toBe(200);
    expect(retry.body.publication).toMatchObject({ queueId: ref.id, status: "pending", contextRevision: 2 });
    expect(retry.body.publication).not.toHaveProperty("warning");
    expect((await preparation.get()).data()).toMatchObject({ attempts: 0, inputDigest: "c".repeat(64), preparedDigest: "d".repeat(64) });
    expect((await ref.collection("backgroundOutputs").doc("feed").get()).data()).toMatchObject({ status: "pending", attempts: 0 });
    expect((await queues()).size).toBe(1);
    expect(await currentRevision()).toBe(2);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });

  it("refuses a retry after a newer snapshot was published", async () => {
    const first = await publish("public-site-chrome", 1);
    expect(first.code).toBe(200);
    await call(settings.createCmsSaveSettingsHandler(deps()), { id: "public-site-chrome", baseVersion: 2,
      values: { ...fixtures["public-site-chrome"], newsletterLabel: "New public label" } });
    expect((await publish("public-site-chrome", 3)).code).toBe(200);
    const replay = await publish("public-site-chrome", 1);
    expect(replay.code).toBe(409);
    expect(await currentRevision()).toBe(3);
    expect((await queues()).size).toBe(2);
  });

  it("retries a superseded context with the frozen snapshot and leaves a newer private draft alone", async () => {
    const original = await publish("public-site-chrome", 1);
    expect(original.code).toBe(200);
    const draft = { ...fixtures["public-site-chrome"], newsletterLabel: "Private unsent label" };
    await call(settings.createCmsSaveSettingsHandler(deps()), { id: "public-site-chrome", baseVersion: 2, values: draft });
    const banner = await publish("public-homepage-banner", 1);
    expect(banner.code).toBe(200);
    const retried = await publish("public-site-chrome", 1);
    expect(retried.code).toBe(200);
    expect(retried.body.publication).toMatchObject({ originalOperationId: original.body.publication.queueId,
      contextRevision: 3, status: "pending" });
    expect(retried.body.publication.queueId).not.toBe(original.body.publication.queueId);
    expect((await db.doc(`cmsPublishQueue/${retried.body.publication.queueId}`).get()).data()).toMatchObject({
      changes: [], settingsPublication: { id: "public-site-chrome", sourceVersion: 1 },
    });
    expect(retried.body.settings).toMatchObject({ version: 3, values: draft, published: original.body.settings.published });
    expect(await currentRevision()).toBe(3);
    const replay = await publish("public-site-chrome", 1);
    expect(replay.body.publication).toEqual(retried.body.publication);
    expect((await queues()).size).toBe(3);
    expect((await get("public-site-chrome")).body.publication.queueId).toBe(retried.body.publication.queueId);
    expect((await db.doc(`cmsPublishQueue/${banner.body.publication.queueId}`).get()).data().status).toBe("pending");
    expect((await publish("public-homepage-banner", 1)).code).toBe(200);
  });

  it("keeps a retry's billing refusal specific and leaves its accepted work intact", async () => {
    const original = await publish("public-site-chrome", 1);
    expect(original.code).toBe(200);
    await db.doc(`cmsPublishQueue/${original.body.publication.queueId}`).update({ status: "failed" });
    await db.doc("system/billing").set({ disabled: true });
    const retry = await publish("public-site-chrome", 1);
    expect(retry.code).toBe(409);
    expect(retry.body.error).toMatch(/billing/i);
    expect(retry.body.error).not.toMatch(/replaced/i);
    expect(await currentRevision()).toBe(2);
  });

  it("refuses retry while a Post owns pending aggregate outputs without reporting a server failure", async () => {
    const original = await publish("public-site-chrome", 1);
    const ref = db.doc(`cmsPublishQueue/${original.body.publication.queueId}`);
    await ref.update({ createdAt: Timestamp.fromMillis(Date.now() - publication.PUBLICATION_BUDGET_MS - 1) });
    // A Post publication replaces a shared family with a non-context-only task.
    const output = db.doc("cmsBackgroundOutputs/listings");
    await output.update({ contextOnly: false, postId: "post-fixture", contextDigest: null, status: "pending",
      taskPath: "cmsPublishQueue/post-publication/backgroundOutputs/listings", receipt: null });
    const before = (await output.get()).data();
    const beforeRetry = await retryState(ref.id);
    const retry = await publish("public-site-chrome", 1);
    expect(retry.code).toBe(409);
    expect(retry.body.error).toMatch(/another publication.*try.*again/i);
    expect(log.warn.mock.calls).toEqual([["Settings publication retry refused", { code: "settings_retry_guard_refused" }]]);
    expect(log.error).not.toHaveBeenCalled();
    expect(await retryState(ref.id)).toEqual(beforeRetry);
    expect((await output.get()).data()).toEqual(before);
    expect((await get("public-site-chrome")).body.settings).toEqual(original.body.settings);
    expect(await currentRevision()).toBe(2);
    expect((await queues()).size).toBe(1);
  });

  it.each(["missing output", "foreign output", "missing task", "foreign preparation"])(
    "safely diagnoses a retry with %s and leaves accepted work unchanged", async kind => {
      const original = await publish("public-site-chrome", 1);
      expect(original.code).toBe(200);
      const queueId = original.body.publication.queueId;
      await db.doc(`cmsPublishQueue/${queueId}`).update({
        createdAt: Timestamp.fromMillis(Date.now() - publication.PUBLICATION_BUDGET_MS - 1),
      });
      const output = db.doc("cmsBackgroundOutputs/listings");
      const state = (await output.get()).data();
      if (kind === "missing output") await output.delete();
      if (kind === "foreign output") await output.update({ runtime: { owner: "cloudflare", release: "b".repeat(40) },
        privateDiagnostic: "PRIVATE fixture detail" });
      if (kind === "missing task") await db.doc(state.taskPath).delete();
      if (kind === "foreign preparation") await db.doc(
        `cmsPublishQueue/${queueId}/backgroundPreparation/${context.publicContextDigest(2)}`,
      ).set({ runtime: { owner: "cloudflare", release: "b".repeat(40) }, privateDiagnostic: "PRIVATE fixture detail" });
      const before = await retryState(queueId);
      const retry = await publish("public-site-chrome", 1);
      expect(retry.code).toBe(409);
      expect(retry.body).toEqual({ code: "settings_publication_unavailable",
        error: "Another publication is updating the public outputs. Try this site update again shortly." });
      expect(log.warn.mock.calls).toEqual([["Settings publication retry refused", { code: "settings_retry_guard_refused" }]]);
      expect(log.error).not.toHaveBeenCalled();
      expect(await retryState(queueId)).toEqual(before);
    });

  it("settles exact aggregate receipts for same-context settings aliases without claiming Page, Post or Home completion", async () => {
    expect((await publish("public-site-chrome", 1)).code).toBe(200);
    const banner = await publish("public-homepage-banner", 1);
    const chrome = await publish("public-site-chrome", 1);
    expect(chrome.code).toBe(200);
    for (const output of aggregatePublication.OUTPUTS) {
      const ref = db.doc(`cmsBackgroundOutputs/${output}`);
      const state = (await ref.get()).data();
      // Family receipts retain immutable manifest and route digests; context
      // settlement projects these fields into its compact aggregate receipt.
      await ref.update({ status: "verified", receipt: { revision: state.revision,
        rendererSha: sha, contextDigest: context.publicContextDigest(3), verifiedAt: Date.now(),
        digest: "d".repeat(64), routeSetDigest: "e".repeat(64) } });
    }
    expect(await aggregatePublication.settlePublicContext({ firestore: db, operationId: chrome.body.publication.queueId,
      runtime: { owner: "cloudflare", release: sha } })).toBe(true);
    for (const id of [banner.body.publication.queueId, chrome.body.publication.queueId]) {
      const queue = (await db.doc(`cmsPublishQueue/${id}`).get()).data();
      expect(queue.status).toBe("success");
      expect(Object.keys(queue.aggregateReceipt.outputs)).toEqual(aggregatePublication.OUTPUTS);
      expect(queue.aggregateReceipt.outputs.search).toMatchObject({ contextRevision: 3,
        contextDigest: context.publicContextDigest(3), rendererSha: sha });
    }
    expect((await get("public-homepage-banner")).body.publication).toMatchObject({ status: "pending", missingConsumers: ["pages", "posts", "home"] });
    expect((await get("public-site-chrome")).body.publication).toMatchObject({ status: "pending", missingConsumers: ["pages", "posts", "home"] });
  });

  it("lets an overdue settings alias retry the shared owner's failed tasks and checkpoint", async () => {
    expect((await publish("public-site-chrome", 1)).code).toBe(200);
    const banner = await publish("public-homepage-banner", 1);
    const chrome = await publish("public-site-chrome", 1);
    expect(chrome.code).toBe(200);
    const ownerRef = db.doc(`cmsPublishQueue/${chrome.body.publication.queueId}`);
    await ownerRef.collection("backgroundOutputs").doc("feed").update({ status: "failed", attempts: 4, nextAttemptAt: null });
    const preparation = ownerRef.collection("backgroundPreparation").doc(context.publicContextDigest(3));
    await preparation.set({ runtime: { owner: "cloudflare", release: sha }, status: "failed", attempts: 4,
      claim: null, nextAttemptAt: null, inputDigest: "c".repeat(64) });
    await aggregatePublication.settlePublicContext({ firestore: db, operationId: ownerRef.id, runtime: { owner: "cloudflare", release: sha } });
    await db.doc(`cmsPublishQueue/${banner.body.publication.queueId}`).update({ createdAt: Timestamp.fromMillis(Date.now() - publication.PUBLICATION_BUDGET_MS - 1) });
    const retry = await publish("public-homepage-banner", 1);
    expect(retry.code).toBe(200);
    expect(retry.body.publication).toMatchObject({ queueId: banner.body.publication.queueId, status: "pending" });
    expect((await ownerRef.collection("backgroundOutputs").doc("feed").get()).data()).toMatchObject({ status: "pending", attempts: 0 });
    expect((await preparation.get()).data()).toMatchObject({ attempts: 0, inputDigest: "c".repeat(64) });
    expect(await currentRevision()).toBe(3);
    expect((await queues()).size).toBe(3);
  });
});

it("change-log: accepts public settings and deduplicates a lost-response retry", async () => {
  await enrollPublicReleaseLog(db, sha);
  const result = await publish("public-site-chrome", 1);
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const [entry] = await publicReleaseEntries(db);
  expect(entry.operationId).toBe(result.body.publication.queueId);
  expect(entry.changes).toMatchObject([{ kind: "settings", id: "public-site-chrome", action: "publish", sourceVersion: 1 }]);
  expect((await db.doc("cmsSettings/public-site-chrome").get()).data().published.sourceVersion).toBe(1);
  expect((await publish("public-site-chrome", 1)).code).toBe(200);
  expect(await publicReleaseEntries(db)).toHaveLength(1);
});
