"use strict";

const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { can } = require("./lib/rbac");
const { createDesktopSessions, problem } = require("./lib/premiere-desktop-session");
const sourceMedia = require("./source-media");
const uploads = require("./source-media-uploads");
const uploadContract = require("./lib/source-media-upload-contract");
const { clipHandler } = require("./video-clips");
const { createPremiereReportIntake } = require("./bug-report");
const { MAX_PREMIERE_REPORT_BYTES } = require("./lib/premiere-report-contract");
const { READ_SECRETS } = require("./lib/private-video-runtime");

const KIB = 1024;
const OPERATIONS = Object.freeze({
  session: "read",
  cmsListMediaSources: "read",
  cmsListSourceMedia: "read",
  cmsCreateSourceMediaRead: "read",
  cmsStartSourceMediaUpload: "upload",
  cmsSignSourceMediaUploadParts: "multipart",
  cmsResumeSourceMediaUpload: "multipart",
  cmsCompleteSourceMediaUpload: "multipart",
  cmsCancelSourceMediaUpload: "multipart",
  cmsUpdateSourceMediaMetadata: "metadata",
  cmsRequestVideoClip: "export",
  cmsGetVideoClip: "read",
  cmsCreateVideoClipRead: "read",
  cmsCancelVideoClip: "metadata",
  cmsSubmitPremiereReport: "report",
});
const LIMITS = { read: [120, 60000], upload: [8, 240000], multipart: [240, 60000], metadata: [30, 60000], export: [8, 60000] };

function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) throw problem(400, "Invalid request fields");
  return body;
}

function shortText(value, max, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max ||
      [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw problem(400, "Invalid device details");
  return value.trim() || fallback;
}

function enabled() {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.PREMIERE_DESKTOP_ENABLED === "true";
}

function trustedMediaHandler(operation, actor, firestore) {
  // These closures exist only after the desktop session was verified. Browser handlers
  // still use Firebase ID tokens and App Check; request headers cannot create this proof.
  const principal = async () => actor;
  const desktopProof = async () => ({ appId: "approved-premiere-session" });
  const registry = () => {
    const source = sourceMedia.runtimeRegistry().get("video-library");
    return new Map(source ? [[source.id, source]] : []);
  };
  const deps = { firestore, requirePrincipalFn: principal, verifyAppCheckFn: desktopProof, registryFn: registry };
  if (operation === "cmsListMediaSources") return sourceMedia.createCmsListMediaSourcesHandler(deps);
  if (operation === "cmsListSourceMedia") return sourceMedia.createCmsListSourceMediaHandler(deps);
  if (operation === "cmsCreateSourceMediaRead") return sourceMedia.createCmsCreateSourceMediaReadHandler(deps);
  const clipActions = { cmsRequestVideoClip: "request", cmsGetVideoClip: "get", cmsCreateVideoClipRead: "read", cmsCancelVideoClip: "cancel" };
  if (clipActions[operation]) return clipHandler(clipActions[operation], {
    firestore, requirePrincipal: principal, verifyAppCheck: desktopProof, registry,
  });
  const uploadActions = {
    cmsStartSourceMediaUpload: { maxBytes: 96 * KIB, parse: uploadContract.parseStartUploadRequest, run: uploads.startUpload },
    cmsSignSourceMediaUploadParts: { parse: uploadContract.parseSignUploadPartsRequest, run: uploads.signUploadParts },
    cmsResumeSourceMediaUpload: { parse: uploadContract.parseSessionRequest, run: uploads.resumeUpload },
    cmsCompleteSourceMediaUpload: { parse: value => uploadContract.parseSessionRequest(value, { requiresVersion: true }), run: uploads.completeUpload },
    cmsCancelSourceMediaUpload: { parse: value => uploadContract.parseSessionRequest(value, { requiresVersion: true }), run: uploads.cancelUpload },
    cmsUpdateSourceMediaMetadata: { maxBytes: 96 * KIB, parse: uploadContract.parseMetadataUpdateRequest, run: uploads.updateMetadata, operation: "metadata", usesUploader: false },
  };
  const action = uploadActions[operation];
  if (!action) throw problem(400, "Unsupported Premiere operation");
  return uploads.makeHandler({ maxBytes: 16 * KIB, operation: "upload", ...action }, deps);
}

function createPremiereHandlers(deps = {}) {
  const sessions = createDesktopSessions(deps);
  const featureEnabled = deps.enabled ?? enabled;
  const log = deps.log ?? logger;
  const submitReport = createPremiereReportIntake({ ...deps, consume: sessions.consume });

  function endpoint(name, maxBytes, run) {
    return async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      try {
        if (name !== "revoke" && !featureEnabled()) throw problem(503, "Premiere sign-in is not enabled");
        if (req.method !== "POST") throw problem(405, "Method not allowed");
        validateBoundedJsonRequest(req, maxBytes);
        await run(req, res);
        log.info("Premiere request", { endpoint: name, status: res.statusCode ?? 200 });
      } catch (error) {
        if (res.headersSent) return;
        const status = Number.isInteger(error.status) ? error.status : 500;
        log[status >= 500 ? "error" : "info"]("Premiere request", { endpoint: name, status });
        if (status === 429) res.set("Retry-After", String(error.retryAfterSeconds ?? (error.code === "slow_down" ? 5 : 60)));
        res.status(status).json({ error: status < 500 || status === 503 ? error.message : "Premiere request failed", ...(error.code ? { code: error.code } : {}) });
      }
    };
  }

  const start = endpoint("start", 2 * KIB, async (req, res) => {
    const body = fields(req.body, ["deviceName", "hostVersion"]);
    const result = await sessions.start({
      deviceName: shortText(body.deviceName, 80, "Premiere"),
      hostVersion: shortText(body.hostVersion, 40, ""),
    });
    res.status(200).json({ success: true, ...result });
  });

  const approve = endpoint("approve", 2 * KIB, async (req, res) => {
    const body = fields(req.body, ["action", "userCode"]);
    if (!["lookup", "approve", "deny"].includes(body.action)) throw problem(400, "Choose lookup, approve, or deny");
    await verifyAppCheckToken(req.headers?.["x-firebase-appcheck"]);
    const actor = await requirePrincipal(req, { includeAccountStatus: true });
    if (!actor.approvedActive || !Number.isFinite(actor.authTime)) throw problem(403, "An active Boardwalk staff account is required");
    await sessions.consume(actor.uid, "approval", 20, 60000);
    const pairing = await sessions.approval(body.action, body.userCode, actor);
    res.status(200).json({ success: true, pairing });
  });

  const poll = endpoint("poll", 2 * KIB, async (req, res) => {
    fields(req.body, ["deviceCode"]);
    res.status(200).json({ success: true, ...await sessions.poll(req.body.deviceCode) });
  });

  const request = endpoint("request", 96 * KIB, async (req, res) => {
    const { operation, payload } = fields(req.body, ["operation", "payload"]);
    if (typeof operation !== "string" || !Object.hasOwn(OPERATIONS, operation)) throw problem(400, "Unsupported Premiere operation");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw problem(400, "Payload must be an object");
    if (payload.sourceId !== undefined && payload.sourceId !== "video-library") throw problem(403, "Premiere can access the shared video library only");
    const { actor, session } = await sessions.authenticate(req);
    if (operation === "cmsSubmitPremiereReport") {
      validateBoundedJsonRequest(req, MAX_PREMIERE_REPORT_BYTES);
      const result = await submitReport(payload, actor, req);
      res.status(result.created ? 201 : 200).json(result.response);
      return;
    }
    const category = OPERATIONS[operation];
    await sessions.consume(actor.uid, category, ...LIMITS[category]);
    if (operation === "session") {
      fields(payload, []);
      res.status(200).json({ success: true, expiresAt: new Date(session.expiresAtMs).toISOString(),
        user: { uid: actor.uid, displayName: actor.displayName }, sourceId: "video-library", capabilities: {
          canBrowse: true, canUpload: can(actor.principal, "media.upload", {}),
          canEditMetadata: can(actor.principal, "media.video.manage", {}),
        } });
      return;
    }
    const body = operation === "cmsListMediaSources" ? fields(payload, []) : { ...payload, sourceId: "video-library" };
    if (operation === "cmsStartSourceMediaUpload") {
      if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata) ||
          typeof body.metadata.name !== "string" || !body.metadata.name.trim()) throw problem(400, "Give the finished video a name");
      body.metadata = { ...body.metadata, rightsStatus: "pending" };
    }
    const handler = trustedMediaHandler(operation, actor, deps.firestore);
    // IncomingMessage headers and Express accessors live on the prototype.
    const delegated = Object.create(req, {
      body: { value: body }, rawBody: { value: Buffer.from(JSON.stringify(body)) },
    });
    await handler(delegated, res);
  });

  const revoke = endpoint("revoke", 2 * KIB, async (req, res) => {
    fields(req.body, []);
    await sessions.revoke(req);
    res.status(200).json({ success: true });
  });

  return { start, approve, poll, request, revoke };
}

const handlers = createPremiereHandlers();
const options = { cors: true, timeoutSeconds: 60, maxInstances: 10, serviceAccount: sourceMedia.FUNCTION_SERVICE_ACCOUNT };
module.exports = {
  createPremiereHandlers,
  cmsStartPremierePairing: cmsOnRequest(options, handlers.start),
  cmsApprovePremierePairing: cmsOnRequest(options, handlers.approve),
  cmsPollPremierePairing: cmsOnRequest(options, handlers.poll),
  cmsPremiereRequest: cmsOnRequest({ ...options, secrets: READ_SECRETS }, handlers.request),
  cmsRevokePremiereSession: cmsOnRequest(options, handlers.revoke),
};
