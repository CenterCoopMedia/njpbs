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
import { registerWordPressArchiveMedia } from "../../scripts/register-wordpress-archive-media.mjs";
import lifecycle from "../../functions/lifecycle-transition.js";
import scheduled from "../../functions/scheduled-publish.js";
import listMedia from "../../functions/list-media.js";
import { renderBlock } from "../../packages/content-core/src/content-render.ts";
import preview from "../../functions/preview.js";
import publicContent from "../../functions/public-content.js";
import purge from "../../functions/lib/media-purge-executor.js";
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

it("registers approved originals independently and delivers only admitted assets to editors and readers", async () => {
  const file = await tempFile();
  const source = "example-news";
  const parent = await loadStory();
  const attachment = JSON.parse((await readFile(fixture, "utf8")).split("\n")[3]);
  const [image, duplicate, document, privateItem, unstaged] = ["63", "64", "65", "66", "67"].map(postId =>
    sourceRevision(attachment, { postId, parentPostId: parent.postId, sourceStatus: postId === "66" ? "private" : "inherit" }));
  await writeArchive(file, parent, image, duplicate, document, privateItem, unstaged);
  await stageWordPressArchive({ firestore, file, apply: true });
  const png = await sharp({ create: { width: 16, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const pdfDocument = await PDFDocument.create();
  pdfDocument.addPage();
  const pdf = Buffer.from(await pdfDocument.save());
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(scratch, digest(png)), png);
  await writeFile(join(scratch, digest(pdf)), pdf);
  const manifestItem = (row, fields = {}) => ({ postId: row.postId, revisionSha256: row.revision.sha256,
    sha256: digest(png), originalName: "train.png", mimeType: "image/png", title: "Train",
    caption: "A train at the station.", altText: "Blue train", credit: "Archive Photography",
    license: "Approved for reuse", ...fields });
  const manifest = [manifestItem(image), manifestItem(duplicate, { title: "Another record for the train" }),
    manifestItem(document, { sha256: digest(pdf), originalName: "schedule.pdf", mimeType: "application/pdf",
      title: "Service schedule", altText: null }), manifestItem(privateItem), manifestItem(unstaged)];
  const manifestFile = join(scratch, "approved.json");
  const writeManifest = items => writeFile(manifestFile, JSON.stringify({ source, version: 1, items }));
  const options = { firestore, manifestFile, originals: scratch };
  await writeManifest(manifest.slice(0, 3));
  await stageWordPressArchiveMedia({ ...options, apply: true });
  await writeManifest(manifest);
  const staged = row => archiveItemRef(firestore, source, row.postId);
  const id = row => `archive-${staged(row).id}`;
  const imageProof = (await staged(image).get()).data().media;
  // A copied verification payload alone cannot approve an explicitly private source.
  await staged(privateItem).update({ media: { ...imageProof, sourceRevisionSha256: privateItem.revision.sha256 } });

  const objects = new Map();
  const storage = {
    async putFinal({ key, body, mimeType, metadata }) {
      if (objects.has(key)) return { created: false };
      objects.set(key, { bytes: body, contentType: mimeType, contentLength: body.length, metadata });
      return { created: true };
    },
    async head(key) { return objects.get(key); },
  };
  const rows = [];
  const register = (overrides = {}) => registerWordPressArchiveMedia({ ...options, publicOrigin: "https://media.njpbs.org",
    getStorage: () => storage, report: row => rows.push(row), ...overrides });
  await expect(register()).resolves.toEqual({ register: 3, skip: 0, review: 2 });
  expect(rows.filter(row => row.action === "review").map(row => row.reason)).toEqual(["nonpublic-source", "original-not-staged"]);
  expect(objects.size).toBe(0);
  await firestore.doc("mediaCategories/general").set({ id: "general", label: "General", description: "",
    order: 10, active: true, version: 1 });
  await expect(register({ apply: true, report: async row => {
    if (row.phase === "plan-complete") await staged(document).update({ version: 3 });
  } })).resolves.toEqual({ register: 2, skip: 0, review: 3 });
  expect([...objects.keys()].every(key => !key.includes(id(document)))).toBe(true);

  // An interrupted write can resume against the same immutable object and owner.
  const write = storage.putFinal;
  storage.putFinal = async input => {
    await write(input);
    throw Error("Synthetic interrupted write");
  };
  const head = storage.head;
  storage.head = async () => null;
  await expect(register({ apply: true })).rejects.toThrow("Synthetic interrupted write");
  expect(rows.at(-1)).toMatchObject({ phase: "apply", sourceRef: { source, postId: document.postId },
    action: "failed", reason: "apply-interrupted" });
  storage.putFinal = write;
  storage.head = head;
  await expect(register({ apply: true })).resolves.toEqual({ register: 1, skip: 2, review: 2 });
  await expect(register({ apply: true })).resolves.toEqual({ register: 0, skip: 3, review: 2 });

  const asset = row => firestore.doc(`media_assets/${id(row)}`);
  const publicAsset = row => firestore.doc(`media_assets_public/${id(row)}`);
  const registered = (await asset(image).get()).data();
  const second = (await asset(duplicate).get()).data();
  const notice = (await asset(document).get()).data();
  expect(registered).toMatchObject({ archiveImport: { source, postId: image.postId,
    revisionSha256: image.revision.sha256, originalSha256: digest(png) }, contentHash: digest(png),
    thumbnailStatus: "ready", thumbnails: [{ width: 16, height: 8 }] });
  expect(second).toMatchObject({ contentHash: digest(png), name: "Another record for the train" });
  expect(second.storageKey).not.toBe(registered.storageKey);
  expect(objects.get(registered.storageKey).bytes).toEqual(png);
  expect(objects.get(registered.thumbnails[0].storageKey).contentType).toBe("image/webp");
  expect(objects.get(notice.storageKey).bytes).toEqual(pdf);
  expect(notice.archiveImport).toMatchObject({ pageCount: 1, originalSha256: digest(pdf) });
  expect((await publicAsset(document).get()).data()).not.toHaveProperty("archiveImport");
  expect([...objects.keys()].some(key => key.includes(id(privateItem)) || key.includes(id(unstaged)))).toBe(false);
  for (const record of [registered, second]) {
    const owner = await firestore.runTransaction(transaction => purge.ownedReceipt(transaction, firestore,
      record.id, record.contentHash, [record.storageKey]));
    expect(owner.data()?.assetId).toBe(record.id);
  }
  const { records } = await listMedia.readMediaAssetSummariesByIds(firestore, [image, document, privateItem, unstaged].map(id));
  expect(records).toMatchObject([
    { id: id(image), description: "A train at the station.", altText: "Blue train", credit: "Archive Photography",
      license: "Approved for reuse", kind: "image" },
    { id: id(document), name: "Service schedule", kind: "document", mimeType: "application/pdf" },
  ]);

  const date = "2026-11-20T00:00:00.000Z";
  const blocks = [
    { id: "image", type: "image", order: 0, visible: true,
      data: { assetId: records[0].id, alt: records[0].altText, caption: records[0].description } },
    { id: "notices", type: "document_list", order: 1, visible: true,
      data: { documents: [{ itemId: "schedule", assetId: records[1].id, title: records[1].name, addedAt: date }] } },
  ];
  const pageId = "public-meetings";
  const pageRef = firestore.doc(`cmsPages/${pageId}`);
  const page = { title: "Archive fixtures", description: "Synthetic archive media", template: "genericPage",
    status: "published", version: 7, blocks, publishAt: date, publiclyVisible: true,
    published: { metadata: { title: "Archive fixtures", description: "Synthetic archive media" },
      blocks, publishedAt: date, publishedBy: "editor", sourceVersion: 7 },
  };
  await pageRef.set(page);
  await firestore.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready",
    rendererSha: preview.EMULATOR_RENDERER_SHA, serializerId: "cloud-preview" });
  const enqueue = sourceVersion => preview.enqueuePreview({ pageId, sourceVersion,
    actor: { uid: "editor", principal: { id: "editor", grants: [{ role: "admin" }] } } },
  { firestore, getTransport: () => "serializer", serializerReady: true,
    getRendererSha: () => preview.EMULATOR_RENDERER_SHA });
  const { queueId } = await enqueue(7);
  const saved = (await firestore.doc(`cmsPreviewQueue/${queueId}`).get()).data();
  expect(saved.sourceVersion).toBe(7);
  const render = (content, assets) => content.map(block => renderBlock(block,
    { resolveAsset: assetId => assets[assetId], showImageCredits: true })).join("");
  const previewHtml = render(saved.snapshot.blocks, Object.fromEntries(saved.assets.map(media => [media.id, media])));
  expect(previewHtml).toContain(`src="${registered.url}"`);
  expect(previewHtml).toContain(`href="${notice.url}"`);

  await firestore.doc("system/publicDeployment").set({ schemaVersion: 1, mediaLifecycleReady: true,
    state: "idle", activeGeneration: 1, activeDeploymentId: "fixture-deployment", activeCommitSha: "b".repeat(40),
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build" });
  const readPublicPage = () => publicContent.readPublicPageProjection({ firestore, pageId, now: new Date("2026-11-21") });
  const publicPage = (await readPublicPage()).page;
  const publicHtml = render(publicPage.blocks, publicPage.assets);
  expect(publicHtml).toContain('alt="Blue train"');
  expect(publicHtml).toContain("A train at the station.");
  expect(publicHtml).toContain("Archive Photography");
  expect(publicHtml).toContain(`href="${notice.url}"`);

  const privateBlocks = [{ ...blocks[0], data: { ...blocks[0].data, assetId: id(privateItem) } }, blocks[1]];
  await pageRef.update({ version: 8, blocks: privateBlocks, "published.blocks": privateBlocks });
  await expect(enqueue(8)).rejects.toThrow("is missing");
  await expect(readPublicPage()).rejects.toThrow();
  expect((await publicAsset(privateItem).get()).exists).toBe(false);
});
