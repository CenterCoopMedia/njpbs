import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stageWordPressArchive } from "../../scripts/stage-wordpress-archive.mjs";
import lifecycle from "../../functions/lifecycle-transition.js";
import scheduled from "../../functions/scheduled-publish.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";

const fixture = fileURLToPath(new URL("../fixtures/wordpress-archive/interchange.ndjson", import.meta.url));
const archive = "wordpressArchiveItems";
const firestore = isolatedFirestore("wordpress-staging");
let scratch;
beforeEach(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${firestore.projectId}/databases/(default)/documents`,
    { method: "DELETE" });
});
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true });
  scratch = undefined;
});

async function tempFile() {
  scratch = await mkdtemp(join(tmpdir(), "wordpress-staging-test-"));
  return join(scratch, "archive.ndjson");
}

async function storyRows(file, ...rows) {
  const [header] = (await readFile(fixture, "utf8")).trimEnd().split("\n");
  const summary = { kind: "summary", counts: { story: rows.length, author: 0, attachment: 0, unmappable: 0 }, reasons: {} };
  await writeFile(file, `${[header, ...[...rows, summary].map(row => JSON.stringify(row))].join("\n")}\n`);
}

async function loadStory() {
  return JSON.parse((await readFile(fixture, "utf8")).split("\n")[2]);
}

function sourceRevision(story, changes) {
  const { revision, ...record } = { ...story, ...changes };
  // The fixture's nested taxonomy entries already use extractor key order.
  const canonical = Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  return { ...record, revision: { ...revision, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") } };
}

it("previews the complete export and keeps a resumed import isolated from publication", async () => {
  const plan = [];
  await expect(stageWordPressArchive({ firestore, file: fixture, report: row => plan.push(row) }))
    .resolves.toEqual({ create: 4, skip: 0, review: 2 });
  expect(plan.at(-1)).toMatchObject({ phase: "plan-complete" });
  expect(await firestore.listCollections()).toHaveLength(0);

  const first = await loadStory();
  const apply = rows => stageWordPressArchive({ firestore, file: fixture, apply: true, report: rows });
  await expect(apply(row => {
    if (row.phase === "apply" && row.sourceRef.postId === first.postId) throw new Error("Synthetic interruption");
  })).rejects.toThrow("Synthetic interruption");
  expect((await firestore.collection(archive).get()).size).toBe(2);
  const [story] = (await firestore.collection(archive).where("kind", "==", "story").get()).docs;
  const receipt = story.ref.collection("archiveImportReceipts").doc("staged");
  const before = (await receipt.get()).data();
  expect(before).toMatchObject({ action: "create", expectedVersion: 0, sourceRef: { source: "example-news", postId: "62" } });
  expect(story.data()).toMatchObject({ version: 1, formatVersion: 1, record: { sourceStatus: "publish", lifecycle: "staged" },
    conversion: { report: { status: "complete" }, blocks: [{ type: "prose" }] } });

  await expect(apply()).resolves.toEqual({ create: 2, skip: 2, review: 2 });
  await expect(apply()).resolves.toEqual({ create: 0, skip: 4, review: 2 });
  expect((await receipt.get()).data()).toEqual(before);
  const schedule = scheduled.createScheduledPublishRunner({ firestore, now: () => "2026-07-15T12:00:00.000Z" });
  await expect(schedule()).resolves.toMatchObject({ publishedCount: 0, changes: [] });
  expect(lifecycle.validateTransitionRequest({ collection: archive, id: story.id, baseVersion: 1, action: "publish" }))
    .toBe("collection must be cmsPages or cmsPosts");
  // The only writes are archive records and receipts. There are no Posts,
  // publication or promotion candidates, editorial audits, or notification jobs.
  expect((await firestore.listCollections()).map(collection => collection.id)).toEqual([archive]);
});

it("distinguishes duplicate IDs from changed source revisions and preserves a concurrent editorial edit", async () => {
  const file = await tempFile();
  const original = await loadStory();
  const updated = sourceRevision(original, { title: "Changed at source" });
  await storyRows(file, original, original, updated);
  await expect(stageWordPressArchive({ firestore, file, apply: true })).resolves.toEqual({ create: 1, skip: 1, review: 1 });
  const [staged] = (await firestore.collection(archive).get()).docs;
  const receipts = staged.ref.collection("archiveImportReceipts");
  expect((await receipts.get()).docs.map(doc => doc.data())).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "create" }),
    expect.objectContaining({ action: "review", reason: "source-revision-conflict", revision: updated.revision }),
  ]));

  const outcomes = [];
  await storyRows(file, updated, original);
  await expect(stageWordPressArchive({ firestore, file, apply: true, report: async row => {
    outcomes.push(row);
    if (row.phase === "plan-complete") await staged.ref.update({ version: 2, editorialTitle: "Staff correction" });
  } })).resolves.toEqual({ create: 0, skip: 1, review: 1 });
  expect(outcomes).toContainEqual(expect.objectContaining({ phase: "apply", action: "review", reason: "staging-changed" }));
  expect((await staged.ref.get()).data()).toMatchObject({ version: 2, editorialTitle: "Staff correction", record: original });
  expect((await receipts.get()).docs.map(doc => doc.data())).toContainEqual(expect.objectContaining({
    reason: "staging-changed", expectedVersion: 1, observedVersion: 2,
  }));

  await staged.ref.delete();
  await storyRows(file, original);
  await expect(stageWordPressArchive({ firestore, file, apply: true })).resolves.toEqual({ create: 0, skip: 0, review: 1 });
  expect((await staged.ref.get()).exists).toBe(false);
});

it("rejects altered records and truncated files before the first write", async () => {
  const file = await tempFile();
  const contents = await readFile(fixture, "utf8");
  for (const [bad, message] of [
    [contents.replace("Transit & the café", "Changed without a digest"), "Invalid archive record or revision"],
    [contents.split("\n").slice(0, -2).join("\n") + "\n", "no complete summary"],
  ]) {
    await writeFile(file, bad);
    await expect(stageWordPressArchive({ firestore, file, apply: true })).rejects.toThrow(message);
    expect(await firestore.listCollections()).toHaveLength(0);
  }
});

it("records a durable review for a source record above the Firestore size budget", async () => {
  const file = await tempFile();
  const oversized = sourceRevision(await loadStory(), { html: "x".repeat(1024 * 1024) });
  await storyRows(file, oversized);
  const options = { firestore, file, apply: true };
  await expect(stageWordPressArchive(options)).resolves.toEqual({ create: 0, skip: 0, review: 1 });
  await expect(stageWordPressArchive(options)).resolves.toEqual({ create: 0, skip: 0, review: 1 });
  expect((await firestore.collection(archive).get()).empty).toBe(true);
  const receipts = await firestore.collectionGroup("archiveImportReceipts").get();
  expect(receipts.docs.map(doc => doc.data())).toEqual([
    expect.objectContaining({ action: "review", reason: "staging-size-limit", revision: oversized.revision }),
  ]);
});

it("keeps the source when only the derived blocks exceed the Firestore depth limit", async () => {
  const file = await tempFile();
  const html = '<ul><li>First<ul><li>Second<ul><li><a href="https://example.org/news">Third</a></li></ul></li></ul></li></ul>';
  const original = sourceRevision(await loadStory(), { html });
  await storyRows(file, original);
  await expect(stageWordPressArchive({ firestore, file, apply: true })).resolves.toEqual({ create: 1, skip: 0, review: 0 });
  const [staged] = (await firestore.collection(archive).get()).docs;
  expect(staged.data()).toMatchObject({ record: original, conversion: { blocks: [], report: {
    status: "manual_review", issues: [{ code: "staging_conversion_depth_limit", start: 0, end: 0 }],
  } } });
});
