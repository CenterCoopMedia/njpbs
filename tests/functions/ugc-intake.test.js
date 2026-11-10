import { createHash, randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import intake from "../../functions/ugc-intake.js";
import contract from "../../functions/lib/ugc-contract.js";

const PROJECT = "demo-njpbs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const DAMAGED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2lWAAAAAElFTkSuQmCC",
  "base64",
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"),
  Buffer.alloc(4), Buffer.from("mp41"), Buffer.alloc(12),
]);
const WEBM = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84,
  0x77, 0x65, 0x62, 0x6d,
]);
const texts = Object.fromEntries(contract.CONSENT_TEXT_FIELDS.map((field) => [field, `${field} text`]));
const config = {
  consentVersion: "ugc-release-1", approvedBy: "jules", approvedAt: new Date(), texts,
};

let firestore;

function request(overrides = {}) {
  return {
    requestId: randomUUID(), name: "Person", email: "person@example.org",
    message: "A photo from the station.",
    consentVersion: config.consentVersion,
    consentTextHash: contract.consentTextHash(texts.release),
    consentChecked: true, ageAttested: true,
    file: { name: "photo.png", type: "image/png", size: PNG.length },
    clientIpHash: "a".repeat(64), ...overrides,
  };
}

function httpRequest(body, method = "POST") {
  return { method, headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body)), body };
}

function response() {
  return {
    statusCode: null, body: null, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    signPut: vi.fn(async (key) => `https://r2.example.test/${key}`),
    head: vi.fn(async (key) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, etag: '"fixed"' } : null;
    }),
    read: vi.fn(async (key, _etag, range) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Missing object");
      const selected = range ? bytes.subarray(0, 65536) : bytes;
      return (async function* () { yield selected; })();
    }),
    delete: vi.fn(async (key) => { objects.delete(key); }),
    rejectUpload: vi.fn(async (key) => { objects.set(key, Buffer.alloc(0)); }),
  };
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  firestore = admin.firestore();
});

beforeEach(async () => {
  await Promise.all([
    firestore.recursiveDelete(firestore.collection("ugcSubmissions")),
    firestore.collection("ugcConfig").doc("current").delete(),
  ]);
});

describe("UGC intake", () => {
  it("returns closed config and refuses a start until all text is approved", async () => {
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const result = response();
    await handlers.getConfig({ method: "GET" }, result);
    expect(result.body.open).toBe(false);
    await expect(handlers.start(httpRequest(request()), response()))
      .rejects.toMatchObject({ code: "closed" });
    expect(storage.signPut).not.toHaveBeenCalled();
  });

  it("writes one consent record and returns the same upload for a retry", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    let clock = Date.parse("2026-09-28T12:00:00Z");
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage,
      now: () => clock, uuid: () => "object-1" });
    const body = request();
    const first = response();
    const second = response();
    await handlers.start(httpRequest(body), first);
    clock += 14 * 60 * 1000;
    await handlers.start(httpRequest(body), second);
    expect(second.body).toEqual(first.body);
    expect(storage.signPut.mock.calls.map((call) => call[3])).toEqual([900, 60]);
    expect(first.body.uploadHeaders).toEqual({
      "Content-Type": "image/png", "If-None-Match": "*",
    });
    const snapshot = await firestore.collection("ugcSubmissions")
      .doc(first.body.submissionId).get();
    const row = snapshot.data();
    expect(row.status).toBe("uploading");
    expect(row.quarantineKey).toBe(`ugc-quarantine/${body.requestId}/object-1`);
    expect(row.consentedAt.toDate()).toBeInstanceOf(Date);
    expect(row.ageAttestation).toMatchObject({
      version: config.consentVersion, attested: true,
    });
    expect(row.ageAttestation.attestedAt.toDate()).toBeInstanceOf(Date);
    expect(row.scopes).toEqual({ broadcast: true, web: true, social: true });
    expect(row.clientIpHash).toBe(body.clientIpHash);
    expect(row.consentTexts).toEqual(texts);
    expect(row.expireAt.toDate().toISOString()).toBe("2026-12-27T12:00:00.000Z");
    expect((await firestore.collection("ugcSubmissions").get()).size).toBe(1);
    await expect(handlers.start(httpRequest({ ...body, message: "Changed message" }), response()))
      .rejects.toMatchObject({ code: "invalid" });
    clock += 57_500;
    await handlers.start(httpRequest(body), response());
    expect(storage.signPut.mock.calls.at(-1)[3]).toBe(2);
    clock += 1_500;
    await expect(handlers.start(httpRequest(body), response()))
      .rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses stale consent and invalid fields before creating a row", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const handlers = intake.createUgcHandlers({ firestore, storage: () => memoryStorage() });
    await expect(handlers.start(httpRequest(request({ consentTextHash: "b".repeat(64) })), response()))
      .rejects.toMatchObject({ code: "invalid" });
    await expect(handlers.start(httpRequest(request({ file: {
      name: "huge.mp4", type: "video/mp4", size: contract.VIDEO_MAX_BYTES + 1,
    } })), response())).rejects.toMatchObject({ code: "too_large" });
    expect((await firestore.collection("ugcSubmissions").get()).empty).toBe(true);
  });

  it("checks the uploaded image, stores its hash, and completes a retry", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request();
    const started = response();
    await handlers.start(httpRequest(body), started);
    const ref = firestore.collection("ugcSubmissions").doc(started.body.submissionId);
    storage.objects.set((await ref.get()).data().quarantineKey, PNG);
    await handlers.complete(httpRequest({ submissionId: body.requestId,
      requestId: body.requestId }), response());
    const row = (await ref.get()).data();
    expect(row.status).toBe("pending");
    expect(row.sniffedType).toBe("image/png");
    expect(row.size).toBe(PNG.length);
    expect(row.contentHash).toBe(createHash("sha256").update(PNG).digest("hex"));
    const retry = response();
    await handlers.complete(httpRequest({ submissionId: body.requestId,
      requestId: body.requestId }), retry);
    expect(retry.body).toEqual({ ok: true });
  });

  it("rejects a file that does not match its declared type and fences it", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request({ file: { name: "photo.png", type: "image/png", size: MP4.length } });
    await handlers.start(httpRequest(body), response());
    const ref = firestore.collection("ugcSubmissions").doc(body.requestId);
    const key = (await ref.get()).data().quarantineKey;
    storage.objects.set(key, MP4);
    await expect(handlers.complete(httpRequest({ submissionId: body.requestId,
      requestId: body.requestId }), response())).rejects.toMatchObject({ code: "rejected_file" });
    expect(storage.objects.get(key)).toEqual(Buffer.alloc(0));
    const row = (await ref.get()).data();
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "file_check",
      consentVersion: config.consentVersion });
    for (const field of ["name", "email", "message"]) expect(row[field]).toBeUndefined();
    await expect(handlers.start(httpRequest(body), response()))
      .rejects.toMatchObject({ code: "invalid" });
  });

  it("does not restore pending status over a later rejection", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request();
    await handlers.start(httpRequest(body), response());
    const ref = firestore.collection("ugcSubmissions").doc(body.requestId);
    storage.objects.set((await ref.get()).data().quarantineKey, PNG);
    const read = storage.read;
    storage.read = async (...args) => {
      await ref.update({ status: "rejected" });
      return read(...args);
    };
    await expect(handlers.complete(httpRequest({ submissionId: body.requestId,
      requestId: body.requestId }), response())).rejects.toMatchObject({ code: "rejected_file" });
    expect((await ref.get()).data().status).toBe("rejected");
  });

  it("keeps rejection after a fence error and removes the bytes on retry", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request({ file: { name: "photo.png", type: "image/png", size: MP4.length } });
    await handlers.start(httpRequest(body), response());
    const ref = firestore.collection("ugcSubmissions").doc(body.requestId);
    const key = (await ref.get()).data().quarantineKey;
    storage.objects.set(key, MP4);
    const remove = storage.rejectUpload;
    storage.rejectUpload = vi.fn().mockRejectedValueOnce(new Error("R2 unavailable"))
      .mockImplementation(remove);
    const complete = () => handlers.complete(httpRequest({
      submissionId: body.requestId, requestId: body.requestId,
    }), response());
    await expect(complete()).rejects.toThrow("R2 unavailable");
    expect((await ref.get()).data().status).toBe("rejected");
    expect(storage.objects.has(key)).toBe(true);
    await expect(complete()).rejects.toMatchObject({ code: "rejected_file" });
    expect(storage.objects.get(key)).toEqual(Buffer.alloc(0));
  });

  it("sniffs video containers and streams the full file hash", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request({ file: { name: "clip.mp4", type: "video/mp4", size: MP4.length } });
    await handlers.start(httpRequest(body), response());
    const ref = firestore.collection("ugcSubmissions").doc(body.requestId);
    storage.objects.set((await ref.get()).data().quarantineKey, MP4);
    await handlers.complete(httpRequest({ submissionId: body.requestId,
      requestId: body.requestId }), response());
    expect((await ref.get()).data().contentHash)
      .toBe(createHash("sha256").update(MP4).digest("hex"));
    expect(storage.read.mock.calls.map((call) => call[2]))
      .toEqual(["bytes=0-65535", undefined]);
    expect(intake.sniffVideo(WEBM, "video/webm")).toBe("video/webm");
    expect(intake.sniffVideo(WEBM, "video/mp4")).toBeNull();
    expect(intake.sniffVideo(MP4, "video/quicktime")).toBeNull();
  });

  it("returns missing and expired upload errors", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    let clock = Date.now();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage,
      now: () => clock });
    const body = request();
    await handlers.start(httpRequest(body), response());
    const complete = () => handlers.complete(httpRequest({
      submissionId: body.requestId, requestId: body.requestId,
    }), response());
    await expect(complete()).rejects.toMatchObject({ code: "missing_upload" });
    clock += 16 * 60 * 1000;
    await expect(complete()).rejects.toMatchObject({ code: "expired" });
  });

  it("accepts the Worker's 32-character IP hash and an uppercase ID on complete", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request({ clientIpHash: "b".repeat(32) });
    await handlers.start(httpRequest(body), response());
    const record = (await firestore.collection("ugcSubmissions")
      .doc(body.requestId).get()).data();
    storage.objects.set(record.quarantineKey, PNG);
    const upper = body.requestId.toUpperCase();
    await handlers.complete(httpRequest({ submissionId: upper, requestId: upper }), response());
    expect((await firestore.collection("ugcSubmissions").doc(body.requestId)
      .get()).data().status).toBe("pending");
  });

  it("rejects a photo whose pixels do not decode", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage });
    const body = request({ file: { name: "photo.png", type: "image/png", size: DAMAGED_PNG.length } });
    await handlers.start(httpRequest(body), response());
    const ref = firestore.collection("ugcSubmissions").doc(body.requestId);
    storage.objects.set((await ref.get()).data().quarantineKey, DAMAGED_PNG);
    await expect(handlers.complete(httpRequest({
      submissionId: body.requestId, requestId: body.requestId,
    }), response())).rejects.toMatchObject({ code: "rejected_file" });
    expect((await ref.get()).data().status).toBe("rejected");
  });

  it("completes a slow upload that finished after the signed URL expired", async () => {
    await firestore.collection("ugcConfig").doc("current").set(config);
    const storage = memoryStorage();
    let clock = Date.now();
    const handlers = intake.createUgcHandlers({ firestore, storage: () => storage,
      now: () => clock });
    const body = request();
    await handlers.start(httpRequest(body), response());
    const record = (await firestore.collection("ugcSubmissions")
      .doc(body.requestId).get()).data();
    storage.objects.set(record.quarantineKey, PNG);
    clock += 40 * 60 * 1000;
    await handlers.complete(httpRequest({
      submissionId: body.requestId, requestId: body.requestId,
    }), response());
    expect((await firestore.collection("ugcSubmissions").doc(body.requestId)
      .get()).data().status).toBe("pending");
  });

  it("signs the exact PUT type and length with a one-write condition", async () => {
    const client = new S3Client({ region: "auto", endpoint: "https://r2.example.test",
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    const storage = intake.createUgcStorage({ client, bucket: "ugc-private" });
    const url = new URL(await storage.signPut("ugc-quarantine/a/b", "image/png", 123));
    expect(url.searchParams.get("X-Amz-SignedHeaders"))
      .toBe("content-length;content-type;host;if-none-match");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });
});
