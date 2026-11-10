#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");
const { currentIdentity, enqueueCopy } = require("./lib/private-video-copy");

export function argumentsFor(args) {
  const result = { apply: false, pages: 1 };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply" && !result.apply) result.apply = true;
    else if (args[index] === "--retry-failed" && /^[a-f0-9]{64}$/.test(args[index + 1] ?? "")) result.retryId = args[++index];
    else if (args[index] === "--pages" && /^[1-9]\d?$/.test(args[index + 1] ?? "")) result.pages = Number(args[++index]);
    else throw Error("Invalid arguments");
  }
  return result;
}

export async function backfillPage({ firestore, source, apply = false, documentId }) {
  const progress = firestore.collection("mediaSourceImportCheckpoints").doc("private-video-v1");
  const saved = (await progress.get()).data() ?? {};
  let query = firestore.collection("mediaSourceAssets").orderBy(documentId).limit(50);
  if (saved.cursor) query = query.startAfter(saved.cursor);
  const page = await query.get();
  const counts = { scanned: 0, ready: 0, missingViewingCopy: 0, inactiveOrOtherSource: 0 };
  for (const snapshot of page.docs) {
    counts.scanned++;
    if (!currentIdentity(source, snapshot)) {
      const data = snapshot.data();
      if (data.lifecycle === "active" && data.sourceId === source.id) counts.missingViewingCopy++;
      else counts.inactiveOrOtherSource++;
      continue;
    }
    counts.ready++;
    if (apply) await enqueueCopy({ firestore, source, assetId: snapshot.id });
  }
  // Only advance after every enqueue has committed; replay is idempotent after a crash.
  if (apply) await firestore.runTransaction(async tx => {
    const current = (await tx.get(progress)).data() ?? {};
    if (current.cursor !== saved.cursor) throw Error("Backfill cursor changed");
    tx.set(progress, { cursor: page.docs.at(-1)?.id ?? saved.cursor ?? null,
    complete: page.size < 50, counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value + (saved.counts?.[key] ?? 0)])),
    updatedAt: new Date().toISOString() });
  });
  return { ...counts, complete: page.size < 50, apply };
}

async function main() {
  const { apply, pages, retryId } = argumentsFor(process.argv.slice(2));
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== "njpbs-site") throw Error("Wrong Firebase project");
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id });
  try {
    // The approved source facts are server-owned, not supplied on this command line.
    const bucket = process.env.CMS_MEDIA_AWS_VIDEO_BUCKET;
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "")) throw Error("Deployed video bucket required");
    const source = { id: "video-library", bucket };
    if (retryId) {
      const db = getFirestore(app);
      const job = (await db.collection("mediaPrivateVideoCopies").doc(retryId).get()).data();
      if (!job || job.phase !== "failed") throw Error("Failed copy required");
      const snapshot = await db.collection("mediaSourceAssets").doc(job.identity.assetId).get();
      if (currentIdentity(source, snapshot)?.id !== retryId) throw Error("Copy binding changed");
      if (apply) await enqueueCopy({ firestore: db, source, assetId: job.identity.assetId, repair: true });
      console.log(JSON.stringify({ apply, eligible: true, retry: true }));
      return;
    }
    for (let page = 0; page < (apply ? pages : 1); page++) {
      const result = await backfillPage({ firestore: getFirestore(app), source, apply, documentId: FieldPath.documentId() });
      console.log(JSON.stringify(result));
      if (result.complete) break;
    }
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const refusals = ["Invalid arguments", "Deployed video bucket required", "Wrong Firebase project", "Failed copy required",
      "Copy binding changed", "Backfill cursor changed"];
    console.error(refusals.includes(error?.message) ? error.message : "Private video backfill failed");
    process.exitCode = 1;
  });
}
