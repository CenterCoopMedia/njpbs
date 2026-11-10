"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { ID_PATTERN, sourceMediaFileVersion } = require("./source-media-contract");
const { parseExportRequest, parseImportRequest, buildDedupKey, transferOperationId, transition,
  SAFE_ERROR_CODES, transferError } = require("./cuez-transfer-contract");
const { originMarker } = require("./cuez-transfer-selection");

const OPERATIONS = "cuezTransferOperations";
const MAPPINGS = "cuezMappings";
const HASH = /^[a-f0-9]{64}$/;
const COLLECTIONS = ["mediaSourceAssets", "mediaSourceClipJobs", "mediaSourceTranscriptJobs", "media_assets", "cmsPosts", "aroundNjStories"];

function requireId(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw transferError("invalid_request");
  return value;
}

function text(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || !value.isWellFormed() ||
      value.trim() !== value || value.includes("://") || /\p{Cc}/u.test(value)) throw transferError("invalid_request");
  return value;
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw transferError("invalid_request");
}

// These shapes admit identity and revision evidence only, never editorial payloads.
const SHAPES = {
  record: { collection: text, recordId: text, updateTime: text, version: Number.isSafeInteger },
  original: { bucket: text, objectKey: text, objectVersionId: text, sizeBytes: Number.isSafeInteger },
  clip: { jobId: text, updateTime: text, attemptId: text, objectKey: text, objectVersionId: text,
    sizeBytes: Number.isSafeInteger, inMs: Number.isSafeInteger, outMs: Number.isSafeInteger,
    durationSeconds: Number.isFinite, expiresAt: text },
  transcript: { jobId: text, updateTime: text, editRevision: Number.isSafeInteger, segments: null, text: null },
  image: { storageKey: text, sizeBytes: Number.isSafeInteger, mimeType: text },
};

function identityObject(value, shape, optional = []) {
  exactObject(value, Object.keys(shape));
  const result = {};
  for (const [key, validate] of Object.entries(shape)) {
    if (value[key] === undefined && optional.includes(key)) continue;
    if (validate === null) result[key] = identityObject(value[key], { objectKey: text, objectVersionId: text });
    else if (!validate(value[key])) throw transferError("invalid_request");
    else result[key] = value[key];
  }
  return result;
}

function normalizePrepared(value) {
  exactObject(value, ["direction", "selectionSnapshot", "resolvedSelection", "initiatedBy", "origin"]);
  const dedupKey = buildDedupKey(value.direction, value.selectionSnapshot);
  if (typeof value.initiatedBy !== "string" || !ID_PATTERN.test(value.initiatedBy)) throw transferError("invalid_request");
  const s = value.selectionSnapshot.selection;
  const fields = value.direction === "import" ? [] : ["record",
    ...(["video", "clip", "transcript"].includes(s.kind) ? ["original"] : []),
    ...(["image", "clip", "transcript"].includes(s.kind) ? [s.kind] : [])];
  exactObject(value.resolvedSelection, fields);
  const resolved = {};
  for (const field of fields) resolved[field] = identityObject(value.resolvedSelection[field], SHAPES[field], field === "record" ? ["version"] : []);
  if (resolved.record && (!COLLECTIONS.includes(resolved.record.collection) || !ID_PATTERN.test(resolved.record.recordId))) {
    throw transferError("invalid_request");
  }
  if (value.direction === "export") assertResolvedSelection(s, resolved);
  const origin = originMarker(value.origin);
  const selectionSnapshot = value.direction === "export" ? parseExportRequest(value.selectionSnapshot) : {
    ...parseImportRequest(Object.fromEntries(Object.entries(value.selectionSnapshot).filter(([key]) => key !== "remoteChangeMarker"))),
    remoteChangeMarker: text(value.selectionSnapshot.remoteChangeMarker),
  };
  return { operationId: transferOperationId(value.direction, value.selectionSnapshot), dedupKey,
    direction: value.direction, selectionSnapshot,
    resolvedSelection: resolved, initiatedBy: value.initiatedBy, origin };
}

function assertResolvedSelection(s, resolved) {
  const collections = { video: "mediaSourceAssets", clip: "mediaSourceAssets", transcript: "mediaSourceAssets",
    image: "media_assets", post: "cmsPosts", "around-nj": "aroundNjStories" };
  if (resolved.record.collection !== collections[s.kind] || resolved.record.recordId !== (s.assetId ?? s.recordId) ||
      resolved.record.updateTime !== s.expectedUpdateTime || resolved.record.version !== s.expectedVersion) {
    throw transferError("selection_changed");
  }
  if (resolved.original && sourceMediaFileVersion(resolved.original.objectVersionId) !== s.fileVersion) throw transferError("selection_changed");
  if (s.kind === "clip" && (resolved.clip.jobId !== s.clipId || resolved.clip.updateTime !== s.expectedJobUpdateTime ||
      Object.keys(s.expectedClipOutput).some(key => resolved.clip[key] !== s.expectedClipOutput[key]))) throw transferError("selection_changed");
  if (s.kind === "transcript" && (resolved.transcript.jobId !== s.transcriptId ||
      resolved.transcript.updateTime !== s.expectedJobUpdateTime || resolved.transcript.editRevision !== s.expectedEditRevision)) {
    throw transferError("selection_changed");
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function sameSelection(operation, prepared) {
  return operation.dedupKey === prepared.dedupKey &&
    JSON.stringify(canonical(operation.resolvedSelection)) === JSON.stringify(canonical(prepared.resolvedSelection));
}

function mappingIdentity(operation, importedRecord) {
  const s = operation.selectionSnapshot.selection;
  let record = operation.resolvedSelection.record;
  if (operation.direction === "import") {
    record = identityObject(importedRecord, SHAPES.record);
    if (record.collection !== "cmsPosts" || !ID_PATTERN.test(record.recordId) || record.version < 1) throw transferError("invalid_request");
  } else if (s.kind === "clip") record = { collection: "mediaSourceClipJobs", recordId: s.clipId };
  else if (s.kind === "transcript") record = { collection: "mediaSourceTranscriptJobs", recordId: s.transcriptId };
  const boardwalkRecord = { collection: record.collection, recordId: record.recordId };
  const objectType = operation.direction === "import" ? "story-with-brief-and-dossiers" : operation.selectionSnapshot.target.kind;
  const targetId = operation.direction === "import" ? operation.selectionSnapshot.storyId : operation.selectionSnapshot.target.storyId ?? null;
  const mappingId = createHash("sha256").update(JSON.stringify([
    "boardwalk-mapping-v1", operation.selectionSnapshot.workspaceId, boardwalkRecord.collection, boardwalkRecord.recordId, objectType, targetId,
  ])).digest("hex");
  return { mappingId, boardwalkRecord, objectType };
}

function createTransferOperations({ firestore, now = Date.now }) {
  const stamp = () => Timestamp.fromMillis(now());
  const ref = id => firestore.collection(OPERATIONS).doc(requireId(id));
  const withId = (id, data) => ({ operationId: id, ...data });

  async function enqueue(value, { automatic = false } = {}) {
    const p = normalizePrepared(value);
    if (automatic && p.origin && p.origin.system === (p.direction === "export" ? "external" : "boardwalk")) {
      throw transferError("remote_conflict");
    }
    return firestore.runTransaction(async tx => {
      const reference = ref(p.operationId);
      const existing = (await tx.get(reference)).data();
      if (existing) {
        if (!sameSelection(existing, p)) throw transferError("selection_changed");
        return { created: false, operation: withId(p.operationId, existing) };
      }
      const { operationId, ...identity } = p;
      const time = stamp();
      const operation = { ...identity, origin: p.origin ?? { system: p.direction === "export" ? "boardwalk" : "external",
        operationId, mappingId: null }, state: "queued", attemptCount: 0, attemptId: null,
        createdAt: time, updatedAt: time, startedAt: null, finishedAt: null, errorCode: null,
        remoteIdentity: null, remoteChangeMarker: null, mappingId: null, conflict: null, lastEvent: null,
        steps: {}, mappingCheck: null };
      tx.create(reference, operation);
      return { created: true, operation: withId(operationId, operation) };
    });
  }

  async function claim(operationId, prepared) {
    const p = normalizePrepared(prepared);
    if (p.operationId !== operationId) throw transferError("selection_changed");
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || !sameSelection(operation, p)) throw transferError("selection_changed");
      if (operation.state !== "queued") return { claimed: false, operation: withId(operationId, operation) };
      if (!Number.isSafeInteger(operation.attemptCount) || operation.attemptCount >= Number.MAX_SAFE_INTEGER) throw transferError("invalid_transition");
      const patch = { state: transition(operation.state, "start"), attemptCount: operation.attemptCount + 1,
        attemptId: randomUUID(), updatedAt: stamp(), startedAt: stamp(), finishedAt: null, lastEvent: "start" };
      tx.update(reference, patch);
      return { claimed: true, operation: withId(operationId, { ...operation, ...patch }) };
    });
  }

  async function advance({ operationId, attemptId, event, errorCode = null, conflict = null, unstartedStep = null }) {
    if (unstartedStep !== null && !/^[a-z][a-z0-9-]{0,63}$/.test(unstartedStep)) throw transferError("invalid_request");
    if (!["confirmed_failure", "confirmed_conflict", "outcome_unknown", "retry"].includes(event)) throw transferError("invalid_transition");
    const codes = { confirmed_failure: SAFE_ERROR_CODES.filter(code => !["remote_conflict", "outcome_unknown"].includes(code)),
      confirmed_conflict: ["remote_conflict", "selection_changed"], outcome_unknown: ["outcome_unknown"], retry: [null] };
    if (!codes[event].includes(errorCode)) throw transferError("invalid_request");
    let versions = null;
    if (event === "confirmed_conflict") {
      exactObject(conflict, ["localRevision", "remoteRevision"]);
      versions = { localRevision: text(conflict.localRevision), remoteRevision: text(conflict.remoteRevision) };
    } else if (conflict !== null) throw transferError("invalid_request");
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || operation.attemptId !== attemptId || operation.partialAcknowledgment) throw transferError("invalid_transition");
      // A pre-write observation loses authority once another worker starts this step.
      if (unstartedStep && operation.steps[unstartedStep] && operation.steps[unstartedStep].outcome !== "not-applied") {
        return withId(operationId, operation);
      }
      if (operation.lastEvent === event) {
        if (operation.errorCode !== errorCode || (versions &&
            (operation.conflict?.localRevision !== versions.localRevision || operation.conflict?.remoteRevision !== versions.remoteRevision))) {
          throw transferError("invalid_transition");
        }
        return withId(operationId, operation);
      }
      const hasCompletedSteps = Object.values(operation.steps).some(step => step.outcome === "complete");
      const hasUnknownSteps = Object.values(operation.steps).some(step => step.outcome === "unknown");
      if ((operation.state === "queued" && operation.attemptId !== null && event !== "retry") || (hasUnknownSteps && event === "retry")) {
        throw transferError("invalid_transition");
      }
      const uncertain = hasUnknownSteps && ["confirmed_failure", "confirmed_conflict"].includes(event);
      const state = uncertain ? "reconciliation" : transition(operation.state, event, operation.errorCode, hasCompletedSteps);
      const release = !hasCompletedSteps && !hasUnknownSteps && (state === "conflict" || (state === "failed" && errorCode !== "transient_failure"));
      let mappingRef, mapping;
      if (release && operation.mappingCheck) {
        mappingRef = firestore.collection(MAPPINGS).doc(operation.mappingCheck.mappingId);
        mapping = (await tx.get(mappingRef)).data();
      }
      const patch = { state, lastEvent: uncertain ? "outcome_unknown" : event, updatedAt: stamp(),
        errorCode: uncertain ? "outcome_unknown" : errorCode,
        finishedAt: ["failed", "conflict"].includes(state) ? stamp() : null };
      if (versions) patch.conflict = { ...versions, selectionSnapshot: operation.selectionSnapshot,
        resolvedSelection: operation.resolvedSelection, remoteIdentity: operation.remoteIdentity,
        remoteChangeMarker: operation.remoteChangeMarker };
      if (mapping?.pendingOperationId === operationId) {
        if (mapping.lastOperationId) tx.update(mappingRef, { pendingOperationId: null });
        else tx.delete(mappingRef);
      }
      tx.update(reference, patch);
      return withId(operationId, { ...operation, ...patch });
    });
  }

  async function acknowledgePartial({ operationId, attemptId, acknowledgedBy }) {
    if (typeof acknowledgedBy !== "string" || !ID_PATTERN.test(acknowledgedBy)) throw transferError("invalid_request");
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || operation.attemptId !== attemptId) throw transferError("invalid_transition");
      if (operation.partialAcknowledgment) {
        if (operation.partialAcknowledgment.acknowledgedBy !== acknowledgedBy) throw transferError("invalid_transition");
        return withId(operationId, operation);
      }
      if (operation.direction !== "export" || operation.selectionSnapshot.target.kind !== "new-story" ||
          !["failed", "conflict"].includes(operation.state) || !operation.mappingCheck) throw transferError("invalid_transition");
      const steps = Object.entries(operation.steps);
      if (steps.some(([, step]) => !["complete", "not-applied"].includes(step.outcome))) throw transferError("invalid_transition");
      const stories = steps.filter(([, step]) => step.outcome === "complete" && ["stories_create", "stories_update"].includes(step.tool));
      if (stories.length !== 1 || !stories[0][1].remoteIdentity || !stories[0][1].remoteChangeMarker) throw transferError("invalid_transition");
      const story = stories[0][1];
      const { mappingId, ...association } = mappingIdentity(operation);
      const mappingRef = firestore.collection(MAPPINGS).doc(mappingId);
      const previous = (await tx.get(mappingRef)).data();
      if (operation.mappingCheck.mappingId !== mappingId || previous?.pendingOperationId !== operationId ||
          (previous.lastOperationId ?? null) !== operation.mappingCheck.expectedMappingOperationId ||
          (previous.externalId && previous.externalId !== story.remoteIdentity)) throw transferError("invalid_transition");
      const time = stamp();
      const partialAcknowledgment = { acknowledgedBy, acknowledgedAt: time,
        completedStepIds: steps.filter(([, step]) => step.outcome === "complete").map(([id]) => id).sort() };
      const marker = { ...operation.origin, mappingId: operation.origin.mappingId ?? mappingId };
      // Adopt the confirmed story without declaring the unfinished export complete.
      const mapping = { ...association, workspaceId: operation.selectionSnapshot.workspaceId,
        externalId: story.remoteIdentity, lastRemoteRevision: story.remoteChangeMarker,
        lastLocalRevision: { selectionSnapshot: operation.selectionSnapshot, resolvedSelection: operation.resolvedSelection },
        mappingVersion: operation.selectionSnapshot.mappingVersion, origin: marker, lastOperationId: operationId,
        createdAt: previous.createdAt ?? time, updatedAt: time, pendingOperationId: null, partialAcknowledgment };
      const patch = { mappingId, origin: marker, remoteIdentity: story.remoteIdentity,
        remoteChangeMarker: story.remoteChangeMarker, partialAcknowledgment, updatedAt: time };
      tx.set(mappingRef, mapping);
      tx.update(reference, patch);
      return withId(operationId, { ...operation, ...patch });
    });
  }

  // Reserve the association before network writes, including its first creation.
  async function reserveMapping({ operationId, attemptId, expectedMappingOperationId = null }) {
    if (expectedMappingOperationId !== null) requireId(expectedMappingOperationId);
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || operation.attemptId !== attemptId || operation.direction !== "export" ||
          !["transferring", "reconciliation"].includes(operation.state)) throw transferError("invalid_transition");
      const { mappingId, ...association } = mappingIdentity(operation);
      const mappingRef = firestore.collection(MAPPINGS).doc(mappingId);
      const previous = (await tx.get(mappingRef)).data();
      if ((previous?.lastOperationId ?? null) !== expectedMappingOperationId ||
          (previous?.pendingOperationId && previous.pendingOperationId !== operationId)) {
        const patch = { state: "conflict", errorCode: "remote_conflict", lastEvent: "confirmed_conflict",
          updatedAt: stamp(), finishedAt: stamp(), conflict: { previousMapping: previous ?? null,
            proposed: { selectionSnapshot: operation.selectionSnapshot, resolvedSelection: operation.resolvedSelection } } };
        tx.update(reference, patch);
        return { operation: withId(operationId, { ...operation, ...patch }), mapping: previous ?? null };
      }
      const mappingCheck = { mappingId, expectedMappingOperationId };
      tx.set(mappingRef, { ...previous, ...association, pendingOperationId: operationId }, { merge: true });
      tx.update(reference, { mappingCheck, updatedAt: stamp() });
      return { operation: withId(operationId, { ...operation, mappingCheck }), mapping: previous?.lastOperationId ? previous : null };
    });
  }

  async function beginStep({ operationId, attemptId, step, tool, storyId = null, payloadHash, preImportAssetIds = null }) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(step ?? "") || !["stories_create", "stories_update", "sections_create",
      "sections_update", "assets_import_from_url"].includes(tool)) throw transferError("invalid_request");
    requireId(payloadHash);
    if (storyId !== null) text(storyId);
    if (preImportAssetIds !== null && (!Array.isArray(preImportAssetIds) || preImportAssetIds.length > 10000 ||
        preImportAssetIds.some(id => !text(id)) || new Set(preImportAssetIds).size !== preImportAssetIds.length)) throw transferError("invalid_request");
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || operation.attemptId !== attemptId || !operation.mappingCheck ||
          !["transferring", "reconciliation"].includes(operation.state)) throw transferError("invalid_transition");
      const mapping = (await tx.get(firestore.collection(MAPPINGS).doc(operation.mappingCheck.mappingId))).data();
      if (mapping?.pendingOperationId !== operationId) throw transferError("invalid_transition");
      const previous = operation.steps[step];
      if (previous && (previous.tool !== tool || previous.storyId !== storyId || previous.payloadHash !== payloadHash)) {
        throw transferError("selection_changed");
      }
      if (previous && previous.outcome !== "not-applied") return { step: previous, priorOutcome: previous.outcome };
      if (operation.state !== "transferring" || Object.values(operation.steps).some(item => item.outcome === "unknown")) {
        throw transferError("invalid_transition");
      }
      const progress = { tool, storyId, payloadHash, outcome: "unknown", remoteIdentity: null,
        remoteChangeMarker: null, errorCode: null, preImportAssetIds };
      tx.update(reference, { steps: { ...operation.steps, [step]: progress }, updatedAt: stamp() });
      return { step: progress, priorOutcome: "not-attempted" };
    });
  }

  async function finishStep({ operationId, attemptId, step, outcome, remoteIdentity = null, remoteChangeMarker = null, errorCode = null }) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(step ?? "") || !["complete", "unknown", "not-applied"].includes(outcome)) throw transferError("invalid_request");
    if (remoteIdentity !== null) text(remoteIdentity);
    if (remoteChangeMarker !== null) text(remoteChangeMarker);
    if ((outcome === "complete" && (!remoteIdentity || errorCode !== null)) ||
        (outcome === "unknown" && errorCode !== "outcome_unknown") ||
        (outcome === "not-applied" && (!SAFE_ERROR_CODES.includes(errorCode) || errorCode === "outcome_unknown"))) {
      throw transferError("invalid_request");
    }
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      const previous = operation?.steps?.[step];
      if (!operation || operation.attemptId !== attemptId || !previous ||
          !["transferring", "reconciliation"].includes(operation.state)) throw transferError("invalid_transition");
      if (previous.outcome !== "unknown") {
        if (previous.outcome === outcome && previous.remoteIdentity === remoteIdentity &&
            previous.errorCode === errorCode && (previous.remoteChangeMarker === remoteChangeMarker ||
              (outcome === "complete" && remoteChangeMarker === null))) return previous;
        // A confirmed identity survives a failed revision read; allow its first observation.
        if (!(previous.outcome === "complete" && outcome === "complete" && previous.remoteIdentity === remoteIdentity &&
            previous.remoteChangeMarker === null && remoteChangeMarker !== null && errorCode === null)) throw transferError("invalid_transition");
      }
      const progress = { ...previous, outcome, remoteIdentity, remoteChangeMarker, errorCode };
      tx.update(reference, { steps: { ...operation.steps, [step]: progress }, updatedAt: stamp() });
      return progress;
    });
  }

  async function complete({ operationId, attemptId, remoteIdentity, remoteChangeMarker = null,
    expectedMappingOperationId = null, importedRecord }) {
    text(remoteIdentity);
    if (remoteChangeMarker !== null) text(remoteChangeMarker);
    if (expectedMappingOperationId !== null) requireId(expectedMappingOperationId);
    return firestore.runTransaction(async tx => {
      const reference = ref(operationId);
      const operation = (await tx.get(reference)).data();
      if (!operation || operation.attemptId !== attemptId) throw transferError("invalid_transition");
      if (operation.state === "complete" && operation.remoteIdentity === remoteIdentity && operation.remoteChangeMarker === remoteChangeMarker) {
        return withId(operationId, operation);
      }
      const state = transition(operation.state, "confirmed_complete");
      const identity = mappingIdentity(operation, importedRecord);
      const mappingRef = firestore.collection(MAPPINGS).doc(identity.mappingId);
      const previous = (await tx.get(mappingRef)).data();
      if (operation.direction === "export" && (!operation.mappingCheck || previous?.pendingOperationId !== operationId ||
          operation.mappingCheck.expectedMappingOperationId !== expectedMappingOperationId ||
          Object.values(operation.steps).some(step => step.outcome !== "complete"))) throw transferError("invalid_transition");
      if (operation.direction === "export" && ["new-story", "dossier"].includes(identity.objectType) && !remoteChangeMarker) {
        throw transferError("invalid_request");
      }
      if ((previous?.lastOperationId ?? null) !== expectedMappingOperationId ||
          (previous?.externalId && previous.externalId !== remoteIdentity && identity.objectType !== "story-asset")) {
        const patch = { state: transition(operation.state, "confirmed_conflict"), errorCode: "remote_conflict",
          updatedAt: stamp(), finishedAt: stamp(), lastEvent: "confirmed_conflict",
          conflict: { previousMapping: previous ?? null, proposed: { remoteIdentity, remoteChangeMarker,
            selectionSnapshot: operation.selectionSnapshot, resolvedSelection: operation.resolvedSelection } } };
        tx.update(reference, patch);
        return withId(operationId, { ...operation, ...patch });
      }
      const { mappingId, ...association } = identity;
      const marker = { ...operation.origin, mappingId: operation.origin.mappingId ?? mappingId };
      const lastLocalRevision = operation.direction === "import" ? identityObject(importedRecord, SHAPES.record)
        : { selectionSnapshot: operation.selectionSnapshot, resolvedSelection: operation.resolvedSelection };
      const mapping = { ...association, workspaceId: operation.selectionSnapshot.workspaceId,
        externalId: remoteIdentity, lastLocalRevision, lastRemoteRevision: remoteChangeMarker,
        mappingVersion: operation.selectionSnapshot.mappingVersion, origin: marker, lastOperationId: operationId,
        createdAt: previous?.createdAt ?? stamp(), updatedAt: stamp(), pendingOperationId: null };
      const patch = { state, mappingId, origin: marker, remoteIdentity, remoteChangeMarker,
        ...(operation.direction === "import" ? { lastLocalRevision } : {}),
        errorCode: null, updatedAt: stamp(), finishedAt: stamp(), lastEvent: "confirmed_complete" };
      tx.set(mappingRef, mapping);
      tx.update(reference, patch);
      return withId(operationId, { ...operation, ...patch });
    });
  }

  async function read(operationId) {
    const snapshot = await ref(operationId).get();
    return snapshot.exists ? withId(snapshot.id, snapshot.data()) : null;
  }

  // Join the validated Post owner's transaction so the draft and receipt cannot diverge.
  async function prepareImportCommit({ transaction: tx, operationId, attemptId, recordId,
    expectedMappingOperationId, draftHash, sourceAttribution }) {
    const reference = ref(operationId);
    const operation = (await tx.get(reference)).data();
    if (!operation || operation.direction !== "import" || operation.state !== "transferring" ||
        operation.attemptId !== attemptId) throw transferError("invalid_transition");
    const identity = mappingIdentity(operation, { collection: "cmsPosts", recordId, version: 1, updateTime: "new" });
    const mappingRef = firestore.collection(MAPPINGS).doc(identity.mappingId);
    const previous = (await tx.get(mappingRef)).data();
    const draftRef = firestore.collection("cmsPosts").doc(recordId);
    const draft = (await tx.get(draftRef)).data();
    const unchanged = previous ? draft && draftHash(draft) === previous.lastLocalRevision?.draftHash : !draft;
    const privateDraft = !draft || (draft.status === "draft" && !draft.published && !draft.deleted);
    if ((previous?.lastOperationId ?? null) !== expectedMappingOperationId || !unchanged || !privateDraft) {
      const conflict = { previousMapping: previous ?? null, proposed: { selectionSnapshot: operation.selectionSnapshot,
        localRevision: draft ? draftHash(draft) : "absent", remoteRevision: operation.selectionSnapshot.remoteChangeMarker } };
      const patch = { state: "conflict", errorCode: "remote_conflict", lastEvent: "confirmed_conflict", conflict,
        updatedAt: stamp(), finishedAt: stamp() };
      tx.update(reference, patch);
      return { operation: withId(operationId, { ...operation, ...patch }), commit: null };
    }
    return { operation: withId(operationId, operation), draft,
      commit(document) {
        if (document.id !== recordId || document.type !== "post" || document.status !== "draft" ||
            document.published || !Number.isSafeInteger(document.version)) throw transferError("invalid_transition");
        const { mappingId, ...association } = identity;
        const marker = { ...operation.origin, mappingId: operation.origin.mappingId ?? mappingId };
        const persisted = { ...document, cuezOrigin: marker };
        const remoteIdentity = operation.selectionSnapshot.storyId;
        const remoteChangeMarker = operation.selectionSnapshot.remoteChangeMarker;
        const mapping = { ...association, workspaceId: operation.selectionSnapshot.workspaceId, externalId: remoteIdentity,
          lastLocalRevision: { record: { collection: "cmsPosts", recordId, version: document.version }, draftHash: draftHash(persisted) },
          lastRemoteRevision: remoteChangeMarker, mappingVersion: operation.selectionSnapshot.mappingVersion,
          origin: marker, lastOperationId: operationId, pendingOperationId: null, sourceAttribution,
          createdAt: previous?.createdAt ?? stamp(), updatedAt: stamp() };
        const patch = { state: transition(operation.state, "confirmed_complete"), mappingId, origin: marker,
          importedRecord: { collection: "cmsPosts", recordId, version: document.version },
          remoteIdentity, remoteChangeMarker, sourceAttribution, errorCode: null, lastEvent: "confirmed_complete",
          updatedAt: stamp(), finishedAt: stamp() };
        tx.update(draftRef, { cuezOrigin: marker });
        tx.set(mappingRef, mapping);
        tx.update(reference, patch);
        return withId(operationId, { ...operation, ...patch });
      } };
  }

  return { enqueue, claim, advance, acknowledgePartial, reserveMapping, beginStep, finishStep, complete, read, prepareImportCommit };
}

module.exports = { OPERATIONS, MAPPINGS, mappingIdentity, createTransferOperations };
