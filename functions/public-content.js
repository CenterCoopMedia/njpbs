"use strict";

const { gzipSync, gunzipSync } = require("node:zlib");
const { isDeepStrictEqual } = require("node:util");
const { contentLinkReadFits } = require("./lib/content-link");
const { readNoBuildPostDecision } = require("./lib/no-build-post-publication");
const { readNoBuildPageDecision } = require("./lib/no-build-page-serving");
const { readSelectedNoBuildPageProjection } = require("./lib/no-build-page-source");
const { createPostBackgroundOutputs } = require("./lib/post-background-outputs");
const { createPostBackgroundStorage } = require("./lib/post-background-storage");
const { readPublicBackgroundContextInTransaction, publicContextDigest } = require("./lib/public-context-revision");
const { publicationTarget, publicationPostCacheTag } = require("./lib/publication-target");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { app, db } = require("./lib/firebase");
const {
  PublicContentProjectionError,
  projectPublicPageDocument,
  publicAssetRequirementsForDocument,
} = require("./lib/public-content-projection");
const {
  assertPublishedAssetProjection,
} = require("./lib/published-media-safety");
const {
  assertMediaLifecycleDeploymentFence,
} = require("./lib/public-deployment");
const { readPublicDeploymentPointer } = require("./lib/public-deployment-pointer");
const {
  acceptsGzip,
  createPublicDecisionCache,
  readPublicDecisionValidator,
  sendJson,
} = require("./lib/public-decision-cache");

async function readPublicPageProjection({ firestore, pageId, now = new Date() }) {
  const selected = await readSelectedNoBuildPageProjection({ firestore, pageId, now });
  if (selected !== null) return selected;
  const pageSnapshot = await firestore.collection("cmsPages").doc(pageId).get();
  const document = pageSnapshot.exists ? pageSnapshot.data() : null;
  const { assetIds, documentAssetIds, imageAssetIds } =
    publicAssetRequirementsForDocument({ pageId, document, now });
  const assetRefs = assetIds.flatMap((assetId) => [
    firestore.collection("media_assets").doc(assetId),
    firestore.collection("media_assets_public").doc(assetId),
  ]);
  const assetSnapshots = assetRefs.length > 0
    ? await firestore.getAll(...assetRefs)
    : [];
  const hasUploadedMedia = assetIds.some(
    (_assetId, index) =>
      assetSnapshots[index * 2]?.data()?.source === "upload",
  );
  let uploadedMediaReady = false;
  if (hasUploadedMedia) {
    const deploymentSnapshot = await firestore
      .collection("system")
      .doc("publicDeployment")
      .get();
    try {
      assertMediaLifecycleDeploymentFence(readPublicDeploymentPointer(deploymentSnapshot?.data()));
      uploadedMediaReady = true;
    } catch {
      // The per-asset assertion below returns the same public-content refusal
      // used by the static-build preflight without exposing pointer details.
    }
  }
  const assets = new Map();
  for (const [index, assetId] of assetIds.entries()) {
    assets.set(
      assetId,
      assertPublishedAssetProjection({
        assetId,
        owner: `published page ${pageId}`,
        privateSnapshot: assetSnapshots[index * 2],
        publicSnapshot: assetSnapshots[index * 2 + 1],
        uploadedMediaReady,
        requiresPdf: documentAssetIds.includes(assetId),
        requiresImage: imageAssetIds.includes(assetId),
      }),
    );
  }
  return projectPublicPageDocument({ pageId, document, assets, now });
}

function createCmsGetPublicPageHandler(deps = {}) {
  const readProjectionFn = deps.readProjectionFn ?? readPublicPageProjection;
  const firestore = deps.firestore ?? db;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());

  const decisionCache = deps.decisionCache ?? null;
  const reply = (req, res, result) => {
    if (!acceptsGzip(req)) return res.status(200).json(result);
    return sendJson(req, res, JSON.stringify(result));
  };
  // Reads the validator before the decision, so a stored decision is never
  // older than the validator key it is stored under. Errors are not stored.
  const cachedDecision = async (req, res, requestKey, read, storable) => {
    const send = (entry, body, gzip) => {
      if (entry) res.set("x-njpbs-public-decision-valid-until", String(entry.expiresAt));
      return sendJson(req, res, body, entry?.gzip ?? gzip);
    };
    const validator = decisionCache ? await readPublicDecisionValidator(firestore) : null;
    if (validator?.cacheable) {
      const hit = decisionCache.get(requestKey, validator.key);
      if (hit) return send(hit, null);
    }
    const result = await read();
    if (!validator?.cacheable || !storable(result)) return reply(req, res, result);
    const body = JSON.stringify(result);
    const gzip = gzipSync(body);
    const entry = decisionCache.set(requestKey, validator.key, body, gzip);
    return send(entry, body, gzip);
  };

  // Schedule and Live still capture and qualify current CODE and packet
  // authority for every request. Reuse only the stable Page projection under
  // that exact capture and a fresh ordinary public validator. No transport
  // lease is exposed: the Worker keeps both authority checks around rendering.
  const readScheduledDecision = async ({ capture, read, path, rendererSha, method, target }) => {
    const schedules = require("./lib/no-build-page-schedule-reader");
    const identity = schedules.pageScheduleCaptureIdentity({ firestore, target, rendererSha, capture });
    const requestKey = JSON.stringify(["scheduled-page", path, rendererSha, method, identity]);
    const validator = await readPublicDecisionValidator(firestore);
    schedules.assertPageScheduleCapture({ firestore, target, rendererSha, capture });
    if (validator.cacheable) {
      const hit = decisionCache.get(requestKey, validator.key);
      if (hit) return JSON.parse(gunzipSync(hit.gzip).toString("utf8"));
    }
    const result = await read();
    if (validator.cacheable && ["page", "context-page"].includes(result.kind) &&
        ["schedule", "live"].includes(result.receipt?.pageId ?? result.renderContext?.pageId)) {
      decisionCache.set(requestKey, validator.key, JSON.stringify(result));
    }
    return result;
  };

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const pageId = req.body?.pageId;
    try {
      if (req.body?.retained !== undefined) {
        if (deps.retainedReplies !== true) throw new Error("Retained replies are disabled");
        const feature = { "no-build-post-v1": "postChrome", "no-build-page-v1": "capabilities" }[req.body.mode];
        return reply(req, res, await require("./lib/cms-reader-retained-request").retainedReaderReply({
          firestore, body: req.body, feature, now: deps.now ?? Date.now }));
      }
      if (req.body?.mode === "release-installed-consumers-v2") {
        require("./lib/public-release-pair").exact(req.body, ["mode", "nonce"]);
        return reply(req, res, require("./lib/public-release-installed-consumers").installedPublicReleaseConsumers({ nonce: req.body.nonce }));
      }
      if (req.body?.mode === "release-routing-measurement-v2") {
        const environment = deps.target?.environment ?? process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production";
        if (!(deps.routingMeasurementEnabled ?? process.env.PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED === "true") || environment !== "development") throw new Error("Routing measurement is disabled");
        require("./lib/public-release-pair").exact(req.body, ["mode", "measurementId"]);
        return reply(req, res, await require("./lib/public-release-routing-measurement").readPrivateRoutingMeasurementSelector({
          firestore, measurementId: req.body.measurementId }));
      }
      if (req.body?.mode === "release-decision-v2") {
        if (!(deps.releaseReadersEnabled ?? process.env.PUBLIC_RELEASE_READERS_ENABLED === "true")) throw new Error("Release readers are disabled");
        const environment = deps.target?.environment ?? process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production";
        return reply(req, res, await require("./lib/public-release-serving").readPublicReleaseDecision({ firestore, environment,
          pair: req.body.pair, selection: req.body.selection, path: req.body.path,
          composedReadersEnabled: deps.composedReadersEnabled ?? process.env.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED === "true" }));
      }
      if (req.body?.mode === "release-selector-v2") {
        if (!(deps.releaseReadersEnabled ?? process.env.PUBLIC_RELEASE_READERS_ENABLED === "true")) throw new Error("Release readers are disabled");
        const environment = deps.target?.environment ?? process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production";
        const result = await require("./lib/public-release-serving").readPublicReleaseSelector({ firestore, environment });
        return reply(req, res, result);
      }
      if (req.body?.mode === "no-build-code-post-v1") {
        const { path, rendererSha, method = "GET" } = req.body;
        if (typeof path !== "string" || path.length > 512 || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) ||
            !/^[a-f0-9]{40}$/.test(rendererSha ?? "") || !["GET", "HEAD"].includes(method)) throw new Error("Invalid code Post request");
        const read = async () => {
          const result = await require("./lib/no-build-code-post-consumer").readCodePostConsumer({ firestore, path, rendererSha, log,
            currentCodeRequest: deps.currentCodeRequest, target: require("./lib/no-build-page-target").pagePublicationTarget({ firestore, target: deps.target }) });
          if (!contentLinkReadFits(result, 8 * 1024 * 1024, "published")) throw new Error("Code Post context is too large");
          return result;
        };
        return await cachedDecision(req, res, JSON.stringify(["code-post", path, rendererSha, method]), read,
          result => result.kind !== "code-post-unavailable");
      }
      if (req.body?.mode === "no-build-page-v1") {
        const { path, rendererSha, method = "GET" } = req.body;
        if (!["GET", "HEAD"].includes(method)) throw new Error("Invalid public Page method");
        const target = require("./lib/no-build-page-target").pagePublicationTarget({ firestore, target: deps.target });
        const read = async () => {
          const result = await readNoBuildPageDecision({ firestore, path, rendererSha, target, legacyStaffServing: true,
            currentCodeRequest: deps.currentCodeRequest,
            ...(decisionCache ? { readScheduledDecision: ({ capture, read }) =>
              readScheduledDecision({ capture, read, path, rendererSha, method, target }) } : {}) });
          const limit = result.kind === "schedule-export" ? 24 * 1024 * 1024 : 8 * 1024 * 1024;
          if (!contentLinkReadFits(result, limit, result.published ? "published" : "renderContext")) throw new Error("Published Page read too large");
          return result;
        };
        // These routes qualify their schedule capture before any projection
        // cache hit. They never supply a lease for the Worker HTML cache.
        if (require("./lib/no-build-page-schedule-reader").isPageScheduleExportPath(path) ||
            ["/schedule/", "/live/"].includes(path)) return reply(req, res, await read());
        return await cachedDecision(req, res, JSON.stringify(["page", path, rendererSha, method]), read,
          result => !["schedule-export", "schedule-unavailable"].includes(result.kind) &&
            !["schedule", "live"].includes(result.receipt?.pageId ?? result.renderContext?.pageId));
      }
      if (req.body?.mode === "no-build-post-v1") {
        const { path, rendererSha, method = "GET", probe } = req.body;
        if (typeof path !== "string" || path.length > 512 || !path.startsWith("/") || /[%?#\\]/.test(path) ||
            new URL(path, "https://njpbs.org").pathname !== path || !["GET", "HEAD"].includes(method) ||
            !/^[a-f0-9]{40}$/.test(rendererSha ?? "")) throw new Error("Invalid public Post request");
        const { outputForPath, isBackgroundAssetPath } = require("./lib/post-background-outputs");
        // Only detail and receipt reads repeat expensive Post authority reads.
        // Background bytes keep their own post-serve authority check.
        if (!probe && (/^\/posts\/[^/]+\/$/.test(path) || ["/_publication.json", "/_content-status.json"].includes(path)) &&
            !outputForPath(path) && !isBackgroundAssetPath(path)) {
          return await cachedDecision(req, res, JSON.stringify(["post", path, rendererSha, method]), async () => {
            const result = await (deps.readNoBuildPostFn ?? readNoBuildPostDecision)({ firestore, path, rendererSha, probe });
            if (result.kind === "background") throw new Error("Background output is outside the decision cache");
            delete result.backgroundBucket;
            if (!contentLinkReadFits(result, 2 * 1024 * 1024, "published")) throw new Error("Published read too large");
            return result;
          }, result => ["pass", "post", "alias", "gone", "receipts"].includes(result.kind));
        }
        const result = await (deps.readNoBuildPostFn ?? readNoBuildPostDecision)({ firestore, path, rendererSha, probe });
        if (result.kind === "background") {
          const identity = result.context ?? result.catalog ?? result.receipt;
          const owner = createPostBackgroundOutputs({ firestore, enabled: true, accepting: false,
            postIds: [], contentApiEnabled: true,
            artifacts: deps.backgroundArtifacts ?? createPostBackgroundStorage(result.backgroundBucket, app),
            readContextInTransaction: transaction => readPublicBackgroundContextInTransaction(transaction, firestore) });
          const response = result.record?.visible === false ? new Response(null, { status: 410, headers: { "cache-control": "no-store",
            "x-njpbs-background-renderer-sha": result.context.rendererSha,
            "x-njpbs-background-context-sha256": result.context.contextDigest } })
            : await owner.serve(new Request(`https://njpbs.org${path}`, { method }));
          // An owned namespace never falls back to Assets when the fence is missing.
          if (!response) throw new Error("Background ownership is unavailable");
          if (result.record?.visible) {
            const preparedRevision = Number(response.headers.get("x-njpbs-background-context-revision"));
            if (response.status !== 200 || !Number.isSafeInteger(preparedRevision) || preparedRevision < result.record.contextRevision ||
                publicContextDigest(preparedRevision) !== response.headers.get("x-njpbs-background-context-sha256")) {
              throw new Error("Record output predates its accepted source");
            }
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 16 * 1024 * 1024) throw new Error("Background output is too large");
          const current = await (deps.readNoBuildPostFn ?? readNoBuildPostDecision)({ firestore, path, rendererSha, probe });
          const currentIdentity = current.context ?? current.catalog ?? current.receipt;
          const identityField = result.context ? "contextDigest" : "admissionRevision";
          // Sealed bytes have their own receipt/freshness check in owner.serve.
          // An unrelated live context bump or successor enqueue cannot revoke the same aggregate
          // authority; withdrawals, Home changes and ownership still fence it.
          const sameAuthority = result.aggregateAuthority
            ? isDeepStrictEqual(current.aggregateAuthority, result.aggregateAuthority)
            : currentIdentity?.[identityField] === identity[identityField];
          if (current.kind !== "background" || !sameAuthority ||
              Boolean(current.context) !== Boolean(result.context) || current.backgroundBucket !== result.backgroundBucket ||
              JSON.stringify(current.record ?? null) !== JSON.stringify(result.record ?? null)) throw new Error("Background admission changed");
          // A manifest reference is only an asset candidate. After every eligible
          // family declines the path, retain the original static asset route.
          if (isBackgroundAssetPath(path) && response.status === 404) return reply(req, res, { kind: "pass" });
          const environment = process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production";
          // The documented local emulator uses the production-shaped cache contract.
          // Never normalize a real project's invalid target into production.
          const localEmulator = environment === "emulator" && /^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "") &&
            /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "");
          const target = publicationTarget(localEmulator ? "production" : environment);
          return reply(req, res, { kind: "background", status: response.status,
            headers: { ...Object.fromEntries(response.headers),
              ...(result.record ? { "x-njpbs-record-id": result.record.documentId, "x-njpbs-record-family": result.record.family,
                "x-njpbs-publication-operation": result.record.operationId, "x-njpbs-source-version": String(result.record.sourceVersion),
                "x-njpbs-record-generation": String(result.record.generation), "x-njpbs-snapshot-sha256": result.record.snapshotDigest,
                "x-njpbs-record-visible": String(result.record.visible) } : {}),
              ...(result.context ? { "x-njpbs-public-context-revision": String(identity.contextRevision),
                "x-njpbs-admission-revision": String(identity.contextRevision) } :
                { "x-njpbs-admission-revision": String(identity.admissionRevision) }),
              "x-njpbs-background-purge-tag": publicationPostCacheTag(target, "background") }, bytes: bytes.toString("base64") });
        }
        delete result.backgroundBucket;
        if (!contentLinkReadFits(result, 2 * 1024 * 1024, "published")) throw new Error("Published read too large");
        return reply(req, res, result);
      }
      const result = await readProjectionFn({
        firestore,
        pageId,
        now: now(),
      });
      reply(req, res, result);
    } catch (error) {
      if (res.headersSent) return;
      if (req.body?.mode === "no-build-page-v1" && ["schedule", "live"].includes(error.pageScheduleId)) {
        log.warn?.("Page schedule qualification refused", { path: req.body.path, pageId: error.pageScheduleId, error });
        return res.status(200).json({ kind: "schedule-unavailable", path: req.body.path, pageId: error.pageScheduleId });
      }
      const status =
        error instanceof PublicContentProjectionError && error.status === 404
          ? 404
          : 503;
      log.error("cmsGetPublicPage failed", {
        pageId: typeof pageId === "string" ? pageId : null,
        errorMessage: error?.message ?? String(error),
        errorClass: error?.constructor?.name ?? typeof error,
        errorCode: ["string", "number"].includes(typeof (error?.readerCode ?? error?.code))
          ? error.readerCode ?? error.code : null,
        errorStatus: typeof error?.status === "number" ? error.status : null,
      });
      res.status(status).json({
        error:
          status === 404
            ? "Public page not found"
            : "Public content is unavailable",
      });
    }
  };
}

const cmsGetPublicPage = cmsOnRequest(
  { invoker: "public", minInstances: 0 },
  createCmsGetPublicPageHandler({ decisionCache: createPublicDecisionCache() }),
);

module.exports = {
  cmsGetPublicPage,
  createCmsGetPublicPageHandler,
  readPublicPageProjection,
};
