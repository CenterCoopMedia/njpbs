import { afterAll, beforeAll, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import directory from "../../functions/lib/content-link-directory.js";
import reader from "../../functions/published-post-reader.js";

const projectId = "demo-njpbs-content-link-capacity";
const app = initializeApp({ projectId }, "content-link-directory-capacity");
const firestore = getFirestore(app);
const now = new Date("2026-11-02T20:00:00.000Z");
const id = (collection: string, index: number) => collection === "cmsPages" ? `page-${index.toString(16).padStart(32, "0")}` : `story-${index}`;
const document = (collection: string, index: number, visible = true) => ({
  type: collection === "cmsPosts" ? "post" : "page", status: visible ? "published" : "archived", publiclyVisible: visible,
  publishAt: "2026-11-01T12:00:00.000Z", deleted: !visible,
  published: { sourceVersion: 1, publishedAt: "2026-11-01T12:00:00.000Z", metadata: {
    title: "Linked reporting", slug: `report-${index}`, ...(collection === "cmsPosts" ? { type: "post" } : {}),
    contentLinkMode: "custom", contentLinkUrl: "https://example.test/report", contentLinkNewTab: true,
  } },
});
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use the loopback demo emulator");
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  for (const collection of ["cmsPosts", "cmsPages"]) {
    for (let offset = 0; offset < 1001; offset += 250) {
      const batch = firestore.batch();
      for (let index = offset; index < Math.min(offset + 250, 1001); index++) batch.set(firestore.doc(`${collection}/${id(collection, index)}`), document(collection, index, index < 500));
      await batch.commit();
    }
  }
}, 20_000);
afterAll(() => deleteApp(app));

it.each(["cmsPosts", "cmsPages"])("refuses excess %s links at publication while allowing edits, disabling and withdrawal", async collection => {
  const admit = (documentId: string, nextDocument: any) => firestore.runTransaction(transaction => directory.assertContentLinkCapacityInTransaction({ firestore, transaction, collection, documentId, nextDocument }));
  await expect(admit(id(collection, 1002), document(collection, 1002))).rejects.toThrow("already 500 public");
  await expect(admit(id(collection, 0), document(collection, 0))).resolves.toBeUndefined();
  await expect(admit(id(collection, 0), { ...document(collection, 0), publiclyVisible: false })).resolves.toBeUndefined();
  const normal = document(collection, 1002);
  normal.published.metadata.contentLinkMode = "normal";
  await expect(admit(id(collection, 1002), normal)).resolves.toBeUndefined();
  // A real withdrawal releases its slot; retained snapshots never consume it.
  await firestore.doc(`${collection}/${id(collection, 0)}`).update({ publiclyVisible: false });
  await expect(firestore.runTransaction(async transaction => {
    const nextDocument = document(collection, 1002);
    await directory.assertContentLinkCapacityInTransaction({ firestore, transaction, collection, documentId: id(collection, 1002), nextDocument });
    transaction.set(firestore.doc(`${collection}/${id(collection, 1002)}`), nextDocument);
  })).resolves.toBeUndefined();
});

it("keeps public reads available with 500 active links and over 500 withdrawn/deleted snapshots per collection", async () => {
  const chrome = await firestore.runTransaction(transaction => reader.readPublishedChrome(firestore, transaction, now), { readOnly: true });
  expect(chrome.contentLinks).toHaveLength(1000);
  expect(chrome.contentLinks?.every((entry: any) => entry.contentLinkUrl === "https://example.test/report")).toBe(true);
});

it("refuses excess directory bytes before publication even below the item count limit", async () => {
  await firestore.doc(`cmsPosts/${id("cmsPosts", 1)}`).update({ publiclyVisible: false });
  const rows = await Promise.all(["cmsPosts", "cmsPages"].map(collection => firestore.collection(collection).where("publiclyVisible", "==", true).get()));
  // Independent serialized directory fixture, using the public address schema.
  const entries = rows.flatMap((snapshot, group) => snapshot.docs.map(row => ({ collection: group ? "cmsPages" : "cmsPosts", id: row.id, document: row.data() })));
  const serialized = () => JSON.stringify(entries.map(({ collection, document: entry }) => ({
    path: `${collection === "cmsPosts" ? "/posts" : ""}/${entry.published.metadata.slug}/`, contentLinkMode: "custom",
    contentLinkUrl: entry.published.metadata.contentLinkUrl, contentLinkNewTab: true,
    previousSlugs: entry.published.metadata.previousSlugs ?? [],
  })));
  const bytes = () => Buffer.byteLength(serialized());
  const batch = firestore.batch();
  let candidate: { id: string; document: any } | undefined;
  for (const entry of entries.filter(entry => entry.collection === "cmsPosts")) {
    const previous = entry.document;
    entry.document = structuredClone(previous);
    Object.assign(entry.document.published.metadata, { contentLinkUrl: "https://example.test/" + "a".repeat(2000),
      previousSlugs: Array.from({ length: 99 }, (_, alias) => `old-${entry.id}-${alias}-${"b".repeat(50)}`) });
    if (bytes() > 1_048_576) {
      const next = document("cmsPosts", 3000);
      Object.assign(next.published.metadata, { contentLinkUrl: "https://example.test/" + "a".repeat(2000),
        previousSlugs: Array.from({ length: 99 }, (_, alias) => `old-new-${alias}-`.padEnd(80, "b")) });
      candidate = { id: id("cmsPosts", 3000), document: next };
      entry.document = previous;
      break;
    }
    batch.set(firestore.doc(`cmsPosts/${entry.id}`), entry.document);
  }
  expect(candidate).toBeDefined();
  expect(bytes()).toBeLessThanOrEqual(1_048_576);
  await batch.commit();
  await expect(firestore.runTransaction(transaction => directory.assertContentLinkCapacityInTransaction({ firestore, transaction,
    collection: "cmsPosts", documentId: candidate!.id, nextDocument: candidate!.document }))).rejects.toThrow("1 MB size limit");
});
