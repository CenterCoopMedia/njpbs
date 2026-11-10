#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../functions/package.json", import.meta.url));

// This estimate reads app records only. It neither proves S3 readability nor
// creates the source-verified durable inventory used by the transfer runner.
export async function inventoryRecords({ db, sourceBucket }) {
  const { inventoryPage } = require("../functions/lib/video-backup.js");
  const receipt = { phase: "inventory", sourceVerified: false, complete: false,
    scanned: 0, eligibleFiles: 0, eligibleBytes: 0, gapCount: 0, gapReasons: {} };
  let after = null;
  do {
    const page = await inventoryPage({ db, sourceBucket, after, recordsOnly: true });
    receipt.scanned += page.scanned;
    receipt.eligibleFiles += page.eligibleFiles;
    receipt.eligibleBytes += page.eligibleBytes;
    receipt.gapCount += page.gaps.length;
    for (const gap of page.gaps) receipt.gapReasons[gap.reason] = (receipt.gapReasons[gap.reason] || 0) + 1;
    after = page.nextCursor;
  } while (after !== null);
  return { ...receipt, complete: true, completedAt: new Date().toISOString() };
}

// R2 has no bucket ACL API. Check its actual public endpoints and the lock
// protecting archives from deletion/overwrite by the object-write credential.
export async function assertPrivateBackupBucket({ accountId, bucket, apiToken, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}`;
  const [managed, custom, lock] = await Promise.all(["domains/managed", "domains/custom", "lock"].map(async path => {
    const response = await fetchImpl(`${base}/${path}`, {
      headers: { authorization: `Bearer ${apiToken}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body?.success !== true) throw Error("Backup bucket policy unreadable");
    return body.result;
  }));
  if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.length !== 0) {
    throw Error("Backup bucket must have no public domains");
  }
  if (!Array.isArray(lock?.rules) || !lock.rules.some(rule => rule.enabled === true &&
      [undefined, "", "viewing-copies-v1/"].includes(rule.prefix) && rule.condition?.type === "Indefinite")) {
    throw Error("Backup archive prefix must have an indefinite bucket lock");
  }
}

export function backupExitCode(result) {
  return result.copy?.failed > 0 || result.inventory?.gapReasons?.source_unreadable > 0 ||
    result.inventory?.gapReasons?.source_identity_mismatch > 0 ? 1 : 0;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 1 || !["--inventory", "--tick"].includes(args[0])) throw Error("Invalid backup mode");
  const inventory = args[0] === "--inventory";
  if (!inventory && env.NJPBS_VIDEO_BACKUP_ENABLED !== "true") return { phase: "disabled" };
  if (env.FIRESTORE_EMULATOR_HOST || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.CMS_MEDIA_AWS_RENDITION_BUCKET || "")) {
    throw Error("Production rendition binding required");
  }
  const input = JSON.parse(readFileSync(0, "utf8"));
  const firebase = inventory ? input : input.firebase;
  if (firebase?.project_id !== "njpbs-site") throw Error("Wrong Firebase project");
  if (!inventory && (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || "") ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.NJPBS_VIDEO_BACKUP_BUCKET || "") ||
      !/^\d{12}$/.test(env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID || "") ||
      !isAbsolute(env.NJPBS_VIDEO_BACKUP_STATE_DIR || "") || !env.NJPBS_VIDEO_BACKUP_AWS_PROFILE ||
      !input.r2?.accessKeyId || !input.r2?.secretAccessKey || !input.cloudflareApiToken)) {
    throw Error("Backup runtime binding required");
  }
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ credential: cert(firebase), projectId: "njpbs-site" });
  const clients = [];
  try {
    const db = getFirestore(app), sourceBucket = env.CMS_MEDIA_AWS_RENDITION_BUCKET;
    if (inventory) return await inventoryRecords({ db, sourceBucket });
    const { S3Client } = require("@aws-sdk/client-s3");
    const { fromIni } = require("@aws-sdk/credential-providers");
    const { createVideoBackupSource } = require("../functions/lib/video-backup-source.js");
    const { createR2BackupDestination } = require("../functions/lib/video-backup-r2.js");
    const { createFileBackupState } = await import("./lib/video-backup-files.mjs");
    const { createVideoBackupRunner } = await import("./lib/video-backup-runner.mjs");
    const accountId = env.CLOUDFLARE_ACCOUNT_ID, bucket = env.NJPBS_VIDEO_BACKUP_BUCKET;
    const options = { maxAttempts: 1, requestHandler: { connectionTimeout: 10_000, requestTimeout: 30 * 60_000 },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" };
    const sourceClient = new S3Client({ ...options, region: "us-east-2",
      credentials: fromIni({ profile: env.NJPBS_VIDEO_BACKUP_AWS_PROFILE }) });
    const destinationClient = new S3Client({ ...options, region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: async () => input.r2 });
    clients.push(sourceClient, destinationClient);
    const assertPrivate = () => assertPrivateBackupBucket({ accountId, bucket, apiToken: input.cloudflareApiToken });
    await assertPrivate();
    const source = createVideoBackupSource({ client: sourceClient, bucket: sourceBucket,
      expectedBucketOwner: env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID });
    const destination = createR2BackupDestination({ client: destinationClient, bucket, singleWriter: true, assertPrivate });
    // Destination identity is part of state ownership; another bucket/account
    // must never reuse a previous destination's verified-job receipts.
    const directory = join(env.NJPBS_VIDEO_BACKUP_STATE_DIR, accountId, bucket);
    const stagingDirectory = join(directory, "staging");
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const state = createFileBackupState(directory);
    const result = await createVideoBackupRunner({ db, source, sourceBucket, destination, state, stagingDirectory }).tick({ allowCopy: true });
    process.exitCode = backupExitCode(result);
    return result;
  } finally {
    for (const client of clients) client.destroy();
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    const reason = ["BACKUP_LOCK_HELD", "BACKUP_LOCK_UNAVAILABLE"].includes(error.code) ? error.code : "details suppressed";
    console.error(`Video backup failed; ${reason}`);
    process.exitCode = 1;
  });
}
