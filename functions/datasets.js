"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { principalFromUserDoc, registeredPrincipalFromUserDoc } = require("./lib/principal");
const { accessTierReadsActive, userDocUsesAccessTier } = require("./lib/access-tier-activation");
const { can, canEditContent } = require("./lib/rbac");
const { mayReachContentRead } = require("./lib/content-authorization");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { readApprovedDatasetProjection } = require("./lib/dataset-dependencies");
const { captureDatasetRefresh, affectedUse } = require("./lib/dataset-refresh");
const { DATASET_COLLECTION, MAX_DATASET_BYTES, DatasetError, validDatasetId, validateDatasetRelease } = require("./lib/datasets");

const MUTATION_ACTIONS = Object.freeze(["assign", "save", "review", "approve", "archive"]);
const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => hash(JSON.stringify(canonical(value)));
const fail = (message, status = 400) => { throw new DatasetError(message, status); };
const resource = record => ({ ownerId: record.ownerUid, unassignedDraft: true });
function summary(id, record, principal) {
  return { id, title: record.title, ownerUid: record.ownerUid, ownerName: record.ownerName ?? "Staff owner", version: record.version,
    state: record.state, archived: record.archived, approvedReleaseId: record.approvedReleaseId,
    updatedAt: record.updatedAt, canEdit: !record.archived && canEditContent(principal, resource(record)),
    canApprove: !record.archived && can(principal, "datasets.approve", {}) };
}
async function staffPrincipal(firestore, transaction, actor) {
  if (!validDatasetId(actor?.uid)) fail("An active staff account is required.", 403);
  const user = await transaction.get(firestore.doc(`users/${actor.uid}`));
  const profile = user.data();
  const tiersActive = await userDocUsesAccessTier(firestore, profile, transaction);
  if (!user.exists || profile.active === false || (tiersActive && actor.emailVerified !== true)) fail("An active staff account is required.", 403);
  const principal = await registeredPrincipalFromUserDoc(firestore, actor.uid, profile, transaction, tiersActive);
  if (!mayReachContentRead(principal)) fail("Editorial access is required.", 403);
  return { ...principal, displayName: typeof profile.displayName === "string" ? profile.displayName.slice(0, 120) : "Staff owner" };
}
function parseRequest(body) {
  const allowed = {
    list: ["action", "cursor", "approvedOnly"], get: ["action", "id"], releases: ["action", "id", "cursor"],
    release: ["action", "id", "releaseId"], figure: ["action", "id", "version"], refresh: ["action", "id"], retry: ["action", "id"],
    owners: ["action", "cursor"],
    assign: ["action", "id", "baseVersion", "requestId", "ownerUid"],
    save: ["action", "id", "baseVersion", "requestId", "title", "release", "releaseId"],
    review: ["action", "id", "baseVersion", "requestId"],
    approve: ["action", "id", "baseVersion", "requestId", "expectedUseCount"],
    archive: ["action", "id", "baseVersion", "requestId", "expectedUseCount"],
  };
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(allowed, body.action)) fail("Choose a dataset action.");
  if (Object.keys(body).some(key => !allowed[body.action].includes(key))) fail("Unknown dataset request field.");
  if (["list", "owners"].includes(body.action)) {
    if (body.cursor !== undefined && !validDatasetId(body.cursor)) fail("Choose a valid dataset page.");
    if (body.approvedOnly !== undefined && typeof body.approvedOnly !== "boolean") fail("approvedOnly must be a boolean.");
    return body;
  }
  if (!(body.action === "save" && body.id === undefined) && !validDatasetId(body.id)) fail("Choose a valid dataset.");
  if (body.action === "releases" && body.cursor !== undefined && !validDatasetId(body.cursor)) fail("Choose a valid reporting-release page.");
  if (body.action === "release" && !validDatasetId(body.releaseId)) fail("Choose a valid reporting release.");
  if (["get", "releases", "release", "figure", "refresh", "retry"].includes(body.action)) return body;
  if (!validDatasetId(body.requestId) || body.requestId.length < 16) fail("Use a unique request id.");
  if (body.id !== undefined && (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1)) fail("Reload the dataset before changing it.");
  if (body.id === undefined && body.baseVersion !== undefined) fail("A new dataset has no base version.");
  if (body.action === "save") {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 300) fail("Use a dataset title of 1 to 300 characters.");
    validateDatasetRelease(body.release);
    if (body.releaseId !== undefined && !validDatasetId(body.releaseId)) fail("Choose a valid reporting release.");
    if (body.release.changeKind === "new_release" && body.releaseId !== undefined) fail("New reporting release ids are assigned by the server.");
  }
  if (["approve", "archive"].includes(body.action) && (!Number.isSafeInteger(body.expectedUseCount) || body.expectedUseCount < 0)) fail("Review the affected use count before approval.");
  if (body.action === "assign" && !validDatasetId(body.ownerUid)) fail("Choose a staff owner.");
  return body;
}
/** Approval never reads a working Page/Post or publishes its newer edits. */
async function mutateDataset(firestore, actor, request) {
  if (!MUTATION_ACTIONS.includes(request.action)) fail("Choose a dataset action.");
  const id = request.id ?? hash(`${actor.uid}:${request.requestId}`).slice(0, 32);
  const ref = firestore.collection(DATASET_COLLECTION).doc(id);
  const receiptRef = ref.collection("requests").doc(hash(`${actor.uid}:${request.requestId}`));
  return firestore.runTransaction(async transaction => {
    const principal = await staffPrincipal(firestore, transaction, actor);
    const before = (await transaction.get(ref)).data();
    if (!before && request.id !== undefined) fail("This dataset is unavailable.", 404);
    if (!before && !can(principal, "content.create", { ownerId: actor.uid, unassignedDraft: true })) fail("You cannot create datasets.", 403);
    if (before && !canEditContent(principal, resource(before))) fail("You cannot change this dataset.", 403);
    if (request.action === "assign" && !can(principal, "content.edit.any", {})) fail("Global editorial access is required to change an owner.", 403);
    if (["approve", "archive"].includes(request.action) && !can(principal, "datasets.approve", {})) fail("Dataset approval permission is required.", 403);
    const receipt = (await transaction.get(receiptRef)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint(request) || before?.version !== receipt.version) fail("The request or dataset changed. Reload it.", 409);
      return { dataset: { ...summary(id, before, principal), ...before, id }, replayed: true };
    }
    if (["approve", "archive"].includes(request.action) && before?.refreshJobId) {
      const refresh = (await transaction.get(firestore.doc(`cmsDatasetRefreshJobs/${before.refreshJobId}`))).data();
      if (refresh?.status !== "success") fail("Complete the current dataset refresh before another approval or archive.", 409);
    }
    if (before?.archived) fail("This dataset is archived. Its history is retained.", 409);
    if (before && (request.id === undefined || before.version !== request.baseVersion)) fail("This dataset changed. Reload it before saving.", 409);
    let after = { ...before, title: before?.title ?? request.title.trim(), ownerUid: before?.ownerUid ?? actor.uid,
      ownerName: before?.ownerName ?? principal.displayName,
      version: (before?.version ?? 0) + 1, archived: false, approvedReleaseId: before?.approvedReleaseId ?? null,
      updatedBy: actor.uid, updatedAt: new Date().toISOString() };
    if (request.action === "assign") {
      const profile = (await transaction.get(firestore.doc(`users/${request.ownerUid}`))).data();
      const tiersActive = await userDocUsesAccessTier(firestore, profile, transaction);
      const target = await registeredPrincipalFromUserDoc(firestore, request.ownerUid, profile, transaction, tiersActive);
      if (!profile || profile.active === false || !can(target, "content.create", { ownerId: request.ownerUid, unassignedDraft: true })) fail("Choose an active staff author.");
      after.ownerUid = request.ownerUid;
      after.ownerName = typeof profile.displayName === "string" ? profile.displayName.slice(0, 120) : "Staff owner";
    }
    if (request.action === "save") {
      let releaseId = before?.state !== "approved" ? before?.workingReleaseId : undefined;
      if (request.release.changeKind === "correction") {
        releaseId = request.releaseId ?? (before?.workingRelease?.changeKind === "correction" ? before.workingReleaseId : before?.approvedReleaseId);
        if (!validDatasetId(releaseId)) fail("Select an approved reporting release to correct.");
        const release = (await transaction.get(ref.collection("releases").doc(releaseId))).data();
        if (!release || !Number.isSafeInteger(release.approvedRevision)) fail("This reporting release is not approved.", 409);
      } else if (before?.workingRelease?.changeKind === "correction") releaseId = undefined;
      after = { ...after, title: request.title.trim(), state: "draft", workingRelease: request.release,
        workingReleaseId: releaseId ?? randomUUID() };
    }
    if (request.action === "review") {
      if (before.state !== "draft") fail("Save a draft before requesting review.", 409);
      validateDatasetRelease(before.workingRelease, { complete: true });
      after.state = "review";
    }
    if (["approve", "archive"].includes(request.action)) {
      let refresh;
      if (request.action === "approve") {
        if (before.state !== "review") fail("Request review before approval.", 409);
        validateDatasetRelease(before.workingRelease, { complete: true });
        const releaseRef = ref.collection("releases").doc(before.workingReleaseId);
        const prior = (await transaction.get(releaseRef)).data();
        if (before.workingRelease.changeKind === "new_release" && prior) fail("This reporting release already exists.", 409);
        if (before.workingRelease.changeKind === "correction" && !prior) fail("The reporting release is unavailable.", 409);
        const revision = (prior?.approvedRevision ?? 0) + 1;
        const digest = fingerprint(before.workingRelease);
        refresh = await captureDatasetRefresh({ firestore, transaction, datasetId: id,
          action: before.workingRelease.changeKind, releaseId: releaseRef.id, revision, approvedDigest: digest,
          expectedUseCount: request.expectedUseCount, requestId: request.requestId });
        transaction.create(releaseRef.collection("revisions").doc(String(revision)), {
          release: before.workingRelease, datasetId: id, releaseId: releaseRef.id, revision, digest,
          approvedBy: actor.uid, approvedAt: after.updatedAt,
        });
        transaction.set(releaseRef, { approvedRevision: revision, approvedDigest: digest,
          period: before.workingRelease.period, releasedOn: before.workingRelease.releasedOn, label: before.workingRelease.label });
        after.state = "approved";
        if (before.workingRelease.changeKind === "new_release") after.approvedReleaseId = releaseRef.id;
      } else {
        refresh = await captureDatasetRefresh({ firestore, transaction, datasetId: id, action: "archive",
          expectedUseCount: request.expectedUseCount, requestId: request.requestId });
        after.archived = true;
      }
      after.refreshJobId = refresh.ref.id;
      after.refreshStatus = refresh.job.status;
      refresh.write();
    }
    transaction.set(ref, after);
    transaction.create(receiptRef, { fingerprint: fingerprint(request), version: after.version });
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: `dataset.${request.action}`,
      target: ref.path, before: before ? { version: before.version, state: before.state } : null,
      after: { version: after.version, state: after.state, archived: after.archived },
    }));
    return { dataset: { ...after, ...summary(id, after, principal) }, replayed: false };
  });
}
function createDatasetsHandler({ firestore = db, requirePrincipalFn = requirePrincipal } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      validateBoundedJsonRequest(req, MAX_DATASET_BYTES + 4096);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > MAX_DATASET_BYTES + 4096) fail("The dataset request is too large.", 413);
      const request = parseRequest(req.body);
      let result;
      if (["list", "get", "releases", "release", "owners", "figure", "refresh", "retry"].includes(request.action)) {
        result = await firestore.runTransaction(async transaction => {
          const principal = await staffPrincipal(firestore, transaction, actor);
          const datasets = firestore.collection(DATASET_COLLECTION);
          if (request.action === "owners") {
            if (!can(principal, "content.edit.any", {})) fail("Global editorial access is required to choose an owner.", 403);
            let query = firestore.collection("users").orderBy("__name__").limit(51);
            if (request.cursor) query = query.startAfter(request.cursor);
            const rows = await transaction.get(query);
            const owners = [];
            const tiersActive = rows.docs.some(row => Object.hasOwn(row.data(), "accessTier"))
              ? await accessTierReadsActive(firestore, transaction) : false;
            for (const row of rows.docs.slice(0, 50)) {
              const profile = row.data();
              const target = principalFromUserDoc(row.id, profile, tiersActive);
              if (profile.active !== false && can(target, "content.create", { ownerId: row.id, unassignedDraft: true })) owners.push({
                uid: row.id, name: typeof profile.displayName === "string" ? profile.displayName.slice(0, 120) : "Staff owner",
              });
            }
            return { owners, nextCursor: rows.size > 50 ? rows.docs[49].id : null };
          }
          if (request.action === "list") {
            let query = datasets.orderBy("__name__").limit(51);
            if (request.cursor) query = query.startAfter(request.cursor);
            const rows = await transaction.get(query);
            return { datasets: rows.docs.slice(0, 50).filter(row => !request.approvedOnly ||
              (!row.data().archived && row.data().approvedReleaseId)).map(row => summary(row.id, row.data(), principal)),
            nextCursor: rows.size > 50 ? rows.docs[49].id : null };
          }
          const ref = datasets.doc(request.id);
          const record = (await transaction.get(ref)).data();
          if (!record) fail("This dataset is unavailable.", 404);
          if (request.action === "figure") return { figure: await readApprovedDatasetProjection({ firestore, transaction, datasetId: request.id, version: request.version }) };
          if (["refresh", "retry"].includes(request.action)) {
            if (request.action === "retry" && (!can(principal, "datasets.approve", {}) || !canEditContent(principal, resource(record)))) fail("Dataset approval permission is required.", 403);
            const refresh = record.refreshJobId ? (await transaction.get(firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`))).data() : null;
            const owners = refresh ? await transaction.get(firestore.collection(`cmsDatasetRefreshJobs/${record.refreshJobId}/owners`).orderBy("__name__").limit(501)) : null;
            return { refresh: refresh ? { id: record.refreshJobId, status: refresh.status, owners: owners.docs.map(row => ({
              title: row.data().capture.ownerTitle ?? "Published content", status: row.data().status, error: row.data().error ?? null })), expectedUseCount: refresh.expectedUseCount,
              expectedOwnerCount: refresh.expectedOwnerCount, verifiedOwnerCount: refresh.verifiedOwnerCount,
              supersededOwnerCount: refresh.supersededOwnerCount, failedOwnerCount: refresh.failedOwnerCount, receipt: refresh.receipt ?? null } : null };
          }
          if (request.action === "release") {
            const releaseRef = ref.collection("releases").doc(request.releaseId);
            const head = (await transaction.get(releaseRef)).data();
            if (!head || !Number.isSafeInteger(head.approvedRevision)) fail("This reporting release is unavailable.", 404);
            const revision = (await transaction.get(releaseRef.collection("revisions").doc(String(head.approvedRevision)))).data();
            if (!revision || revision.digest !== head.approvedDigest || fingerprint(revision.release) !== revision.digest) fail("This reporting release needs repair.", 409);
            return { release: revision.release };
          }
          if (request.action === "releases") {
            let query = ref.collection("releases").orderBy("__name__").limit(101);
            if (request.cursor) query = query.startAfter(request.cursor);
            const releases = await transaction.get(query);
            return { releases: releases.docs.slice(0, 100).map(row => ({ id: row.id, ...row.data() })), hasMore: releases.size > 100,
              nextCursor: releases.size > 100 ? releases.docs[99].id : null };
          }
          const uses = await transaction.get(firestore.collection("cmsDatasetUses").where("datasetId", "==", ref.id).limit(501));
          if (uses.size > 500) fail("This dataset exceeds the supported use count.", 409);
          return { dataset: { ...record, ...summary(ref.id, record, principal) }, useCount: uses.size,
            affectedUseCount: uses.docs.filter(row => affectedUse(row.data(), record.workingRelease.changeKind, record.workingReleaseId)).length,
            uses: uses.docs.map(row => { const use = row.data(); return { title: use.ownerTitle ?? "Published content", publicPath: use.publicPath,
              policy: use.releasePolicy === "pinned" ? "Pinned release" : "Latest approved release" }; }) };
        });
      } else result = await mutateDataset(firestore, actor, request);
      if (request.action === "retry" && result.refresh) await require("./lib/dataset-refresh").retryDatasetRefreshJob({ firestore, jobId: result.refresh.id, actor });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error("Dataset request failed", { code: Number.isInteger(error.code) && error.code >= 0 && error.code <= 16 ? error.code : typeof error.code === "string" && /^[a-z0-9_/-]{1,80}$/i.test(error.code) ? error.code : "unknown" });
      return res.status(status).json({ error: status >= 500 ? "Datasets are unavailable. Try again." : error.message });
    }
  };
}
module.exports = { MUTATION_ACTIONS, createDatasetsHandler, mutateDataset, parseRequest, fingerprint,
  cmsDatasets: cmsOnRequest({ cors: true }, createDatasetsHandler()) };
