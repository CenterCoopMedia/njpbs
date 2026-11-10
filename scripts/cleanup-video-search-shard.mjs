#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { initializeApp, cert, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import cleanup from "../functions/lib/video-search-shard-cleanup.js";

export function cleanupConfig(env = process.env) {
  const bucket = env.CMS_MEDIA_AWS_RENDITION_BUCKET, accountId = env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID;
  if (!/^[0-9]{12}$/.test(accountId ?? "") || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "")) {
    throw Error("search_shard_cleanup_scope_invalid");
  }
  return { bucket, accountId };
}
export function cleanupDiagnostic(error) {
  const own = new Set(["search_shard_invalid", "search_shard_referenced", "search_shard_scope_changed",
    "search_shard_reviewed_fingerprint_required", "search_shard_cleanup_scope_invalid", "search_shard_delete_marker"]);
  if (own.has(error?.message)) return error.message;
  if (error?.message === "Wrong Firebase project") return "firebase_project_mismatch";
  if (error?.message === "Separate cleanup role required") return "cleanup_role_required";
  if (error?.message === "Invalid arguments" || error?.message === "Reviewed fingerprint required") return "invalid_arguments";
  if (error?.name === "AccessDenied") return "storage_access_denied";
  return "cleanup_unconfirmed";
}
export function parseArguments(args) {
  const values = {}, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw Error("Invalid arguments");
    seen.add(flag);
    if (flag === "--apply") { values.apply = true; continue; }
    const key = { "--digest": "digest", "--object-version": "objectVersion", "--expect": "expectedFingerprint" }[flag];
    const value = args[++index];
    if (!key || !value || value.startsWith("--")) throw Error("Invalid arguments");
    values[key] = value;
  }
  cleanup.deletionRef({ collection: () => ({ doc: () => null }) }, values);
  if (values.apply && !/^[a-f0-9]{64}$/.test(values.expectedFingerprint ?? "")) throw Error("Reviewed fingerprint required");
  return { descriptor: { digest: values.digest, objectVersion: values.objectVersion },
    apply: values.apply === true, expectedFingerprint: values.expectedFingerprint };
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") {
    console.log("cleanup-video-search-shard.mjs --digest <sha256> --object-version <exact S3 version> [--apply --expect <reviewed fingerprint>]");
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  const config = cleanupConfig();
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== "njpbs-site") throw Error("Wrong Firebase project");
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id }, "search-shard-cleanup");
  let s3;
  try {
    let remove;
    if (options.apply) {
      const profile = process.env.AWS_PROFILE ?? "njpbs-video-version-cleanup";
      const identity = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--profile", profile, "--output", "json"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      if (identity.Account !== config.accountId ||
          !new RegExp(`^arn:aws:sts::${config.accountId}:assumed-role/njpbs-video-version-cleanup/[^/]+$`).test(identity.Arn ?? "")) {
        throw Error("Separate cleanup role required");
      }
      s3 = new S3Client({ region: "us-east-2", credentials: fromIni({ profile }), maxAttempts: 1 });
      remove = cleanup.shardDeleter(s3, config);
    }
    console.log(JSON.stringify(await cleanup.cleanupSearchShard({ ...options, config, firestore: getFirestore(app), remove })));
  } finally { s3?.destroy(); await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ state: "refused_or_incomplete", code: cleanupDiagnostic(error) })); process.exitCode = 1; });
}
