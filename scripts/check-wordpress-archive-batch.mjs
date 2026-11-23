#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { archiveItemRef, firebaseOptions, writeArchiveReportRow } from "./stage-wordpress-archive.mjs";
import { ArchiveInputError, sha256 } from "./lib/wordpress-archive-interchange.mjs";
import { attachmentProblem, HEX_DIGEST, matches, matchesStagingReceipt, POST_ID, readRegularFile,
  SOURCE_KEY } from "./lib/wordpress-archive-staging.mjs";

const MAX_ITEMS = 100;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ENTRY_FIELDS = ["kind", "postId", "revisionSha256", "stagedVersion"];

async function readManifest(file) {
  const bytes = await readRegularFile(file, MAX_MANIFEST_BYTES);
  let manifest;
  try {
    if (bytes) manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ArchiveInputError("Expected a UTF-8 JSON archive batch manifest.");
  }
  if (manifest?.version !== 1 || !matches(manifest.source, SOURCE_KEY) || Object.keys(manifest).length !== 3 ||
      !Array.isArray(manifest.items) || manifest.items.length > MAX_ITEMS) {
    throw new ArchiveInputError(`Expected a version 1 archive batch manifest with one source and at most ${MAX_ITEMS} items.`);
  }

  const seen = new Set();
  const items = manifest.items.map((item, index) => {
    const attachment = item?.kind === "attachment";
    const fields = attachment ? [...ENTRY_FIELDS, "originalSha256"] : ENTRY_FIELDS;
    if (!item || (!attachment && item.kind !== "story") || Object.keys(item).length !== fields.length ||
        !fields.every(key => Object.hasOwn(item, key)) || !matches(item.postId, POST_ID) ||
        !matches(item.revisionSha256, HEX_DIGEST) || !Number.isSafeInteger(item.stagedVersion) || item.stagedVersion < 1 ||
        (attachment && !matches(item.originalSha256, HEX_DIGEST)) || seen.has(item.postId)) {
      throw new ArchiveInputError(`Invalid or repeated archive batch entry at position ${index + 1}.`);
    }
    seen.add(item.postId);
    return Object.fromEntries(fields.map(key => [key, item[key]]));
  });
  if (!items.some(item => item.kind === "story")) throw new ArchiveInputError("The archive batch needs an approved story.");
  return { version: manifest.version, source: manifest.source, items };
}

async function itemProblem({ firestore, reader, source, item, attachments }) {
  const { kind, postId, revisionSha256, stagedVersion } = item;
  const sourceRef = { source, postId };
  const ref = archiveItemRef(firestore, source, postId);
  const [snapshot, accepted] = await reader.getAll(ref, ref.collection("archiveImportReceipts").doc("staged"));
  const staged = snapshot.data();
  const receipt = accepted.data();
  if (staged?.version !== stagedVersion) return "missing-staged-version";
  if (kind === "attachment") {
    const problem = await attachmentProblem({ firestore, reader, staged, receipt, sourceRef, revisionSha256 });
    if (problem) return problem;
    const proof = staged.media;
    return proof?.sourceRevisionSha256 === revisionSha256 && proof.original?.sha256 === item.originalSha256 &&
      ["image", "document"].includes(proof.kind) ? null : "missing-verified-original";
  }
  if (!matchesStagingReceipt(staged, receipt, sourceRef, "story")) return "invalid-staged-story";
  if (staged.record.revision.sha256 !== revisionSha256) return "source-revision-conflict";
  if (staged.record.sourceStatus !== "publish") return "nonpublic-source";
  if (staged.conversion?.report?.status !== "complete" ||
      !Array.isArray(staged.conversion.blocks) || staged.conversion.blocks.length === 0) return "conversion-needs-review";
  const featured = staged.record.featuredAttachmentId;
  return featured === null || attachments.has(featured) ? null : "missing-featured-attachment";
}

/** Check explicitly approved inputs in one read-only Firestore snapshot. */
export async function checkWordPressArchiveBatch({ firestore, manifestFile }) {
  const manifest = await readManifest(manifestFile);
  const { source, items } = manifest;
  const attachments = new Set(items.filter(item => item.kind === "attachment").map(item => item.postId));
  await firestore.runTransaction(async reader => {
    for (const [index, item] of items.entries()) {
      const problem = await itemProblem({ firestore, reader, source, item, attachments });
      if (problem) throw new ArchiveInputError(`Archive batch entry ${index + 1} failed validation (${problem}).`);
    }
  }, { readOnly: true });

  items.sort((left, right) => left.postId === right.postId ? 0 : left.postId < right.postId ? -1 : 1);
  return { phase: "batch-inputs-checked", inputDigest: sha256(JSON.stringify(manifest)),
    stories: items.length - attachments.size, attachments: attachments.size };
}

async function main() {
  let app;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: "string" } } });
    if (positionals.length !== 1 || !matches(values.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)) {
      throw new ArchiveInputError("Usage: node scripts/check-wordpress-archive-batch.mjs <approved.json> --project <project-id>");
    }
    app = initializeApp(await firebaseOptions(values.project), "wordpress-archive-batch-check");
    await writeArchiveReportRow(await checkWordPressArchiveBatch({ firestore: getFirestore(app), manifestFile: positionals[0] }));
  } catch (error) {
    console.error(error instanceof ArchiveInputError ? error.message :
      "Archive batch validation stopped. Check the manifest and target, then rerun the same manifest.");
    process.exitCode = 1;
  } finally {
    if (app) await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
