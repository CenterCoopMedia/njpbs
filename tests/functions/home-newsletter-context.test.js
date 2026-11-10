import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import reader from "../../functions/lib/home-newsletter-context.js";
import deployment from "../../functions/lib/public-deployment.js";
import media from "../../functions/lib/media-contract.js";
import copy from "../../site/tests/fixtures/home-sources/newsletter-public-copy.json";
import context from "../../functions/lib/no-build-page-render-context.js";
import contract from "../../functions/lib/no-build-page-contract.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import homeFixture from "../../site/tests/fixtures/home-composition-v1.json";
import selection from "../../site/tests/fixtures/home-v2-selections.json";

let firestore;
const paths = new Set();
const write = async (path, data) => { paths.add(path); await firestore.doc(path).set(data); };
const cleanup = async () => {
  for (const path of paths) await firestore.doc(path).delete();
  paths.clear();
};
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-home1013)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use the local demo Firestore emulator");
  firestore = isolatedFirestore("home-newsletter-context.test.js");
});
beforeEach(cleanup);
afterAll(async () => { if (firestore) await cleanup(); });
async function newsletter(id, { approved = true, archived = false, art = false, signupUrl = copy.signupUrl } = {}) {
  const snapshot = { type: "newsletter", status: "approved", version: 2, title: `Approved ${id}`,
    signupUrl, summary: copy.summary, privateNote: "PRIVATE approval sibling",
    ...(art ? { imageAssetId: "roster-art", imageAlt: "Approved artwork" } : {}) };
  await write(`cmsPosts/${id}`, { ...snapshot, version: 3, status: archived ? "archived" : "draft",
    title: "PRIVATE working title", signupUrl: "https://private.example.test/", imageAssetId: "private-art" });
  if (approved) await write(`cmsVersionHistory/roster-${id}`, { collection: "cmsPosts", documentId: id,
    action: "approve", after: snapshot });
}
const read = (recordIds = []) => firestore.runTransaction(transaction => reader.readHomeNewslettersInTransaction({
  firestore, transaction, recordIds, pointer: deployment.initialPublicDeploymentPointer(),
}), { readOnly: true });

it("lists unselected immutable approvals while excluding working-only, archived and private fields", async () => {
  await newsletter("roster-one"); await newsletter("roster-two");
  await newsletter("roster-unapproved", { approved: false }); await newsletter("roster-archived", { archived: true });
  const result = await read();
  expect(result.joinedRecords.map(record => record.id)).toEqual(["roster-one", "roster-two"]);
  expect(result.joinedRecords[0].approvedLibraryVersion.title).toBe("Approved roster-one");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(JSON.stringify(result)).not.toContain("private-art");
  await firestore.doc("cmsPosts/roster-two").update({ status: "archived" });
  expect((await read()).joinedRecords.map(record => record.id)).toEqual(["roster-one"]);
});

it("exports only paired approved art and keeps signup text when optional art is missing, mismatched or replacing", async () => {
  await newsletter("roster-one", { art: true });
  const blocks = [...homeFixture.blocks, { id: "selected-newsletter", type: "newsletter_signup", section: "home-newsletter",
    order: 7, visible: true, data: { newsletterIds: ["roster-one"], actionLabel: "Sign up by email", selectionReceipt: selection.editorial.receipt } }];
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { ...homeFixture, homeCompositionVersion: 2, blocks },
    publishedAt: selection.editorial.catalog.cutoffAt, publishedBy: "PRIVATE test actor" });
  const plan = contract.validateNoBuildPageSnapshot({ pageId: "home", snapshot: published });
  expect(plan.recordIds).not.toContain("roster-one");
  const actual = () => firestore.runTransaction(transaction => context.readPageRenderDependenciesInTransaction({
    firestore, transaction, pageId: "home", recordIds: plan.recordIds, page: { path: "/", blocks: published.blocks },
    pointer: deployment.initialPublicDeploymentPointer(), now: new Date(selection.editorial.catalog.cutoffAt),
  }), { readOnly: true });
  expect((await actual()).homeNewsletters.assets).toEqual([]);
  const asset = { id: "roster-art", source: "site_seed", lifecycle: "active", kind: "image",
    url: "https://media.njpbs.org/cms-media/roster-art/fixture.webp", altText: "Approved artwork",
    mimeType: "image/webp", width: 1280, height: 720 };
  await write("media_assets/roster-art", asset);
  await write("media_assets_public/roster-art", JSON.parse(JSON.stringify(media.mediaProjection(asset))));
  expect((await read()).assets).toEqual([{ id: "roster-art", url: asset.url, mimeType: "image/webp", width: 1280, height: 720 }]);
  await firestore.doc("media_assets_public/roster-art").update({ width: 999 });
  expect((await actual()).homeNewsletters.assets).toEqual([]);
  await write("system/media/replacements/roster-art", { state: "pending" });
  const replacing = await actual();
  expect(replacing.homeNewsletters.assets).toEqual([]);
  expect(replacing.homeNewsletters.joinedRecords[0].approvedLibraryVersion.signupUrl).toBe(copy.signupUrl);
  expect(JSON.stringify(replacing)).not.toMatch(/PRIVATE|private-art/);
});
it("filters approved no-link records before bounding the eligible picker pool", async () => {
  for (let index = 0; index < 200; index++) await newsletter(`roster-${String(index).padStart(3, "0")}`, { signupUrl: "" });
  await newsletter("roster-z-eligible");
  expect((await read()).joinedRecords.map(record => record.id)).toEqual(["roster-z-eligible"]);
});
// Saturated snapshots carry usable rows, just like Firestore. The positive
// controls prove that an error cannot come from a malformed stub swallowed by
// the optional-service catch: without the size guards these pools are ready.
function rosterBoundary({ candidateCount = 1, historyCount = 1 } = {}) {
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    id: `candidate-${String(index).padStart(4, "0")}`,
    data: () => ({ type: "newsletter", status: "draft", version: historyCount + 1 }),
  }));
  const query = (collection, ids = []) => ({ collection, ids,
    where: (field, _operator, value) => query(collection, field === "documentId" ? value : ids),
    limit: () => query(collection, ids),
  });
  return {
    firestore: { collection: name => query(name) },
    transaction: { get: async request => {
      if (request.collection === "cmsPosts") return { size: candidates.length, docs: candidates };
      const docs = request.ids.flatMap(id => Array.from({ length: historyCount }, (_, index) => ({
        data: () => ({ collection: "cmsPosts", documentId: id, action: "approve",
          after: { type: "newsletter", status: "approved", version: index + 1,
            title: `Approved ${id}`, signupUrl: copy.signupUrl, summary: copy.summary } }),
      })));
      return { size: docs.length, docs };
    }, getAll: async () => [] }, recordIds: [], pointer: deployment.initialPublicDeploymentPointer(),
  };
}
it("reports a saturated candidate read as an unavailable service without admitting a partial pool or failing Home", async () => {
  const control = await reader.readHomeNewslettersInTransaction(rosterBoundary({ candidateCount: 1000 }));
  expect(control.joinedRecords).toHaveLength(200);
  const result = await reader.readHomeNewslettersInTransaction(rosterBoundary({ candidateCount: 1001 }));
  expect(result).toEqual({ status: "error" });
});

it("bounds the roster at 200 while retaining a selected approved ID beyond its ordinary alphabetical window", async () => {
  for (let index = 0; index < 201; index++) await newsletter(`roster-${String(index).padStart(3, "0")}`);
  const result = await read(["roster-200"]);
  expect(result.joinedRecords).toHaveLength(200);
  expect(result.joinedRecords[0].id).toBe("roster-200");
  expect(result.joinedRecords.some(record => record.id === "roster-199")).toBe(false);
});

it("reads history only until the eligible 200-choice window is full and skips unconditionally revoked candidates", async () => {
  for (let index = 0; index < 210; index++) await newsletter(`roster-${String(index).padStart(3, "0")}`);
  for (let index = 0; index < 10; index++) await newsletter(`archived-${index}`, { archived: true });
  await newsletter("deleted"); await firestore.doc("cmsPosts/deleted").update({ deleted: true });
  await newsletter("invalid-version"); await firestore.doc("cmsPosts/invalid-version").update({ version: 0 });
  const names = new WeakMap();
  const queries = [];
  let inFlight = 0, maximumInFlight = 0;
  const bounded = {
    collection(name) {
      const track = query => ({ where: (...args) => track(query.where(...args)),
        limit: size => { const final = query.limit(size); names.set(final, name); return final; } });
      return track(firestore.collection(name));
    },
    doc: path => firestore.doc(path),
  };
  const result = await firestore.runTransaction(async transaction => reader.readHomeNewslettersInTransaction({
    firestore: bounded, transaction: {
      get: async query => {
        const name = names.get(query);
        if (name === "cmsVersionHistory") { inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight); }
        try { const rows = await transaction.get(query); queries.push({ collection: name, size: rows.size }); return rows; }
        finally { if (name === "cmsVersionHistory") inFlight--; }
      },
      getAll: (...refs) => transaction.getAll(...refs),
    }, recordIds: ["roster-209"], pointer: deployment.initialPublicDeploymentPointer(),
  }), { readOnly: true });
  expect(result.joinedRecords).toHaveLength(200);
  expect(result.joinedRecords[0].id).toBe("roster-209");
  expect(queries.filter(query => query.collection === "cmsPosts")).toEqual([{ collection: "cmsPosts", size: 222 }]);
  const history = queries.filter(query => query.collection === "cmsVersionHistory");
  expect(history).toHaveLength(20);
  expect(history.reduce((sum, query) => sum + query.size, 0)).toBe(200);
  expect(maximumInFlight).toBe(20);
});

it("contains candidate/history read failures and saturated history as an unavailable optional service", async () => {
  for (const mode of ["candidate-error", "history-error"]) {
    const query = { where: () => query, limit: () => query };
    let reads = 0;
    const result = await reader.readHomeNewslettersInTransaction({ firestore: { collection: () => query },
      transaction: { get: async () => {
        reads++;
        if (reads === 1) {
          if (mode === "candidate-error") throw new Error("database boundary unavailable");
          return { size: 1, docs: [{ id: "candidate", data: () => ({ status: "draft", version: 3 }) }] };
        }
        if (mode === "history-error") throw new Error("history boundary unavailable");
        throw new Error("Unexpected query");
      } }, recordIds: [], pointer: deployment.initialPublicDeploymentPointer() });
    expect(result).toEqual({ status: "error" });
  }
  const control = await reader.readHomeNewslettersInTransaction(rosterBoundary({ historyCount: 1000 }));
  expect(control.joinedRecords.map(record => record.id)).toEqual(["candidate-0000"]);
  expect(control.joinedRecords[0].approvedLibraryVersion.version).toBe(1000);
  const saturated = await reader.readHomeNewslettersInTransaction(rosterBoundary({ historyCount: 1001 }));
  expect(saturated).toEqual({ status: "error" });
});
