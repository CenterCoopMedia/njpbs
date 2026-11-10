"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db, admin } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { MAX_REQUEST_BYTES, LiveError, fail, validId, parseRequest } = require("./lib/live-production-requests");
const { readStaff, mutateStaff } = require("./lib/live-production-store");
const { admitCommand, agentRequest } = require("./lib/live-production-journal");
const { defineSecret, defineString } = require("firebase-functions/params");
const { readStudioTitleFiles } = require("./lib/studio-title-files");

const R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const R2_BUCKET = defineString("CMS_MEDIA_MASTER_R2_BUCKET", { default: "" });
let connectorDownloadService;
function readConnector(sourceSha, download) {
  if (!R2_BUCKET.value()) return Promise.resolve({ available: false, sourceSha });
  if (!connectorDownloadService) {
    // Device polling and ordinary studio actions do not load the storage SDK.
    const { R2MediaStorage } = require("./lib/r2-media");
    const { createConnectorDownload } = require("./lib/studio-connector-download");
    let store;
    connectorDownloadService = createConnectorDownload({ storage: () => store ??= new R2MediaStorage({
      endpoint: R2_ENDPOINT.value(), bucket: R2_BUCKET.value(),
      accessKeyId: R2_ACCESS_KEY_ID.value(), secretAccessKey: R2_SECRET_ACCESS_KEY.value(),
    }) });
  }
  return connectorDownloadService(sourceSha, download);
}

async function requireDevice(req) {
  const authorization = req.headers?.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) fail("Device authentication required.", 401);
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(authorization.slice(7), true); }
  catch (error) {
    if (["auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token", "auth/argument-error", "auth/user-disabled"].includes(error.code)) fail("Invalid device authentication.", 401);
    throw error;
  }
  if (!validId(decoded.liveProductionDeviceId)) fail("A dedicated device credential is required.", 403);
  return { uid: decoded.uid, deviceId: decoded.liveProductionDeviceId };
}
function createLiveProductionHandler({ firestore = db, requirePrincipalFn = requirePrincipal,
  requireDeviceFn = requireDevice, clock = Date.now, agent = false, connectorDownload = readConnector,
  titleFiles = readStudioTitleFiles } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const identity = agent ? await requireDeviceFn(req) : await requirePrincipalFn(req, { includeAccountStatus: true });
      // Device-only accounts have no staff profile and cannot reach this path.
      if (!agent && (identity.approvedActive !== true || !can(identity.principal, "content.edit.any", {}))) fail("Existing global editorial access is required.", 403);
      validateBoundedJsonRequest(req, MAX_REQUEST_BYTES);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > MAX_REQUEST_BYTES) fail("Request exceeds the 256 KiB byte budget.", 413);
      const request = parseRequest(req.body, agent);
      let result;
      if (!agent && ["get_connector_package", "create_connector_download"].includes(request.action)) {
        try { result = await connectorDownload(request.sourceSha, request.action === "create_connector_download"); }
        catch { fail("The Studio connector download is unavailable. Try again or contact support.", 503); }
      } else if (agent) {
        if (identity.deviceId !== request.deviceId) fail("Wrong authenticated device.", 403);
        const expectedTitleFiles = request.action === "verify_mapping" ? titleFiles() : undefined;
        result = await agentRequest(firestore, request, identity, clock, expectedTitleFiles);
      } else if (["list_sessions", "get_session", "list_banners"].includes(request.action)) result = await readStaff(firestore, request, identity, clock());
      else if (request.action === "command") result = await admitCommand(firestore, request, identity, clock);
      else result = await mutateStaff(firestore, request, identity, clock);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 500);
      // Do not log request bodies, tokens, or native banner text.
      if (status >= 500) console.error("Live production request failed", { code: error.code ?? "internal" });
      return res.status(status).json({ error: status >= 500 ? "Live production is unavailable." : error.message,
        ...(error instanceof LiveError && error.code ? { code: error.code } : {}),
        ...(error instanceof LiveError && error.details ? { current: error.details } : {}) });
    }
  };
}
module.exports = { createLiveProductionHandler, requireDevice,
  cmsLiveProduction: cmsOnRequest({ cors: true, secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY] }, createLiveProductionHandler()),
  cmsLiveProductionAgent: cmsOnRequest({ cors: true }, createLiveProductionHandler({ agent: true })),
};
