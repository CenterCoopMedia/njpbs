import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";
import contract from "../../functions/lib/source-media-rendition.js";
import copies from "../../functions/lib/private-video-copy.js";
import transport from "../../functions/lib/private-video-transfer.js";
import reader from "../../functions/lib/private-video-reader.js";
import worker from "../../functions/private-video-copies.js";
import s3Reader from "../../functions/lib/s3-media-source.js";

const source = { id: "video-library", bucket: "originals", expectedBucketOwner: "123456789012", roleArn: "arn:aws:iam::123456789012:role/boardwalk-video-read", prefix: "" };
const config = { renditionBucket: "renditions", renditionExpectedBucketOwner: "123456789012" };
const web = Buffer.from("Fixture MP4 bytes: exact original-version-bound viewing copy");
const poster = Buffer.from("Fixture JPEG bytes");
function fixture() {
  const store = fakeFirestore();
  const asset = { id: "fixture", sourceId: source.id, lifecycle: "active", name: "Fixture", originalName: "fixture.mov",
    nameSort: "fixture", updatedAtSort: "2026-10-17T00:00:00Z", kind: "video", mimeType: "video/quicktime",
    objectKey: "objects/fixture.mov", objectVersionId: "original-v1", sizeBytes: 1000,
    preview: "download_only", rightsStatus: "pending", tags: [], version: 1 };
  const prefix = contract.sourceMediaRenditionOutputPrefix(asset, "attempt-1");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes, attemptId: "attempt-1",
    updatedAt: "2026-10-17T00:00:00Z", web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: web.length, mimeType: "video/mp4" },
    poster: { objectKey: `${prefix}preview-poster.0000001.jpg`, objectVersionId: "poster-v1", sizeBytes: poster.length, mimeType: "image/jpeg" } };
  store.rows.set("mediaSourceAssets/fixture", asset);
  const binding = copies.copyIdentity(source, asset);
  return { ...store, asset, binding, ref: store.firestore.collection(copies.COPIES).doc(binding.id) };
}

// Network boundaries model exact version/range reads and multipart completion.
function storage({ corrupt = false, loseCompletion = false } = {}) {
  const objects = new Map();
  const uploads = new Map();
  const sourceReads = [];
  let serial = 0;
  const missing = () => Object.assign(Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  const s3 = { send: async command => {
    const input = command.input;
    const bytes = input.Key.endsWith(".mp4") ? web : poster;
    const version = input.Key.endsWith(".mp4") ? "web-v1" : "poster-v1";
    if (input.VersionId !== version || input.ExpectedBucketOwner !== "123456789012") throw Error("wrong source identity");
    if (command.constructor.name === "HeadObjectCommand") return { VersionId: version, ContentLength: bytes.length };
    sourceReads.push(input);
    return { VersionId: version, ContentLength: bytes.length, ContentRange: `bytes 0-${bytes.length - 1}/${bytes.length}`, Body: Readable.from([bytes]) };
  } };
  const r2 = { send: async command => {
    const input = command.input;
    switch (command.constructor.name) {
      case "CreateMultipartUploadCommand": {
        const UploadId = `upload-${++serial}`;
        uploads.set(UploadId, { ...input, parts: new Map() });
        return { UploadId };
      }
      case "UploadPartCommand": uploads.get(input.UploadId).parts.set(input.PartNumber, Buffer.from(input.Body)); return { ETag: `"part-${input.PartNumber}"` };
      case "CompleteMultipartUploadCommand": {
        const upload = uploads.get(input.UploadId);
        if (!upload) throw Error("NoSuchUpload");
        objects.set(input.Key, { bytes: Buffer.concat([...upload.parts.values()]), Metadata: upload.Metadata, ETag: `"complete-${serial}"` });
        uploads.delete(input.UploadId);
        if (loseCompletion) { loseCompletion = false; throw Error("lost completion response"); }
        return {};
      }
      case "HeadObjectCommand": {
        const obj = objects.get(input.Key);
        if (!obj) throw missing();
        return { ContentLength: obj.bytes.length, Metadata: obj.Metadata, ETag: obj.ETag };
      }
      case "GetObjectCommand": {
        const obj = objects.get(input.Key);
        if (!obj) throw missing();
        if (input.IfMatch !== obj.ETag) throw Error("etag changed");
        const bytes = Buffer.from(obj.bytes);
        if (corrupt) bytes[0] ^= 1;
        return { ContentLength: bytes.length, ETag: obj.ETag, ContentRange: `bytes 0-${bytes.length - 1}/${bytes.length}`, Body: Readable.from([bytes]) };
      }
      case "DeleteObjectCommand": objects.delete(input.Key); return {};
      case "AbortMultipartUploadCommand": uploads.delete(input.UploadId); return {};
      default: throw Error(`Unsupported network boundary ${command.constructor.name}`);
    }
  } };
  return { r2, s3, objects, uploads, sourceReads, transfer: transport.createPrivateVideoTransfer({ r2, s3, bucket: "private", config }) };
}
async function finish(job, transfer) {
  for (let index = 0; index < 20 && job.active; index++) {
    await transfer.step(job, async changes => { Object.assign(job, changes); return true; });
  }
}

describe("private viewing copy integrity and lifecycle", () => {
  it("copies unpublished ready outputs once, resumes saved parts and verifies destination bytes", async () => {
    const { binding } = fixture();
    const { transfer, sourceReads, objects } = storage();
    const job = copies.newCopy(binding, 1);
    const save = async changes => { Object.assign(job, changes); return true; };
    await transfer.step(job, save);
    await transfer.step(job, save);
    const resumed = structuredClone(job);
    await finish(resumed, transfer);
    expect(resumed.phase).toBe("ready");
    expect(sourceReads).toHaveLength(2);
    expect(copies.verifiedFile(resumed, "web").checksumAlgorithm).toBe("sha256-parts-v1");
    expect(objects.get(resumed.files.web.key).bytes).toEqual(web);
    await finish(resumed, transfer);
    expect(sourceReads).toHaveLength(2);
  });
  it("recovers a lost completion response without copying the source again", async () => {
    const { binding } = fixture();
    const { transfer, sourceReads } = storage({ loseCompletion: true });
    const job = copies.newCopy(binding, 1);
    await expect(finish(job, transfer)).rejects.toThrow("lost completion");
    await finish(job, transfer);
    expect(job.phase).toBe("ready");
    expect(sourceReads).toHaveLength(2);
  });
  it("refuses a destination checksum mismatch and never marks it ready", async () => {
    const { binding } = fixture();
    const { transfer } = storage({ corrupt: true });
    const job = copies.newCopy(binding, 1);
    await expect(finish(job, transfer)).rejects.toThrow("checksum_invalid");
    expect(copies.verifiedFile(job, "web")).toBeNull();
    expect(job.phase).toBe("copying");
  });
  it("serializes admission, rejects stale completion and removes delivery bytes after deletion", async () => {
    const { firestore, rows, ref, asset } = fixture();
    await copies.enqueueCopy({ firestore, source, assetId: asset.id });
    const first = rows.get(ref.path);
    await copies.enqueueCopy({ firestore, source, assetId: asset.id });
    expect(rows.get(ref.path).generation).toBe(first.generation);
    const job = await copies.claimCopy({ firestore, ref, source, now: 1 });
    expect(await copies.claimCopy({ firestore, ref, source, now: 2 })).toBeNull();
    const { transfer, objects } = storage();
    await finish(job, transfer);
    rows.set(ref.path, job);
    asset.lifecycle = "deleted";
    await copies.revokeCopies({ firestore, source, assetId: asset.id, remove: transfer.remove });
    expect(objects.size).toBe(0);
    expect(await copies.saveCopy({ firestore, ref, source, job, changes: { phase: "ready", active: false } })).toBe(false);
    expect(rows.get(ref.path).revoked).toBe(true);
  });
  it("revokes replaced originals and does not enqueue stale readiness", async () => {
    const { firestore, rows, ref, asset } = fixture();
    await copies.enqueueCopy({ firestore, source, assetId: asset.id });
    const job = await copies.claimCopy({ firestore, ref, source, now: 1 });
    asset.objectVersionId = "original-v2";
    expect(await copies.enqueueCopy({ firestore, source, assetId: asset.id })).toBeNull();
    expect(await copies.saveCopy({ firestore, ref, source, job, changes: { phase: "ready" } })).toBe(false);
    expect(rows.get(ref.path).revoked).toBe(true);
  });
  it("admits a fresh generation after cleanup when the exact binding is current again", async () => {
    const { firestore, rows, ref, asset } = fixture();
    await copies.enqueueCopy({ firestore, source, assetId: asset.id });
    const old = structuredClone(rows.get(ref.path));
    await copies.revokeCopies({ firestore, source: undefined, assetId: asset.id });
    await worker.processPrivateVideoTick({ firestore, source: undefined, copyEnabled: false,
      transfer: { remove: async () => {} } });
    expect(rows.get(ref.path).phase).toBe("deleted");
    expect(await copies.enqueueCopy({ firestore, source, assetId: asset.id })).toBe(old.id);
    expect(rows.get(ref.path)).toMatchObject({ phase: "copying", active: true, revoked: false, failures: 0 });
    expect(rows.get(ref.path).generation).not.toBe(old.generation);
    expect(rows.get(ref.path).files.web.key).not.toBe(old.files.web.key);
    await copies.enqueueCopy({ firestore, source, assetId: asset.id });
    expect(rows.get(ref.path).phase).toBe("copying");
  });
});

describe("private read access and fallback", () => {
  async function ready() {
    const data = fixture();
    const network = storage();
    const job = copies.newCopy(data.binding, 1);
    await finish(job, network.transfer);
    data.rows.set(data.ref.path, job);
    return { ...data, ...network, job };
  }
  it("signs only the current verified object with bounded private access and no required browser headers", async () => {
    const { firestore, asset, r2, job } = await ready();
    const read = reader.createPrivateVideoReader({ firestore, storage: () => ({ client: r2, bucket: "private" }), now: () => 0,
      sign: async (client, command, options) => {
        expect(command.input.Key).toBe(job.files.web.key);
        expect(command.input.IfMatch).toBeUndefined();
        expect(options.expiresIn).toBe(300);
        expect(command.input.ResponseCacheControl).toBe("private, max-age=300");
        return "https://private.invalid/signed";
      } });
    expect(await read(source, asset, "preview", "inline")).toMatchObject({ expiresAt: "1970-01-01T00:05:00.000Z", supportsRange: true });
    expect(await read(source, asset, "download", "attachment")).toBeNull();
  });
  it.each(["missing", "changed", "corrupt", "deleted"])("refuses %s delivery and queues repair without exposing it", async mode => {
    const { firestore, asset, r2, job, objects, rows, ref } = await ready();
    if (mode === "missing") objects.clear();
    if (mode === "changed") objects.get(job.files.web.key).ETag = '"different"';
    if (mode === "corrupt") job.files.web.parts[0].sha256 = "0".repeat(64);
    if (mode === "deleted") asset.lifecycle = "deleted";
    const read = reader.createPrivateVideoReader({ firestore, storage: () => ({ client: r2, bucket: "private" }), sign: async () => { throw Error("must not sign"); } });
    expect(await read(source, asset, "preview", "inline")).toBeNull();
    if (mode !== "deleted") expect(rows.get(ref.path).phase).toBe("repair");
  });
  it("uses verified R2 before AWS HEAD while preserving original S3 downloads", async () => {
    const { asset } = fixture();
    let awsReads = 0;
    const read = s3Reader.createS3MediaSourceReader(config, { S3ClientCtor: class { async send() { awsReads++; throw Error("AWS offline"); } },
      createAwsRoleCredentialProviderFn: () => async () => ({}), privateReadFn: async () => ({ url: "r2" }) });
    expect(await read(source, asset, "preview")).toEqual({ url: "r2" });
    expect(awsReads).toBe(0);
  });
});

it("keeps immutable identity independent of Firestore map order", () => {
  const { binding } = fixture();
  const reordered = Object.fromEntries(Object.entries(binding.identity).reverse().map(([key, value]) =>
    [key, value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()) : value]));
  expect(copies.identityDigest(reordered)).toBe(binding.id);
});

it("does not recopy unchanged bytes after a frame-rate metadata update", () => {
  const { asset, binding } = fixture();
  asset.rendition.web.sourceFrameRateNumerator = 30000;
  asset.rendition.web.sourceFrameRateDenominator = 1001;
  expect(copies.copyIdentity(source, asset).id).toBe(binding.id);
});

it("preserves a ready generation after temporary storage failure and leaves stopped jobs stopped", async () => {
  const { firestore, rows, ref, asset, binding } = fixture();
  const { transfer } = storage();
  const job = copies.newCopy(binding, 1);
  await finish(job, transfer);
  rows.set(ref.path, job);
  const read = reader.createPrivateVideoReader({ firestore, storage: () => ({ bucket: "private", client: {
    send: async () => { throw Object.assign(Error("temporary"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } }); },
  } }) });
  expect(await read(source, asset, "poster", "inline")).toBeNull();
  expect(rows.get(ref.path).phase).toBe("ready");
  rows.set(ref.path, { ...job, phase: "failed", active: false });
  expect(await read(source, asset, "poster", "inline")).toBeNull();
  expect(rows.get(ref.path)).toMatchObject({ phase: "failed", active: false });
});


it("stops repeated copy failures after five scheduled attempts", async () => {
  const { firestore, rows, ref, asset } = fixture();
  await copies.enqueueCopy({ firestore, source, assetId: asset.id });
  const transfer = { step: async () => { throw Error("source unavailable"); }, remove: async () => {} };
  for (let index = 0; index < 5; index++) await worker.processPrivateVideoTick({ firestore, source, transfer, copyEnabled: true, now: () => 1000 + index });
  expect(rows.get(ref.path)).toMatchObject({ phase: "failed", active: false, failures: 5 });
  expect(await worker.processPrivateVideoTick({ firestore, source, transfer })).toEqual({ idle: true });
});

it("gives an explicit retry a fresh bounded cleanup budget without restarting it on reads", async () => {
  const { firestore, rows, ref, asset, binding } = fixture();
  const stopped = { ...copies.newCopy(binding, 1), phase: "failed", active: false, failures: 5 };
  rows.set(ref.path, stopped);
  const read = reader.createPrivateVideoReader({ firestore, storage: () => { throw Error("must not read storage"); } });
  expect(await read(source, asset, "poster", "inline")).toBeNull();
  await copies.enqueueCopy({ firestore, source, assetId: asset.id });
  expect(rows.get(ref.path)).toMatchObject({ phase: "failed", active: false, failures: 5 });

  await copies.enqueueCopy({ firestore, source, assetId: asset.id, repair: true });
  expect(rows.get(ref.path)).toMatchObject({ phase: "repair", active: true, failures: 0, generation: stopped.generation });
  const remove = vi.fn().mockRejectedValue(Error("temporary cleanup failure"));
  const transfer = { remove, step: vi.fn() };
  const tick = () => worker.processPrivateVideoTick({ firestore, source, transfer, copyEnabled: true, now: () => 1000 });
  await tick();
  expect(rows.get(ref.path)).toMatchObject({ phase: "repair", active: true, failures: 1 });
  for (let index = 1; index < 5; index++) await tick();
  expect(rows.get(ref.path)).toMatchObject({ phase: "failed", active: false, failures: 5 });
  expect(await tick()).toEqual({ idle: true });
  expect(remove).toHaveBeenCalledTimes(5);
  expect(transfer.step).not.toHaveBeenCalled();

  await copies.enqueueCopy({ firestore, source, assetId: asset.id, repair: true });
  remove.mockResolvedValue(undefined);
  await tick();
  expect(rows.get(ref.path)).toMatchObject({ phase: "copying", active: true, failures: 0 });
  expect(rows.get(ref.path).generation).not.toBe(stopped.generation);
});

it("uses exact fixed-size ranges at multipart boundaries", () => {
  expect(transport.partRange({ sizeBytes: 134217741 }, 1))
    .toEqual({ start: 67108864, end: 134217727, length: 67108864, Range: "bytes=67108864-134217727" });
  expect(transport.partRange({ sizeBytes: 134217741 }, 2))
    .toEqual({ start: 134217728, end: 134217740, length: 13, Range: "bytes=134217728-134217740" });
});


it("revokes existing copies through library deletion while private delivery is disabled", async () => {
  const { deleteSourceMedia } = await import("../../functions/source-media-uploads.js");
  const { privateVideoStorage } = await import("../../functions/lib/private-video-runtime.js");
  const data = fixture();
  const network = storage();
  const job = copies.newCopy(data.binding, 1);
  await finish(job, network.transfer);
  data.rows.set(data.ref.path, job);
  vi.stubEnv("CMS_PRIVATE_VIDEO_ENABLED", "false");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_ENDPOINT", `https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_BUCKET", "njpbs-boardwalk-private-video");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID", "fixture-write-id");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY", "fixture-write-secret");
  try {
    expect(privateVideoStorage()).toBeNull();
    const writer = privateVideoStorage(true);
    expect(writer.bucket).toBe("njpbs-boardwalk-private-video");
    const { createRequire } = await import("node:module");
    const { S3Client } = createRequire(import.meta.url)("@aws-sdk/client-s3");
    vi.spyOn(S3Client.prototype, "send").mockImplementation(command => {
      expect(command.input.Bucket).toBe("njpbs-boardwalk-private-video");
      return network.r2.send(command);
    });
    const before = network.sourceReads.length;
    expect(await deleteSourceMedia({ actor: { uid: "staff" }, firestore: data.firestore, source,
      nowFn: () => "2026-10-18T01:00:00Z", request: { assetId: "fixture", expectedVersion: 1 } }))
      .toEqual({ deleted: true });
    expect(network.objects.size).toBe(0);
    expect(data.rows.get(data.ref.path)).toMatchObject({ phase: "revoking", active: true, revoked: true });
    await worker.processPrivateVideoTick({ firestore: data.firestore, source, transfer: network.transfer, copyEnabled: false });
    expect(data.rows.get(data.ref.path)).toMatchObject({ phase: "deleted", active: false });
    expect(network.sourceReads).toHaveLength(before);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it("does no copy work in disabled mode and keeps the cleanup query bounded", async () => {
  const { firestore, queries, asset } = fixture();
  await copies.enqueueCopy({ firestore, source, assetId: asset.id });
  expect(await worker.processPrivateVideoTick({ firestore, source, copyEnabled: false })).toEqual({ idle: true });
  expect(queries.at(-1).cap).toBe(20);
});

it("keeps a read-only R2 body alive across provider upload backpressure", async () => {
  const { privateVideoStreamStorage } = await import("../../functions/lib/private-video-runtime.js");
  const { createRequire } = await import("node:module");
  const { GetObjectCommand } = createRequire(import.meta.url)("@aws-sdk/client-s3");
  // The old HEAD client cut off this valid body after a 1.5-second idle gap.
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-length": "12", "content-type": "audio/x-m4a" });
    response.write("hello");
    const timer = setTimeout(() => response.end(" source"), 1800);
    response.once("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv("CMS_PRIVATE_VIDEO_ENABLED", "true");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_ENDPOINT", `https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_BUCKET", "njpbs-boardwalk-private-video");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID", "fixture-read-id");
  vi.stubEnv("CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY", "fixture-read-secret");
  let client;
  try {
    const storage = privateVideoStreamStorage();
    client = storage.client;
    // Route only the network boundary to a real local HTTP server. Keep the
    // production client, credentials selection and Smithy timeout behavior.
    client.middlewareStack.add(next => args => {
      Object.assign(args.request, { hostname: "127.0.0.1", protocol: "http:", port: server.address().port });
      return next(args);
    }, { step: "build", name: "localPrivateAudioBoundary" });
    const response = await client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: "private-audio/input.m4a" }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello source");
  } finally {
    client?.middlewareStack.remove("localPrivateAudioBoundary");
    client?.destroy();
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
