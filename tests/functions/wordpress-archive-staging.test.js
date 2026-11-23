import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkWordPressArchiveBatch } from "../../scripts/check-wordpress-archive-batch.mjs";
import { archiveItemRef, stageWordPressArchive } from "../../scripts/stage-wordpress-archive.mjs";
import { stageWordPressArchiveMedia } from "../../scripts/stage-wordpress-archive-media.mjs";
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

async function writeArchive(file, ...rows) {
  const [header] = (await readFile(fixture, "utf8")).trimEnd().split("\n");
  const counts = { story: 0, author: 0, attachment: 0, unmappable: 0 };
  for (const row of rows) counts[row.kind]++;
  const summary = { kind: "summary", counts, reasons: {} };
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

it("checks one approved archive batch and rejects stale, incomplete, or private inputs", async () => {
  const manifestFile = await tempFile();
  const source = "example-news";
  const [story, attachment, future] = (await readFile(fixture, "utf8")).trimEnd().split("\n").slice(2, 5).map(JSON.parse);
  await stageWordPressArchive({ firestore, file: fixture, apply: true });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  const originalSha256 = createHash("sha256").update(png).digest("hex");
  await writeFile(join(scratch, originalSha256), png);
  const writeManifest = items => writeFile(manifestFile, JSON.stringify({ version: 1, source, items }));
  await writeManifest([{ postId: attachment.postId, revisionSha256: attachment.revision.sha256,
    sha256: originalSha256, originalName: "train.png", mimeType: "image/png", title: "Train",
    caption: null, altText: "Train", credit: null, license: null }]);
  await expect(stageWordPressArchiveMedia({ firestore, manifestFile, originals: scratch, apply: true }))
    .resolves.toEqual({ stage: 1, skip: 0, review: 0 });

  const entry = (row, stagedVersion) => ({ kind: row.kind, postId: row.postId, revisionSha256: row.revision.sha256, stagedVersion });
  const storyEntry = entry(story, 1);
  const attachmentEntry = { ...entry(attachment, 2), originalSha256 };
  const check = (reader = firestore) => checkWordPressArchiveBatch({ firestore: reader, manifestFile });
  for (const [items, reason] of [
    [[storyEntry, storyEntry], "repeated archive batch entry"],
    [[storyEntry], "missing-featured-attachment"],
    [[storyEntry, { ...attachmentEntry, originalSha256: "a".repeat(64) }], "missing-verified-original"],
    [[entry(future, 1)], "nonpublic-source"],
  ]) {
    await writeManifest(items);
    await expect(check()).rejects.toThrow(reason);
  }

  await writeManifest([storyEntry, attachmentEntry]);
  let reads = 0;
  const interrupted = {
    collection: firestore.collection.bind(firestore),
    runTransaction: (inspect, options) => firestore.runTransaction(transaction => inspect({
      async getAll(...refs) {
        if (++reads === 2) throw new Error("Synthetic interrupted read");
        return transaction.getAll(...refs);
      },
    }), options),
  };
  await expect(check(interrupted)).rejects.toThrow("Synthetic interrupted read");
  const first = await check();
  expect(first).toEqual({ phase: "batch-inputs-checked", inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), stories: 1, attachments: 1 });
  await writeManifest([attachmentEntry, storyEntry]);
  await expect(check()).resolves.toEqual(first);

  await archiveItemRef(firestore, source, story.postId).update({ version: 2 });
  await expect(check()).rejects.toThrow("missing-staged-version");
  await writeManifest([entry(story, 2), attachmentEntry]);
  expect((await check()).inputDigest).not.toBe(first.inputDigest);
  expect((await firestore.listCollections()).map(collection => collection.id)).toEqual([archive]);
});

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
  await writeArchive(file, original, original, updated);
  await expect(stageWordPressArchive({ firestore, file, apply: true })).resolves.toEqual({ create: 1, skip: 1, review: 1 });
  const [staged] = (await firestore.collection(archive).get()).docs;
  const receipts = staged.ref.collection("archiveImportReceipts");
  expect((await receipts.get()).docs.map(doc => doc.data())).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "create" }),
    expect.objectContaining({ action: "review", reason: "source-revision-conflict", revision: updated.revision }),
  ]));

  const outcomes = [];
  await writeArchive(file, updated, original);
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
  await writeArchive(file, original);
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
  await writeArchive(file, oversized);
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
  await writeArchive(file, original);
  await expect(stageWordPressArchive({ firestore, file, apply: true })).resolves.toEqual({ create: 1, skip: 0, review: 0 });
  const [staged] = (await firestore.collection(archive).get()).docs;
  expect(staged.data()).toMatchObject({ record: original, conversion: { blocks: [], report: {
    status: "manual_review", issues: [{ code: "staging_conversion_depth_limit", start: 0, end: 0 }],
  } } });
});

it("stages verified image and PDF originals by attachment identity and keeps review cases private", async () => {
  const file = await tempFile();
  const source = "example-news";
  const fixtureAttachment = JSON.parse((await readFile(fixture, "utf8")).split("\n")[3]);
  const attachment = sourceRevision(fixtureAttachment, { attachmentUrl: "https://example.org/uploads/train.png" });
  const stagedRef = postId => archiveItemRef(firestore, source, postId);
  const [document, duplicate, privateItem, missing, changed, unsupported] =
    ["70", "71", "72", "73", "74", "75"].map(postId => sourceRevision(attachment, {
      postId, sourceStatus: postId === "72" ? "private" : "inherit",
      ...(postId === "70" && { attachmentUrl: "https://example.org/uploads/schedule.pdf", title: "Service schedule" }),
    }));
  const publishedParent = await loadStory();
  const privateParent = sourceRevision(publishedParent, { postId: "76", sourceStatus: "private" });
  const inheritedPrivate = sourceRevision(attachment, { postId: "77", parentPostId: privateParent.postId });
  const inheritedUnknown = sourceRevision(attachment, { postId: "78", parentPostId: null });
  await writeArchive(file, publishedParent, privateParent, attachment, document, duplicate, privateItem, missing, changed,
    unsupported, inheritedPrivate, inheritedUnknown);
  await stageWordPressArchive({ firestore, file, apply: true });

  const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  const pdfDocument = await PDFDocument.create();
  pdfDocument.addPage();
  pdfDocument.addPage();
  const pdf = await pdfDocument.save();
  const imageHash = createHash("sha256").update(png).digest("hex");
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  await writeFile(join(scratch, imageHash), png);
  await writeFile(join(scratch, pdfHash), pdf);
  const imageEntry = { postId: attachment.postId, revisionSha256: attachment.revision.sha256,
    sha256: imageHash, originalName: "train.png", mimeType: "image/png", title: "Train",
    caption: "A train at the station.", altText: "Blue train", credit: "Archive Photography", license: "Approved for reuse" };
  const item = (row, fields = {}) => ({ ...imageEntry, postId: row.postId, revisionSha256: row.revision.sha256, ...fields });
  const missingHash = "a".repeat(64);
  const incorrectHash = "b".repeat(64);
  await writeFile(join(scratch, incorrectHash), png);
  const items = [
    imageEntry,
    item(document, { sha256: pdfHash, originalName: "schedule.pdf", mimeType: "application/pdf", title: "Service schedule", altText: null }),
    item(duplicate),
    item(privateItem, { sha256: missingHash }),
    item(missing, { sha256: missingHash }),
    item(changed, { sha256: incorrectHash }),
    item(unsupported, { mimeType: "image/svg+xml" }),
    item(inheritedPrivate),
    item(inheritedUnknown),
  ];
  const manifestFile = join(scratch, "approved.json");
  const writeManifest = entries => writeFile(manifestFile, JSON.stringify({ source, version: 1, items: entries }));
  const options = { firestore, manifestFile, originals: scratch };
  await writeManifest([...items, imageEntry]);
  await expect(stageWordPressArchiveMedia({ ...options, apply: true })).rejects.toThrow("repeated media manifest entry");
  await writeManifest(items);
  const rows = [];
  await expect(stageWordPressArchiveMedia({ ...options, report: row => rows.push(row) }))
    .resolves.toEqual({ stage: 3, skip: 0, review: 6 });
  expect(rows.filter(row => row.action === "review").map(row => row.reason))
    .toEqual(["nonpublic-source", "missing-original", "checksum-mismatch", "unsupported-type", "nonpublic-source", "unverified-parent"]);
  expect((await stagedRef(attachment.postId).get()).data().media).toBeUndefined();

  await expect(stageWordPressArchiveMedia({ ...options, apply: true, report: async row => {
    if (row.phase === "plan-complete") await stagedRef(document.postId).update({ version: 2, editorialTitle: "Staff correction" });
  } })).resolves.toEqual({ stage: 2, skip: 0, review: 7 });
  expect((await stagedRef(document.postId).get()).data()).toMatchObject({ version: 2, editorialTitle: "Staff correction" });
  expect((await stagedRef(document.postId).get()).data().media).toBeUndefined();
  await expect(stageWordPressArchiveMedia({ ...options, apply: true })).resolves.toEqual({ stage: 1, skip: 2, review: 6 });
  await expect(stageWordPressArchiveMedia({ ...options, apply: true })).resolves.toEqual({ stage: 0, skip: 3, review: 6 });

  const image = (await stagedRef(attachment.postId).get()).data();
  expect(image).toMatchObject({ version: 2, sourceRef: { source, postId: attachment.postId }, record: attachment });
  expect(image.media).toEqual({
    sourceRevisionSha256: attachment.revision.sha256, kind: "image", title: "Train", caption: "A train at the station.",
    altText: "Blue train", credit: "Archive Photography", license: "Approved for reuse",
    original: { sha256: imageHash, originalName: "train.png", mimeType: "image/png", sizeBytes: png.length, width: 8, height: 4, animated: false },
  });
  const storedPdf = (await stagedRef(document.postId).get()).data();
  expect(storedPdf.media).toMatchObject({
    kind: "document", title: "Service schedule", altText: null,
    original: { sha256: pdfHash, originalName: "schedule.pdf", mimeType: "application/pdf", sizeBytes: pdf.length, pageCount: 2 },
  });
  const sameBytes = (await stagedRef(duplicate.postId).get()).data();
  expect(sameBytes.sourceRef.postId).toBe(duplicate.postId);
  expect(sameBytes.media.original.sha256).toBe(imageHash);
  expect((await stagedRef(privateItem.postId).get()).data().media).toBeUndefined();
  expect((await stagedRef(inheritedPrivate.postId).get()).data().media).toBeUndefined();
  expect((await stagedRef(inheritedUnknown.postId).get()).data().media).toBeUndefined();
  expect((await firestore.listCollections()).map(collection => collection.id)).toEqual([archive]);

  await writeManifest([{ ...imageEntry, caption: "A replacement caption" },
    item(document, { revisionSha256: imageEntry.revisionSha256 })]);
  rows.length = 0;
  await expect(stageWordPressArchiveMedia({ ...options, apply: true, report: row => rows.push(row) }))
    .resolves.toEqual({ stage: 0, skip: 0, review: 2 });
  expect(rows.filter(row => row.action === "review").map(row => row.reason))
    .toEqual(["original-or-metadata-conflict", "source-revision-conflict"]);
  expect((await stagedRef(attachment.postId).get()).data()).toEqual(image);
});
