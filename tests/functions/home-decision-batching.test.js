import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import content from "../../functions/public-content.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import { pageDocument, publishedAt, rendererSha, seedHomeDecisionFixture, seedOwnedHomeDecisionFixture } from "./fixtures/home-decision-3441.js";

let app;
let firestore;
let handler;
const golden = name => readFileSync(new URL(`./fixtures/home-decision-3441-${name}.json`, import.meta.url), "utf8").trimEnd();
const call = async (path = "/") => {
  const response = { headers: {}, statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ method: "POST", body: { mode: "no-build-page-v1", path, rendererSha, method: "GET" } }, response);
  return response;
};
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use the local demo Firestore emulator");
  }
  app = initializeApp({ projectId: "njpbs-site-dev" }, "home-decision-batching");
  firestore = getFirestore(app);
  handler = content.createCmsGetPublicPageHandler({ firestore, log: { error() {} } });
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await seedHomeDecisionFixture(firestore);
});
afterAll(async () => {
  if (!firestore) return;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await deleteApp(app);
});

it("keeps exact pre-change owned Home bytes and reads its authority on the next call", async () => {
  await seedOwnedHomeDecisionFixture(firestore);
  const before = await call();
  expect(before.statusCode).toBe(200);
  expect(before.body.kind).toBe("page");
  expect(JSON.stringify(before.body)).not.toContain("PRIVATE");
  expect(JSON.stringify(before.body)).toBe(golden("home-owned"));
  await firestore.doc("system/publicDeployment/noBuildPageOwners/home").update({ servingEnabled: false });
  await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: false });
  const after = await call();
  expect(after.statusCode).toBe(503);
  expect(after.body).toEqual({ error: "Public content is unavailable" });
});

it("shows a new Page publication and context revision on the next call", async () => {
  const before = await call("/contact/");
  expect(before.statusCode).toBe(200);
  expect(before.headers["Cache-Control"]).toBe("private, no-store");
  expect(Object.keys(before.body).sort()).toEqual(["contextReceipt", "kind", "path", "renderContext"]);
  expect(before.body).toMatchObject({ kind: "context-page", path: "/contact/",
    renderContext: { kind: "published-page-context", pageId: "contact", path: "/contact/" },
    contextReceipt: { rendererSha, contextRevision: 4, codeGeneration: 5, path: "/contact/", source: "cms", sourceVersion: 7 } });
  expect(JSON.stringify(before.body)).not.toContain("PRIVATE");
  await firestore.doc("cmsPages/contact").update({ version: 9,
    "published.sourceVersion": 8, "published.metadata.title": "New published title",
    "published.blocks": pageDocument("New published title").published.blocks });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 5 });
  const after = await call("/contact/");
  expect(before.body.renderContext.page.title).toBe("Fixture contact");
  expect(after.statusCode).toBe(200);
  expect(after.body.renderContext.page.title).toBe("New published title");
  expect(after.body.contextReceipt).toMatchObject({ contextRevision: 5, sourceVersion: 8 });
  expect(JSON.stringify(after.body)).not.toContain("PRIVATE");
});
it("reflects an unowned built-in withdrawal on the next call", async () => {
  expect((await call("/contact/")).body.renderContext.page).not.toBeNull();
  await firestore.doc("cmsPages/contact").update({ publiclyVisible: false });
  const response = await call("/contact/");
  expect(response.statusCode).toBe(200);
  expect(response.body.contextReceipt.source).toBe("site");
  expect(response.body.renderContext.page).toBeNull();
});
it("does not serve the earlier frame after a new owner claim", async () => {
  expect((await call("/contact/")).statusCode).toBe(200);
  await ownership.pageRouteRef(firestore, "/contact/").set({ schemaVersion: 1, pageId: "contact", path: "/contact/" });
  const response = await call("/contact/");
  expect(response.statusCode).toBe(503);
  expect(response.body).toEqual({ error: "Public content is unavailable" });
});
it("checks renderer authority again on the next call", async () => {
  const before = await call();
  expect(before.body.kind).toBe("context-page");
  expect(JSON.stringify(before.body)).not.toContain("PRIVATE");
  await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ rendererSha: "b".repeat(40) });
  expect((await call()).body).toEqual({ kind: "pass", path: "/" });
});
it("shows Post publication, withdrawal, alias conflict and replacement changes without a cached card", async () => {
  const ref = firestore.doc("cmsPosts/fixture-post-00");
  expect((await call()).body.renderContext.posts[0].document.published.metadata.title).toBe("Fixture Post 0");
  await ref.update({ version: 3, "published.sourceVersion": 2, "published.metadata.title": "Updated public card" });
  expect((await call()).body.renderContext.posts[0].document.published.metadata.title).toBe("Updated public card");
  await firestore.doc("system/media/replacements/fixture-image-0").set({ state: "pending" });
  expect((await call()).statusCode).toBe(503);
  await firestore.doc("system/media/replacements/fixture-image-0").delete();
  await firestore.doc("cmsPosts/conflicting-alias").set({ version: 2, status: "archived", publiclyVisible: false,
    published: { sourceVersion: 1, publishedAt, blocks: [], metadata: { type: "post", title: "Retained alias",
      slug: "different-canonical", previousSlugs: ["fixture-post-00"], locale: "en" } } });
  expect((await call()).statusCode).toBe(503);
  await firestore.doc("cmsPosts/conflicting-alias").delete();
  await ref.update({ publiclyVisible: false });
  expect((await call()).body.renderContext.posts).toHaveLength(19);
});
