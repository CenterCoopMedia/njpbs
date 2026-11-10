"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { quotaEvidence, quotaEvidenceRef, reconcileQuota } = require("./lib/ugc-quota");
const { inspectUpload } = require("./media");
const { MediaValidationError } = require("./lib/media-contract");
const { isMissingObject, r2ClientConfig } = require("./lib/r2-media");
const {
  RETENTION_DAYS,
  UPLOAD_URL_LIFETIME_SECONDS,
  UGC_TYPES,
  UgcContractError,
  normalizeStartRequest,
  quarantineObjectKey,
  readConsentConfig,
} = require("./lib/ugc-contract");

const UGC_R2_BUCKET = defineString("UGC_R2_BUCKET", { default: "" });
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const R2_ACCESS_KEY_ID = defineSecret("UGC_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("UGC_R2_SECRET_ACCESS_KEY");
const DAY_MS = 24 * 60 * 60 * 1000;
const HEADER_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 8 * 1024;
const STATUS = Object.freeze({
  closed: 403, invalid: 400, too_large: 413, type: 415,
  rejected_file: 422, missing_upload: 404, expired: 410,
});

function createUgcStorage({ client, bucket, sign = getSignedUrl }) {
  if (!bucket) throw new Error("UGC_R2_BUCKET is not configured");
  const location = (key) => ({ Bucket: bucket, Key: key });
  return {
    async signPut(key, type, size, expiresIn = UPLOAD_URL_LIFETIME_SECONDS) {
      const command = new PutObjectCommand({
        ...location(key), ContentType: type, ContentLength: size,
        IfNoneMatch: "*", CacheControl: "no-store",
      });
      return sign(client, command, {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length", "if-none-match"]),
      });
    },
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand(location(key)));
        return { size: result.ContentLength, etag: result.ETag, quotaReleased: result.Metadata?.["ugc-quota-released"] === "true" };
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
    async sealMissing(key) {
      try {
        await client.send(new PutObjectCommand({
          ...location(key), Body: Buffer.alloc(0), ContentLength: 0,
          IfNoneMatch: "*", Metadata: { "ugc-quota-released": "true" },
          CacheControl: "no-store",
        }));
        return true;
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 412) return false;
        throw error;
      }
    },
    async rejectUpload(key) {
      // Replace rejected bytes atomically. Delete followed by PUT would open a
      // replay window and could remove a concurrent reconciliation's fence.
      await client.send(new PutObjectCommand({
        ...location(key), Body: Buffer.alloc(0), ContentLength: 0,
        Metadata: { "ugc-quota-released": "true" }, CacheControl: "no-store",
      }));
    },
    async signGet(key, expiresIn = 300) {
      return sign(client, new GetObjectCommand(location(key)), { expiresIn });
    },
    async read(key, etag, range) {
      const result = await client.send(new GetObjectCommand({
        ...location(key), ...(etag ? { IfMatch: etag } : {}),
        ...(range ? { Range: range } : {}),
      }));
      return result.Body;
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand(location(key)));
    },
  };
}

function runtimeStorage() {
  return createUgcStorage({
    client: new S3Client(r2ClientConfig({
      endpoint: R2_ENDPOINT.value(),
      accessKeyId: R2_ACCESS_KEY_ID.value(),
      secretAccessKey: R2_SECRET_ACCESS_KEY.value(),
    })),
    bucket: UGC_R2_BUCKET.value(),
  });
}

async function readBoundedBody(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new UgcContractError("rejected_file");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function ebmlSize(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let width = 1;
  while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width += 1;
  if (width > 8 || offset + width > bytes.length) return null;
  let value = first & ((1 << (8 - width)) - 1);
  for (let i = 1; i < width; i += 1) value = value * 256 + bytes[offset + i];
  return { width, value };
}

function isWebm(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const rootSize = ebmlSize(bytes, 4);
  if (!rootSize) return false;
  let offset = 4 + rootSize.width;
  const end = Math.min(offset + rootSize.value, bytes.length);
  while (offset < end) {
    const id = ebmlSize(bytes, offset);
    if (!id) return false;
    const idBytes = bytes.subarray(offset, offset + id.width);
    offset += id.width;
    const size = ebmlSize(bytes, offset);
    if (!size) return false;
    offset += size.width;
    if (offset + size.value > end) return false;
    if (idBytes.equals(Buffer.from([0x42, 0x82]))) {
      return bytes.subarray(offset, offset + size.value).toString("ascii") === "webm";
    }
    offset += size.value;
  }
  return false;
}

function sniffVideo(bytes, declaredType) {
  if (declaredType === "video/webm") return isWebm(bytes) ? declaredType : null;
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) return null;
  const brands = [];
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (offset !== 12) brands.push(bytes.toString("ascii", offset, offset + 4));
  }
  if (declaredType === "video/quicktime") {
    return brands.includes("qt  ") ? declaredType : null;
  }
  const mp4Brand = brands.some((brand) =>
    /^(isom|iso[2-9]|mp4[1-9]|avc1|M4V |MSNV|dash)$/.test(brand));
  return mp4Brand ? declaredType : null;
}

async function inspectStoredFile(storage, record, head) {
  const { file, quarantineKey } = record;
  if (head.size !== file.size || !Number.isSafeInteger(head.size)) {
    throw new UgcContractError("rejected_file");
  }
  if (UGC_TYPES[file.type]?.kind === "image") {
    const body = await storage.read(quarantineKey, head.etag);
    const bytes = await readBoundedBody(body, file.size);
    if (bytes.length !== file.size) throw new UgcContractError("rejected_file");
    try {
      const inspection = await inspectUpload(bytes, file.type);
      if (inspection.animated && file.type !== "image/webp") {
        throw new MediaValidationError("Animated photo type is unavailable", 415);
      }
    } catch (error) {
      if (!(error instanceof MediaValidationError)) throw error;
      throw new UgcContractError("rejected_file");
    }
    return {
      sniffedType: file.type, size: bytes.length,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const prefix = await readBoundedBody(
    await storage.read(quarantineKey, head.etag, `bytes=0-${HEADER_BYTES - 1}`),
    HEADER_BYTES,
  );
  const sniffedType = sniffVideo(prefix, file.type);
  if (!sniffedType) throw new UgcContractError("rejected_file");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of await storage.read(quarantineKey, head.etag)) {
    size += chunk.length;
    if (size > file.size) throw new UgcContractError("rejected_file");
    hash.update(chunk);
  }
  if (size !== file.size) throw new UgcContractError("rejected_file");
  return { sniffedType, size, contentHash: hash.digest("hex") };
}

function parseJson(req, method) {
  if (req.method !== method) throw new UgcContractError("invalid");
  if (method === "GET") return null;
  if (req.headers?.["content-type"]?.split(";", 1)[0]?.trim() !== "application/json" ||
      (Buffer.isBuffer(req.rawBody) && req.rawBody.length > MAX_JSON_BYTES) ||
      !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new UgcContractError("invalid");
  }
  return req.body;
}

async function missingUploadError(ref) {
  const current = (await ref.get()).data();
  return new UgcContractError(
    current?.status === "rejected" ? "rejected_file" : "missing_upload");
}

function createUgcHandlers({ firestore = db, storage = runtimeStorage, now = Date.now,
  uuid = randomUUID } = {}) {
  async function getConfig(req, res) {
    parseJson(req, "GET");
    const snapshot = await firestore.collection("ugcConfig").doc("current").get();
    res.status(200).json(readConsentConfig(snapshot.data()));
  }

  async function start(req, res) {
    const body = parseJson(req, "POST");
    const request = normalizeStartRequest(body);
    if (typeof body.clientIpHash !== "string" || !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(body.clientIpHash)) {
      throw new UgcContractError("invalid");
    }
    const submissionRef = firestore.collection("ugcSubmissions").doc(request.requestId);
    const evidenceRef = quotaEvidenceRef(submissionRef);
    const configRef = firestore.collection("ugcConfig").doc("current");
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(request)).digest("hex");
    const currentTime = now();
    const record = await firestore.runTransaction(async (transaction) => {
      const [configSnapshot, submissionSnapshot, evidenceSnapshot] = await Promise.all([
        transaction.get(configRef), transaction.get(submissionRef), transaction.get(evidenceRef),
      ]);
      const config = readConsentConfig(configSnapshot.data());
      if (!config.open) throw new UgcContractError("closed");
      if (request.consentVersion !== config.consentVersion ||
          request.consentTextHash !== config.consentTextHash) {
        throw new UgcContractError("invalid");
      }
      if (submissionSnapshot.exists) {
        const existing = submissionSnapshot.data();
        if (existing.status !== "uploading" ||
            existing.requestFingerprint !== requestFingerprint ||
            existing.clientIpHash !== body.clientIpHash ||
            existing.uploadExpiresAt?.toMillis() <= currentTime) {
          throw new UgcContractError("invalid");
        }
        if (!evidenceSnapshot.exists) transaction.create(evidenceRef, quotaEvidence(existing));
        return existing;
      }
      if (evidenceSnapshot.exists) throw new UgcContractError("invalid");
      const submissionId = submissionRef.id;
      const quarantineKey = quarantineObjectKey(submissionId, uuid());
      const uploadExpiresAt = Timestamp.fromMillis(
        currentTime + UPLOAD_URL_LIFETIME_SECONDS * 1000);
      const value = {
        submissionId, requestId: request.requestId, requestFingerprint,
        status: "uploading", name: request.name, email: request.email,
        message: request.message, file: request.file,
        consentVersion: config.consentVersion,
        consentTextHash: config.consentTextHash,
        consentTexts: config.texts,
        consentedAt: FieldValue.serverTimestamp(),
        scopes: { broadcast: true, web: true, social: true },
        ageAttestation: {
          version: config.consentVersion, attested: true,
          attestedAt: FieldValue.serverTimestamp(),
        },
        clientIpHash: body.clientIpHash, quarantineKey,
        uploadExpiresAt,
        // Import must clear this TTL so the rights record remains with imported media.
        expireAt: Timestamp.fromMillis(currentTime + RETENTION_DAYS * DAY_MS),
        createdAt: FieldValue.serverTimestamp(),
      };
      transaction.create(submissionRef, value);
      transaction.create(evidenceRef, quotaEvidence(value));
      return value;
    });
    const remainingSeconds = Math.floor(
      (record.uploadExpiresAt.toMillis() - now()) / 1000);
    if (remainingSeconds <= 1) throw new UgcContractError("invalid");
    const uploadUrl = await storage().signPut(
      record.quarantineKey, record.file.type, record.file.size, remainingSeconds);
    res.status(200).json({
      submissionId: record.submissionId, uploadUrl,
      uploadHeaders: { "Content-Type": record.file.type, "If-None-Match": "*" },
      expiresAt: record.uploadExpiresAt.toDate().toISOString(),
    });
  }

  async function complete(req, res) {
    const body = parseJson(req, "POST");
    if (typeof body.submissionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submissionId) ||
        typeof body.requestId !== "string" ||
        body.requestId.toLowerCase() !== body.submissionId.toLowerCase()) {
      throw new UgcContractError("invalid");
    }
    const ref = firestore.collection("ugcSubmissions").doc(body.submissionId.toLowerCase());
    const snapshot = await ref.get();
    let record = snapshot.data();
    // This header is set only by the edge's internal reconciliation path. The
    // public Worker never forwards caller headers to the secret-gated origin.
    if (req.headers?.["x-njpbs-quota-reconcile"] === "1") {
      if (!snapshot.exists) {
        const evidence = (await quotaEvidenceRef(ref).get()).data();
        if (!evidence) throw new UgcContractError("missing_upload");
        if (!Number.isSafeInteger(evidence.uploadExpiresAtMs) || !evidence.quarantineKey) {
          throw new Error("Missing upload storage binding");
        }
        record = { ...evidence, status: "uploading",
          uploadExpiresAt: Timestamp.fromMillis(evidence.uploadExpiresAtMs) };
      }
      if (record.clientIpHash !== body.clientIpHash) throw new UgcContractError("invalid");
      const quotaBytes = await reconcileQuota(storage(), record, now());
      if (quotaBytes === null) throw new UgcContractError("missing_upload");
      res.status(200).json({ quotaBytes });
      return;
    }
    if (!snapshot.exists) throw new UgcContractError("missing_upload");
    if (record.status === "pending" || record.status === "imported") {
      res.status(200).json({ ok: true });
      return;
    }
    if (record.status === "rejected") {
      if (record.rejectionReason === "file_check" && (record.quarantineKey || record.quotaKey)) {
        await storage().rejectUpload(record.quarantineKey || record.quotaKey);
      }
      throw new UgcContractError("rejected_file");
    }
    if (record.status !== "uploading") throw new UgcContractError("invalid");
    const store = storage();
    const head = await store.head(record.quarantineKey);
    if (head?.quotaReleased) throw new UgcContractError("expired");
    // The signed URL bounds when a PUT may start, not when a slow upload ends.
    if (!head && record.uploadExpiresAt?.toMillis() <= now()) {
      throw new UgcContractError("expired");
    }
    if (!head) throw await missingUploadError(ref);
    let inspected;
    try {
      inspected = await inspectStoredFile(store, record, head);
    } catch (error) {
      if (isMissingObject(error)) throw await missingUploadError(ref);
      if (!(error instanceof UgcContractError) || error.code !== "rejected_file") throw error;
      const status = await firestore.runTransaction(async (transaction) => {
        const latest = await transaction.get(ref);
        if (latest.data()?.status === "uploading") {
          transaction.update(ref, { status: "rejected", rejectionReason: "file_check",
            rejectedAt: FieldValue.serverTimestamp(), name: FieldValue.delete(),
            email: FieldValue.delete(), message: FieldValue.delete() });
          return "rejected";
        }
        return latest.data()?.status;
      });
      if (status === "pending" || status === "imported") {
        res.status(200).json({ ok: true });
        return;
      }
      if (status !== "rejected") throw new UgcContractError("missing_upload");
      await store.rejectUpload(record.quarantineKey);
      throw error;
    }
    const finalStatus = await firestore.runTransaction(async (transaction) => {
      const latest = await transaction.get(ref);
      if (latest.data()?.status === "uploading") {
        transaction.update(ref, { ...inspected, status: "pending",
          completedAt: FieldValue.serverTimestamp() });
        return "pending";
      }
      return latest.data()?.status;
    });
    if (finalStatus === "rejected") throw new UgcContractError("rejected_file");
    if (!["pending", "imported"].includes(finalStatus)) {
      throw new UgcContractError("missing_upload");
    }
    res.status(200).json({ ok: true });
  }

  return { getConfig, start, complete };
}

function route(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof UgcContractError) {
        res.status(STATUS[error.code] ?? 400).json({ error: error.code });
        return;
      }
      logger.error("UGC intake failed", { error });
      res.status(503).json({ error: "unavailable" });
    }
  };
}

const handlers = createUgcHandlers();
const ugcGetConfig = cmsOnRequest({ memory: "256MiB", concurrency: 10,
  maxInstances: 5 }, route(handlers.getConfig));
const ugcStartSubmission = cmsOnRequest({ memory: "256MiB", concurrency: 10,
  maxInstances: 5, secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY] },
route(handlers.start));
const ugcCompleteSubmission = cmsOnRequest({ memory: "1GiB", concurrency: 1,
  maxInstances: 5, timeoutSeconds: 540,
  secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY] }, route(handlers.complete));

module.exports = {
  UGC_R2_BUCKET,
  createUgcHandlers,
  createUgcStorage,
  readBoundedBody,
  runtimeStorage,
  inspectStoredFile,
  isWebm,
  route,
  sniffVideo,
  ugcCompleteSubmission,
  ugcGetConfig,
  ugcStartSubmission,
};
