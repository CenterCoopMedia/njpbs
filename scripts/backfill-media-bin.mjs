#!/usr/bin/env node

// Emulator rehearsal only. Existing tombstones receive the deployment date +
// 30 days, never their original deletion date. No object storage is accessed.
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-media-bin.mjs \
//   --deploy-date 2026-09-25T12:00:00.000Z [--apply]
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";
import mediaBin from "../functions/lib/media-bin.js";

const { createImagePurgeEntry, mediaPurgeRef, purgeAfterFor } = mediaBin;
const PAGE_SIZE = 100;
const PROJECT_ID = "demo-njpbs";

function assertEmulator() {
  if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(
    process.env.FIRESTORE_EMULATOR_HOST || "",
  )) {
    throw new Error("Backfill requires a local FIRESTORE_EMULATOR_HOST; production is forbidden");
  }
}

export async function backfillMediaBin({
  firestore,
  deployDate,
  apply = false,
  nowIso = new Date().toISOString(),
} = {}) {
  assertEmulator();
  if (!firestore?.projectId?.startsWith("demo-")) {
    throw new Error("Backfill requires a demo- Firestore project");
  }
  if (typeof deployDate !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(deployDate) ||
      !Number.isFinite(Date.parse(deployDate))) {
    throw new Error("An explicit ISO --deploy-date with timezone is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("Invalid audit timestamp");
  const purgeAfter = purgeAfterFor(new Date(deployDate).toISOString());
  const result = { dryRun: !apply, purgeAfter, scanned: 0, eligible: 0, migrated: 0, skipped: 0, invalidAssetIds: [] };
  let cursor = null;
  while (true) {
    let query = firestore.collection("media_assets")
      .where("lifecycle", "==", "tombstoned")
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      result.scanned += 1;
      const outcome = await firestore.runTransaction(async (transaction) => {
        // Re-read both documents so restore, new deletion, and a purge claim
        // cannot be overwritten by a stale scan or a repeated invocation.
        const queueRef = mediaPurgeRef(firestore, document.id);
        const [snapshot, queue] = await Promise.all([
          transaction.get(document.ref), transaction.get(queueRef),
        ]);
        const stored = snapshot.data();
        if (!snapshot.exists || stored.lifecycle !== "tombstoned" ||
            stored.source !== "upload" || stored.kind !== "image" ||
            stored.purgeAfter !== undefined || queue.exists) return false;
        let entry;
        try {
          entry = createImagePurgeEntry(document.id, stored, nowIso, purgeAfter);
        } catch {
          // Report malformed legacy records without guessing deletion keys.
          return "invalid";
        }
        if (apply) {
          transaction.update(document.ref, { purgeAfter });
          transaction.create(queueRef, entry);
          transaction.create(firestore.collection("admin_logs").doc(), {
            actorUid: "system:media-bin-backfill",
            actorEmail: null,
            action: "media.bin.backfill",
            target: `media_assets/${document.id}`,
            before: { lifecycle: stored.lifecycle, purgeAfter: null },
            after: { lifecycle: stored.lifecycle, purgeAfter, queueId: queueRef.id },
            source: "backfill-media-bin",
            timestamp: FieldValue.serverTimestamp(),
            at: nowIso,
          });
        }
        return true;
      });
      if (outcome === "invalid") result.invalidAssetIds.push(document.id);
      else if (outcome) {
        result.eligible += 1;
        if (apply) result.migrated += 1;
      } else result.skipped += 1;
    }
    cursor = page.docs.at(-1).id;
  }
  return result;
}

async function main() {
  assertEmulator();
  const args = process.argv.slice(2);
  let deployDate;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--deploy-date") deployDate = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  const app = initializeApp({ projectId: PROJECT_ID }, "media-bin-backfill");
  try {
    console.log(JSON.stringify(await backfillMediaBin({
      firestore: getFirestore(app), deployDate, apply,
    }), null, 2));
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
