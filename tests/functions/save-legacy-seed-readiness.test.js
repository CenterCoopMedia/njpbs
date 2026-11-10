import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import publish from "../../functions/publish.js";

const PROJECT = "demo-njpbs";
const NOW = "2026-10-08T16:00:00.000Z";
const legacyPage = {
  id: "programLanding",
  template: "programLanding",
  title: "Legacy landing page",
  status: "published",
  blocks: [{ id: "legacy-divider", type: "divider", order: 0, visible: true, data: {} }],
  createdBy: "staff-1",
  version: 7,
};
let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("save-legacy-seed-readiness.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
  await db.collection("cmsPages").doc(legacyPage.id).set(legacyPage);
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

async function savePage({ role = "editor", seed = true, firestore = db } = {}) {
  const handler = save.createCmsSaveHandler({
    firestore,
    requirePrincipalFn: () => ({
      uid: "staff-1",
      email: "staff-1@example.test",
      principal: { id: "staff-1", grants: [{ role }] },
    }),
    assertPublishReadyFn: publish.assertPublishReady,
    enablePublishSnapshot: true,
    now: () => NOW,
    log: { info() {}, warn() {}, error() {} },
  });
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({
    method: "POST",
    headers: {},
    ip: "203.0.113.7",
    body: {
      collection: "cmsPages",
      id: "watch",
      createOnly: true,
      ...(seed ? { seedFromLegacyPage: { id: legacyPage.id, version: 7 } } : {}),
      document: seed
        ? { template: "programLanding", blocks: legacyPage.blocks }
        : { template: "programLanding", title: "Watch draft", blocks: [], status: "draft" },
    },
  }, res);
  return res;
}

async function expectNoSave() {
  expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
  expect((await db.collection("cmsPages").doc(legacyPage.id).get()).data()).toEqual(legacyPage);
  for (const collection of ["cmsVersionHistory", "admin_logs", "cmsPublishQueue"]) {
    expect((await db.collection(collection).get()).empty).toBe(true);
  }
  expect((await db.collectionGroup("mediaUsage").get()).empty).toBe(true);
}

// Hold the Firestore read boundary so a second writer changes state during readiness.
function firestoreWithBillingReadChange(change) {
  return new Proxy(db, {
    get(target, key) {
      if (key === "doc") return (path) => {
        const ref = target.doc(path);
        if (path !== "system/billing") return ref;
        return { get: async () => { await change(); return ref.get(); } };
      };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("legacy seed publication readiness", () => {
  it("refuses a legacy seed while the billing kill switch is on without saving state", async () => {
    await db.doc("system/billing").set({ disabled: true, reason: "Test publication hold" });

    const res = await savePage();

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "billing is disabled: Test publication hold" });
    await expectNoSave();
  });

  it("refuses a legacy seed with an invalid publish transport without saving state", async () => {
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "invalid-test-transport");

    const res = await savePage();

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "publish pipeline is not fully configured: publish transport is invalid" });
    await expectNoSave();
  });

  it("refuses a caller without publication authority before disclosing readiness", async () => {
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "invalid-test-transport");

    const res = await savePage({ role: "contributor" });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "You do not have permission to save this record." });
    await expectNoSave();
  });

  it.each([["contributor", "draft"], ["editor", "archived"]])(
    "keeps %s seed creates of %s pages available while publication is stopped",
    async (role, status) => {
      await db.collection("cmsPages").doc(legacyPage.id).update({ status });
      await db.doc("system/billing").set({ disabled: true });
      vi.stubEnv("CMS_PUBLISH_TRANSPORT", "invalid-test-transport");

      const res = await savePage({ role });

      expect(res.statusCode).toBe(200);
      const stored = (await db.collection("cmsPages").doc("watch").get()).data();
      expect(stored).toMatchObject({ title: legacyPage.title, status, version: 1 });
      expect(stored.published).toBeUndefined();
      expect((await db.collection("cmsPages").doc(legacyPage.id).get()).data())
        .toEqual({ ...legacyPage, status });
      expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    },
  );

  it("still materializes the published snapshot when publication is ready", async () => {
    const res = await savePage();

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      status: "published",
      version: 1,
      published: {
        metadata: { title: legacyPage.title },
        blocks: [{ ...legacyPage.blocks[0], id: expect.any(String) }],
        publishedAt: NOW,
        publishedBy: "staff-1",
        sourceVersion: 1,
      },
    });
    expect((await db.collection("cmsVersionHistory").get()).docs.map(doc => doc.data().action))
      .toEqual(["publish"]);
    expect((await db.collection("admin_logs").get()).docs.map(doc => doc.data().action))
      .toEqual(["cms.publish-snapshot"]);
  });

  it("refuses a seed that changed while publication readiness was checked", async () => {
    const firestore = firestoreWithBillingReadChange(() =>
      db.collection("cmsPages").doc(legacyPage.id).update({ version: 8 }),
    );

    const res = await savePage({ firestore });

    expect(res.statusCode).toBe(409);
    expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
    expect((await db.collection("cmsPages").doc(legacyPage.id).get()).data())
      .toEqual({ ...legacyPage, version: 8 });
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("preserves a canonical page created while publication readiness was checked", async () => {
    const competingPage = {
      id: "watch", template: "programLanding", title: "Another saved page",
      status: "draft", blocks: [], version: 1, createdBy: "staff-1",
    };
    const firestore = firestoreWithBillingReadChange(() =>
      db.collection("cmsPages").doc("watch").set(competingPage),
    );

    const res = await savePage({ firestore });

    expect(res.statusCode).toBe(409);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toEqual(competingPage);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("keeps ordinary draft creates available while publication is stopped", async () => {
    await db.doc("system/billing").set({ disabled: true });
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "invalid-test-transport");

    const res = await savePage({ role: "contributor", seed: false });

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages").doc("watch").get()).data())
      .toMatchObject({ title: "Watch draft", status: "draft", version: 1 });
  });
});
