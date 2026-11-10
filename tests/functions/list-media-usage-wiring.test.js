import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import usageApi from "../../functions/list-media-usage.js";
import deploymentContract from "../../functions/lib/public-deployment.js";

const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const user = {
  uid: "editor-1",
  principal: { id: "editor-1", grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }] },
};

describe("media usage Firestore reads", () => {
  let app;
  let db;
  beforeAll(() => {
    app = initializeApp({ projectId: PROJECT }, "media-usage-read-test");
    db = isolatedFirestore("list-media-usage-wiring.test.js");
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" }, db);
    await db.doc("media_assets/art").set({ lifecycle: "active", category: "news" });
  });
  afterAll(async () => { await deleteApp(app); });

  async function seedOwner(path, document, state, sourceVersion, extra = {}) {
    const batch = db.batch();
    batch.set(db.doc(path), document);
    batch.set(db.doc(`${path}/mediaUsage/${state}`), {
      state, sourceVersion, assetIds: ["art", "another-asset"], occurrenceCount: 7, ...extra,
    });
    await batch.commit();
  }

  const query = (state, extra = {}) => ({ assetId: "art", state, page: 1, pageSize: 25, ...extra });

  it("joins real owner records before paging and never writes source or index data", async () => {
    const post = { version: 2, section: "news", createdBy: "someone-else", title: "A visible post" };
    await seedOwner("cmsPosts/visible", post, "working", 2);
    await seedOwner("cmsPosts/hidden", { ...post, section: "arts", title: "Private title" }, "working", 2);
    await seedOwner("cmsPosts/deleted", { ...post, deleted: true }, "working", 2);
    await seedOwner("cmsAuthorProfiles/own", { version: 2, uid: user.uid, displayName: "My profile" }, "working", 2);
    await seedOwner("cmsAuthorProfiles/other", { version: 2, uid: "other", displayName: "Other profile" }, "working", 2);
    await seedOwner("cmsSettings/newsroom", { version: 2, title: "Private setting" }, "working", 2);
    // Orphaned usage remains possible because deleting a document does not
    // delete its subcollections. It must not become a visible owner.
    await db.doc("cmsPosts/missing/mediaUsage/working").set({
      state: "working", sourceVersion: 2, assetIds: ["art"], occurrenceCount: 1,
    });
    // cmsTransitionContent advances version for a status-only transition and
    // preserves the working usage written by the last content save.
    await db.doc("cmsPosts/visible").update({ version: 3, status: "in_review" });
    const before = await db.doc("cmsPosts/visible/mediaUsage/working").get();

    const first = await usageApi.readMediaUsage(db, user, query("working", { pageSize: 1 }));
    const second = await usageApi.readMediaUsage(db, user, query("working", { page: 2, pageSize: 1 }));

    expect(first).toMatchObject({ total: 2, pageCount: 2, coverage: "indexed_only", generation: null });
    expect(first.items).toEqual([
      { collection: "cmsAuthorProfiles", documentId: "own", title: "My profile", sourceVersion: 2 },
    ]);
    expect(second.items).toEqual([
      { collection: "cmsPosts", documentId: "visible", title: "A visible post", sourceVersion: 2 },
    ]);
    expect((await db.doc("cmsPosts/visible/mediaUsage/working").get()).updateTime.isEqual(before.updateTime)).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("keeps published snapshots separate from the acknowledged deployed generation", async () => {
    const post = { version: 4, section: "news", createdBy: user.uid, title: "Current title", published: { sourceVersion: 3 } };
    await seedOwner("cmsPosts/post", post, "published", 3);
    const pointer = {
      ...deploymentContract.initialPublicDeploymentPointer(),
      mediaLifecycleReady: true,
      activeGeneration: 2,
      activeDeploymentId: "deployment-two",
      activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 3,
      newestEligibleGeneration: 3,
      newestEligibleBuildBatchId: "pending-build",
      updatedAt: Timestamp.now(),
    };
    await db.doc("system/publicDeployment").set(pointer);
    for (const generation of [1, 2, 3]) {
      await db.doc(`cmsPosts/post/mediaUsage/deployed-${generation}`).set({
        state: "deployed", generation, sourceVersion: generation,
        assetIds: ["art"], occurrenceCount: 1, commitSha: "a".repeat(40),
      });
    }

    expect(await usageApi.readMediaUsage(db, user, query("published"))).toMatchObject({
      generation: null, items: [{ documentId: "post", sourceVersion: 3 }], total: 1,
    });
    expect(await usageApi.readMediaUsage(db, user, query("deployed"))).toMatchObject({
      generation: 2, items: [{ documentId: "post", sourceVersion: 2 }], total: 1,
    });
    await db.doc("system/publicDeployment").delete();
    await expect(usageApi.readMediaUsage(db, user, query("deployed"))).rejects.toMatchObject({ status: 503 });
  });
});
