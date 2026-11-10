import { DEFAULT_NJ_DECIDES_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import { beforeEach, describe, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import settings from "../../functions/settings.js";
import legacyPublish from "../../functions/publish.js";
import save from "../../functions/save.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import reader from "../../functions/published-post-reader.js";

const db = isolatedFirestore("coverage-labels.test.ts");
const id = "coverage-labels", sha = "a".repeat(40);
const label = { id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: false };
const actor = { uid: "coverage-admin", principal: { id: "coverage-admin", grants: [{ role: "admin" }] } };
const writer = { uid: "coverage-writer", principal: { id: "coverage-writer", grants: [{ role: "contributor" }] } };
const deps = (user = actor) => ({ firestore: db, requirePrincipalFn: async () => user, log: { warn() {}, error() {} } });
async function call(handler: any, body: unknown) {
  const res = { code: 200, body: undefined as any, headersSent: false, set() {}, status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
  return res;
}
const publish = () => call(settings.createCmsPublishSettingsHandler(deps()), { id, baseVersion: 1, publicationTransport: "public-context-no-build-v1" });

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  await db.doc(`cmsSettings/${id}`).set({ schemaVersion: 1, version: 1, values: { labels: [label] } });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeCommitSha: sha, activeDeploymentId: "coverage-fixture", lastReservedGeneration: 1, newestEligibleGeneration: 1,
    newestEligibleBuildBatchId: "coverage-fixture", mediaLifecycleReady: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
});

describe("coverage settings at Firestore boundaries", () => {
  it("keeps drafts private, rejects unsafe settings and denies a writer's management request", async () => {
    const read = settings.createCmsGetCoverageLabelsHandler(deps(writer));
    expect((await call(read, { id })).body).toMatchObject({ success: true, found: false });
    expect((await call(read, { id: "site-navigation" })).code).toBe(404);
    const denied = await call(settings.createCmsSaveSettingsHandler(deps(writer)), { id, baseVersion: 1, values: { labels: [] } });
    expect(denied.code).toBe(403);
    const invalid = await call(settings.createCmsSaveSettingsHandler(deps()), { id, baseVersion: 1,
      values: { labels: [{ ...label, textColor: "#eeeeee" }] } });
    expect(invalid.code).toBe(400);
    expect((await db.doc(`cmsSettings/${id}`).get()).data()!.version).toBe(1);
  });
  it("publishes exact settings/context work once, keeps later drafts private and returns only published choices", async () => {
    const accepted = await publish();
    expect({ code: accepted.code, error: accepted.body.error }).toEqual({ code: 200, error: undefined });
    expect(accepted.body.publication).toMatchObject({ status: "pending", sourceVersion: 1, contextRevision: 2, rendererSha: sha });
    const updated = await call(settings.createCmsSaveSettingsHandler(deps()), { id, baseVersion: 2,
      values: { labels: [{ ...label, name: "PRIVATE draft rename", retired: true }] } });
    expect(updated.code).toBe(200);
    const choices = await call(settings.createCmsGetCoverageLabelsHandler(deps(writer)), { id });
    expect(choices.body).toMatchObject({ found: true, published: { values: { labels: [label] }, sourceVersion: 1 } });
    expect(JSON.stringify(choices.body)).not.toContain("PRIVATE");
    expect((await publish()).body.publication.queueId).toBe(accepted.body.publication.queueId);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()!.revision).toBe(2);
    const legacy = await call(legacyPublish.createCmsPublishHandler({ ...deps(), log: { info() {}, warn() {}, error() {} } }),
      { changes: [{ collection: "cmsSettings", id, sourceVersion: 1 }] });
    expect(legacy.code).toBe(409);
    expect(legacy.body.code).toBe("settings_publication_client_outdated");
  });
  it("forwards the detached registry beside the legacy chrome array, including retired published history", async () => {
    await db.doc(`cmsSettings/${id}`).update({ published: { schemaVersion: 1, sourceVersion: 1,
      publishedAt: "2026-10-29T12:00:00.000Z", values: { labels: [{ ...label, retired: true }] } }, values: { labels: [] } });
    await Promise.all(Object.entries({ "nj-decides-brand": DEFAULT_NJ_DECIDES_SETTINGS, "public-homepage-banner": DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
      "public-site-chrome": DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, "site-navigation": DEFAULT_SITE_NAVIGATION }).map(([id, values]) =>
      db.doc(`cmsSettings/${id}`).set({ version: 1, schemaVersion: 1, values, published: { schemaVersion: 1, sourceVersion: 1, publishedAt: "2026-10-29T12:00:00.000Z", values } })));
    const chrome = await db.runTransaction(tx => reader.readPublishedChrome(db, tx, new Date("2026-10-29T13:00:00.000Z")), { readOnly: true });
    expect(chrome.settings).toHaveLength(4);
    expect(chrome.settings.map(setting => setting.id)).not.toContain("coverage-labels");
    expect(chrome.coverageLabels.published.values.labels).toEqual([{ ...label, retired: true }]);
  });
  it.each([false, true])("saves, reopens and clears a label without a legacy live-blog fallback (%s)", async legacyBlog => {
    const post = { id: "coverage-post", type: "post", title: "Election coverage", tags: [], blocks: [], slug: "coverage-post",
      previousSlugs: [], locale: "en", status: "draft", createdBy: actor.uid, version: 3, coverageLabelId: label.id,
      ...(legacyBlog ? { liveBlog: { schemaVersion: 1, coverageState: "ongoing", branding: "nj-decides-2026", updates: [] } } : {}) };
    await db.doc("cmsPosts/coverage-post").set(post);
    const handler = save.createCmsSaveHandler(deps());
    const saved = await call(handler, { collection: "cmsPosts", id: post.id, baseVersion: 3,
      document: { type: "post", title: "Revised headline", tags: [], blocks: [], coverageLabelId: label.id } });
    expect({ code: saved.code, error: saved.body.error }).toEqual({ code: 200, error: undefined });
    const reopened = (await db.doc("cmsPosts/coverage-post").get()).data()!;
    expect(reopened.coverageLabelId).toBe(label.id);
    const cleared = await call(handler, { collection: "cmsPosts", id: post.id, baseVersion: reopened.version,
      document: { type: "post", title: "Revised headline", tags: [], blocks: [], coverageLabelId: null } });
    expect({ code: cleared.code, error: cleared.body.error }).toEqual({ code: 200, error: undefined });
    const withoutLabel = (await db.doc("cmsPosts/coverage-post").get()).data()!;
    expect(withoutLabel).not.toHaveProperty("coverageLabelId");
    if (legacyBlog) expect(withoutLabel.liveBlog).not.toHaveProperty("branding");
    const invalid = await call(handler, { collection: "cmsPosts", id: post.id, baseVersion: withoutLabel.version,
      document: { type: "post", title: "Revised headline", tags: [], blocks: [], coverageLabelId: "bad/id" } });
    expect(invalid.code).toBe(400);
    expect((await db.doc("cmsPosts/coverage-post").get()).data()).toEqual(withoutLabel);
  });
});
