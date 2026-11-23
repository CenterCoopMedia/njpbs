#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import documentSize from "../functions/lib/document-size.js";
import converter from "../functions/wordpress-archive-content.js";
import { ArchiveInputError, readWordPressArchive, sha256 } from "./lib/wordpress-archive-interchange.mjs";

const COLLECTION = "wordpressArchiveItems";
const FORMAT_VERSION = 1;
const digest = parts => sha256(JSON.stringify(parts));

function fitsFirestoreDepth(value, depth = 0) {
  if (value === null || typeof value !== "object") return true;
  return depth < 20 && Object.values(value).every(child => fitsFirestoreDepth(child, depth + 1));
}

function candidate(firestore, source, record) {
  const sourceRef = record.kind === "author" ? { source, authorId: record.authorId } : { source, postId: record.postId };
  const id = digest(record.kind === "author" ? [source, "author", record.authorId] : [source, "item", record.postId]);
  const ref = firestore.collection(COLLECTION).doc(id);
  const receipts = ref.collection("archiveImportReceipts");
  const document = { formatVersion: FORMAT_VERSION, version: 1, kind: record.kind, sourceRef, record };
  if (record.kind === "story") {
    document.conversion = converter.convertWordPressStory({ html: record.html, permalink: record.permalink, sourceRef });
  }
  let stagingError;
  if (!fitsFirestoreDepth(document)) stagingError = "staging-depth-limit";
  else if (documentSize.firestoreDocumentBytes(document, ref.path) > documentSize.DOCUMENT_SIZE_BUDGET_BYTES) {
    stagingError = "staging-size-limit";
  }
  return { ref, receipts, document, accepted: receipts.doc("staged"), stagingError };
}

function versionOf(current) {
  if (current === undefined) return 0;
  return Number.isSafeInteger(current.version) && current.version > 0 ? current.version : null;
}

function decide(item, current, accepted, expectedVersion = versionOf(current)) {
  const { record, sourceRef, kind } = item.document;
  const version = versionOf(current);
  if (current === undefined) {
    if (accepted) return { action: "review", reason: "missing-staged-record" };
    if (expectedVersion !== 0) return { action: "review", reason: "staging-changed" };
    if (item.stagingError) return { action: "review", reason: item.stagingError };
    return { action: "create" };
  }
  if (version === null || !accepted || current.formatVersion !== FORMAT_VERSION ||
      current.sourceRef?.source !== sourceRef.source || current.sourceRef?.postId !== sourceRef.postId ||
      current.sourceRef?.authorId !== sourceRef.authorId || !current.record?.revision) {
    return { action: "review", reason: "invalid-staging-state" };
  }
  const saved = current.record.revision;
  if (current.kind === kind && saved.sha256 === record.revision.sha256 && saved.modifiedAt === record.revision.modifiedAt) {
    return { action: "skip", reason: "already-staged" };
  }
  return { action: "review", reason: version === expectedVersion ? "source-revision-conflict" : "staging-changed" };
}

async function commit(firestore, item, expectedVersion) {
  return firestore.runTransaction(async transaction => {
    const [snapshot, accepted] = await transaction.getAll(item.ref, item.accepted);
    const current = snapshot.data();
    const result = decide(item, current, accepted.exists, expectedVersion);
    if (result.action === "skip") return result;

    const { sourceRef, kind, record: { revision } } = item.document;
    const receipt = { sourceRef, kind, revision, ...result, expectedVersion,
      observedVersion: versionOf(current), recordedAt: FieldValue.serverTimestamp() };
    if (result.action === "create") {
      transaction.create(item.ref, item.document);
      transaction.create(item.accepted, receipt);
    } else {
      const ref = item.receipts.doc(digest([kind, revision.sha256, revision.modifiedAt, result.reason]));
      if (!(await transaction.get(ref)).exists) transaction.create(ref, receipt);
    }
    return result;
  });
}

function reportRow(phase, number, item, result) {
  const { kind, sourceRef, conversion } = item.document;
  return { phase, line: number, kind, sourceRef, ...result,
    ...(conversion && { conversionStatus: conversion.report.status }) };
}

async function plan(firestore, input, report) {
  const expectedVersions = [];
  const plannedCreates = new Map();
  const counts = { create: 0, skip: 0, review: 0 };
  for await (const { source, number, row } of readWordPressArchive(input)) {
    if (row.kind === "unmappable") {
      counts.review++;
      await report({ phase: "plan", line: number, source, ...row, action: "review" });
      continue;
    }
    const item = candidate(firestore, source, row);
    const planned = plannedCreates.get(item.ref.id);
    const snapshots = planned ? null : await firestore.getAll(item.ref, item.accepted);
    const current = planned ?? snapshots[0].data();
    const result = decide(item, current, planned ? true : snapshots[1].exists);
    expectedVersions[number] = versionOf(current);
    if (result.action === "create") {
      const { formatVersion, version, kind, sourceRef, record: { revision } } = item.document;
      plannedCreates.set(item.ref.id, { formatVersion, version, kind, sourceRef, record: { revision } });
    }
    counts[result.action]++;
    await report(reportRow("plan", number, item, result));
  }
  await report({ phase: "plan-complete", counts });
  return { counts, expectedVersions };
}

async function applyPlan(firestore, input, expectedVersions, report) {
  const counts = { create: 0, skip: 0, review: 0 };
  for await (const { source, number, row } of readWordPressArchive(input)) {
    if (row.kind === "unmappable") {
      counts.review++;
      continue;
    }
    const item = candidate(firestore, source, row);
    const result = await commit(firestore, item, expectedVersions[number]);
    counts[result.action]++;
    await report(reportRow("apply", number, item, result));
  }
  await report({ phase: "apply-complete", counts });
  return counts;
}

async function privateSnapshot(file) {
  const directory = await mkdtemp(join(tmpdir(), "wordpress-archive-"));
  try {
    const path = join(directory, "archive.ndjson");
    await copyFile(file, path);
    // Unlink while the descriptor is open so the snapshot is reachable only by this run.
    return await open(path, "r");
  } finally {
    await rm(directory, { recursive: true });
  }
}

/** Plan the complete file, then reconcile one item and its receipt per transaction. */
export async function stageWordPressArchive({ firestore, file, apply = false, report = () => {} }) {
  if (!(await stat(file)).isFile()) throw new ArchiveInputError("The interchange must be a regular file.");
  if (!apply) return (await plan(firestore, createReadStream(file), report)).counts;
  const snapshot = await privateSnapshot(file);
  const input = () => snapshot.createReadStream({ start: 0, autoClose: false });
  try {
    const { expectedVersions } = await plan(firestore, input(), report);
    return await applyPlan(firestore, input(), expectedVersions, report);
  } finally {
    await snapshot.close();
  }
}

async function firebaseOptions(projectId) {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (emulator !== undefined) {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(emulator) || !projectId.startsWith("demo-")) {
      throw new ArchiveInputError("An emulator run requires a loopback host and explicit demo project.");
    }
    return { projectId };
  }
  if (projectId.startsWith("demo-")) throw new ArchiveInputError("A demo project requires a local emulator.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(null, { fd: 3 })) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new ArchiveInputError("Invalid service account input.");
    chunks.push(chunk);
  }
  const account = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (account?.type !== "service_account" || account.project_id !== projectId) {
    throw new ArchiveInputError("The service account project must match the requested project.");
  }
  return { projectId, credential: cert(account) };
}

async function main() {
  let app;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      project: { type: "string" }, apply: { type: "boolean", default: false },
    } });
    if (positionals.length !== 1 || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project ?? "")) {
      throw new ArchiveInputError("Usage: node scripts/stage-wordpress-archive.mjs <archive.ndjson> --project <project-id> [--apply]");
    }
    app = initializeApp(await firebaseOptions(values.project), "wordpress-archive-import");
    await stageWordPressArchive({ firestore: getFirestore(app), file: positionals[0], apply: values.apply,
      report: row => new Promise((resolveWrite, reject) => {
        process.stdout.write(`${JSON.stringify(row)}\n`, error => error ? reject(error) : resolveWrite());
      }),
    });
  } catch (error) {
    console.error(error instanceof ArchiveInputError ? error.message : "Archive staging stopped. Keep the input and rerun to reconcile committed items.");
    process.exitCode = 1;
  } finally {
    if (app) await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
