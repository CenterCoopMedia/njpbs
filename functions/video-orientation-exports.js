"use strict";

const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { authorizeMediaSource } = require("./lib/media-sources");
const { runtimeRegistry, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const exportJobs = require("./lib/video-orientation-export");

function createExportHandler(operation, dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4 * 1024);
      await (dependencies.verifyAppCheckFn ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
      const request = exportJobs.parseExportRequest(req.body, { list: operation === "list" });
      const source = (dependencies.registryFn ?? runtimeRegistry)().get(request.sourceId);
      // An export adds a video to the library, so it needs upload access.
      await (dependencies.authorizeFn ?? authorizeMediaSource)({ firestore, actor, source,
        operation: operation === "list" ? "browse" : "upload" });
      if (operation === "list") {
        return res.status(200).json({ success: true, ...await exportJobs.listExports({ firestore, request }) });
      }
      const result = await exportJobs.requestExport({ firestore, request, actor, audit: dependencies.audit });
      return res.status(200).json({ success: true, export: exportJobs.publicExport(result.job), cached: result.cached });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) (dependencies.log ?? logger).warn("Video export request failed", { operation, status });
      return res.status(status).json({ error: status < 500 || status === 503 ? error.message : "Video export request failed" });
    }
  };
}

const options = { cors: true, maxInstances: 10, timeoutSeconds: 60, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsRequestVideoOrientationExport = cmsOnRequest(options, createExportHandler("request"));
const cmsListVideoOrientationExports = cmsOnRequest(options, createExportHandler("list"));

module.exports = { cmsRequestVideoOrientationExport, cmsListVideoOrientationExports, createExportHandler };
