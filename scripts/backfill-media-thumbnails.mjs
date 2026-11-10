#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";
import mediaContract from "../functions/lib/media-contract.js";
import thumbnailModule from "../functions/lib/media-thumbnails.js";
import storageModule from "../functions/lib/r2-media.js";

const PAGE_SIZE = 100;
const CONCURRENCY = 2;
// Several uniformly transient failures suggest a service outage. One or two
// optional thumbnails must not block a Functions deployment.
const MIN_OUTAGE_CANDIDATES = 3;
const PROJECT_ID = "njpbs-site";
const { finalObjectKey, MAX_IMAGE_PIXELS, MEDIA_TYPES } = mediaContract;
const { createMediaThumbnails, MediaThumbnailError, thumbnailWidths } = thumbnailModule;
const { R2MediaStorage } = storageModule;

function validImageRecord(id, asset) {
  if (asset?.lifecycle !== "active" || asset.kind !== "image") return false;
  if (MEDIA_TYPES[asset.mimeType]?.kind !== "image") return false;
  if (!Number.isSafeInteger(asset.width) || asset.width < 1) return false;
  if (!Number.isSafeInteger(asset.height) || asset.height < 1) return false;
  try {
    return asset.storageKey === finalObjectKey({
      category: asset.category,
      assetId: id,
      contentHash: asset.contentHash,
      mimeType: asset.mimeType,
    });
  } catch {
    return false;
  }
}

function needsThumbnails(id, asset) {
  return validImageRecord(id, asset) && !(Array.isArray(asset.thumbnails) &&
    thumbnailWidths(asset.width).every((width) =>
      asset.thumbnails.some((thumbnail) => thumbnail.width === width)));
}

function needsAnimationFlag(id, asset) {
  // Page seeds have no R2 object. scripts/backfill-page-seed-media.mjs classifies them.
  return validImageRecord(id, asset) && asset.animated !== true && asset.animated !== false;
}

function needsBackfill(id, asset) {
  return asset?.thumbnailStatus !== "unavailable" &&
    (needsThumbnails(id, asset) || needsAnimationFlag(id, asset));
}

async function mapWithConcurrency(values, callback) {
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, worker));
}

async function checkedImageWidth(buffer, asset) {
  let metadata;
  try {
    const image = sharp(buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    metadata = await image.metadata();
    await image.stats();
  } catch {
    throw new MediaThumbnailError("The image cannot be decoded safely");
  }
  const frameHeight = metadata.pageHeight ?? metadata.height;
  const width = metadata.orientation >= 5 && metadata.orientation <= 8
    ? frameHeight
    : metadata.width;
  const height = metadata.orientation >= 5 && metadata.orientation <= 8
    ? metadata.width
    : frameHeight;
  if (
    metadata.format !== MEDIA_TYPES[asset.mimeType].sharpFormat ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS ||
    width !== asset.width || height !== asset.height
  ) {
    throw new MediaThumbnailError("Source image does not match the asset record");
  }
  return { width, animated: (metadata.pages ?? 1) > 1 };
}

function isTransientFailure(error) {
  const status = error?.$metadata?.httpStatusCode;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  // gRPC deadline, quota, aborted transaction and unavailable statuses.
  if ([4, 8, 10, 14].includes(error?.code)) return true;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code) ||
    ["TimeoutError", "RequestTimeout", "RequestTimeoutException"].includes(error?.name);
}

async function backfillOne({ firestore, storage, publicOrigin, document }) {
  const asset = document.data();
  try {
    const createdKeys = [];
    let thumbnails;
    let animated;
    let unavailable = false;
    try {
      const buffer = await storage.get(asset.storageKey);
      if (createHash("sha256").update(buffer).digest("hex") !== asset.contentHash) {
        throw new MediaThumbnailError("The original hash does not match the asset record");
      }
      const checked = await checkedImageWidth(buffer, asset);
      animated = checked.animated;
      thumbnails = needsThumbnails(document.id, asset)
        ? await createMediaThumbnails({
          buffer,
          width: checked.width,
          category: asset.category,
          assetId: document.id,
          contentHash: asset.contentHash,
          publicOrigin,
          storage,
          createdKeys,
        })
        : null;
    } catch (error) {
      if (!(error instanceof MediaThumbnailError)) throw error;
      console.warn(`Thumbnail backfill skipped asset ${document.id}: ${error.name}`);
      unavailable = true;
    }
    const updated = await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(document.ref);
      if (!current.exists) return "stale";
      const stored = current.data();
      if (
        stored.lifecycle !== "active" ||
        stored.contentHash !== asset.contentHash ||
        stored.storageKey !== asset.storageKey ||
        stored.width !== asset.width ||
        stored.height !== asset.height
      ) return "stale";
      if (!needsBackfill(document.id, stored)) return "skipped";
      const patch = {};
      if (unavailable) {
        patch.thumbnailStatus = "unavailable";
      } else {
        if (thumbnails && needsThumbnails(document.id, stored)) {
          patch.thumbnails = thumbnails;
          patch.thumbnailStatus = "ready";
        }
      }
      if (typeof animated === "boolean" && stored.animated !== true && stored.animated !== false) {
        patch.animated = animated;
      }
      if (Object.keys(patch).length === 0) return "skipped";
      transaction.update(document.ref, patch);
      return unavailable ? "unavailable" : "updated";
    });
    if (updated === "stale") {
      // The asset identity changed, so nothing can name these keys. A skipped
      // result can mean another writer already adopted the same keys.
      await Promise.allSettled(createdKeys.map((key) => storage.deleteFinal(key)));
      return "skipped";
    }
    return updated;
  } catch (error) {
    if (isTransientFailure(error)) {
      console.warn(`Thumbnail backfill deferred asset ${document.id}: ${error?.name || "Error"}`);
      return "retryable";
    }
    console.warn(`Thumbnail backfill failed for asset ${document.id}: ${error?.name || "Error"}`);
    return "failed";
  }
}

export async function backfillMediaThumbnails({
  firestore,
  storage,
  publicOrigin,
  apply = false,
} = {}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (apply && (!storage || typeof storage.get !== "function" || !publicOrigin)) {
    throw new Error("R2 storage and a public origin are required for --apply");
  }

  const result = {
    apply, scanned: 0, eligible: 0, updated: 0, skipped: 0, unavailable: 0, failed: 0,
    retryable: 0, retryableIds: [], eligibleIds: [],
  };
  let cursor = null;
  while (true) {
    let query = firestore.collection("media_assets")
      .orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    result.scanned += page.size;
    result.unavailable += page.docs.filter((document) =>
      validImageRecord(document.id, document.data()) &&
      document.data().thumbnailStatus === "unavailable").length;
    const candidates = page.docs.filter((document) =>
      needsBackfill(document.id, document.data()));
    result.eligible += candidates.length;
    result.eligibleIds.push(...candidates.map((document) => document.id));
    if (apply) {
      await mapWithConcurrency(candidates, async (document) => {
        const outcome = await backfillOne({ firestore, storage, publicOrigin, document });
        result[outcome] += 1;
        if (outcome === "retryable") result.retryableIds.push(document.id);
      });
    }
    cursor = page.docs.at(-1).id;
  }
  return result;
}

/** Only this pass's known transient failures may remain eligible after apply. */
export function uploadedMediaReleaseReady(applied, verified) {
  if (applied?.failed !== 0 || verified?.failed !== 0) return false;
  if (applied.eligible >= MIN_OUTAGE_CANDIDATES && applied.retryable === applied.eligible) return false;
  if (verified.eligible === 0) return true;
  const retryableIds = new Set(applied.retryableIds ?? []);
  return Array.isArray(verified.eligibleIds) && verified.eligibleIds.length === verified.eligible &&
    verified.eligibleIds.every((id) => retryableIds.has(id));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.length > 1) {
    throw new Error("Usage: node scripts/backfill-media-thumbnails.mjs [--apply]");
  }
  const apply = args.includes("--apply");
  const env = process.env;
  const requiredR2 = [
    "CMS_MEDIA_R2_ENDPOINT", "CMS_MEDIA_R2_BUCKET",
    "CMS_MEDIA_R2_ACCESS_KEY_ID", "CMS_MEDIA_R2_SECRET_ACCESS_KEY",
    "CMS_MEDIA_PUBLIC_ORIGIN",
  ];
  // config-input: CMS_MEDIA_PUBLIC_ORIGIN, CMS_MEDIA_R2_ACCESS_KEY_ID, CMS_MEDIA_R2_BUCKET, CMS_MEDIA_R2_ENDPOINT
  // config-input: CMS_MEDIA_R2_SECRET_ACCESS_KEY
  if (apply && requiredR2.some((name) => !env[name])) {
    throw new Error("CMS_MEDIA_R2_* and CMS_MEDIA_PUBLIC_ORIGIN are required for --apply");
  }

  // The service account JSON arrives on stdin, as in the other backfill scripts,
  // so the Firebase key never reaches argv, the environment or the disk. The R2
  // variables for --apply still come from the environment.
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== PROJECT_ID) throw new Error("Wrong Firebase project");
  const app = initializeApp({ credential: cert(credential), projectId: PROJECT_ID });
  try {
    const storage = apply ? new R2MediaStorage({
      endpoint: env.CMS_MEDIA_R2_ENDPOINT,
      bucket: env.CMS_MEDIA_R2_BUCKET,
      accessKeyId: env.CMS_MEDIA_R2_ACCESS_KEY_ID,
      secretAccessKey: env.CMS_MEDIA_R2_SECRET_ACCESS_KEY,
    }) : null;
    const result = await backfillMediaThumbnails({
      firestore: getFirestore(app),
      storage,
      publicOrigin: apply ? env.CMS_MEDIA_PUBLIC_ORIGIN : null,
      apply,
    });
    console.log(JSON.stringify(result));
    if (apply) {
      const verified = await backfillMediaThumbnails({
        firestore: getFirestore(app),
        apply: false,
      });
      console.log(JSON.stringify({ verify: true, ...verified }));
      if (!uploadedMediaReleaseReady(result, verified)) {
        throw new Error("Uploaded media classification is incomplete");
      }
    }
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Thumbnail backfill failed: ${error?.name || "Error"}`);
    process.exitCode = 1;
  });
}
