import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import ownership from "../../functions/lib/no-build-record-ownership.js";
import contract from "../../functions/lib/no-build-record-contract.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import context from "../../functions/lib/public-context-revision.js";
import { recordDocument } from "../../site/tests/fixtures/published-records/fixtures";

const rendererSha = "a".repeat(40);
const app = initializeApp({ projectId: "demo-njpbs" }, "record-route-local-fixture");
const db = isolatedFirestore("no-build-record-ownership.test.ts");
function fixture(kind: "program" | "event" = "program", documentId = `${kind}-one`) {
  const source = recordDocument(kind, documentId);
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: {
    ...source.published.metadata, version: 7 }, publishedAt: "2026-10-10T12:00:00.000Z", publishedBy: "editor" });
  const family = kind === "program" ? "programs" : "events";
  const plan = contract.validateNoBuildRecordSnapshot({ family, documentId, snapshot: published });
  const document = { ...source, published };
  const state = { schemaVersion: 1, family, documentId, sourceVersion: 7,
    operationId: "A".repeat(20), snapshotDigest: contract.recordSnapshotDigest(published),
    canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths, visible: true, rendererSha, generation: 3,
    runtime: { owner: "cloudflare", release: rendererSha }, contextRevision: 4,
    contextDigest: context.publicContextDigest(4), admissionRevision: 7 };
  return { state, document };
}
async function claim(state: ReturnType<typeof fixture>["state"], document?: ReturnType<typeof fixture>["document"]) {
  return db.runTransaction(async transaction => {
    const write = await ownership.prepareRecordRouteClaimsInTransaction({ firestore: db, transaction,
      family: state.family, documentId: state.documentId, ownedPaths: state.ownedPaths });
    write();
    transaction.set(db.doc(`${ownership.RECORD_OWNER_COLLECTION}/${state.documentId}`), state);
    if (document) transaction.set(db.doc(`cmsPosts/${state.documentId}`), document);
  });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator.");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterAll(async () => { await deleteApp(app); });

it.each(["program", "event"] as const)("keeps %s canonical and retained claims after withdrawal", async kind => {
  const { state, document } = fixture(kind);
  await claim(state, document);
  const owner = await ownership.readNoBuildRecordOwner({ firestore: db, documentId: state.documentId });
  expect(owner.state).toEqual(state);
  await claim({ ...state, visible: false }, { ...document, publiclyVisible: false });
  const withdrawn = (await ownership.listNoBuildRecordOwners({ firestore: db, family: state.family }))[0].state;
  expect(withdrawn.visible).toBe(false);
  for (const path of state.ownedPaths) {
    expect((await ownership.recordRouteRef(db, path).get()).data()).toEqual({
      schemaVersion: 1, family: state.family, documentId: state.documentId, path });
  }
  expect(() => ownership.assertRecordOwnerSnapshot(withdrawn, { ...document, publiclyVisible: false })).not.toThrow();
});

it("refuses lost aliases, cross-family changes and another record's retained claims", async () => {
  const { state, document } = fixture();
  await claim(state, document);
  await expect(claim({ ...state, ownedPaths: [state.canonicalPath] })).rejects.toThrow("keep every accepted");
  const event = fixture("event");
  await expect(claim({ ...event.state, documentId: state.documentId })).rejects.toThrow("keep every accepted");
  const other = { ...fixture("program", "program-two").state, ownedPaths: ["/shows/earlier-program-one/"] };
  await expect(claim(other)).rejects.toThrow("already has this public address");
});

it("reserves old static addresses even when a record has no cloud owner", async () => {
  const first = fixture();
  await db.doc("cmsPosts/program-one").set({ ...first.document, publiclyVisible: false, status: "archived" });
  const next = fixture("program", "program-two").state;
  await expect(claim({ ...next, ownedPaths: ["/programs/earlier-program-one/"] })).rejects.toThrow("retained record");
  expect((await db.collection(ownership.RECORD_OWNER_COLLECTION).get()).empty).toBe(true);
});

it("serializes competing first admissions of the same Program address", async () => {
  const first = fixture(), second = fixture("program", "program-two");
  second.document.published.metadata.slug = "current-program-one";
  second.document.published.metadata.previousSlugs = ["earlier-program-one"];
  second.state = { ...second.state, canonicalPath: first.state.canonicalPath, ownedPaths: first.state.ownedPaths,
    snapshotDigest: contract.recordSnapshotDigest(second.document.published) };
  const results = await Promise.allSettled([claim(first.state, first.document), claim(second.state, second.document)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(await ownership.listNoBuildRecordOwners({ firestore: db })).toHaveLength(1);
});

it("binds immutable content, visibility, renderer provenance and source floors", () => {
  const { state, document } = fixture();
  expect(() => ownership.assertRecordOwnerSnapshot(state, document)).not.toThrow();
  expect(() => ownership.assertRecordOwnerSnapshot(state, { ...document, title: "Private later draft", version: 20 })).not.toThrow();
  for (const changed of [{ ...document, version: 6 }, { ...document, publicSourceVersion: 8 },
    { ...document, publiclyVisible: false }, { ...document, published: { ...document.published,
      metadata: { ...document.published.metadata, title: "Changed immutable title" } } }]) {
    expect(() => ownership.assertRecordOwnerSnapshot(state, changed)).toThrow();
  }
  for (const patch of [{ schemaVersion: 2 }, { sourceVersion: 0 }, { documentId: "cmsPosts/id" }, { canonicalPath: 7 },
    { canonicalPath: "/shows/current-program-one/" }, { ownedPaths: ["/programs/"] },
    { ownedPaths: ["/events/other/"] }, { contextDigest: "b".repeat(64) },
    { runtime: { owner: "node-compute", release: rendererSha } }, { runtime: { owner: "cloudflare", release: "b".repeat(40) } },
    { extra: "unsupported" }]) {
    expect(() => ownership.validateNoBuildRecordState({ ...state, ...patch })).toThrow();
  }
});

it("refuses corrupt route and owner identity instead of treating it as unowned", async () => {
  const { state } = fixture();
  await ownership.recordRouteRef(db, state.canonicalPath).set({ schemaVersion: 1, family: "programs",
    documentId: "foreign", path: state.canonicalPath });
  await expect(claim(state)).rejects.toThrow("owns this public route");
  await db.doc(`${ownership.RECORD_OWNER_COLLECTION}/${state.documentId}`).set({ ...state, documentId: "foreign" });
  await expect(ownership.readNoBuildRecordOwner({ firestore: db, documentId: state.documentId })).rejects.toThrow();
  await expect(ownership.listNoBuildRecordOwners({ firestore: db })).rejects.toThrow();
});


it("retains a validated withdrawal marker through a later visible record generation", () => {
  const { state } = fixture();
  const durableWithdrawal = { schemaVersion: 1, recordId: state.documentId, family: state.family,
    operationId: state.operationId, sourceVersion: state.sourceVersion, revision: state.generation,
    ownedPaths: state.ownedPaths, snapshotDigest: state.snapshotDigest, contextRevision: state.contextRevision };
  const next = { ...state, operationId: "B".repeat(20), generation: state.generation + 1,
    contextRevision: 5, contextDigest: context.publicContextDigest(5), durableWithdrawal };
  expect(ownership.validateNoBuildRecordState(next)).toEqual(next);
  for (const patch of [{ recordId: "another-record" }, { family: "events" }, { revision: 99 }, { contextRevision: 99 },
    { ownedPaths: ["/programs/unclaimed/"] }, { snapshotDigest: "invalid" }, { extra: true }]) {
    expect(() => ownership.validateNoBuildRecordState({ ...next, durableWithdrawal: { ...durableWithdrawal, ...patch } })).toThrow();
  }
});
