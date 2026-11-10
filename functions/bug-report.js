"use strict";

const { createHash } = require("node:crypto");
const Busboy = require("busboy");
const sharp = require("sharp");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requestHeader } = require("./lib/http-json");
const { db } = require("./lib/firebase");
const { requirePrincipal, ForbiddenError } = require("./lib/auth");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const {
  BUG_REPORT_COLLECTIONS,
  BugReportContractError,
  composeBugReport,
  mintBugReportId,
  reportForReporter,
  shouldEmailBugReport,
} = require("./lib/bug-report-contract");
const {
  parsePremiereReport, premiereIncidentFingerprint, premiereReportSubmission,
  premiereRequestFingerprint,
} = require("./lib/premiere-report-contract");
const {
  AdminStatusRevisionError,
  readLiveAdminBuildRevision,
} = require("./lib/admin-status-revision");
const BUG_REPORT_BUILD_REVISION = defineString("CMS_ADMIN_BUILD_REVISION", {
  default: "",
});
const BUG_REPORT_DEPLOYMENT_ENVIRONMENT = defineString(
  "CMS_DEPLOYMENT_ENVIRONMENT",
  { default: "" },
);

const ALLOWED_FIELDS = new Set(["report", "clientRequestId", "website"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILD_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "development",
  "preview",
  "emulator",
  "local",
]);
const ROLE_RANK = new Map([
  ["staff", 1],
  ["contributor", 2],
  ["editor", 3],
  ["admin", 4],
  ["super_admin", 5],
]);
const MIME_BY_FORMAT = new Map([
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);
const MAX_SCREENSHOT_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 128 * 1024;
const MAX_REPORT_FIELD_BYTES = 120 * 1024;
const MAX_SCREENSHOT_PIXELS = 50_000_000;
const MAX_SCREENSHOT_DIMENSION = 1_600;
const MAX_STORED_SCREENSHOT_BYTES = 700 * 1024;
const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const RATE_WINDOW_MS = 15 * 60 * 1_000;
const RATE_MAX_REPORTS = 5;
const AUTOMATIC_USER_MAX_REPORTS = 3;
const AUTOMATIC_GLOBAL_MAX_REPORTS = 10;

class BugReportRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "BugReportRequestError";
    this.status = status;
  }
}

class BugReportRateLimitError extends BugReportRequestError {
  constructor(retryAfterSeconds) {
    super("Too many reports. Try again later.", 429);
    this.name = "BugReportRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function configuredValue(param, envName) {
  // config-input: CMS_ADMIN_BUILD_REVISION, CMS_DEPLOYMENT_ENVIRONMENT
  const local = process.env[envName]?.trim();
  return local || param.value().trim();
}

function validateMultipartRequest(req) {
  const encoding = requestHeader(req, "content-encoding");
  if (encoding && encoding.toLocaleLowerCase("en-US") !== "identity") {
    throw new BugReportRequestError(
      "Compressed report requests are not supported",
      415,
    );
  }
  const contentType = requestHeader(req, "content-type") ?? "";
  if (!/^multipart\/form-data\s*;.*\bboundary=/i.test(contentType)) {
    throw new BugReportRequestError(
      "Content-Type must be multipart/form-data",
      415,
    );
  }
  if (!Buffer.isBuffer(req.rawBody)) {
    throw new BugReportRequestError("A multipart report is required");
  }
  if (
    req.rawBody.length >
    MAX_SCREENSHOT_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    throw new BugReportRequestError("The report request is too large", 413);
  }
}

function parseMultipartReport(req, { allowAdminBuildRevision = false } = {}) {
  const allowedFields = allowAdminBuildRevision
    ? new Set([...ALLOWED_FIELDS, "adminBuildRevision"])
    : ALLOWED_FIELDS;
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_SCREENSHOT_UPLOAD_BYTES,
          files: 1,
          fields: allowedFields.size,
          fieldSize: MAX_REPORT_FIELD_BYTES,
          parts: allowedFields.size + 2,
        },
      });
    } catch {
      reject(new BugReportRequestError("A valid multipart report is required"));
      return;
    }

    const fields = {};
    let screenshot = null;
    let failure = null;
    const fail = (error) => {
      if (!failure) failure = error;
    };

    parser.on("field", (name, value, info) => {
      if (!allowedFields.has(name)) {
        fail(new BugReportRequestError(`Unknown report field ${name}`));
        return;
      }
      if (info?.valueTruncated) {
        fail(new BugReportRequestError(`Report field ${name} is too long`));
        return;
      }
      if (Object.hasOwn(fields, name)) {
        fail(new BugReportRequestError(`Report field ${name} must appear once`));
        return;
      }
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "screenshot" || screenshot !== null) {
        fail(
          new BugReportRequestError(
            "Use at most one file in the screenshot field",
          ),
        );
        stream.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      screenshot = {
        mimeType: String(info.mimeType ?? "").toLocaleLowerCase("en-US"),
        buffer: null,
      };
      stream.on("limit", () => {
        fail(new BugReportRequestError("The screenshot is too large", 413));
      });
      stream.on("data", (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on("end", () => {
        screenshot.buffer = Buffer.concat(chunks, size);
      });
    });
    parser.on("filesLimit", () => {
      fail(new BugReportRequestError("Only one screenshot is allowed"));
    });
    parser.on("fieldsLimit", () => {
      fail(new BugReportRequestError("The report has too many fields"));
    });
    parser.on("partsLimit", () => {
      fail(new BugReportRequestError("The report has too many parts"));
    });
    parser.on("error", () => {
      fail(new BugReportRequestError("The multipart report is invalid"));
    });
    parser.on("close", () => {
      if (failure) {
        reject(failure);
        return;
      }
      if (
        screenshot &&
        (!Buffer.isBuffer(screenshot.buffer) || screenshot.buffer.length === 0)
      ) {
        reject(new BugReportRequestError("The screenshot must not be empty"));
        return;
      }
      resolve({ fields, screenshot });
    });
    parser.end(req.rawBody);
  });
}

function parseReportFields(fields) {
  if (typeof fields.report !== "string") {
    throw new BugReportRequestError("The report field is required");
  }
  if (
    typeof fields.clientRequestId !== "string" ||
    !UUID_PATTERN.test(fields.clientRequestId)
  ) {
    throw new BugReportRequestError("The client request id is invalid");
  }
  if (typeof fields.website === "string" && fields.website.trim()) {
    throw new BugReportRequestError("The report could not be submitted");
  }
  let report;
  try {
    report = JSON.parse(fields.report);
  } catch {
    throw new BugReportRequestError("The report field must be valid JSON");
  }
  return {
    report,
    clientRequestId: fields.clientRequestId.toLocaleLowerCase("en-US"),
  };
}

async function normalizeScreenshot(screenshot) {
  if (!screenshot) return null;
  let metadata;
  try {
    metadata = await sharp(screenshot.buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_SCREENSHOT_PIXELS,
    }).metadata();
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new BugReportRequestError("The screenshot has too many pixels. Resize it and try again.", 413);
    }
    throw new BugReportRequestError("The screenshot cannot be decoded safely", 415);
  }
  const detectedMimeType = MIME_BY_FORMAT.get(metadata.format);
  if (!detectedMimeType || detectedMimeType !== screenshot.mimeType) {
    throw new BugReportRequestError(
      "The screenshot content does not match its type",
      415,
    );
  }
  if (
    (metadata.pages ?? 1) !== 1 ||
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width * metadata.height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new BugReportRequestError("The screenshot dimensions are invalid", 415);
  }

  let processed;
  try {
    processed = await sharp(screenshot.buffer, {
      failOn: "error",
      limitInputPixels: MAX_SCREENSHOT_PIXELS,
    })
      .rotate()
      .resize({
        width: MAX_SCREENSHOT_DIMENSION,
        height: MAX_SCREENSHOT_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 72, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new BugReportRequestError("The screenshot could not be normalized", 415);
  }
  if (processed.data.length > MAX_STORED_SCREENSHOT_BYTES) {
    throw new BugReportRequestError(
      "The normalized screenshot is too large",
      413,
    );
  }
  return {
    buffer: processed.data,
    mimeType: "image/webp",
    sizeBytes: processed.data.length,
    width: processed.info.width,
    height: processed.info.height,
    sha256: createHash("sha256").update(processed.data).digest("hex"),
  };
}

function reporterRole(principal) {
  let selected = null;
  let selectedRank = 0;
  for (const grant of principal?.grants ?? []) {
    const rank = ROLE_RANK.get(grant?.role) ?? 0;
    if (rank > selectedRank) {
      selected = grant.role;
      selectedRank = rank;
    }
  }
  if (!selected) {
    throw new ForbiddenError("An approved, active CMS account is required");
  }
  return selected;
}

function deterministicReportId(uid, clientRequestId) {
  const digest = createHash("sha256")
    .update(uid, "utf8")
    .update("\0", "utf8")
    .update(clientRequestId, "utf8")
    .digest("hex");
  return mintBugReportId(digest);
}

function asMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  return Number.NaN;
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function validateRuntimeContext(buildRevision, deploymentEnvironment) {
  if (!BUILD_REVISION_PATTERN.test(buildRevision)) {
    throw new BugReportRequestError("Report intake is not configured", 503);
  }
  if (!DEPLOYMENT_ENVIRONMENTS.has(deploymentEnvironment)) {
    throw new BugReportRequestError("Report intake is not configured", 503);
  }
}

function runtimeContextReader(deps) {
  const environmentFn = deps.deploymentEnvironment ?? (() => configuredValue(
    BUG_REPORT_DEPLOYMENT_ENVIRONMENT, "CMS_DEPLOYMENT_ENVIRONMENT",
  ));
  const buildRevisionFn = deps.buildRevision ?? (async () => {
    if (environmentFn() === "production") return readLiveAdminBuildRevision({ fetchFn: deps.fetchFn });
    const local = configuredValue(BUG_REPORT_BUILD_REVISION, "CMS_ADMIN_BUILD_REVISION");
    if (!BUILD_REVISION_PATTERN.test(local)) throw new AdminStatusRevisionError();
    return local;
  });
  return async () => {
    const buildRevision = await buildRevisionFn();
    const deploymentEnvironment = environmentFn();
    validateRuntimeContext(buildRevision, deploymentEnvironment);
    return { buildRevision, deploymentEnvironment };
  };
}

function nativeReceiptRef(firestore, uid, clientRequestId) {
  return firestore.collection(BUG_REPORT_COLLECTIONS.mutationReceipts)
    .doc(`premiere-intake--${premiereRequestFingerprint([uid, clientRequestId])}`);
}

function replayNativeReceipt(snapshot, requestFingerprint) {
  if (!snapshot.exists) return null;
  const receipt = snapshot.data();
  if (receipt.requestFingerprint !== requestFingerprint) {
    throw new BugReportRequestError("This report request ID was already used for different content", 409);
  }
  return receipt.response.mode === "manual"
    ? { ...receipt.response, idempotent: true } : receipt.response;
}

function nextReportQuota(snapshot, now, maximum) {
  const rate = snapshot.data();
  const started = asMillis(rate?.windowStartedAt);
  const current = Number.isFinite(started) && now.getTime() - started < RATE_WINDOW_MS;
  const count = current && Number.isSafeInteger(rate.count) ? rate.count : 0;
  if (count >= maximum) {
    throw new BugReportRateLimitError(Math.max(1, Math.ceil((started + RATE_WINDOW_MS - now.getTime()) / 1000)));
  }
  return { windowStartedAt: current ? rate.windowStartedAt : now, count: count + 1, updatedAt: now };
}

async function persistBugReport({
  firestore,
  record,
  screenshot,
  now,
  source,
  nativeIntake,
}) {
  const queueDelivery = record.environment.deploymentEnvironment !== "development";
  const reportRef = firestore
    .collection(BUG_REPORT_COLLECTIONS.reports)
    .doc(record.id);
  const rateRef = firestore
    .collection(BUG_REPORT_COLLECTIONS.rateLimits)
    .doc(record.reporter.uid);
  const evidenceRef = firestore
    .collection(BUG_REPORT_COLLECTIONS.evidence)
    .doc(record.id);
  const outboxRef = firestore
    .collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
    .doc(`${record.id}--telegram`);
  const emailOutboxRef = firestore
    .collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
    .doc(`${record.id}--email--received`);
  const auditRef = firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc();
  const receiptRef = nativeIntake
    ? nativeReceiptRef(firestore, record.reporter.uid, nativeIntake.clientRequestId) : null;
  const automatic = nativeIntake?.incidentFingerprint;
  const incidentRef = automatic ? firestore.collection(BUG_REPORT_COLLECTIONS.rateLimits)
    .doc(`premiere-incident--${automatic}`) : null;

  return firestore.runTransaction(async (transaction) => {
    const receipt = receiptRef
      ? replayNativeReceipt(await transaction.get(receiptRef), nativeIntake.requestFingerprint) : null;
    if (receipt) return { created: false, response: receipt };
    if (automatic) {
      const incident = (await transaction.get(incidentRef)).data();
      if (asMillis(incident?.expiresAt) > now.getTime()) {
        const activeRef = firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(incident.reportId);
        const active = (await transaction.get(activeRef)).data();
        if (active?.automatic?.fingerprint === automatic && !shouldEmailBugReport(active)) {
          const firstSeen = Date.parse(active.automatic.firstSeenAt);
          const minute = Math.floor((now.getTime() - firstSeen) / 60000);
          const repeatRef = firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
            .doc(`${active.id}--telegram--repeat-${minute}`);
          const repeat = queueDelivery ? await transaction.get(repeatRef) : null;
          const repeatCount = active.automatic.repeatCount + 1;
          const response = { success: true, mode: "automatic", accepted: true, deduplicated: true, repeatCount };
          transaction.update(activeRef, {
            "automatic.repeatCount": repeatCount, "automatic.lastSeenAt": now.toISOString(),
          });
          // Preserve active leases. An intake transaction can commit after its
          // minute's edit settled, so a delivered row must accept the newer count.
          if (queueDelivery && !repeat.exists) transaction.create(repeatRef, {
            reportId: active.id, eventType: "report_repeated", channel: "telegram", state: "pending",
            attemptCount: 0, nextAttemptAt: new Date(firstSeen + (minute + 1) * 60000),
            leaseUntil: null, createdAt: now, updatedAt: now,
          });
          else if (queueDelivery && repeat.data().state === "delivered" && repeatCount > (active.delivery?.telegramRepeatCount ?? 0)) {
            transaction.update(repeatRef, {
              state: "pending", attemptCount: 0, leaseUntil: null, lastError: null,
              nextAttemptAt: new Date(Math.max(firstSeen + (minute + 1) * 60000,
                Date.parse(active.delivery?.nextAutomaticEditAt ?? "") || 0)),
              updatedAt: now,
            });
          }
          transaction.create(receiptRef, {
            requestFingerprint: nativeIntake.requestFingerprint, reportId: active.id, response, createdAt: now,
          });
          return { created: false, response };
        }
      }
    }
    const existing = await transaction.get(reportRef);
    if (existing.exists) {
      const stored = existing.data();
      if (stored?.reporter?.uid !== record.reporter.uid) {
        throw new ForbiddenError("This bug report is not available");
      }
      return { record: stored, created: false };
    }

    const quotaRefs = automatic ? [
      { ref: firestore.collection(BUG_REPORT_COLLECTIONS.rateLimits).doc(`premiere-auto-user--${premiereRequestFingerprint(record.reporter.uid)}`), maximum: AUTOMATIC_USER_MAX_REPORTS },
      { ref: firestore.collection(BUG_REPORT_COLLECTIONS.rateLimits).doc("premiere-auto-global"), maximum: AUTOMATIC_GLOBAL_MAX_REPORTS },
    ] : [{ ref: rateRef, maximum: RATE_MAX_REPORTS }];
    const quotas = [];
    for (const quota of quotaRefs) quotas.push({ ref: quota.ref,
      value: nextReportQuota(await transaction.get(quota.ref), now, quota.maximum) });

    const expiresAt = new Date(now.getTime() + EVIDENCE_RETENTION_MS);
    const evidenceSummary = screenshot
      ? {
          id: record.id,
          mimeType: screenshot.mimeType,
          sizeBytes: screenshot.sizeBytes,
          width: screenshot.width,
          height: screenshot.height,
          sha256: screenshot.sha256,
          expiresAt: expiresAt.toISOString(),
        }
      : null;
    const storedRecord = {
      ...record,
      evidence: { screenshot: evidenceSummary },
      deliveryStatus: queueDelivery ? "pending" : "not_queued",
      ...(automatic ? { automatic: {
        fingerprint: automatic, repeatCount: 1, firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(), windowExpiresAt: new Date(now.getTime() + RATE_WINDOW_MS).toISOString(),
      } } : {}),
    };

    transaction.create(reportRef, storedRecord);
    if (screenshot) {
      transaction.create(evidenceRef, {
        id: record.id,
        reportId: record.id,
        reporterUid: record.reporter.uid,
        mimeType: screenshot.mimeType,
        sizeBytes: screenshot.sizeBytes,
        width: screenshot.width,
        height: screenshot.height,
        sha256: screenshot.sha256,
        bytes: screenshot.buffer,
        createdAt: now,
        expireAt: expiresAt,
      });
    }
    if (queueDelivery) transaction.create(outboxRef, {
      reportId: record.id,
      eventType: "report_created",
      channel: "telegram",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
    });
    if (queueDelivery && shouldEmailBugReport(storedRecord)) transaction.create(emailOutboxRef, {
      reportId: record.id,
      eventType: "report_received",
      eventStatus: record.status,
      reportVersion: record.version,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(
      auditRef,
      adminLogEntry({
        actorUid: record.reporter.uid,
        actorEmail: record.reporter.email,
        action: "bug_report.create",
        target: `${BUG_REPORT_COLLECTIONS.reports}/${record.id}`,
        after: {
          id: record.id,
          severity: record.severity,
          area: record.area,
          screenshotIncluded: Boolean(screenshot),
          version: record.version,
        },
        source,
      }),
    );
    for (const quota of quotas) transaction.set(quota.ref, quota.value);
    if (automatic) transaction.set(incidentRef, {
      reportId: record.id, expiresAt: new Date(now.getTime() + RATE_WINDOW_MS),
    });
    const response = nativeIntake ? automatic
      ? { success: true, mode: "automatic", accepted: true, deduplicated: false, repeatCount: 1 }
      : { success: true, mode: "manual", idempotent: false, report: { id: record.id } } : null;
    if (receiptRef) transaction.create(receiptRef, {
      requestFingerprint: nativeIntake.requestFingerprint, reportId: record.id, response, createdAt: now,
    });
    return { record: storedRecord, created: true, ...(response ? { response } : {}) };
  });
}

function createPremiereReportIntake(deps = {}) {
  const firestore = deps.firestore ?? db;
  const runtimeContext = runtimeContextReader(deps);
  return async (payload, actor, req) => {
    const role = reporterRole(actor.principal);
    if (!actor.email || actor.emailVerified !== true) throw new ForbiddenError("A verified CMS staff email is required");
    const report = parsePremiereReport(payload);
    const requestFingerprint = premiereRequestFingerprint(report);
    const receiptRef = nativeReceiptRef(firestore, actor.uid, report.clientRequestId);
    const replay = replayNativeReceipt(await receiptRef.get(), requestFingerprint);
    if (replay) return { created: false, response: replay };
    if (report.mode === "automatic") await deps.consume(actor.uid, "automatic_report", 20, 60000);
    const now = new Date((deps.now ?? Date.now)());
    const requestId = requestHeader(req, "x-njpbs-request-id");
    const record = composeBugReport(premiereReportSubmission(report, now.toISOString()), {
      reportId: deterministicReportId(actor.uid, `premiere:${report.clientRequestId}`),
      nowIso: now.toISOString(), reporter: { uid: actor.uid, email: actor.email, role },
      ...await runtimeContext(), requestId,
      native: { source: "premiere", mode: report.mode, context: report.context },
    });
    return persistBugReport({
      firestore, record, now, source: { ip: clientIp(req), requestId },
      nativeIntake: { clientRequestId: report.clientRequestId, requestFingerprint,
        ...(report.mode === "automatic" ? { incidentFingerprint: premiereIncidentFingerprint(report) } : {}) },
    });
  };
}

function createCmsSubmitBugReportHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const authenticate = deps.requirePrincipalFn ?? requirePrincipal;
  const parseMultipartFn = deps.parseMultipartFn ?? parseMultipartReport;
  const normalizeScreenshotFn = deps.normalizeScreenshotFn ?? normalizeScreenshot;
  const nowFn = deps.now ?? (() => new Date());
  const runtimeContext = runtimeContextReader(deps);
  const log = deps.logger ?? logger;

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateMultipartRequest(req);
      const actor = await authenticate(req);
      const role = reporterRole(actor.principal);
      if (!actor.email || actor.emailVerified !== true) {
        throw new ForbiddenError("A verified CMS staff email is required");
      }
      const { fields, screenshot: upload } = await parseMultipartFn(req);
      const { report, clientRequestId } = parseReportFields(fields);
      const reportId = deterministicReportId(actor.uid, clientRequestId);
      const existing = await firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(reportId).get();
      if (existing.exists) {
        const stored = existing.data();
        if (stored?.reporter?.uid !== actor.uid) {
          throw new ForbiddenError("This bug report is not available");
        }
        res.status(200).json({
          success: true,
          idempotent: true,
          report: reportForReporter(stored, actor.uid),
        });
        return;
      }
      const screenshot = await normalizeScreenshotFn(upload);
      const now = nowFn();
      const { buildRevision, deploymentEnvironment } = await runtimeContext();
      const requestId = requestHeader(req, "x-njpbs-request-id");
      const record = composeBugReport(report, {
        reportId,
        nowIso: now.toISOString(),
        reporter: { uid: actor.uid, email: actor.email, role },
        buildRevision,
        deploymentEnvironment,
        requestId,
      });
      const result = await persistBugReport({
        firestore,
        record,
        screenshot,
        now,
        source: { ip: clientIp(req), requestId },
      });
      res.status(result.created ? 201 : 200).json({
        success: true,
        idempotent: !result.created,
        report: reportForReporter(result.record, actor.uid),
      });
    } catch (error) {
      const status = error?.status ?? 500;
      if (status >= 500) {
        log.error("Bug report intake failed", {
          requestId: requestHeader(req, "x-njpbs-request-id"),
          error,
        });
      }
      if (error instanceof BugReportRateLimitError) {
        res.set("Retry-After", String(error.retryAfterSeconds));
      }
      const safeMessage =
        error instanceof BugReportRequestError ||
        error instanceof BugReportContractError ||
        error instanceof AdminStatusRevisionError ||
        error instanceof ForbiddenError
          ? error.message
          : "The report could not be submitted";
      res.status(status).json({ error: safeMessage });
    }
  };
}

const cmsSubmitBugReport = cmsOnRequest(
  {
    cors: true,
    memory: "1GiB",
    concurrency: 1,
    maxInstances: 5,
    timeoutSeconds: 30,
  },
  createCmsSubmitBugReportHandler(),
);

module.exports = {
  EVIDENCE_RETENTION_MS,
  MAX_SCREENSHOT_UPLOAD_BYTES,
  MAX_STORED_SCREENSHOT_BYTES,
  RATE_MAX_REPORTS,
  RATE_WINDOW_MS,
  BugReportRequestError,
  BugReportRateLimitError,
  cmsSubmitBugReport,
  createCmsSubmitBugReportHandler,
  createPremiereReportIntake,
  deterministicReportId,
  normalizeScreenshot,
  parseMultipartReport,
  parseReportFields,
  persistBugReport,
  reporterRole,
  validateMultipartRequest,
};
