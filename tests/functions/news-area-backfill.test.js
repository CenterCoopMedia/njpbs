import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { backfillNewsArea } from "../../scripts/backfill-news-area.mjs";
import rbac from "../../functions/lib/rbac.js";

const PROJECT = "demo-njpbs";
const NOW = "2026-10-07T17:00:00.000Z";
let db;
beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("news-area-backfill.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });
const migrate = (options = {}) => backfillNewsArea({ firestore: db, nowIso: NOW, ...options });
async function seed() {
  await db.collection("cmsPosts").doc("legacy-post").set({ type: "post", status: "draft", createdBy: "writer", version: 3, title: "Station update" });
  await db.collection("cmsPosts").doc("event").set({ type: "event", title: "Station event" });
  await db.collection("cmsPosts").doc("unassigned").set({ type: "post", status: "draft", unassignedDraft: true, createdBy: "watch-writer" });
  await db.collection("users").doc("editor").set({ grants: [{ role: "editor", sections: ["news"] }] });
  await db.collection("users").doc("writer").set({ grants: [{ role: "contributor", sections: ["news"] }] });
  await db.collection("users").doc("watch-editor").set({ grants: [{ role: "editor", sections: ["watch"] }] });
}

describe("audited News area backfill", () => {
  it("defaults to a dry run and exposes only deliberate News capability gains", async () => {
    await seed();
    const plan = await migrate();
    expect(plan).toMatchObject({ dryRun: true, registry: "create", postsStamped: 0, blocked: [] });
    expect(plan.rows.find((row) => row.id === "unassigned").action).toBe("skip-unassigned-draft");
    expect(plan.rows.find((row) => row.id === "legacy-post").permissionChanges).toEqual([
      { uid: "editor", gained: ["content.create", "content.edit.any", "content.publish", "content.unpublish"], lost: [] },
      { uid: "writer", gained: ["content.create", "content.edit.own"], lost: [] },
    ]);
    expect((await db.collection("sections").doc("news").get()).exists).toBe(false);
    expect((await db.collection("cmsPosts").doc("legacy-post").get()).data()).not.toHaveProperty("section");
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect((await migrate()).planHash).toBe(plan.planHash);
  });

  it("applies only the reviewed plan and audits the registry and post atomically", async () => {
    await seed();
    const plan = await migrate();
    const result = await migrate({ apply: true, expectedPlan: plan.planHash });
    expect(result).toMatchObject({ dryRun: false, postsStamped: 1 });
    expect((await db.collection("sections").doc("news").get()).data()).toMatchObject({ id: "news", label: "News", order: 5 });
    expect((await db.collection("cmsPosts").doc("legacy-post").get()).data()).toMatchObject({ section: "news", version: 3, title: "Station update", updatedBy: "system:news-area-backfill" });
    expect((await db.collection("cmsPosts").doc("event").get()).data()).not.toHaveProperty("section");
    expect((await db.collection("cmsPosts").doc("unassigned").get()).data()).not.toHaveProperty("section");
    const logs = (await db.collection("admin_logs").get()).docs.map((doc) => doc.data());
    expect(logs.map((row) => row.action).sort()).toEqual(["content.section_backfill", "section.registry_seed"]);
    expect(logs.every((row) => row.planHash === plan.planHash)).toBe(true);
    expect(logs.find((row) => row.action === "content.section_backfill")).toMatchObject({ before: { section: null }, after: { section: "news", permissionChanges: plan.rows.find((row) => row.id === "legacy-post").permissionChanges } });
    const next = await migrate();
    await migrate({ apply: true, expectedPlan: next.planHash });
    expect((await db.collection("admin_logs").get()).size).toBe(2);
    expect(rbac.can({ grants: [{ role: "editor", sections: ["watch"] }] }, "content.publish", { section: "news" })).toBe(false);
  });

  it.each(["post", "grant"])("rejects a stale plan after a %s changes, without partial writes", async (change) => {
    await seed();
    const plan = await migrate();
    if (change === "post") await db.collection("cmsPosts").doc("legacy-post").update({ title: "Changed" });
    else await db.collection("users").doc("editor").update({ grants: [{ role: "editor", sections: ["watch"] }] });
    await expect(migrate({ apply: true, expectedPlan: plan.planHash })).rejects.toThrow(/plan changed/);
    expect((await db.collection("sections").doc("news").get()).exists).toBe(false);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("requires bounded reviewed batches and refuses unknown selections", async () => {
    const batch = db.batch();
    for (let index = 0; index < 201; index++) {
      batch.set(db.collection("cmsPosts").doc(`post-${index}`), { type: "post", status: "draft", title: "Legacy post" });
    }
    await batch.commit();
    const wide = await migrate();
    expect(wide.blocked).toEqual(["More than 200 posts: use --post-id to review and apply smaller batches"]);
    await expect(migrate({ apply: true, expectedPlan: wide.planHash })).rejects.toThrow(/More than 200/);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    const selected = await migrate({ postIds: ["post-0"] });
    expect(selected.rows).toEqual([{ id: "post-0", action: "stamp", section: null, permissionChanges: [] }]);
    await migrate({ apply: true, expectedPlan: selected.planHash, postIds: ["post-0"] });
    expect((await db.collection("cmsPosts").doc("post-0").get()).data().section).toBe("news");
    expect((await db.collection("cmsPosts").doc("post-1").get()).data()).not.toHaveProperty("section");
    await expect(migrate({ postIds: ["missing"] })).rejects.toThrow(/missing or is not a newsroom post/);
  });

  it("reports no permission change for site-wide users and preserves publication snapshots", async () => {
    await seed();
    await db.collection("users").doc("site-editor").set({ grants: [{ role: "editor" }] });
    const published = { sourceVersion: 2, title: "Published story", publishedAt: NOW, blocks: [] };
    await db.collection("cmsPosts").doc("legacy-post").update({ section: null, published, status: "published" });
    const plan = await migrate();
    expect(plan.rows.find((row) => row.id === "legacy-post").permissionChanges.map((row) => row.uid)).toEqual(["editor", "writer"]);
    await migrate({ apply: true, expectedPlan: plan.planHash });
    expect((await db.collection("cmsPosts").doc("legacy-post").get()).data()).toMatchObject({ section: "news", published, status: "published", version: 3 });
  });

  it("reports no permission change for a whole-site staff access level after activation", async () => {
    await seed();
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await db.collection("users").doc("editor").update({ accessTier: "publisher" });
    const plan = await migrate();
    expect(plan.rows.find((row) => row.id === "legacy-post").permissionChanges.map((row) => row.uid)).toEqual(["writer"]);
  });

  it("refuses reassignment from an existing area and requires a reviewed hash", async () => {
    await seed();
    await db.collection("cmsPosts").doc("legacy-post").update({ section: "watch" });
    const plan = await migrate();
    expect(plan.rows.find((row) => row.id === "legacy-post").action).toBe("conflict");
    await expect(migrate({ apply: true, expectedPlan: plan.planHash })).rejects.toThrow(/explicit decision/);
    await expect(migrate({ apply: true })).rejects.toThrow(/reviewed dry run/);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });
});
