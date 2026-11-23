#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import documentSize from "../functions/lib/document-size.js";
import media from "../functions/media.js";
import contract from "../functions/lib/media-contract.js";
import { archiveItemRef, firebaseOptions, writeArchiveReportRow } from "./stage-wordpress-archive.mjs";
import { ArchiveInputError, sha256 } from "./lib/wordpress-archive-interchange.mjs";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const POST_ID = /^[1-9][0-9]{0,19}$/;
const ENTRY_FIELDS = ["postId", "revisionSha256", "sha256", "originalName", "mimeType",
  "title", "caption", "altText", "credit", "license"];

const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const text = value => typeof value === "string" && value.isWellFormed();
const review = reason => ({ action: "review", reason });

async function readRegularFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) return null;
    const chunks = [];
    let length = 0;
    for await (const chunk of file.createReadStream({ start: 0, end: limit, autoClose: false })) {
      chunks.push(chunk);
      length += chunk.length;
    }
    return length <= limit && length === stat.size ? Buffer.concat(chunks, length) : null;
  } finally {
    await file.close();
  }
}

async function readManifest(path) {
  const bytes = await readRegularFile(path, MAX_MANIFEST_BYTES);
  let manifest;
  try {
    if (bytes) manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ArchiveInputError("Expected a UTF-8 JSON media manifest.");
  }
  if (manifest?.version !== 1 || !matches(manifest.source, SOURCE_KEY) || !Array.isArray(manifest.items) ||
      Object.keys(manifest).length !== 3) {
    throw new ArchiveInputError("Expected a version 1 media manifest with one source and an items array.");
  }
  const seen = new Set();
  for (const [index, item] of manifest.items.entries()) {
    if (!item || Object.keys(item).length !== ENTRY_FIELDS.length ||
        !ENTRY_FIELDS.every(key => Object.hasOwn(item, key)) ||
        !matches(item.postId, POST_ID) || !matches(item.revisionSha256, HEX_DIGEST) ||
        !matches(item.sha256, HEX_DIGEST) || ![item.originalName, item.mimeType, item.title].every(text) ||
        ![item.caption, item.altText, item.credit, item.license].every(value => value === null || text(value)) ||
        seen.has(item.postId)) {
      throw new ArchiveInputError(`Invalid or repeated media manifest entry at position ${index + 1}.`);
    }
    seen.add(item.postId);
  }
  return manifest;
}

function attachmentProblem(staged, receipt, sourceRef, entry) {
  if (!staged) return "missing-staged-attachment";
  if (staged.kind !== "attachment" || staged.record?.kind !== "attachment" ||
      staged.formatVersion !== 1 || !Number.isSafeInteger(staged.version) || staged.version < 1 ||
      staged.record.lifecycle !== "staged" || staged.record.postId !== sourceRef.postId ||
      !isDeepStrictEqual(staged.sourceRef, sourceRef) || !isDeepStrictEqual(receipt?.sourceRef, sourceRef) ||
      receipt.kind !== "attachment" || receipt.action !== "create" ||
      !isDeepStrictEqual(receipt.revision, staged.record.revision)) return "invalid-staged-attachment";
  if (!["publish", "inherit"].includes(staged.record.sourceStatus)) return "nonpublic-source";
  if (staged.record.revision?.sha256 !== entry.revisionSha256) return "source-revision-conflict";
  return null;
}

async function verifyOriginal(directory, entry) {
  const type = contract.mediaType(entry.mimeType);
  if (!type || type.kind === "audio") return review("unsupported-type");
  let bytes;
  try {
    bytes = await readRegularFile(join(directory, entry.sha256), contract.DEFAULT_MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error.code === "ENOENT") return review("missing-original");
    if (error.code === "ELOOP") return review("invalid-original");
    throw error;
  }
  if (!bytes) return review("invalid-original");
  if (sha256(bytes) !== entry.sha256) return review("checksum-mismatch");

  let metadata;
  let originalName;
  try {
    originalName = contract.normalizeEditableOriginalName(entry.originalName, entry.mimeType);
    metadata = contract.normalizeUploadMetadata({ name: entry.title, description: entry.caption,
      altText: entry.altText, credit: entry.credit, license: entry.license }, originalName);
  } catch (error) {
    if (error instanceof contract.MediaValidationError) return review("invalid-metadata");
    throw error;
  }
  let inspection;
  try {
    inspection = await media.inspectUpload(bytes, entry.mimeType);
  } catch (error) {
    if (error instanceof contract.MediaValidationError) return review("invalid-media-content");
    throw error;
  }
  return { proof: {
    sourceRevisionSha256: entry.revisionSha256,
    kind: type.kind,
    title: metadata.name,
    caption: metadata.description,
    altText: metadata.altText,
    credit: metadata.credit,
    license: metadata.license,
    original: { sha256: entry.sha256, originalName, mimeType: entry.mimeType, sizeBytes: bytes.length,
      ...(type.kind === "image"
        ? { width: inspection.width, height: inspection.height, animated: inspection.animated }
        : { pageCount: inspection.pageCount }) },
  } };
}

function decide(ref, staged, proof, expectedVersion) {
  if (staged.media !== undefined) {
    return isDeepStrictEqual(staged.media, proof)
      ? { action: "skip", reason: "already-verified" }
      : review("original-or-metadata-conflict");
  }
  if (staged.version !== expectedVersion || staged.version >= Number.MAX_SAFE_INTEGER) return review("staging-changed");
  const updated = { ...staged, version: staged.version + 1, media: proof };
  if (documentSize.firestoreDocumentBytes(updated, ref.path) > documentSize.DOCUMENT_SIZE_BUDGET_BYTES) {
    return review("staging-size-limit");
  }
  return { action: "stage" };
}

export async function stageWordPressArchiveMedia({ firestore, manifestFile, originals, apply = false, report = () => {} }) {
  const { source, items } = await readManifest(manifestFile);
  const plan = [];
  const counts = { stage: 0, skip: 0, review: 0 };
  for (const entry of items) {
    const sourceRef = { source, postId: entry.postId };
    const ref = archiveItemRef(firestore, source, entry.postId);
    const receipt = ref.collection("archiveImportReceipts").doc("staged");
    const [doc, accepted] = await firestore.getAll(ref, receipt);
    const staged = doc.data();
    const problem = attachmentProblem(staged, accepted.data(), sourceRef, entry);
    const verified = problem ? review(problem) : await verifyOriginal(originals, entry);
    const result = verified.proof ? decide(ref, staged, verified.proof, staged.version) : verified;
    counts[result.action]++;
    await report({ phase: "plan", sourceRef, ...result });
    if (result.action === "stage") plan.push({ sourceRef, entry, ref, receipt, version: staged.version, proof: verified.proof });
  }
  await report({ phase: "plan-complete", counts });
  if (!apply) return counts;

  const applied = { ...counts, stage: 0 };
  for (const { sourceRef, entry, ref, receipt, version, proof } of plan) {
    const result = await firestore.runTransaction(async transaction => {
      const [doc, accepted] = await transaction.getAll(ref, receipt);
      const staged = doc.data();
      const problem = attachmentProblem(staged, accepted.data(), sourceRef, entry);
      if (problem) return review(problem);
      const decision = decide(ref, staged, proof, version);
      if (decision.action === "stage") transaction.update(ref, { version: version + 1, media: proof });
      return decision;
    });
    applied[result.action]++;
    await report({ phase: "apply", sourceRef, ...result });
  }
  await report({ phase: "apply-complete", counts: applied });
  return applied;
}

async function main() {
  let app;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      project: { type: "string" }, apply: { type: "boolean", default: false },
    } });
    if (positionals.length !== 2 || !matches(values.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)) {
      throw new ArchiveInputError("Usage: node scripts/stage-wordpress-archive-media.mjs <manifest.json> <originals-dir> --project <project-id> [--apply]");
    }
    app = initializeApp(await firebaseOptions(values.project), "wordpress-archive-media");
    await stageWordPressArchiveMedia({ firestore: getFirestore(app), manifestFile: positionals[0],
      originals: positionals[1], apply: values.apply, report: writeArchiveReportRow });
  } catch (error) {
    console.error(error instanceof ArchiveInputError ? error.message :
      "Archive media staging stopped. Check the input and target, then rerun to reconcile committed items.");
    process.exitCode = 1;
  } finally {
    if (app) await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
