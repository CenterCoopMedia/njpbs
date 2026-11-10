import { describe, expect, it, vi } from "vitest";
import uploads from "../../functions/source-media-uploads.js";
import uploadContract from "../../functions/lib/source-media-upload-contract.js";
import previewJob from "../../functions/lib/video-preview-job.js";
import s3Upload from "../../functions/lib/s3-media-upload.js";

const {
  SourceUploadError,
  deleteSourceMedia,
  cancelUpload,
  completeUpload,
  completedAsset,
  resumeUpload,
  signUploadParts,
  startUpload,
  storeCompletedAsset,
  updateMetadata,
} = uploads;
const { parseStartUploadRequest } = uploadContract;
const { compositeSha256, createS3MediaUploader } = s3Upload;

function source(overrides = {}) {
  return {
    id: "video-library",
    prefix: "shared/",
    bucket: "njpbs-video-123456789012-us-east-2",
    expectedBucketOwner: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/boardwalk-shared-video",
    writable: true,
    ...overrides,
  };
}

function actor(uid = "staff-1") {
  return {
    uid,
    email: `${uid}@example.org`,
    principal: { id: uid, grants: [{ role: "staff" }] },
  };
}

function fakeFirestore(initial = {}, { createErrorAfterCommit = false } = {}) {
  const records = new Map(Object.entries(initial));
  const versions = new Map([...records.keys()].map((key) => [key, 1]));
  let nextId = 1;
  let reportedCreateError = false;
  function ref(collection, id) {
    id ??= `auto-${nextId++}`;
    const key = `${collection}/${id}`;
    return {
      collection,
      id,
      key,
      async get() {
        return snapshot(id, records.get(key));
      },
      async create(value) {
        if (records.has(key)) throw new Error("already exists");
        records.set(key, structuredClone(value));
        if (createErrorAfterCommit && !reportedCreateError) {
          reportedCreateError = true;
          throw new Error("create response lost");
        }
      },
    };
  }
  function snapshot(id, data) {
    return { id, exists: data !== undefined, data: () => structuredClone(data) };
  }
  return {
    records,
    async getAll(...refs) { return Promise.all(refs.map(reference => reference.get())); },
    collection(name) {
      function query(filters = [], count = Infinity) {
        return {
          collection: name,
          doc: (id) => ref(name, id),
          where(field, operator, value) {
            expect(operator).toBe("==");
            return query([...filters, [field, value]], count);
          },
          limit(nextCount) { return query(filters, nextCount); },
          async get() { const docs = this._snapshots().map(doc => ({ ...doc, ref: ref(name, doc.id) })); return { docs, size: docs.length }; },
          _snapshots() {
            return [...records.entries()]
              .filter(([key, value]) => key.startsWith(`${name}/`) &&
                filters.every(([field, expected]) => field.split(".").reduce((item, key) => item?.[key], value) === expected))
              .slice(0, count)
              .map(([key, value]) => snapshot(key.split("/")[1], value));
          },
        };
      };
      return query();
    },
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const writes = [];
        const reads = new Map();
        const transaction = {
          get: async (reference) => {
            if (reference._snapshots) {
              const docs = reference._snapshots();
              for (const doc of docs) {
                const key = `${reference.collection}/${doc.id}`;
                reads.set(key, versions.get(key) ?? 0);
              }
              return { docs, size: docs.length };
            }
            reads.set(reference.key, versions.get(reference.key) ?? 0);
            return snapshot(reference.id, records.get(reference.key));
          },
          create(reference, value) {
            if (
              records.has(reference.key) ||
              writes.some((write) => write.reference.key === reference.key)
            ) {
              throw new Error("already exists");
            }
            writes.push({ action: "create", reference, value });
          },
          update(reference, changes) {
            const current = records.get(reference.key);
            if (!current) throw new Error("missing record");
            writes.push({ action: "update", reference, value: changes });
          },
          set(reference, value, options) {
            writes.push({ action: options?.merge ? "update" : "set", reference, value });
          },
        };
        const result = await callback(transaction);
        if ([...reads].some(([key, version]) => (versions.get(key) ?? 0) !== version)) {
          continue;
        }
        for (const { action, reference, value } of writes) {
          const copy = structuredClone(value);
          records.set(
            reference.key,
            action === "update" ? { ...records.get(reference.key), ...copy } : copy,
          );
          versions.set(reference.key, (versions.get(reference.key) ?? 0) + 1);
        }
        return result;
      }
      throw new Error("transaction conflict");
    },
  };
}

function existingVideo(overrides = {}) {
  return {
    id: "asset-1", sourceId: "video-library", lifecycle: "active",
    name: "Meeting", originalName: "meeting.mp4", description: null,
    nameSort: "meeting", updatedAtSort: "2026-09-14T16:00:00.000Z",
    mimeType: "video/mp4", kind: "video", sizeBytes: 12, preview: "browser",
    license: null, credit: null, tags: [], rightsStatus: "pending", version: 1,
    createdAt: "2026-09-14T15:00:00.000Z", createdBy: "staff-1",
    updatedAt: "2026-09-14T16:00:00.000Z",
    objectKey: "shared/objects/asset-1.mp4", objectVersionId: "version-1",
    ...overrides,
  };
}

function startRequest(sizeBytes = 20 * 1024 * 1024, requestId) {
  return parseStartUploadRequest({
    sourceId: "video-library",
    ...(requestId ? { requestId } : {}),
    originalName: "meeting.mp4",
    mimeType: "video/mp4",
    sizeBytes,
    lastModified: 1_789_400_000_000,
    metadata: {
      name: "County meeting",
      description: "A meeting recording.",
      credit: "NJ PBS",
      license: "Station owned",
      tags: ["county"],
      rightsStatus: "complete",
    },
  });
}

async function seededSession(firestore, uploaderOverrides = {}) {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const uploader = {
    start: vi.fn(async () => ({ uploadId: "s3-upload-id" })),
    cancel: vi.fn(async () => undefined),
    ...uploaderOverrides,
  };
  await startUpload({
    actor: actor(),
    firestore,
    nowFn: () => "2026-09-14T16:00:00.000Z",
    request: startRequest(),
    source: source(),
    uploader,
    uuidFn: () => ids.shift(),
  });
  return { uploader, sessionId: "11111111-1111-4111-8111-111111111111" };
}

describe("source media multipart sessions", () => {
  it("keeps the maximum signed manifest within the Firestore document budget", () => {
    const partSize = uploadContract.choosePartSize(uploadContract.MAX_VIDEO_BYTES);
    const totalParts = Math.ceil(uploadContract.MAX_VIDEO_BYTES / partSize);
    const signedParts = Object.fromEntries(Array.from({ length: totalParts }, (_, index) => {
      const partNumber = index + 1;
      return [partNumber, {
        partNumber,
        sizeBytes: Math.min(partSize, 5 * 1024 ** 3),
        checksumSha256: "A".repeat(43) + "=",
      }];
    }));
    expect(totalParts).toBeLessThanOrEqual(uploadContract.MAX_PARTS);
    // The full session has more than half of Firestore's 1 MiB limit left for field encoding.
    expect(Buffer.byteLength(JSON.stringify({ signedParts }))).toBeLessThan(512 * 1024);
  });

  it("bounds each browser part to 64 MiB and each file to 250 GiB", () => {
    expect(uploadContract.MAX_PART_SIZE).toBe(64 * 1024 ** 2);
    expect(uploadContract.MAX_VIDEO_BYTES).toBe(250 * 1024 ** 3);
    expect(uploadContract.choosePartSize(uploadContract.MAX_VIDEO_BYTES))
      .toBe(uploadContract.MAX_PART_SIZE);
    expect(() => parseStartUploadRequest({
      sourceId: "video-library",
      originalName: "oversize.mxf",
      mimeType: "application/mxf",
      sizeBytes: uploadContract.MAX_VIDEO_BYTES + 1,
      lastModified: 1,
      metadata: {},
    })).toThrow(/Video size must be/);
  });

  it("rejects Firestore path syntax in every upload identifier", () => {
    expect(() => uploadContract.parseSessionRequest({
      sourceId: "video-library",
      sessionId: "../another-document",
    })).toThrow(/Session id is invalid/);
    expect(() => parseStartUploadRequest({
      sourceId: "video-library", requestId: "../another-document",
      originalName: "meeting.mp4", mimeType: "video/mp4", sizeBytes: 1,
      lastModified: 1, metadata: {},
    })).toThrow(/Request id is invalid/);
  });

  it("recognizes MXF and M4V files when the browser gives no useful MIME type", () => {
    expect(parseStartUploadRequest({
      sourceId: "video-library",
      originalName: "master.mxf",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      lastModified: 1,
      metadata: {},
    }).mimeType).toBe("application/mxf");
    expect(parseStartUploadRequest({
      sourceId: "video-library",
      originalName: "segment.m4v",
      mimeType: "",
      sizeBytes: 10,
      lastModified: 1,
      metadata: {},
    }).mimeType).toBe("video/mp4");
  });

  it("rejects names whose normalized sort key exceeds the stored contract", () => {
    const expandingName = "\u0130".repeat(500);
    expect(() => parseStartUploadRequest({
      sourceId: "video-library",
      originalName: "meeting.mp4",
      mimeType: "video/mp4",
      sizeBytes: 10,
      lastModified: 1,
      metadata: { name: expandingName },
    })).toThrow(/Normalized name must be 512 characters or fewer/);
    expect(() => uploadContract.parseMetadataUpdateRequest({
      sourceId: "video-library",
      assetId: "asset-1",
      expectedVersion: 1,
      changes: { name: expandingName },
    })).toThrow(/Normalized name must be 512 characters or fewer/);
  });

  it("creates an actor-bound session with an immutable UUID object key", async () => {
    const firestore = fakeFirestore();
    const { uploader, sessionId } = await seededSession(firestore);
    const session = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    expect(session.actorUid).toBe("staff-1");
    expect(session.objectKey).toBe(
      "shared/objects/22222222-2222-4222-8222-222222222222.mp4",
    );
    expect(session.partSize).toBe(16 * 1024 * 1024);
    expect(session.totalParts).toBe(2);
    expect(uploader.start).toHaveBeenCalledOnce();
  });

  it("returns the same session after a lost start response without a second S3 start", async () => {
    const firestore = fakeFirestore();
    const uploader = { start: vi.fn(async () => ({ uploadId: "s3-first" })), cancel: vi.fn() };
    const request = startRequest(20 * 1024 * 1024, "client-request-1");
    const args = { actor: actor(), firestore, nowFn: () => "2026-09-14T16:00:00.000Z", request, source: source(), uploader, uuidFn: () => "asset-1" };
    const first = await startUpload(args);
    const replay = await startUpload(args);
    expect(replay).toEqual(first);
    expect(first.upload.sessionId).toBe("client-request-1");
    expect(uploader.start).toHaveBeenCalledOnce();
    expect(uploader.cancel).not.toHaveBeenCalled();
  });

  it("rejects a reused request id for another actor or changed file and metadata", async () => {
    const firestore = fakeFirestore();
    const uploader = { start: vi.fn(async () => ({ uploadId: "s3-first" })), cancel: vi.fn() };
    const request = startRequest(20 * 1024 * 1024, "client-request-1");
    const args = { actor: actor(), firestore, nowFn: () => "2026-09-14T16:00:00.000Z", request, source: source(), uploader, uuidFn: () => "asset-1" };
    await startUpload(args);
    await expect(startUpload({ ...args, actor: actor("staff-2") })).rejects.toMatchObject({ status: 404 });
    await expect(startUpload({ ...args, request: { ...request, sizeBytes: request.sizeBytes + 1 } })).rejects.toMatchObject({ status: 409 });
    await expect(startUpload({ ...args, request: { ...request, metadata: { ...request.metadata, license: "Other" } } })).rejects.toMatchObject({ status: 409 });
    expect(uploader.start).toHaveBeenCalledOnce();
  });

  it("keeps a committed S3 upload when its Firestore create response is lost", async () => {
    const firestore = fakeFirestore({}, { createErrorAfterCommit: true });
    const uploader = { start: vi.fn(async () => ({ uploadId: "s3-first" })), cancel: vi.fn() };
    const result = await startUpload({ actor: actor(), firestore, nowFn: () => "2026-09-14T16:00:00.000Z",
      request: startRequest(20 * 1024 * 1024, "client-request-1"), source: source(), uploader, uuidFn: () => "asset-1" });
    expect(result.upload.sessionId).toBe("client-request-1");
    expect(uploader.cancel).not.toHaveBeenCalled();
  });

  it("elects one session from concurrent starts and aborts only the loser", async () => {
    const firestore = fakeFirestore();
    const starts = [];
    const uploader = {
      start: vi.fn(() => new Promise(resolve => starts.push(resolve))),
      cancel: vi.fn(async () => undefined),
    };
    const request = startRequest(20 * 1024 * 1024, "client-request-1");
    const args = { actor: actor(), firestore, nowFn: () => "2026-09-14T16:00:00.000Z", request, source: source(), uploader };
    const first = startUpload({ ...args, uuidFn: () => "asset-1" });
    const second = startUpload({ ...args, uuidFn: () => "asset-2" });
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts[0]({ uploadId: "s3-first" });
    starts[1]({ uploadId: "s3-second" });
    const [one, two] = await Promise.all([first, second]);
    expect(one).toEqual(two);
    expect(firestore.records.get("mediaSourceUploads/client-request-1").s3UploadId).toBe("s3-first");
    expect(uploader.cancel).toHaveBeenCalledOnce();
    expect(uploader.cancel.mock.calls[0][1].s3UploadId).toBe("s3-second");
  });

  it("rejects a part with a size that does not match its fixed position", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    await expect(signUploadParts({
      actor: actor(),
      firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: {
        sourceId: "video-library",
        sessionId,
        version: 1,
        parts: [{ partNumber: 1, sizeBytes: 7, checksumSha256: "A".repeat(43) + "=" }],
      },
      source: source(),
      uploader: { signParts: vi.fn() },
    })).rejects.toMatchObject({ status: 400 });
  });

  it("binds signed checksum records to the next optimistic session version", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const checksum = "A".repeat(43) + "=";
    const result = await signUploadParts({
      actor: actor(),
      firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: {
        sourceId: "video-library",
        sessionId,
        version: 1,
        parts: [{ partNumber: 1, sizeBytes: 16 * 1024 * 1024, checksumSha256: checksum }],
      },
      source: source(),
      uploader: { signParts: async () => [{ partNumber: 1, url: "https://signed.example" }] },
    });
    expect(result.version).toBe(2);
    expect(firestore.records.get(`mediaSourceUploads/${sessionId}`).signedParts[1])
      .toMatchObject({ checksumSha256: checksum });
  });

  it("resumes a completed session with its asset and never lists old upload parts", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const asset = existingVideo();
    const firestore = fakeFirestore({
      "mediaSourceAssets/asset-1": asset,
      [`mediaSourceUploads/${sessionId}`]: {
        id: sessionId,
        actorUid: "staff-1",
        sourceId: "video-library",
        assetId: "asset-1",
        objectKey: "shared/objects/asset-1.mp4",
        s3UploadId: "old-upload",
        version: 3,
        status: "completed",
        assetSummary: asset,
      },
    });
    const listParts = vi.fn();
    await expect(resumeUpload({
      actor: actor(), firestore,
      request: { sourceId: "video-library", sessionId },
      source: source(), uploader: { listParts },
    })).resolves.toMatchObject({ asset: { id: asset.id, version: asset.version } });
    expect(listParts).not.toHaveBeenCalled();
  });

  it("recovers a completed S3 object while resuming a completing session", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const session = firestore.records.get(sessionKey);
    const checksum1 = Buffer.alloc(32, 1).toString("base64");
    const checksum2 = Buffer.alloc(32, 2).toString("base64");
    session.status = "completing";
    session.version = 2;
    session.signedParts = {
      1: { partNumber: 1, sizeBytes: 16 * 1024 * 1024, checksumSha256: checksum1 },
      2: { partNumber: 2, sizeBytes: 4 * 1024 * 1024, checksumSha256: checksum2 },
    };
    const checksum = compositeSha256(Object.values(session.signedParts));
    const listParts = vi.fn();
    const result = await resumeUpload({
      actor: actor(), firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: { sourceId: "video-library", sessionId },
      source: source(),
      uploader: {
        listParts,
        head: async () => ({
          VersionId: "recovered-version",
          ContentLength: session.sizeBytes,
          ChecksumSHA256: checksum,
          Metadata: {
            "boardwalk-session": sessionId,
            "boardwalk-asset": session.assetId,
          },
        }),
      },
    });
    expect(result.asset.id).toBe(session.assetId);
    expect(firestore.records.get(sessionKey).status).toBe("completed");
    expect(listParts).not.toHaveBeenCalled();
  });

  it("refuses cancel after completion without aborting the completed object", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const firestore = fakeFirestore({
      [`mediaSourceUploads/${sessionId}`]: {
        id: sessionId,
        actorUid: "staff-1",
        sourceId: "video-library",
        assetId: "asset-1",
        objectKey: "shared/objects/asset-1.mp4",
        s3UploadId: "old-upload",
        version: 3,
        status: "completed",
      },
    });
    const cancel = vi.fn();
    await expect(cancelUpload({
      actor: actor(), firestore,
      request: { sourceId: "video-library", sessionId, version: 3 },
      source: source(), uploader: { cancel },
      nowFn: () => "2026-09-14T17:00:00.000Z",
    })).rejects.toMatchObject({ status: 409, details: { code: "upload_completed" } });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps a completing upload distinct from a confirmed completed upload", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const firestore = fakeFirestore({
      [`mediaSourceUploads/${sessionId}`]: {
        id: sessionId, actorUid: "staff-1", sourceId: "video-library",
        assetId: "asset-1", objectKey: "shared/objects/asset-1.mp4",
        s3UploadId: "old-upload", version: 3, status: "completing",
        expiresAt: "2026-09-15T16:00:00.000Z",
      },
    });
    const cancel = vi.fn();
    await expect(cancelUpload({
      actor: actor(), firestore,
      request: { sourceId: "video-library", sessionId, version: 3 },
      source: source(), uploader: { cancel },
      nowFn: () => "2026-09-14T17:00:00.000Z",
    })).rejects.toMatchObject({ status: 409, details: {} });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("accepts a stale cancel retry after the upload is already canceled", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const firestore = fakeFirestore({
      [`mediaSourceUploads/${sessionId}`]: {
        id: sessionId,
        actorUid: "staff-1",
        sourceId: "video-library",
        assetId: "asset-1",
        objectKey: "shared/objects/asset-1.mp4",
        s3UploadId: "old-upload",
        version: 2,
        status: "canceled",
        expiresAt: "2026-09-14T16:00:00.000Z",
      },
    });
    const cancel = vi.fn();
    await expect(cancelUpload({
      actor: actor(), firestore,
      request: { sourceId: "video-library", sessionId, version: 1 },
      source: source(), uploader: { cancel },
      nowFn: () => "2026-09-15T17:00:00.000Z",
    })).resolves.toEqual({ canceled: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("persists cancellation before S3 abort and reconciles a lost abort response", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const firstCancel = vi.fn(async () => {
      expect(firestore.records.get(sessionKey).status).toBe("canceling");
      throw new Error("connection reset");
    });
    const request = { sourceId: "video-library", sessionId, version: 1 };
    await expect(cancelUpload({
      actor: actor(), firestore, request,
      source: source(), uploader: { cancel: firstCancel },
      nowFn: () => "2026-09-14T17:00:00.000Z",
    })).rejects.toThrow(/connection reset/);
    expect(firestore.records.get(sessionKey)).toMatchObject({
      status: "canceling",
      version: 2,
      cancelRequestedAt: "2026-09-14T17:00:00.000Z",
    });

    const absent = new Error("already aborted");
    absent.name = "NoSuchUpload";
    await expect(cancelUpload({
      actor: actor(), firestore, request,
      source: source(), uploader: { cancel: vi.fn(async () => { throw absent; }) },
      nowFn: () => "2026-09-14T17:05:00.000Z",
    })).resolves.toEqual({ canceled: true });
    expect(firestore.records.get(sessionKey)).toMatchObject({
      status: "canceled",
      version: 3,
      canceledAt: "2026-09-14T17:05:00.000Z",
    });
  });
});

describe("multipart completion", () => {
  it("uses the SDK string continuation marker when a part list exceeds one page", async () => {
    const inputs = [];
    class FakeS3Client {
      async send(command) {
        inputs.push(command.input);
        return inputs.length === 1
          ? {
              IsTruncated: true,
              NextPartNumberMarker: "1000",
              Parts: [{
                PartNumber: 1000,
                ETag: "etag-1000",
                ChecksumSHA256: "checksum-1000",
                Size: 16,
              }],
            }
          : {
              IsTruncated: false,
              Parts: [{
                PartNumber: 1001,
                ETag: "etag-1001",
                ChecksumSHA256: "checksum-1001",
                Size: 8,
              }],
            };
      }
    }
    const uploader = createS3MediaUploader(
      { audience: "njpbs-boardwalk-s3", region: "us-east-2" },
      {
        S3ClientCtor: FakeS3Client,
        createAwsRoleCredentialsFn: async () => ({
          accessKeyId: "temporary",
          secretAccessKey: "temporary",
          sessionToken: "temporary",
        }),
      },
    );
    const parts = await uploader.listParts(source(), {
      objectKey: "shared/objects/asset.mp4",
      s3UploadId: "upload-id",
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[1].PartNumberMarker).toBe("1000");
    expect(parts.map((part) => part.partNumber)).toEqual([1000, 1001]);
  });

  it("validates every server-listed part and indexes the exact S3 version", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const size1 = 16 * 1024 * 1024;
    const size2 = 4 * 1024 * 1024;
    const checksum1 = Buffer.alloc(32, 1).toString("base64");
    const checksum2 = Buffer.alloc(32, 2).toString("base64");
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const session = firestore.records.get(sessionKey);
    session.signedParts = {
      1: { partNumber: 1, sizeBytes: size1, checksumSha256: checksum1 },
      2: { partNumber: 2, sizeBytes: size2, checksumSha256: checksum2 },
    };
    const parts = [
      { partNumber: 1, sizeBytes: size1, checksumSha256: checksum1, etag: "etag-1" },
      { partNumber: 2, sizeBytes: size2, checksumSha256: checksum2, etag: "etag-2" },
    ];
    const checksum = compositeSha256(parts);
    const uploader = {
      listParts: vi.fn(async () => parts),
      complete: vi.fn(async () => ({ VersionId: "exact-version", ChecksumSHA256: checksum })),
      head: vi.fn(async () => ({
        VersionId: "exact-version",
        ContentLength: size1 + size2,
        ChecksumSHA256: checksum,
        Metadata: {
          "boardwalk-session": sessionId,
          "boardwalk-asset": session.assetId,
        },
      })),
    };
    const result = await completeUpload({
      actor: actor(), firestore,
      adminLogEntryFn: (fields) => ({ ...fields, at: "test" }),
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: { sourceId: "video-library", sessionId, version: 1 },
      source: source(), uploader,
    });
    expect(result.asset).toMatchObject({ id: session.assetId, version: 1 });
    const stored = firestore.records.get(`mediaSourceAssets/${session.assetId}`);
    expect(stored.objectVersionId).toBe("exact-version");
    expect(stored.checksumSha256).toBe(checksum);
    expect([...firestore.records.values()]).toContainEqual(expect.objectContaining({
      action: "media.upload",
      actorUid: "staff-1",
      actorEmail: "staff-1@example.org",
      target: `mediaSourceAssets/${session.assetId}`,
      before: null,
      after: expect.objectContaining({ sourceId: "video-library", version: 1 }),
    }));
  });

  it("does not create an asset when its required audit row cannot be built", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const session = firestore.records.get(sessionKey);
    const asset = completedAsset(session, {
      VersionId: "exact-version",
      ContentLength: session.sizeBytes,
      Metadata: {
        "boardwalk-session": sessionId,
        "boardwalk-asset": session.assetId,
      },
    }, "2026-09-14T17:00:00.000Z");
    await expect(storeCompletedAsset(
      firestore,
      session,
      asset,
      actor(),
      () => { throw new Error("audit unavailable"); },
    )).rejects.toThrow(/audit unavailable/);
    expect(firestore.records.has(`mediaSourceAssets/${session.assetId}`)).toBe(false);
    expect(firestore.records.get(sessionKey).status).toBe("active");
  });

  it("rejects preview admission when the actor already has two active jobs", async () => {
    const firestore = fakeFirestore({
      "mediaSourcePreviewJobs/first": { active: true, actorUid: "staff-1" },
      "mediaSourcePreviewJobs/second": { active: true, actorUid: "staff-1" },
    });
    const { sessionId } = await seededSession(firestore);
    const session = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    const asset = completedAsset(session, {
      VersionId: "exact-version", ContentLength: session.sizeBytes,
      Metadata: { "boardwalk-session": sessionId, "boardwalk-asset": session.assetId },
    }, "2026-09-14T17:00:00.000Z");

    await expect(storeCompletedAsset(firestore, session, asset, actor()))
      .rejects.toMatchObject({ status: 429 });
    expect(firestore.records.has(`mediaSourceAssets/${session.assetId}`)).toBe(false);
  });

  it("serializes concurrent preview admission for one actor", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const first = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    const sessions = Array.from({ length: 3 }, (_, index) => ({
      ...structuredClone(first),
      id: `session-${index}`,
      assetId: `asset-${index}`,
      objectKey: `shared/objects/asset-${index}.mp4`,
    }));
    for (const session of sessions) {
      firestore.records.set(`mediaSourceUploads/${session.id}`, session);
    }

    const results = await Promise.allSettled(sessions.map((session) => storeCompletedAsset(
      firestore,
      session,
      completedAsset(session, {
        VersionId: `version-${session.assetId}`,
        ContentLength: session.sizeBytes,
        Metadata: {
          "boardwalk-session": session.id,
          "boardwalk-asset": session.assetId,
        },
      }, "2026-09-14T17:00:00.000Z"),
      actor(),
    )));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect([...firestore.records.entries()].filter(([key, value]) =>
      key.startsWith("mediaSourcePreviewJobs/") && value.active)).toHaveLength(2);
  });

  it("serializes concurrent preview admission at the shared limit", async () => {
    const active = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [
      `mediaSourcePreviewJobs/existing-${index}`,
      { active: true, actorUid: `existing-${index}` },
    ]));
    const firestore = fakeFirestore(active);
    const { sessionId } = await seededSession(firestore);
    const first = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    const sessions = ["staff-1", "staff-2"].map((actorUid, index) => ({
      ...structuredClone(first),
      id: `global-session-${index}`,
      actorUid,
      assetId: `global-asset-${index}`,
      objectKey: `shared/objects/global-asset-${index}.mp4`,
    }));
    for (const session of sessions) {
      firestore.records.set(`mediaSourceUploads/${session.id}`, session);
    }

    const results = await Promise.allSettled(sessions.map((session) => storeCompletedAsset(
      firestore,
      session,
      completedAsset(session, {
        VersionId: `version-${session.assetId}`,
        ContentLength: session.sizeBytes,
        Metadata: {
          "boardwalk-session": session.id,
          "boardwalk-asset": session.assetId,
        },
      }, "2026-09-14T17:00:00.000Z"),
      actor(session.actorUid),
    )));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected").reason)
      .toMatchObject({ status: 503 });
    expect([...firestore.records.entries()].filter(([key, value]) =>
      key.startsWith("mediaSourcePreviewJobs/") && value.active)).toHaveLength(20);
  });

  it("reserves preview capacity before completing the multipart upload", async () => {
    const firestore = fakeFirestore({
      "mediaSourcePreviewJobs/first": { active: true, actorUid: "staff-1" },
      "mediaSourcePreviewJobs/second": { active: true, actorUid: "staff-1" },
    });
    const { sessionId } = await seededSession(firestore);
    const checksum = Buffer.alloc(32, 1).toString("base64");
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const session = firestore.records.get(sessionKey);
    session.sizeBytes = 16 * 1024 * 1024;
    session.totalParts = 1;
    session.signedParts = {
      1: { partNumber: 1, sizeBytes: session.sizeBytes, checksumSha256: checksum },
    };
    const complete = vi.fn();
    const uploader = {
      listParts: async () => [{
        partNumber: 1,
        sizeBytes: session.sizeBytes,
        checksumSha256: checksum,
        etag: "etag",
      }],
      complete,
      head: vi.fn(),
    };

    await expect(completeUpload({
      actor: actor(),
      firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: { sourceId: "video-library", sessionId, version: 1 },
      source: source(),
      uploader,
    })).rejects.toMatchObject({ status: 429 });
    expect(complete).not.toHaveBeenCalled();
    expect(firestore.records.get(sessionKey).status).toBe("active");
    expect(firestore.records.has(`mediaSourceAssets/${session.assetId}`)).toBe(false);
  });

  it("serializes concurrent reservations before multipart completion", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const first = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    const checksum = Buffer.alloc(32, 1).toString("base64");
    const sessions = Array.from({ length: 3 }, (_, index) => ({
      ...structuredClone(first),
      id: `completion-session-${index}`,
      assetId: `completion-asset-${index}`,
      objectKey: `shared/objects/completion-asset-${index}.mp4`,
      sizeBytes: 16 * 1024 * 1024,
      totalParts: 1,
      signedParts: {
        1: { partNumber: 1, sizeBytes: 16 * 1024 * 1024, checksumSha256: checksum },
      },
    }));
    for (const session of sessions) {
      firestore.records.set(`mediaSourceUploads/${session.id}`, session);
    }
    const parts = [{
      partNumber: 1,
      sizeBytes: 16 * 1024 * 1024,
      checksumSha256: checksum,
      etag: "etag",
    }];
    const multipartChecksum = compositeSha256(parts);
    const complete = vi.fn(async (_source, session) => ({
      VersionId: `version-${session.assetId}`,
      ChecksumSHA256: multipartChecksum,
    }));
    const uploader = {
      listParts: async () => parts,
      complete,
      head: async (_source, session) => ({
        VersionId: `version-${session.assetId}`,
        ContentLength: session.sizeBytes,
        ChecksumSHA256: multipartChecksum,
        Metadata: {
          "boardwalk-session": session.id,
          "boardwalk-asset": session.assetId,
        },
      }),
    };

    const results = await Promise.allSettled(sessions.map((session) => completeUpload({
      actor: actor(),
      firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: { sourceId: "video-library", sessionId: session.id, version: 1 },
      source: source(),
      uploader,
    })));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(results.find(({ status }) => status === "rejected").reason)
      .toMatchObject({ status: 429 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost complete response from a matching object head", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const checksum = Buffer.alloc(32, 1).toString("base64");
    const sessionKey = `mediaSourceUploads/${sessionId}`;
    const session = firestore.records.get(sessionKey);
    session.sizeBytes = 16 * 1024 * 1024;
    session.totalParts = 1;
    session.signedParts = {
      1: { partNumber: 1, sizeBytes: session.sizeBytes, checksumSha256: checksum },
    };
    const composite = compositeSha256([{ checksumSha256: checksum }]);
    const uploader = {
      listParts: async () => [{
        partNumber: 1, sizeBytes: session.sizeBytes, checksumSha256: checksum, etag: "etag",
      }],
      complete: vi.fn(async () => { throw new Error("connection reset"); }),
      head: vi.fn(async () => ({
        VersionId: "recovered-version",
        ContentLength: session.sizeBytes,
        ChecksumSHA256: composite,
        Metadata: {
          "boardwalk-session": sessionId,
          "boardwalk-asset": session.assetId,
        },
      })),
    };
    const result = await completeUpload({
      actor: actor(), firestore,
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: { sourceId: "video-library", sessionId, version: 1 },
      source: source(), uploader,
    });
    expect(result.asset.id).toBe(session.assetId);
    expect(firestore.records.get(sessionKey).status).toBe("completed");
  });
});

describe("source media metadata", () => {
  it("uses optimistic versioning and keeps object coordinates unchanged", async () => {
    const assetId = "asset-1";
    const original = {
      id: assetId,
      sourceId: "video-library",
      lifecycle: "active",
      name: "Old",
      originalName: "meeting.mp4",
      description: null,
      nameSort: "old",
      updatedAtSort: "2026-09-14T16:00:00.000Z",
      mimeType: "video/mp4",
      kind: "video",
      sizeBytes: 12,
      preview: "browser",
      license: null,
      credit: null,
      tags: [],
      rightsStatus: "pending",
      version: 1,
      createdAt: "2026-09-14T15:00:00.000Z",
      updatedAt: "2026-09-14T16:00:00.000Z",
      objectKey: "shared/objects/asset-1.mp4",
      objectVersionId: "version-1",
    };
    const firestore = fakeFirestore({ [`mediaSourceAssets/${assetId}`]: original });
    const result = await updateMetadata({
      actor: actor(), firestore,
      adminLogEntryFn: (fields) => ({ ...fields, at: "test" }),
      nowFn: () => "2026-09-14T17:00:00.000Z",
      request: {
        sourceId: "video-library",
        assetId,
        expectedVersion: 1,
        changes: { name: "New", description: "New description" },
      },
      source: source(),
    });
    const stored = firestore.records.get(`mediaSourceAssets/${assetId}`);
    expect(result.asset).toMatchObject({ name: "New", description: "New description", version: 2 });
    expect(stored.objectKey).toBe(original.objectKey);
    expect(stored.objectVersionId).toBe(original.objectVersionId);
    expect([...firestore.records.values()]).toContainEqual(expect.objectContaining({
      action: "media.metadata.update",
      actorUid: "staff-1",
      actorEmail: "staff-1@example.org",
      target: `mediaSourceAssets/${assetId}`,
      before: expect.objectContaining({ name: "Old", version: 1 }),
      after: expect.objectContaining({ name: "New", version: 2 }),
    }));
  });

  it.each([false, true])("withholds uploader ids from metadata responses even on profile failure %s", async (profileFailure) => {
    const firestore = fakeFirestore({
      "mediaSourceAssets/asset-1": existingVideo({ createdBy: "staff-2" }),
      "users/staff-2": { displayName: "Alex Rivera", email: "private@example.org" },
    });
    if (profileFailure) firestore.getAll = async () => { throw new Error("Directory unavailable"); };
    const handler = uploads.makeHandler({
      maxBytes: 16 * 1024,
      parse: uploadContract.parseMetadataUpdateRequest,
      operation: "metadata",
      run: updateMetadata,
      usesUploader: false,
    }, {
      firestore,
      requirePrincipalFn: async () => actor(),
      verifyAppCheckFn: async () => {},
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => {},
      nowFn: () => "2026-09-14T18:00:00.000Z",
      adminLogEntryFn: (fields) => ({ ...fields, at: "test" }),
      log: { error: vi.fn() },
    });
    const req = (body) => ({
      method: "POST",
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
      headers: { "content-type": "application/json", "x-firebase-appcheck": "token" },
    });
    const res = () => ({
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });

    const success = res();
    await handler(req({
      sourceId: "video-library",
      assetId: "asset-1",
      expectedVersion: 1,
      changes: { name: "New" },
    }), success);
    expect(success.status).toHaveBeenCalledWith(200);
    expect(success.json.mock.calls[0][0].asset.uploadedBy).toEqual({
      name: profileFailure ? "Staff uploader" : "Alex Rivera",
    });

    expect(firestore.records.get("mediaSourceAssets/asset-1")).toMatchObject({ name: "New", version: 2 });
    const conflict = res();
    await handler(req({
      sourceId: "video-library",
      assetId: "asset-1",
      expectedVersion: 1,
      changes: { name: "Stale" },
    }), conflict);
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(conflict.json.mock.calls[0][0].current.uploadedBy).toEqual({
      name: profileFailure ? "Staff uploader" : "Alex Rivera",
    });
  });
});


describe("source video deletion", () => {
  function deletion(firestore, overrides = {}) {
    return deleteSourceMedia({
      actor: actor(), firestore, source: source(),
      adminLogEntryFn: (fields) => ({ ...fields, at: "test" }),
      nowFn: () => "2026-09-15T15:00:00.000Z",
      request: { sourceId: "video-library", assetId: "asset-1", expectedVersion: 1 },
      ...overrides,
    });
  }

  it("atomically records deletion and updates the exact total while retaining the object", async () => {
    const original = existingVideo();
    const firestore = fakeFirestore({
      "mediaSourceAssets/asset-1": original,
      "mediaSourceStats/video-library": { sourceId: "video-library", exact: true, activeCount: 3 },
    });
    await expect(deletion(firestore)).resolves.toEqual({ deleted: true });
    expect(firestore.records.get("mediaSourceAssets/asset-1")).toMatchObject({
      lifecycle: "deleted", version: 2, deletedBy: "staff-1",
      objectKey: original.objectKey, objectVersionId: original.objectVersionId,
    });
    expect(firestore.records.get("mediaSourceStats/video-library").activeCount).toBe(2);
    expect([...firestore.records.values()]).toContainEqual(expect.objectContaining({
      action: "media.library.delete", target: "mediaSourceAssets/asset-1",
      before: expect.objectContaining({ lifecycle: "active" }),
      after: expect.objectContaining({ lifecycle: "deleted", version: 2 }),
    }));
    const committedRecords = structuredClone([...firestore.records]);
    await expect(deletion(firestore)).resolves.toEqual({ deleted: true });
    expect([...firestore.records]).toEqual(committedRecords);
    await expect(deletion(firestore, { request: { sourceId: "video-library", assetId: "asset-1", expectedVersion: 2 } })).rejects.toMatchObject({ status: 404 });
    expect(firestore.records.get("mediaSourceStats/video-library").activeCount).toBe(2);
  });

  it("cannot update metadata after deletion", async () => {
    const firestore = fakeFirestore({ "mediaSourceAssets/asset-1": existingVideo({ lifecycle: "deleted" }) });
    await expect(updateMetadata({ actor: actor(), firestore, source: source(),
      nowFn: () => "2026-09-15T15:00:00.000Z",
      request: { sourceId: "video-library", assetId: "asset-1", expectedVersion: 1,
        changes: { name: "Restored" } },
    })).rejects.toMatchObject({ status: 404 });
    expect(firestore.records.get("mediaSourceAssets/asset-1").lifecycle).toBe("deleted");
  });

  it("rejects a stale version without changing the asset or count", async () => {
    const firestore = fakeFirestore({ "mediaSourceAssets/asset-1": existingVideo({ version: 2 }) });
    await expect(deletion(firestore)).rejects.toMatchObject({ status: 409 });
    expect(firestore.records.size).toBe(1);
    expect(firestore.records.get("mediaSourceAssets/asset-1").lifecycle).toBe("active");
  });

  it("does not delete an asset from another source or path", async () => {
    for (const change of [{ sourceId: "archive-working" }, { objectKey: "outside/file.mp4" }]) {
      const firestore = fakeFirestore({ "mediaSourceAssets/asset-1": existingVideo(change) });
      await expect(deletion(firestore)).rejects.toMatchObject({ status: 404 });
      expect(firestore.records.size).toBe(1);
    }
  });

  it("rolls back deletion when the audit cannot be created", async () => {
    const firestore = fakeFirestore({ "mediaSourceAssets/asset-1": existingVideo() });
    await expect(deletion(firestore, { adminLogEntryFn: () => { throw new Error("Audit failed"); } }))
      .rejects.toThrow("Audit failed");
    expect(firestore.records.get("mediaSourceAssets/asset-1").lifecycle).toBe("active");
    expect(firestore.records.size).toBe(1);
  });

  it("does not return or recreate a deleted video on completed upload retries", async () => {
    const firestore = fakeFirestore();
    const { sessionId } = await seededSession(firestore);
    const session = firestore.records.get(`mediaSourceUploads/${sessionId}`);
    const deleted = existingVideo({ id: session.assetId, objectKey: session.objectKey, lifecycle: "deleted" });
    firestore.records.set(`mediaSourceAssets/${session.assetId}`, deleted);
    firestore.records.set(`mediaSourceUploads/${sessionId}`, { ...session, status: "completed", assetSummary: deleted });
    const args = { actor: actor(), firestore, source: source(),
      request: { sourceId: "video-library", sessionId, version: 1 }, uploader: {},
      nowFn: () => "2026-09-14T17:00:00.000Z" };
    await expect(resumeUpload(args)).rejects.toMatchObject({ status: 410 });
    await expect(completeUpload(args)).rejects.toMatchObject({ status: 410 });
    await expect(storeCompletedAsset(firestore, session, { ...deleted, lifecycle: "active" }))
      .rejects.toMatchObject({ status: 409 });
    expect(firestore.records.get(`mediaSourceAssets/${session.assetId}`).lifecycle).toBe("deleted");
  });

  it("rejects a late preview write after deletion without restoring the asset", async () => {
    const original = existingVideo();
    const job = { ...previewJob.pendingPreview(original), leaseOwner: "worker-1" };
    const firestore = fakeFirestore({
      "mediaSourceAssets/asset-1": original,
      [`mediaSourcePreviewJobs/${job.id}`]: job,
    });
    await deletion(firestore);
    const saved = await previewJob.savePreview(firestore,
      firestore.collection("mediaSourcePreviewJobs").doc(job.id), job,
      { phase: "completed" }, { state: "ready" });
    expect(saved).toBe(false);
    expect(firestore.records.get("mediaSourceAssets/asset-1").lifecycle).toBe("deleted");
    expect(firestore.records.get(`mediaSourcePreviewJobs/${job.id}`)).toMatchObject({ active: false, phase: "stale" });
  });

  it("checks App Check and source authorization before a deletion can run", async () => {
    const body = { sourceId: "video-library", assetId: "asset-1", expectedVersion: 1 };
    const req = { method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)),
      headers: { "content-type": "application/json", "x-firebase-appcheck": "test-token" } };
    const run = vi.fn();
    const authorizeFn = vi.fn(async () => { throw new SourceUploadError(403, "Denied"); });
    const verifyAppCheckFn = vi.fn(async () => undefined);
    const handler = uploads.makeHandler({ maxBytes: 4096,
      parse: uploadContract.parseDeleteSourceMediaRequest, operation: "delete", run, usesUploader: false,
    }, { firestore: {}, requirePrincipalFn: async () => actor(), verifyAppCheckFn,
      registryFn: () => new Map([["video-library", source()]]), authorizeFn,
      log: { error: vi.fn() } });
    const res = { set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler(req, res);
    expect(verifyAppCheckFn).toHaveBeenCalledWith("test-token");
    expect(authorizeFn).toHaveBeenCalledWith(expect.objectContaining({ operation: "delete" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(run).not.toHaveBeenCalled();
    verifyAppCheckFn.mockRejectedValueOnce(new SourceUploadError(401, "App Check required"));
    authorizeFn.mockClear();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(authorizeFn).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("validates the deletion version and rejects caller identity fields", () => {
    const request = { sourceId: "video-library", assetId: "asset-1", expectedVersion: 1 };
    expect(uploadContract.parseDeleteSourceMediaRequest(request)).toEqual(request);
    expect(() => uploadContract.parseDeleteSourceMediaRequest({ ...request, expectedVersion: 0 })).toThrow();
    expect(() => uploadContract.parseDeleteSourceMediaRequest({ ...request, uploadedBy: "admin" })).toThrow();
  });
});
