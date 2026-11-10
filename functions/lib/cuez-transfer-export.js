"use strict";

const { prepareExportSelection, documentRevision, readActor } = require("./cuez-transfer-selection");
const { createTransferOperations, mappingIdentity, MAPPINGS } = require("./cuez-transfer-operations");
const { transferError, SAFE_ERROR_CODES } = require("./cuez-transfer-contract");
const { parseSourceMediaAsset } = require("./source-media-contract");
const { parseSourceMediaRendition } = require("./source-media-rendition");
const { validateClipOutput, jobFormat, jobScope } = require("./video-clip-contract");
const { mediaAssetSummary } = require("./media-library");
const { publicMediaUrl } = require("./media-contract");
const { transferMarker, contentHash } = require("./cuez-transfer-storydesk");
const { authorizeContentWrite, contentResource } = require("./content-authorization");
const { authorizeMediaSource, objectKeyWithinSource } = require("./media-sources");
const { mayUseMedia, isAudioReadAdmitted } = require("./media-access");

// Access outlives the bounded synchronous MCP request. Never persist the URL.
const DELIVERY_TTL_SECONDS = 60 * 60;

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw transferError("output_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw transferError("output_unavailable");
  return url.href;
}

function editorialText(value, maximum = 10000) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > maximum || !value.isWellFormed() ||
      /\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ""))) throw transferError("output_unavailable");
  return value;
}

function storyFields(record, kind) {
  const title = editorialText(kind === "around-nj" ? record.headline : record.title ?? record.name, 250).trim();
  if (!title) throw transferError("output_unavailable");
  const lines = [editorialText(record.summary ?? record.excerpt ?? record.description)];
  if (kind === "around-nj") lines.push(`Source: ${editorialText(record.outlet, 120)}`, safeUrl(record.canonicalUrl));
  else {
    lines.push("Source: Boardwalk, NJ PBS");
    if (record.credit) lines.push(`Credit: ${editorialText(record.credit, 1000)}`);
    if (record.license) lines.push(`License: ${editorialText(record.license, 1000)}`);
    if (record.rightsStatus) lines.push(`Rights: ${editorialText(record.rightsStatus, 1000)}`);
    if (Array.isArray(record.tags) && record.tags.length) lines.push(`Tags: ${record.tags.map(tag => editorialText(tag, 100)).join(", ")}`);
    // A draft with an old published snapshot still has an existing public story.
    const publishedSlug = record.published?.metadata?.slug;
    if (kind === "post" && typeof publishedSlug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publishedSlug)) {
      lines.push(`Public story: https://njpbs.org/posts/${publishedSlug}/`);
    }
  }
  return { title, description: lines.filter(Boolean).join("\n") };
}

function createExportFlow({ firestore, client, actorUid, newsdeskId, registry = new Map(),
  renditionBucket, publicMediaOrigin, storage, now = Date.now }) {
  const operations = createTransferOperations({ firestore, now });
  const prepare = request => prepareExportSelection({ firestore, request, actorUid, newsdeskId, registry, renditionBucket, now: now() });

  async function authorizeRecorded(operation) {
    if (operation.selectionSnapshot.workspaceId !== newsdeskId) throw transferError("not_authorized");
    const actor = await firestore.runTransaction(tx => readActor(firestore, tx, actorUid));
    const s = operation.selectionSnapshot.selection;
    const record = (await firestore.collection(operation.resolvedSelection.record.collection)
      .doc(s.assetId ?? s.recordId).get()).data();
    if (s.kind === "post") {
      if (!record || !authorizeContentWrite(actor.principal, { creating: false, publishing: false,
        storedStatus: record.status, nextStatus: record.status,
        resource: contentResource({ collection: "cmsPosts", documentId: s.recordId, stored: record }) }).allowed) throw transferError("not_authorized");
    } else if (s.kind === "image") {
      const summary = mediaAssetSummary(s.assetId, record);
      if (!summary || !mayUseMedia(actor.principal, summary.category, "image", isAudioReadAdmitted(actor))) throw transferError("not_authorized");
    } else {
      const source = registry.get(s.sourceId);
      await authorizeMediaSource({ firestore, actor, source, operation: "browse", isApprovedActiveAccountFn: async () => true });
      const asset = parseSourceMediaAsset(s.assetId, record);
      if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) throw transferError("not_authorized");
    }
  }

  async function retainSnapshot(operation, payload) {
    const snapshot = { fields: payload.fields };
    if (operation.selectionSnapshot.selection.kind === "video") {
      const { objectKey, objectVersionId, sizeBytes } = payload.delivery;
      snapshot.web = { objectKey, objectVersionId, sizeBytes };
    }
    const ref = firestore.collection("cuezTransferOperations").doc(operation.operationId);
    return firestore.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current.exportSnapshot) return current.exportSnapshot;
      tx.update(ref, { exportSnapshot: snapshot });
      return snapshot;
    });
  }

  async function recordedPayload(operation) {
    // Older queued records can acquire a snapshot only while their selection still matches.
    const snapshot = operation.exportSnapshot ?? await retainSnapshot(operation, await content(await prepare(operation.selectionSnapshot)));
    const s = operation.selectionSnapshot.selection, resolved = operation.resolvedSelection;
    const fields = snapshot.fields;
    if (s.kind === "post") return { fields };
    const source = registry.get(s.sourceId);
    if (s.kind === "transcript") {
      if (!storage?.readText) throw transferError("not_configured");
      const text = await storage.readText({ bucket: renditionBucket, ...resolved.transcript.text, source, maximumBytes: 512000 });
      return { fields, text: editorialText(text, 512000) };
    }
    if (s.kind === "image") return { fields, delivery: {
      publicUrl: safeUrl(publicMediaUrl(publicMediaOrigin, resolved.image.storageKey)), sizeBytes: resolved.image.sizeBytes,
    }, filename: `boardwalk-image.${resolved.image.mimeType.split("/")[1]}` };
    if (s.kind === "clip" && Date.parse(resolved.clip.expiresAt) - now() < DELIVERY_TTL_SECONDS * 1000) throw transferError("output_unavailable");
    if (!renditionBucket || renditionBucket === source?.bucket) throw transferError("not_configured");
    return { fields, delivery: { bucket: renditionBucket, ...(s.kind === "clip" ? resolved.clip : snapshot.web),
      expectedBucketOwner: source.expectedBucketOwner, source }, filename: s.kind === "clip" ? "boardwalk-clip.mp4" : "boardwalk-video.mp4" };
  }

  async function content(prepared) {
    const s = prepared.selectionSnapshot.selection;
    // No ingestion owner exists. A stray document cannot enable this surface.
    if (s.kind === "around-nj") throw transferError("output_unavailable");
    const identity = prepared.resolvedSelection.record;
    const snapshot = await firestore.collection(identity.collection).doc(identity.recordId).get();
    if (!snapshot.exists || documentRevision(snapshot) !== identity.updateTime) throw transferError("selection_changed");
    const record = snapshot.data();
    const fields = storyFields(record, s.kind);
    if (s.kind === "post") return { fields };
    if (s.kind === "transcript") {
      if (!storage?.readText) throw transferError("not_configured");
      const output = prepared.resolvedSelection.transcript.text;
      const text = await storage.readText({ bucket: renditionBucket, ...output, source: registry.get(s.sourceId), maximumBytes: 512000 });
      return { fields, text: editorialText(text, 512000) };
    }
    if (s.kind === "image") {
      const summary = mediaAssetSummary(snapshot.id, record);
      if (!summary || !publicMediaOrigin || safeUrl(summary.url) !== safeUrl(publicMediaUrl(publicMediaOrigin, record.storageKey))) {
        throw transferError("output_unavailable");
      }
      return { fields, delivery: { publicUrl: summary.url, sizeBytes: summary.sizeBytes }, filename: `boardwalk-image.${summary.mimeType.split("/")[1]}` };
    }
    const asset = parseSourceMediaAsset(snapshot.id, record);
    const source = registry.get(s.sourceId);
    let output;
    if (s.kind === "video") {
      const rendition = parseSourceMediaRendition(asset?.rendition, asset);
      if (rendition?.state !== "ready") throw transferError("output_unavailable");
      output = rendition.web;
    } else {
      const job = (await firestore.collection("mediaSourceClipJobs").doc(s.clipId).get()).data();
      if (!job || jobFormat(job) !== "web_mp4" || jobScope(job) !== "clip" ||
          Date.parse(job.expiresAt) - now() < DELIVERY_TTL_SECONDS * 1000) throw transferError("output_unavailable");
      try { output = validateClipOutput(job, { id: job.id, attemptId: job.attemptId, web: job.output }); }
      catch { throw transferError("output_unavailable"); }
    }
    if (!renditionBucket || renditionBucket === source?.bucket) throw transferError("not_configured");
    return { fields, delivery: { bucket: renditionBucket, ...output, expectedBucketOwner: source.expectedBucketOwner,
      source }, filename: s.kind === "clip" ? "boardwalk-clip.mp4" : "boardwalk-video.mp4" };
  }

  async function prepareExport(request) {
    const prepared = await prepare(request);
    const payload = await content(prepared);
    const queued = await operations.enqueue(prepared);
    await retainSnapshot(queued.operation, payload);
    return { ...queued, operation: await operations.read(queued.operation.operationId) };
  }

  async function execute(operation, prepared, payload, expectedMappingOperationId) {
    const fence = { operationId: operation.operationId, attemptId: operation.attemptId };
    const target = prepared.selectionSnapshot.target;
    const kind = prepared.selectionSnapshot.selection.kind;
    const write = async (step, tool, args) => {
      const current = await operations.read(operation.operationId);
      if (current.state === "reconciliation" && !current.steps[step]) {
        // All preceding writes have receipts; an unattempted next step can be retried explicitly.
        if (Object.values(current.steps).every(item => item.outcome === "complete")) {
          await operations.advance({ ...fence, event: "confirmed_failure", errorCode: "transient_failure" });
        }
        return null;
      }
      await authorizeRecorded(operation);
      const result = await client.writeStep({ operations, ...fence, step, tool, arguments: args, expectedMappingOperationId });
      return result.state === "complete" ? result : null;
    };
    let story = null;
    if (target.kind === "new-story") {
      story = await write("story", "stories_create", payload.fields);
      if (!story) return operations.read(operation.operationId);
    }
    const storyId = story?.remoteIdentity ?? target.storyId;
    let result = story;
    if (kind === "transcript") {
      result = await write("dossier", "sections_create", { storyId, title: `${payload.fields.title.slice(0, 150)} transcript`, content: payload.text });
    } else if (["video", "clip", "image"].includes(kind)) {
      if (!storage?.deliveryUrl) throw transferError("not_configured");
      const url = safeUrl(await storage.deliveryUrl(payload.delivery, DELIVERY_TTL_SECONDS));
      result = await write("asset", "assets_import_from_url", { storyId, url, filename: payload.filename });
    }
    if (!result) return operations.read(operation.operationId);
    if (story) {
      const current = (await client.call("stories_get", { storyId }))?.data;
      if (current?.id !== storyId || current.title !== payload.fields.title ||
          current.description !== `${payload.fields.description}\n${transferMarker(operation.operationId)}` || !current.updatedAt) {
        throw transferError("outcome_unknown");
      }
      story.remoteChangeMarker = current.updatedAt;
    }
    return operations.complete({ ...fence, remoteIdentity: story?.remoteIdentity ?? result.remoteIdentity,
      remoteChangeMarker: story?.remoteChangeMarker ?? result.remoteChangeMarker, expectedMappingOperationId });
  }

  async function sendExport(operationId, { retry = false, reconcile = false } = {}) {
    const existing = await operations.read(operationId);
    if (!existing || existing.direction !== "export") throw transferError("invalid_request");
    await authorizeRecorded(existing);
    if (reconcile) return reconcileExport(existing);
    if (["complete", "conflict"].includes(existing.state)) return existing;
    if (retry) await operations.advance({ operationId, attemptId: existing.attemptId, event: "retry" });
    const prepared = Object.fromEntries(["direction", "selectionSnapshot", "resolvedSelection", "initiatedBy", "origin"].map(key => [key, existing[key]]));
    const claimed = await operations.claim(operationId, prepared);
    if (!claimed.claimed) return claimed.operation;
    const operation = claimed.operation;
    const mappingId = mappingIdentity(operation).mappingId;
    const mapping = (await firestore.collection(MAPPINGS).doc(mappingId).get()).data();
    const expected = operation.mappingCheck ? operation.mappingCheck.expectedMappingOperationId : mapping?.lastOperationId ?? null;
    try { return await execute(operation, prepared, await recordedPayload(operation), expected); }
    catch (error) {
      const current = await operations.read(operationId);
      if (!["transferring", "reconciliation"].includes(current.state)) return current;
      const unknown = Object.values(current.steps).some(step => step.outcome === "unknown");
      const code = SAFE_ERROR_CODES.includes(error?.code) ? error.code : "transient_failure";
      if (unknown || code === "outcome_unknown") return operations.advance({ operationId, attemptId: operation.attemptId,
        event: "outcome_unknown", errorCode: "outcome_unknown" });
      return operations.advance({ operationId, attemptId: operation.attemptId, event: "confirmed_failure",
        errorCode: code === "remote_conflict" ? "selection_changed" : code });
    }
  }

  async function reconcileExport(existing) {
    if (!["transferring", "reconciliation"].includes(existing.state)) return existing;
    const fence = { operationId: existing.operationId, attemptId: existing.attemptId };
    if (existing.state === "transferring") await operations.advance({ ...fence, event: "outcome_unknown", errorCode: "outcome_unknown" });
    for (const [id, step] of Object.entries(existing.steps)) {
      if (step.outcome === "not-applied" || step.tool === "assets_import_from_url" && step.outcome === "complete") continue;
      if (step.tool === "assets_import_from_url") return operations.read(existing.operationId);
      let candidates;
      if (["stories_create", "stories_update"].includes(step.tool)) {
        let identity = step.remoteIdentity ?? step.storyId;
        if (!identity) identity = (await client.lookup({ operationId: existing.operationId, tool: "stories_create" })).remoteIdentity;
        if (!identity) return operations.read(existing.operationId);
        const object = (await client.call("stories_get", { storyId: identity }))?.data;
        candidates = object ? [{ identity: object.id, revision: object.updatedAt,
          args: { title: object.title, description: object.description, ...(step.tool === "stories_update" ? { storyId: object.id } : {}) } }] : [];
      } else {
        const list = (await client.call("sections_list", { storyId: step.storyId }))?.data;
        if (!Array.isArray(list)) throw transferError("output_unavailable");
        candidates = list.map(object => ({ identity: object.id, revision: contentHash(JSON.stringify([object.title, object.content])),
          args: { storyId: step.storyId, title: object.title, content: object.content,
            ...(step.tool === "sections_update" ? { sectionId: object.id } : {}) } }));
      }
      const matches = candidates.filter(item => item.identity && item.revision &&
        contentHash(JSON.stringify(Object.entries(item.args).sort(([a], [b]) => a.localeCompare(b)))) === step.payloadHash);
      if (matches.length !== 1 || step.remoteChangeMarker && matches[0].revision !== step.remoteChangeMarker) return operations.read(existing.operationId);
      await operations.finishStep({ ...fence, step: id, outcome: "complete", remoteIdentity: matches[0].identity, remoteChangeMarker: matches[0].revision });
    }
    const current = await operations.read(existing.operationId);
    const kind = current.selectionSnapshot.selection.kind;
    const expectedSteps = [...(current.selectionSnapshot.target.kind === "new-story" ? ["story"] : []),
      ...(kind === "transcript" ? ["dossier"] : ["video", "clip", "image"].includes(kind) ? ["asset"] : [])];
    if (!expectedSteps.every(id => current.steps[id]?.outcome === "complete")) {
      return operations.advance({ ...fence, event: "confirmed_failure", errorCode: "transient_failure" });
    }
    const receipt = current.steps.story ?? current.steps.dossier ?? current.steps.asset;
    return operations.complete({ ...fence, remoteIdentity: receipt.remoteIdentity, remoteChangeMarker: receipt.remoteChangeMarker,
      expectedMappingOperationId: current.mappingCheck.expectedMappingOperationId });
  }

  return { prepareExport, sendExport, operations };
}

module.exports = { DELIVERY_TTL_SECONDS, safeUrl, storyFields, createExportFlow };
