"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest, JsonRequestError } = require("./lib/http-json");
const { hasCapability, can } = require("./lib/rbac");
const { authorizeContentRead, authorizeContentWrite, contentResource } = require("./lib/content-authorization");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { mediaAssetSummary } = require("./lib/media-library");
const { mayUseMedia, isAudioReadAdmitted } = require("./lib/media-access");
const { ID_PATTERN, sourceMediaFileVersion, parseSourceMediaAsset, SourceMediaValidationError } = require("./lib/source-media-contract");
const { getTranscriptJob } = require("./lib/video-transcript-job");
const { clipSummary, sameClipSource, jobFormat, jobScope } = require("./lib/video-clip-contract");
const { documentRevision } = require("./lib/cuez-transfer-selection");
const { createStorydeskClient } = require("./lib/cuez-transfer-storydesk");
const { createExportFlow } = require("./lib/cuez-transfer-export");
const { createImportFlow } = require("./lib/cuez-transfer-import");
const { createTransferOperations, OPERATIONS } = require("./lib/cuez-transfer-operations");
const { createTransferStorage } = require("./lib/cuez-transfer-storage");
const { transferError, SAFE_ERROR_CODES, canRetry } = require("./lib/cuez-transfer-contract");
const { runtimeAwsConfig, runtimeRegistry } = require("./lib/media-source-runtime");
const { FUNCTION_SERVICE_ACCOUNT } = require("./source-media");

const API_KEY = defineSecret("CUEZ_STORYDESK_API_KEY");
const PUBLIC_ORIGIN = defineString("CMS_MEDIA_PUBLIC_ORIGIN", { default: "" });
const SETTINGS_PATH = "system/cuezIntegration";
const ACTIONS = ["status", "destinations", "prepare", "send", "operations", "candidates", "preview", "confirm", "retry", "reconcile"];
const MESSAGES = {
  invalid_request: "Check the selected item and try again.", invalid_transition: "This transfer cannot take that action. Refresh its status.",
  not_authorized: "You do not have access to this item.", not_configured: "StoryDesk transfers are not configured.",
  selection_changed: "This item changed. Select it again before sending.", output_unavailable: "A web or viewing version is unavailable. Prepare one in the media library first.",
  description_too_long: "This StoryDesk description is longer than Boardwalk's 10,000-character import limit. Shorten it in StoryDesk before importing.",
  transient_failure: "The transfer could not finish. Try again.", remote_conflict: "The saved versions differ. Review both items before transferring again.",
  outcome_unknown: "The result needs review. Check StoryDesk before taking another action.",
};

function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw transferError("invalid_request");
}
function localId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw transferError("invalid_request");
  return value;
}
function configuredNewsdeskId(settings) {
  const value = settings?.newsdeskId;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 1024 ||
      !value.isWellFormed() || /\p{Cc}/u.test(value)) throw transferError("not_configured");
  return value;
}
function operationCursor(document, actorUid) {
  const { seconds, nanoseconds } = document.data().updatedAt;
  return Buffer.from(JSON.stringify({ actorUid, operationId: document.id, seconds, nanoseconds })).toString("base64url");
}
function operationPosition(value, actorUid) {
  try {
    if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    fields(decoded, ["actorUid", "operationId", "seconds", "nanoseconds"]);
    if (decoded.actorUid !== actorUid || !Number.isSafeInteger(decoded.seconds) || !Number.isInteger(decoded.nanoseconds)) throw new Error();
    return [new Timestamp(decoded.seconds, decoded.nanoseconds), localId(decoded.operationId)];
  } catch { throw transferError("invalid_request"); }
}
function operationView(operation, label = null) {
  const steps = Object.values(operation.steps ?? {});
  const stories = steps.filter(step => step.outcome === "complete" && ["stories_create", "stories_update"].includes(step.tool));
  const canClosePartial = !operation.partialAcknowledgment && operation.direction === "export" &&
    operation.selectionSnapshot.target.kind === "new-story" && ["failed", "conflict"].includes(operation.state) &&
    !!operation.mappingCheck && steps.every(step => ["complete", "not-applied"].includes(step.outcome)) &&
    stories.length === 1 && !!stories[0].remoteIdentity && !!stories[0].remoteChangeMarker;
  return { operationId: operation.operationId, direction: operation.direction, state: operation.state,
    ...(label ? { label } : {}),
    kind: operation.selectionSnapshot.selection?.kind ?? "story", errorCode: operation.errorCode,
    message: operation.errorCode ? MESSAGES[operation.errorCode] : null,
    canRetry: !operation.partialAcknowledgment && canRetry(operation.state, operation.errorCode, steps.some(step => step.outcome === "complete")),
    canClosePartial, partialAcknowledged: !!operation.partialAcknowledgment,
    updatedAt: operation.updatedAt?.toDate?.().toISOString() ?? null,
    ...(operation.importedRecord ? { draftId: operation.importedRecord.recordId } : {}),
    acknowledged: !!operation.reconciliationAcknowledgedBy };
}

function sourceAsset(snapshot, source) {
  const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
  if (!source || !asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) throw transferError("not_authorized");
  return asset;
}

async function authorizeResource({ firestore, actor, resource, registry, snapshot: suppliedSnapshot, requireEdit = true }) {
  fields(resource, ["kind", "id", "jobId"]);
  localId(resource.id);
  if (["video", "clip", "transcript"].includes(resource.kind)) {
    const source = registry.get("video-library");
    await authorizeMediaSource({ firestore, actor, source, operation: "browse" });
    const snapshot = suppliedSnapshot ?? await firestore.collection("mediaSourceAssets").doc(resource.id).get();
    return safeLabel(sourceAsset(snapshot, source).name);
  }
  const collection = { image: "media_assets", post: "cmsPosts" }[resource.kind];
  if (!collection) throw transferError("invalid_request");
  const snapshot = suppliedSnapshot ?? await firestore.collection(collection).doc(resource.id).get();
  if (resource.kind === "post") {
    const stored = snapshot.data(), content = contentResource({ collection, documentId: resource.id, stored });
    const decision = requireEdit ? snapshot.exists && authorizeContentWrite(actor.principal, { creating: false,
      publishing: false, storedStatus: stored.status, nextStatus: stored.status, resource: content }).allowed
      : authorizeContentRead(actor.principal, { exists: snapshot.exists, resource: content }).allowed;
    if (!decision) throw transferError("not_authorized");
    return safeLabel(snapshot.data()?.title);
  }
  const summary = mediaAssetSummary(snapshot.id, snapshot.data());
  if (!summary || !mayUseMedia(actor.principal, summary.category, "image", isAudioReadAdmitted(actor))) throw transferError("not_authorized");
  return safeLabel(summary.name);
}

function safeLabel(value) {
  return typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").slice(0, 250).trim() : null;
}

async function exportRequest({ firestore, actor, resource, registry, config, now }) {
  await authorizeResource({ firestore, actor, resource, registry });
  const kind = resource.kind;
  const collection = kind === "post" ? "cmsPosts" : kind === "image" ? "media_assets" : "mediaSourceAssets";
  const snapshot = await firestore.collection(collection).doc(resource.id).get();
  if (!snapshot.exists) throw transferError("output_unavailable");
  const record = snapshot.data();
  const selection = { kind, [kind === "post" ? "recordId" : "assetId"]: resource.id,
    expectedVersion: record.version, expectedUpdateTime: documentRevision(snapshot) };
  if (["video", "clip", "transcript"].includes(kind)) {
    selection.sourceId = "video-library";
    selection.fileVersion = sourceMediaFileVersion(record.objectVersionId);
  }
  if (kind === "clip") {
    const jobSnapshot = await firestore.collection("mediaSourceClipJobs").doc(localId(resource.jobId)).get();
    const job = jobSnapshot.data();
    const asset = parseSourceMediaAsset(snapshot.id, record);
    if (!job || !asset || !sameClipSource(asset, job) || jobFormat(job) !== "web_mp4" || jobScope(job) !== "clip" ||
        clipSummary(job, now).state !== "ready") throw transferError("output_unavailable");
    Object.assign(selection, { clipId: jobSnapshot.id, expectedJobUpdateTime: documentRevision(jobSnapshot),
      expectedClipOutput: { attemptId: job.attemptId, objectKey: job.output.objectKey,
        objectVersionId: job.output.objectVersionId, sizeBytes: job.output.sizeBytes } });
  }
  if (kind === "transcript") {
    const job = await getTranscriptJob({ firestore, source: registry.get("video-library"), renditionBucket: config.renditionBucket,
      request: { sourceId: "video-library", assetId: resource.id, transcriptId: localId(resource.jobId) } });
    if (!job || job.phase !== "ready") throw transferError("output_unavailable");
    const jobSnapshot = await firestore.collection("mediaSourceTranscriptJobs").doc(job.id).get();
    Object.assign(selection, { transcriptId: job.id, expectedJobUpdateTime: documentRevision(jobSnapshot), expectedEditRevision: job.editRevision ?? 0 });
  }
  return selection;
}

function requireExportWrite(actor, kind) {
  if (["video", "clip", "transcript"].includes(kind) && !can(actor.principal, "media.video.manage")) throw transferError("not_authorized");
  if (kind === "image" && !can(actor.principal, "media.upload") && !can(actor.principal, "media.manage")) throw transferError("not_authorized");
  // Posts retain their resource-specific edit check in authorizeResource.
}

async function resourceList(context, kind, assetId, cursor) {
  const { firestore, actor, registry, config, now } = context;
  if (cursor !== undefined) localId(cursor);
  const page = async (query, limit) => {
    const ordered = query.orderBy(FieldPath.documentId());
    return (cursor ? ordered.startAfter(cursor) : ordered).limit(limit).get();
  };
  if (["clip", "transcript"].includes(kind)) {
    localId(assetId);
    await authorizeResource({ ...context, resource: { kind: "video", id: assetId } });
    const collection = kind === "clip" ? "mediaSourceClipJobs" : "mediaSourceTranscriptJobs";
    const snapshots = await page(firestore.collection(collection).where("assetId", "==", assetId), 25);
    const items = [];
    for (const doc of snapshots.docs) {
      const resource = { kind, id: assetId, jobId: doc.id };
      try {
        await exportRequest({ firestore, actor, resource, registry, config, now });
        items.push({ resource, label: kind === "clip" ? `Clip ${doc.data().inMs / 1000}–${doc.data().outMs / 1000} seconds` : "Cached transcript",
          detail: doc.id.slice(0, 12) });
      } catch (error) {
        const staleTranscript = kind === "transcript" && error instanceof SourceMediaValidationError && [404, 409].includes(error.status);
        if (!staleTranscript && !["output_unavailable", "selection_changed"].includes(error.code)) throw error;
      }
    }
    return { items, nextCursor: snapshots.size === 25 ? snapshots.docs.at(-1).id : null };
  }
  const collection = { video: "mediaSourceAssets", image: "media_assets", post: "cmsPosts" }[kind];
  if (!collection) throw transferError("invalid_request");
  if (kind === "video") await authorizeMediaSource({ firestore, actor, source: registry.get("video-library"), operation: "browse" });
  const snapshots = await page(firestore.collection(collection), 50);
  const items = [];
  for (const doc of snapshots.docs) {
    const record = doc.data();
    if (kind === "post" && record.type !== "post") continue;
    if (kind === "image" && record.kind !== "image") continue;
    if (record.deleted || record.status === "archived" || (kind !== "post" && record.lifecycle !== "active")) continue;
    if (kind === "video" && record.sourceId !== "video-library") continue;
    const resource = { kind, id: doc.id };
    try {
      if (kind === "video") sourceAsset(doc, registry.get("video-library"));
      else await authorizeResource({ ...context, resource, snapshot: doc });
    }
    catch (error) { if (error.code === "not_authorized") continue; throw error; }
    items.push({ resource, label: record.title ?? record.name ?? "Untitled item", detail: kind === "post" ? record.status : record.description ?? "" });
  }
  return { items, nextCursor: snapshots.size === 50 ? snapshots.docs.at(-1).id : null };
}

function createCuezHandler(action, deps = {}) {
  if (!ACTIONS.includes(action)) throw new Error("Unknown transfer action");
  const log = deps.logger ?? logger;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const firestore = deps.firestore ?? db;
    try {
      // Like the billing settings owner, read server-only settings each time. No cache.
      const settings = (await firestore.doc(SETTINGS_PATH).get()).data();
      if (settings?.enabled !== true) {
        res.status(503).json({ error: "StoryDesk transfers are turned off.", code: "not_configured", enabled: false }); return;
      }
      if (req.method !== "POST") { res.status(405).json({ error: "Use POST.", code: "invalid_request" }); return; }
      validateBoundedJsonRequest(req, 16384);
      await (deps.verifyAppCheck ?? verifyAppCheckToken)(req.headers?.["x-firebase-appcheck"]);
      const actor = await (deps.requirePrincipal ?? requirePrincipal)(req, { includeAccountStatus: true });
      if (!actor.approvedActive || !hasCapability(actor.principal, "guide.view")) throw transferError("not_authorized");
      const body = req.body ?? {};
      const clock = deps.now ?? Date.now;
      if (action === "status") {
        fields(body, []);
        configuredNewsdeskId(settings);
        res.status(200).json({ success: true, enabled: true,
          canImport: can(actor.principal, "content.create", { ownerId: actor.uid, unassignedDraft: true }) }); return;
      }
      if (["destinations", "candidates", "preview", "confirm"].includes(action)) {
        fields(body, ["destinations", "candidates"].includes(action) ? ["search", "page"] : action === "preview" ? ["storyId"] : ["operationId", "confirmed"]);
        if (!can(actor.principal, "content.create", { ownerId: actor.uid, unassignedDraft: true })) throw transferError("not_authorized");
      }
      const newsdeskId = configuredNewsdeskId(settings);
      const registry = (deps.registry ?? runtimeRegistry)();
      const config = (deps.awsConfig ?? runtimeAwsConfig)();
      const client = createStorydeskClient({ apiKey: (deps.apiKey ?? (() => API_KEY.value()))(), newsdeskId,
        fetchImpl: deps.fetchImpl, timeoutMs: 60000 });
      const context = { firestore, actor, registry, config, now: clock() };
      const flowArgs = { firestore, actorUid: actor.uid, actorEmail: actor.email, newsdeskId, client, registry, ...config,
        now: clock, publicMediaOrigin: (deps.publicMediaOrigin ?? (() => PUBLIC_ORIGIN.value()))(),
        storage: deps.storage ?? createTransferStorage(config) };
      const exports = createExportFlow(flowArgs), imports = createImportFlow(flowArgs);
      let result;
      if (["destinations", "candidates"].includes(action)) {
        fields(body, ["search", "page"]);
        result = await imports.listCandidates({ search: body.search ?? "", page: body.page ?? 1 });
      } else if (action === "prepare") {
        fields(body, ["action", "kind", "assetId", "resource", "target", "cursor"]);
        if (body.action === "list") result = await resourceList(context, body.kind, body.assetId, body.cursor);
        else {
          if (body.action !== "prepare") throw transferError("invalid_request");
          requireExportWrite(actor, body.resource?.kind);
          const selection = await exportRequest({ ...context, resource: body.resource });
          const queued = await exports.prepareExport({ workspaceId: newsdeskId, mappingVersion: 1, selection, target: body.target });
          result = { operation: operationView(queued.operation) };
        }
      } else if (action === "preview") {
        fields(body, ["storyId"]);
        if (!can(actor.principal, "content.create", { ownerId: actor.uid, unassignedDraft: true })) throw transferError("not_authorized");
        result = await imports.previewImport({ workspaceId: newsdeskId, mappingVersion: 1, importKind: "story-with-brief-and-dossiers", storyId: body.storyId });
        result.operation = operationView(result.operation);
      } else {
        fields(body, action === "confirm" ? ["operationId", "confirmed"] : action === "reconcile" ? ["operationId", "acknowledged", "closePartial"]
          : action === "operations" ? ["operationId", "cursor"] : ["operationId"]);
        const operations = createTransferOperations({ firestore, now: clock });
        if (action === "operations" && !body.operationId) {
          let query = firestore.collection(OPERATIONS).where("initiatedBy", "==", actor.uid)
            .orderBy("updatedAt", "desc").orderBy(FieldPath.documentId(), "desc");
          if (body.cursor !== undefined) {
            query = query.startAfter(...operationPosition(body.cursor, actor.uid));
          }
          const page = await query.limit(26).get();
          const documents = page.docs.slice(0, 25);
          const visible = [];
          for (const doc of documents) {
            try {
              const label = await authorizeOperation({ ...context, operation: doc.data() });
              visible.push(operationView({ operationId: doc.id, ...doc.data() }, label));
            }
            catch (error) { if (error.code !== "not_authorized") throw error; }
          }
          const last = documents.at(-1);
          result = { operations: visible, nextCursor: page.size > 25 ? operationCursor(last, actor.uid) : null,
            boundary: last ? { operationId: last.id, updatedAt: last.data().updatedAt.toDate().toISOString() } : null };
        } else {
          if (action === "operations" && body.cursor !== undefined) throw transferError("invalid_request");
          const operation = await operations.read(body.operationId);
          if (!operation || operation.selectionSnapshot.workspaceId !== newsdeskId) throw transferError("invalid_request");
          const label = await authorizeOperation({ ...context, operation, requireWrite: action !== "operations" });
          if (action === "operations") result = { operation: operationView(operation, label) };
          else {
            if (action === "confirm" && (body.confirmed !== true || operation.direction !== "import")) throw transferError("invalid_request");
            if (action === "send" && operation.direction !== "export") throw transferError("invalid_request");
            if (action === "reconcile" && body.closePartial === true) {
              if (body.acknowledged !== true) throw transferError("invalid_transition");
              const closed = await operations.acknowledgePartial({ operationId: operation.operationId,
                attemptId: operation.attemptId, acknowledgedBy: actor.uid });
              log.info("StoryDesk transfer request completed", { action });
              res.status(200).json({ success: true, operation: operationView(closed, label) }); return;
            }
            if (action === "reconcile") {
              if (body.acknowledged !== true || !["transferring", "reconciliation"].includes(operation.state)) throw transferError("invalid_transition");
            }
            const run = operation.direction === "export" ? exports.sendExport : imports.confirmImport;
            let recovered = await run(operation.operationId, { retry: action === "retry", reconcile: action === "reconcile" });
            if (action === "reconcile") recovered = await acknowledgeRecovery(firestore, recovered, actor.uid, clock());
            result = { operation: operationView(recovered, label) };
          }
        }
      }
      log.info("StoryDesk transfer request completed", { action });
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const known = SAFE_ERROR_CODES.includes(error?.code), jsonRefusal = error instanceof JsonRequestError;
      const authRefusal = error?.status === 401 || error?.status === 403;
      const code = known ? error.code : jsonRefusal ? "invalid_request" : authRefusal ? "not_authorized" : "transient_failure";
      const status = jsonRefusal ? error.status : error?.status === 401 ? 401 : code === "not_authorized" ? 403 : code === "not_configured" ? 503
        : ["invalid_request"].includes(code) ? 400 : ["selection_changed", "invalid_transition", "remote_conflict", "description_too_long"].includes(code) ? 409 : 503;
      if (known || jsonRefusal || authRefusal) log.info("StoryDesk transfer request refused", { action, code });
      else log.error("StoryDesk transfer request failed", { action, code, cause: errorCause(error) });
      res.status(status).json({ error: MESSAGES[code], code });
    }
  };
}

function errorCause(error) {
  // Arbitrary messages can contain provider bodies, signed URLs, or private text.
  const names = ["Error", "TypeError", "RangeError", "SyntaxError", "FirebaseError"];
  const codes = ["FAILED_PRECONDITION", "UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "PERMISSION_DENIED", "ABORTED", "ETIMEDOUT", "ECONNREFUSED"];
  return { name: names.includes(error?.name) ? error.name : "Error",
    code: Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 || codes.includes(error?.code) ? error.code : null,
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null };
}

async function acknowledgeRecovery(firestore, recovered, actorUid, now) {
  const ref = firestore.collection(OPERATIONS).doc(recovered.operationId);
  return firestore.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current || current.attemptId !== recovered.attemptId || current.state !== recovered.state ||
        !current.updatedAt.isEqual(recovered.updatedAt)) throw transferError("invalid_transition");
    const patch = { reconciliationAcknowledgedBy: actorUid, reconciliationAcknowledgedAt: new Date(now).toISOString() };
    tx.update(ref, patch);
    return { operationId: recovered.operationId, ...current, ...patch };
  });
}

async function authorizeOperation(context) {
  const { operation, actor } = context;
  if (operation.direction === "export") {
    const s = operation.selectionSnapshot.selection;
    if (context.requireWrite) requireExportWrite(actor, s.kind);
    return authorizeResource({ ...context, resource: { kind: s.kind, id: s.assetId ?? s.recordId } });
  } else if (operation.importedRecord) {
    return authorizeResource({ ...context, requireEdit: false, resource: { kind: "post", id: operation.importedRecord.recordId } });
  } else if (!can(actor.principal, "content.create", { ownerId: actor.uid, unassignedDraft: true })) {
    throw transferError("not_authorized");
  }
}

const options = { cors: true, timeoutSeconds: 540, maxInstances: 10, secrets: [API_KEY],
  serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsCuezStatus = cmsOnRequest(options, createCuezHandler("status"));
const cmsCuezListDestinations = cmsOnRequest(options, createCuezHandler("destinations"));
const cmsCuezPrepareExport = cmsOnRequest(options, createCuezHandler("prepare"));
const cmsCuezSendExport = cmsOnRequest(options, createCuezHandler("send"));
const cmsCuezOperationStatus = cmsOnRequest(options, createCuezHandler("operations"));
const cmsCuezListImportCandidates = cmsOnRequest(options, createCuezHandler("candidates"));
const cmsCuezPreviewImport = cmsOnRequest(options, createCuezHandler("preview"));
const cmsCuezConfirmImport = cmsOnRequest(options, createCuezHandler("confirm"));
const cmsCuezRetry = cmsOnRequest(options, createCuezHandler("retry"));
const cmsCuezReconcile = cmsOnRequest(options, createCuezHandler("reconcile"));

module.exports = { SETTINGS_PATH, ACTIONS, createCuezHandler, operationView,
  cmsCuezStatus, cmsCuezListDestinations, cmsCuezPrepareExport, cmsCuezSendExport, cmsCuezOperationStatus,
  cmsCuezListImportCandidates, cmsCuezPreviewImport, cmsCuezConfirmImport, cmsCuezRetry, cmsCuezReconcile };
