"use strict";

const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { authorizeMediaSource } = require("./lib/media-sources");
const { runtimeRegistry, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { getTranscriptJob } = require("./lib/video-transcript-job");
const { createVideoTranscriptProcessor } = require("./lib/video-transcript-processor");
const alignment = require("./lib/video-transcript-alignment-job");
const { transcriptConfig } = require("./video-transcripts");

function unavailable() {
  return Object.assign(new Error("Transcript alignment is not available"), { status: 503 });
}

function createAlignmentHandler(operation, dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  const registry = dependencies.registryFn ?? runtimeRegistry;
  const configFn = dependencies.configFn ?? transcriptConfig;
  let defaultProcessor;
  const processor = (config) => dependencies.processor ?? (defaultProcessor ??= createVideoTranscriptProcessor(config, { firestore }));
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 8 * 1024);
      await (dependencies.verifyAppCheckFn ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
      const request = alignment.parseAlignmentRequest(req.body, { cancel: operation === "cancel" });
      const source = registry().get(request.sourceId);
      await (dependencies.authorizeFn ?? authorizeMediaSource)({ firestore, actor, source, operation: "transcript" });
      const config = configFn();
      if (!config.alignmentEnabled || !alignment.alignmentEngine(config) || !config.bucket || !config.source) throw unavailable();
      const job = await getTranscriptJob({ firestore, source, request, renditionBucket: config.bucket });
      if (!job || job.phase !== "ready") throw Object.assign(new Error("Transcript is not ready"), { status: 409 });
      const result = operation === "cancel"
        ? await alignment.cancelAlignment({ firestore, source, job, request, actor, audit: dependencies.audit })
        : await alignment.requestAlignment({ firestore, source, job,
          segments: await processor(config).readAlignment(job), config, actor, request, audit: dependencies.audit });
      return res.status(200).json({ success: true, alignment: {
        state: result.state,
        timingBasis: "viewing-copy-elapsed", revision: result.job.transcriptRevision,
        requestId: result.job.id, eligiblePassages: result.eligibleCount,
        unavailablePassages: result.unavailableCount, updatedAt: result.updatedAt ?? null,
      }, cached: result.cached });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) (dependencies.log ?? logger).warn("Video transcript alignment request failed", { operation, status });
      return res.status(status).json({ error: status < 500 || status === 503 ? error.message : "Video transcript alignment request failed" });
    }
  };
}

const options = { cors: true, maxInstances: 10, timeoutSeconds: 60, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsRequestVideoTranscriptAlignment = cmsOnRequest(options, createAlignmentHandler("request"));
const cmsCancelVideoTranscriptAlignment = cmsOnRequest(options, createAlignmentHandler("cancel"));

module.exports = { cmsRequestVideoTranscriptAlignment, cmsCancelVideoTranscriptAlignment, createAlignmentHandler };
