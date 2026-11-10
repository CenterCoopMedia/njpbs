#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import searchOutbox from "../functions/lib/video-search-outbox.js";
import mediaSources from "../functions/lib/media-sources.js";
import sourceContract from "../functions/lib/source-media-contract.js";
import uploadContract from "../functions/lib/source-media-upload-contract.js";

const PAGE_SIZE = 100;
const PROFILE = "njpbs";
const REGION = "us-east-2";
const CHECKPOINT_COLLECTION = "mediaSourceImports";
const { buildMediaSourceRegistry, objectKeyWithinSource } = mediaSources;
const { ID_PATTERN, parseSourceMediaAsset } = sourceContract;
const { VIDEO_MIME_EXTENSIONS, normalizeVideoMimeType } = uploadContract;

function configuredRegistry(env) {
  return buildMediaSourceRegistry({
    videoEnabled: env.CMS_MEDIA_AWS_VIDEO_ENABLED,
    videoAccountId: env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID,
    videoBucket: env.CMS_MEDIA_AWS_VIDEO_BUCKET,
    videoPrefix: env.CMS_MEDIA_AWS_VIDEO_PREFIX ?? "",
    videoRoleArn: env.CMS_MEDIA_AWS_VIDEO_ROLE_ARN,
    archiveEnabled: env.CMS_MEDIA_AWS_ARCHIVE_ENABLED,
    archiveAccountId: env.CMS_MEDIA_AWS_ARCHIVE_ACCOUNT_ID,
    archiveOriginalsBucket: env.CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_BUCKET,
    archiveOriginalsPrefix: env.CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_PREFIX ?? "",
    archiveWorkingBucket: env.CMS_MEDIA_AWS_ARCHIVE_WORKING_BUCKET,
    archiveWorkingPrefix: env.CMS_MEDIA_AWS_ARCHIVE_WORKING_PREFIX ?? "",
    archiveRoleArn: env.CMS_MEDIA_AWS_ARCHIVE_ROLE_ARN,
  });
}

function assetIdFor(sourceId, key) {
  return createHash("sha256").update(`${sourceId}\0${key}`).digest("hex").slice(0, 40);
}

function replacementAssetIdForKey(source, key) {
  const prefix = source.prefix && !source.prefix.endsWith("/") ? `${source.prefix}/` : source.prefix;
  const objectPrefix = `${prefix}objects/`;
  if (!key.startsWith(objectPrefix)) return null;
  const [assetId, directory, file, ...rest] = key.slice(objectPrefix.length).split("/");
  if (!ID_PATTERN.test(assetId) || directory !== "replacements" || rest.length || !file) return null;
  return Object.values(VIDEO_MIME_EXTENSIONS).some(extension =>
    file.endsWith(extension) && ID_PATTERN.test(file.slice(0, -extension.length))) ? assetId : null;
}

function boardwalkAssetIdForKey(source, key) {
  const replacementId = replacementAssetIdForKey(source, key);
  if (replacementId) return replacementId;
  const prefix = source.prefix && !source.prefix.endsWith("/")
    ? `${source.prefix}/`
    : source.prefix;
  const objectPrefix = `${prefix}objects/`;
  if (!key.startsWith(objectPrefix)) return null;
  const fileName = key.slice(objectPrefix.length);
  for (const extension of Object.values(VIDEO_MIME_EXTENSIONS)) {
    if (!fileName.endsWith(extension)) continue;
    const assetId = fileName.slice(0, -extension.length);
    return ID_PATTERN.test(assetId) ? assetId : null;
  }
  return null;
}

function indexedAssetId(source, item, head) {
  const boardwalkId = boardwalkAssetIdForKey(source, item.Key);
  if (boardwalkId && head.Metadata?.["boardwalk-asset"] === boardwalkId) {
    return boardwalkId;
  }
  return assetIdFor(source.id, item.Key);
}

function candidateAssetIds(source, item) {
  return [...new Set([
    boardwalkAssetIdForKey(source, item.Key),
    assetIdFor(source.id, item.Key),
  ].filter(Boolean))];
}

function previewFor(mimeType) {
  return ["video/mp4", "video/webm", "video/mpeg"].includes(mimeType)
    ? "browser"
    : "download_only";
}

async function mapWithConcurrency(values, concurrency, callback) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await callback(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

function storedSourceAsset(existing, source, key, { ignoreMismatch = false } = {}) {
  if (!existing?.exists) return null;
  const data = existing.data();
  if (data?.sourceId !== source.id || data?.objectKey !== key) {
    if (ignoreMismatch) return null;
    throw new Error(`Indexed asset ${existing.id} conflicts with ${source.id}`);
  }
  if (!["active", "tombstoned", "deleted"].includes(data?.lifecycle)) {
    throw new Error(`Indexed asset ${existing.id} has an invalid lifecycle`);
  }
  const parsed = parseSourceMediaAsset(existing.id, {
    ...data,
    lifecycle: "active",
  });
  if (!parsed) {
    throw new Error(`Indexed asset ${existing.id} conflicts with ${source.id}`);
  }
  return { data, parsed };
}

function importedAsset(source, assetId, version, head, existing, now) {
  const originalName = basename(version.Key);
  let mimeType;
  try {
    mimeType = normalizeVideoMimeType(head.ContentType, originalName);
  } catch {
    return null;
  }
  const lastModified = version.LastModified instanceof Date
    ? version.LastModified.toISOString()
    : now;
  const previous = existing?.parsed;
  const name = previous?.name ?? originalName;
  const data = {
    id: assetId,
    sourceId: source.id,
    lifecycle: "active",
    name,
    originalName,
    description: previous?.description ?? null,
    nameSort: name.normalize("NFKC").toLocaleLowerCase("en-US"),
    updatedAtSort: now,
    mimeType,
    kind: "video",
    sizeBytes: version.Size,
    preview: previewFor(mimeType),
    license: previous?.license ?? null,
    credit: previous?.credit ?? null,
    tags: previous?.tags ?? [],
    rightsStatus: previous?.rightsStatus ?? "pending",
    version: previous ? previous.version + 1 : 1,
    createdAt: previous?.createdAt ?? lastModified,
    createdBy: existing?.data.createdBy ?? "system:s3-source-import",
    updatedAt: now,
    updatedBy: "system:s3-source-import",
    objectKey: version.Key,
    objectVersionId: version.VersionId,
    checksumSha256: head.ChecksumSHA256 ?? null,
  };
  return parseSourceMediaAsset(data.id, data) ? data : null;
}

export async function importSourcePage({ firestore, s3, source, restart = false, now = new Date().toISOString() }) {
  const checkpointRef = firestore.collection(CHECKPOINT_COLLECTION).doc(source.id);
  const checkpointSnapshot = await checkpointRef.get();
  let checkpoint = checkpointSnapshot.exists ? checkpointSnapshot.data() : null;
  if (checkpoint?.status === "complete" && !restart) {
    return { indexed: 0, skipped: 0, tombstoned: 0, complete: true, checkpoint };
  }
  if (restart || !checkpoint) {
    checkpoint = {
      sourceId: source.id,
      runId: randomUUID(),
      status: "active",
      keyMarker: null,
      versionIdMarker: null,
      indexed: 0,
      skipped: 0,
      tombstoned: 0,
      startedAt: now,
      updatedAt: now,
    };
    await checkpointRef.set(checkpoint);
  }
  const page = await s3.send(new ListObjectVersionsCommand({
    Bucket: source.bucket,
    Prefix: source.prefix,
    ExpectedBucketOwner: source.expectedBucketOwner,
    KeyMarker: checkpoint.keyMarker ?? undefined,
    VersionIdMarker: checkpoint.versionIdMarker ?? undefined,
    MaxKeys: PAGE_SIZE,
  }));
  if (page.IsTruncated === true) {
    const keyMarker = page.NextKeyMarker;
    const versionIdMarker = page.NextVersionIdMarker;
    if (
      typeof keyMarker !== "string" || !keyMarker ||
      typeof versionIdMarker !== "string" || !versionIdMarker ||
      (keyMarker === checkpoint.keyMarker && versionIdMarker === checkpoint.versionIdMarker)
    ) {
      throw new Error("S3 returned an invalid source import continuation");
    }
  }
  const versions = (page.Versions ?? []).filter((version) =>
    version.IsLatest === true && typeof version.Key === "string" &&
    typeof version.VersionId === "string" && Number.isSafeInteger(version.Size) &&
    objectKeyWithinSource(source, version.Key));
  const deleteMarkers = (page.DeleteMarkers ?? []).filter((marker) =>
    marker.IsLatest === true && typeof marker.Key === "string" &&
    typeof marker.VersionId === "string" && marker.VersionId &&
    objectKeyWithinSource(source, marker.Key));
  const heads = await mapWithConcurrency(versions, 5, (version) =>
    s3.send(new HeadObjectCommand({
      Bucket: source.bucket,
      Key: version.Key,
      VersionId: version.VersionId,
      ExpectedBucketOwner: source.expectedBucketOwner,
      ChecksumMode: "ENABLED",
    })));
  const complete = page.IsTruncated !== true;
  const latestKeys = [...versions, ...deleteMarkers].map((item) => item.Key);
  if (new Set(latestKeys).size !== latestKeys.length) {
    throw new Error("S3 returned conflicting latest entries for one object key");
  }
  const activeEntries = versions.map((version, index) => ({
    assetId: indexedAssetId(source, version, heads[index]),
    assetIds: candidateAssetIds(source, version),
    head: heads[index],
    item: version,
    replacementKey: Boolean(replacementAssetIdForKey(source, version.Key)),
  }));
  const deleteEntries = deleteMarkers.map((marker) => ({
    assetIds: candidateAssetIds(source, marker),
    item: marker,
  }));
  const unmanagedEntries = activeEntries.filter(entry => !entry.replacementKey);
  if (new Set(unmanagedEntries.map((entry) => entry.assetId)).size !== unmanagedEntries.length) {
    throw new Error("S3 returned conflicting latest entries for one indexed asset");
  }
  const assetIds = [...new Set([
    ...activeEntries.flatMap((entry) => entry.assetIds),
    ...deleteEntries.flatMap((entry) => entry.assetIds),
  ])];
  const refs = new Map(assetIds.map((assetId) => [
    assetId,
    firestore.collection("mediaSourceAssets").doc(assetId),
  ]));
  const result = await firestore.runTransaction(async (transaction) => {
    const [liveCheckpointSnapshot, assetSnapshots, replacementSnapshots] = await Promise.all([
      transaction.get(checkpointRef),
      Promise.all([...refs.values()].map((ref) => transaction.get(ref))),
      Promise.all(assetIds.map(id => transaction.get(firestore.collection("mediaSourceReplacements").doc(id)))),
    ]);
    const replacements = new Map(assetIds.map((id, index) => [id, replacementSnapshots[index].data()]));
    const existing = new Map(assetIds.map((assetId, index) => [
      assetId,
      assetSnapshots[index],
    ]));
    const liveCheckpoint = liveCheckpointSnapshot.exists
      ? liveCheckpointSnapshot.data()
      : null;
    if (
      liveCheckpoint?.runId !== checkpoint.runId || liveCheckpoint.status !== "active" ||
      (liveCheckpoint.keyMarker ?? null) !== (checkpoint.keyMarker ?? null) ||
      (liveCheckpoint.versionIdMarker ?? null) !== (checkpoint.versionIdMarker ?? null)
    ) {
      throw new Error("Source import checkpoint changed during this page");
    }
    const searchChanges = [];
    let indexed = 0;
    let skipped = 0;
    let tombstoned = 0;
    activeEntries.forEach((entry) => {
      // The replacement state machine alone promotes nested candidates. A
      // historical original can still be S3's latest version at its old key;
      // rescanning it must never move the stable asset back or create a duplicate.
      if (entry.replacementKey || entry.assetIds.some(id => {
        const owner = existing.get(id)?.data(), replacement = replacements.get(id);
        return owner?.sourceId === source.id && owner.objectKey !== entry.item.Key &&
          replacement?.sourceId === source.id && replacement.assetId === id;
      })) {
        skipped += 1;
        return;
      }
      const stored = storedSourceAsset(existing.get(entry.assetId), source, entry.item.Key);
      // S3 versions can lose or gain Boardwalk metadata. Either index identity
      // can hold the deliberate deletion for this exact source and object key.
      const deleted = entry.assetIds.some((assetId) => storedSourceAsset(
        existing.get(assetId), source, entry.item.Key, { ignoreMismatch: true },
      )?.data.lifecycle === "deleted");
      if (deleted || (
        stored?.data.lifecycle === "active" &&
        stored.parsed.objectVersionId === entry.item.VersionId
      )) {
        skipped += 1;
        return;
      }
      const asset = importedAsset(
        source,
        entry.assetId,
        entry.item,
        entry.head,
        stored,
        now,
      );
      if (!asset) {
        skipped += 1;
        return;
      }
      transaction.set(refs.get(entry.assetId), asset);
      searchChanges.push(entry.assetId);
      indexed += 1;
    });
    deleteEntries.forEach((entry) => {
      const matches = entry.assetIds.flatMap((assetId) => {
        const stored = storedSourceAsset(
          existing.get(assetId),
          source,
          entry.item.Key,
          { ignoreMismatch: true },
        );
        return stored ? [{ assetId, stored }] : [];
      });
      if (matches.length > 1) {
        throw new Error(`Delete marker for ${entry.item.Key} matches multiple indexed assets`);
      }
      const match = matches[0];
      if (!match || match.stored.data.lifecycle === "deleted" || (
        match.stored.data.lifecycle === "tombstoned" &&
        match.stored.data.s3DeleteMarkerVersionId === entry.item.VersionId
      )) {
        skipped += 1;
        return;
      }
      const deletedAt = entry.item.LastModified instanceof Date
        ? entry.item.LastModified.toISOString()
        : now;
      transaction.set(refs.get(match.assetId), {
        lifecycle: "tombstoned",
        version: match.stored.parsed.version + 1,
        updatedAt: now,
        updatedAtSort: now,
        updatedBy: "system:s3-source-import",
        tombstonedAt: deletedAt,
        tombstonedBy: "system:s3-source-import",
        s3DeleteMarkerVersionId: entry.item.VersionId,
      }, { merge: true });
      searchChanges.push(match.assetId);
      tombstoned += 1;
    });
    searchOutbox.enqueueVideoSearchShards(transaction, firestore, searchChanges, source.id);
    const nextCheckpoint = {
      ...checkpoint,
      status: complete ? "complete" : "active",
      keyMarker: complete ? null : page.NextKeyMarker,
      versionIdMarker: complete ? null : page.NextVersionIdMarker,
      indexed: checkpoint.indexed + indexed,
      skipped: checkpoint.skipped + skipped,
      tombstoned: (checkpoint.tombstoned ?? 0) + tombstoned,
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    };
    transaction.set(checkpointRef, nextCheckpoint);
    transaction.set(firestore.collection("mediaSourceStats").doc(source.id), {
      sourceId: source.id,
      exact: false,
      updatedAt: now,
    }, { merge: true });
    return { indexed, skipped, tombstoned, checkpoint: nextCheckpoint };
  });
  return { ...result, complete };
}

function parseArguments(argv) {
  const sourceIndex = argv.indexOf("--source");
  const sourceId = sourceIndex >= 0 ? argv[sourceIndex + 1] : null;
  if (!sourceId) throw new Error("Use --source <configured-source-id>");
  return { sourceId, restart: argv.includes("--restart") };
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const { sourceId, restart } = parseArguments(process.argv.slice(2));
  const source = configuredRegistry(process.env).get(sourceId);
  if (!source) throw new Error("The requested source is not enabled and fully configured");
  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  const firestore = getFirestore(app);
  const s3 = new S3Client({ region: REGION, credentials: fromIni({ profile: PROFILE }) });
  try {
    let first = true;
    let result;
    do {
      result = await importSourcePage({ firestore, s3, source, restart: restart && first });
      first = false;
      console.log(
        `Source import page: ${result.indexed} indexed, ` +
        `${result.tombstoned} tombstoned, ${result.skipped} skipped.`,
      );
    } while (!result.complete);
    console.log("Source import checkpoint is complete. Exact total remains unavailable until reconciliation.");
  } finally {
    s3.destroy();
    await deleteApp(app);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
