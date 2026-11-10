#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sourceContract from "../functions/lib/source-media-contract.js";
import mediaSources from "../functions/lib/media-sources.js";

const { parseSourceMediaAsset, ID_PATTERN } = sourceContract;
import searchOutbox from "../functions/lib/video-search-outbox.js";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

export function sourceRateFromProbe(result) {
  const probes = result?.ProbeResults;
  const videos = probes?.length === 1 ? probes[0].Container?.Tracks?.filter(track => track.TrackType === "video") : null;
  const rate = videos?.length === 1 ? videos[0].VideoProperties?.FrameRate : null;
  if (!Number.isSafeInteger(rate?.Numerator) || !Number.isSafeInteger(rate?.Denominator) ||
      rate.Numerator <= 0 || rate.Denominator <= 0 || rate.Numerator / rate.Denominator > 240) {
    throw new Error("Original frame rate was not measured");
  }
  return { sourceFrameRateNumerator: rate.Numerator, sourceFrameRateDenominator: rate.Denominator };
}

function eligible(snapshot, source) {
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  return asset?.sourceId === "video-library" && asset.rendition?.state === "ready" &&
    mediaSources.objectKeyWithinSource(source, asset.objectKey) &&
    asset.rendition.web.sourceFrameRateNumerator === undefined ? asset : null;
}

export async function backfillSourceRate({ firestore, source, assetId, apply = false, inspectOriginal }) {
  const ref = firestore.collection("mediaSourceAssets").doc(assetId);
  const asset = eligible(await ref.get(), source);
  if (!asset) return { assetId, state: "skipped" };
  if (!apply) return { assetId, state: "eligible", apply: false };
  const rate = sourceRateFromProbe(await inspectOriginal(asset));
  return firestore.runTransaction(async tx => {
    const current = await tx.get(ref);
    const fresh = eligible(current, source);
    if (!fresh || fresh.objectKey !== asset.objectKey || fresh.objectVersionId !== asset.objectVersionId ||
        fresh.sizeBytes !== asset.sizeBytes || fresh.rendition.attemptId !== asset.rendition.attemptId) {
      return { assetId, state: "changed" };
    }
    tx.update(ref, { "rendition.web.sourceFrameRateNumerator": rate.sourceFrameRateNumerator,
      "rendition.web.sourceFrameRateDenominator": rate.sourceFrameRateDenominator });
    searchOutbox.enqueueVideoSearchShard(tx, firestore, assetId);
    tx.create(firestore.collection("admin_logs").doc(), { actorUid: "system:video-source-rate-backfill", actorEmail: null,
      action: "media.source.frame-rate.backfill", target: `mediaSourceAssets/${assetId}`, before: null,
      after: { ...rate, sourceObjectVersionId: asset.objectVersionId }, source: null,
      timestamp: FieldValue.serverTimestamp(), at: new Date().toISOString() });
    return { assetId, state: "measured", ...rate };
  });
}

// Feed the signed URL through process stdin. Provider errors can contain URLs,
// so neither stderr nor the raw response is printed by the command.
function probeUrl(url) {
  return new Promise((resolve, reject) => {
    const process = spawn("aws", ["mediaconvert", "probe", "--profile", "njpbs", "--region", "us-east-2",
      "--cli-input-json", "file:///dev/stdin", "--output", "json", "--no-cli-pager"], { stdio: ["pipe", "pipe", "ignore"], timeout: 120_000 });
    let raw = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", chunk => { raw += chunk; if (raw.length > 1_048_576) process.kill(); });
    process.on("error", () => reject(new Error("Metadata Probe could not start")));
    process.on("close", code => {
      if (code !== 0) return reject(new Error("Metadata Probe failed"));
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("Metadata Probe result was invalid")); }
    });
    process.stdin.on("error", () => {});
    process.stdin.end(JSON.stringify({ InputFiles: [{ FileUrl: url }] }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter(arg => arg !== "--apply");
  if (ids.length !== 1 || !ID_PATTERN.test(ids[0]) || args.filter(arg => arg === "--apply").length > 1) {
    throw new Error("Use one asset ID and optional --apply");
  }
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== "njpbs-site") throw new Error("Wrong Firebase project");
  const registry = mediaSources.buildMediaSourceRegistry({ videoEnabled: process.env.CMS_MEDIA_AWS_VIDEO_ENABLED,
    videoAccountId: process.env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID, videoBucket: process.env.CMS_MEDIA_AWS_VIDEO_BUCKET,
    videoPrefix: process.env.CMS_MEDIA_AWS_VIDEO_PREFIX ?? "", videoRoleArn: process.env.CMS_MEDIA_AWS_VIDEO_ROLE_ARN });
  const source = registry.get("video-library");
  if (!source?.enabled) throw new Error("Configure the existing video source");
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id }, "video-source-rate-backfill");
  const s3 = new S3Client({ region: "us-east-2", credentials: fromIni({ profile: "njpbs" }), maxAttempts: 2 });
  try {
    const result = await backfillSourceRate({ firestore: getFirestore(app), source, assetId: ids[0], apply,
      inspectOriginal: async asset => {
        const params = { Bucket: source.bucket, Key: asset.objectKey, VersionId: asset.objectVersionId,
          ExpectedBucketOwner: source.expectedBucketOwner };
        const head = await s3.send(new HeadObjectCommand(params));
        if (head.VersionId !== asset.objectVersionId || head.ContentLength !== asset.sizeBytes) throw new Error("Original changed");
        const url = await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: 900 });
        return probeUrl(url);
      } });
    console.log(JSON.stringify(result));
  } finally { s3.destroy(); await deleteApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Source rate backfill failed; credential and provider details withheld"); process.exitCode = 1; });
}
