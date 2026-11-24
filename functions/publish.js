"use strict";

const { existingNoBuildPostPublication } = require("./lib/no-build-post-recovery");
const { assertRequestedLibraryPublicationAvailable } = require("./lib/frozen-library-publication");
const { assertSerializerPublicationEnabledInTransaction } = require("./lib/serializer-publication-control");
const { existingNoBuildPagePublication } = require("./lib/no-build-page-recovery");

const { cmsOnRequest } = require("./lib/cms-edge");
const { isDeepStrictEqual } = require("node:util");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { admin, db } = require("./lib/firebase");
const { FieldValue: FirestoreFieldValue } = require("firebase-admin/firestore");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { contentResourceSection } = require("./lib/content-authorization");
// Publish needs the billing decision only. Importing the Pub/Sub alert wiring would
// also declare BILLING_ALERT_TOKEN during Firebase source discovery and make this
// HTTPS transport depend on an unrelated notification secret. Keep the deployable
// boundary on the secret-free state reader, as the preview transport already does.
const { assertBillingEnabled } = require("./lib/billing-state");
const { logAdminAction } = require("./lib/audit");
const {
  addressedPublishChanges,
  isConfirmedPublishChange,
  isPendingPublishChange,
  markBuildEnqueuedInTransaction,
  settleBuildQueue,
} = require("./lib/publish-build-state");
const {
  enqueueSerializerBuild,
} = require("./lib/cms-publish-serializer-queue");
const {
  assertPublishedMediaSafe,
} = require("./lib/published-media-safety");
const {
  runtimeCandidate,
  tryRuntimePublication,
} = require("./lib/public-runtime-publication");
const { reservePublicationRetry } = require("./lib/publication-recovery");
const {
  assertCmsPublicationAdmission,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./lib/cms-publication-runtime-control");

const FieldValue = admin.firestore.FieldValue || FirestoreFieldValue;
const { publishSecretBindings, readDevAppCredentials } =
  require("./lib/cms-publish-credentials");
const { AppTokenError, createInstallationTokenProvider } = require("./lib/cms-dev-publish-app");
const { publishGithubRepository } = require("./lib/cms-publish-repository");
const { newDevGithubQueueFields } = require("./lib/dev-publication-queue");
const getInstallationToken = createInstallationTokenProvider();
const PUBLISH_TRANSPORT = defineString("CMS_PUBLISH_TRANSPORT", {
  default: "serializer",
});
const CMS_WRITEBACK_CONFIGURED = defineString("CMS_WRITEBACK_CONFIGURED", {
  default: "false",
});
const GITHUB_TRANSPORT = "github";
const SERIALIZER_TRANSPORT = "serializer";

function defaultDispatchUrl() {
  return `https://api.github.com/repos/${publishGithubRepository()}/dispatches`;
}
const { routePurgeSecretNames } = require("./lib/post-route-purge");

const { buildDispatchPayload } = require("./lib/cms-publish-dispatch");
const QUEUE_COLLECTION = "cmsPublishQueue";
const WRITEBACK_NOT_CONFIRMED_ERROR =
  "publish pipeline is not fully configured: writeback credential not confirmed";
const PUBLISH_TOKEN_NOT_CONFIGURED_ERROR =
  "publish pipeline is not fully configured: publish token not configured";
const INVALID_PUBLISH_TRANSPORT_ERROR =
  "publish pipeline is not fully configured: publish transport is invalid";

function defaultPublishTransport() {
  return PUBLISH_TRANSPORT.value() || SERIALIZER_TRANSPORT;
}

function resolvePublishTransport(value) {
  const transport = typeof value === "function" ? value() : value;
  const requiredTransport = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development"
    ? GITHUB_TRANSPORT : SERIALIZER_TRANSPORT;
  if (transport === requiredTransport) {
    return transport;
  }
  throw failedPrecondition(INVALID_PUBLISH_TRANSPORT_ERROR);
}

function defaultWritebackConfigured() {
  return CMS_WRITEBACK_CONFIGURED.value() === "true";
}

function resolveWritebackConfigured(value) {
  return typeof value === "function" ? value() : value;
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

async function dispatchPublish({
  token,
  url,
  payload,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("Development publication App token unavailable");
  url ??= defaultDispatchUrl();

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "njpbs-cms-publish",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Development GitHub dispatch unavailable");
  }

  if (!response.ok) {
    return {
      dispatched: false,
      status: response.status,
      error: "Development GitHub dispatch rejected",
    };
  }

  return { dispatched: true, status: response.status };
}

function failedPrecondition(message) {
  const err = new Error(message);
  err.code = "failed-precondition";
  return err;
}

async function assertPublishReady(fields = {}, deps = {}) {
  const {
    firestore = fields.firestore ?? db,
    assertBillingEnabledFn = assertBillingEnabled,
    getDevCredentials = readDevAppCredentials,
    getTransport = defaultPublishTransport,
    isWritebackConfigured = defaultWritebackConfigured,
  } = deps;

  const transport = resolvePublishTransport(getTransport);
  // GitHub admission must precede reconciliation and credential reads.
  if (transport === GITHUB_TRANSPORT && deps.dispatchUrl === undefined) defaultDispatchUrl();
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ||
      [process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].includes("njpbs-site-dev")) {
    buildDispatchPayload({ queueId: "preflight", triggeredBy: "preflight" });
  }

  // The transport is metered and the queue requires terminal writeback, so all
  // readiness gates run before a caller mutates lifecycle state or creates a row.
  await assertBillingEnabledFn(firestore);

  if (transport === SERIALIZER_TRANSPORT) {
    return { transport };
  }

  try {
    getDevCredentials();
  } catch {
    throw failedPrecondition(PUBLISH_TOKEN_NOT_CONFIGURED_ERROR);
  }
  if (!resolveWritebackConfigured(isWritebackConfigured)) {
    throw failedPrecondition(WRITEBACK_NOT_CONFIRMED_ERROR);
  }
  return { transport };
}

class PublishDispatchError extends Error {
  constructor(message, { status = 500, queueId = null, publicMessage } = {}) {
    super(message);
    this.name = "PublishDispatchError";
    this.status = status;
    this.queueId = queueId;
    this.publicMessage = publicMessage ?? message;
  }
}

async function enqueuePublishBuild(fields, deps = {}) {
  const {
    firestore = db,
    logAdminActionFn = logAdminAction,
    fetchImpl = fetch,
    dispatchUrl,
    log = logger,
    assertPublishedMediaSafeFn = assertPublishedMediaSafe,
  } = deps;
  const {
    actor,
    changes = [],
    source = null,
    readiness: providedReadiness,
    queueId = null,
    queueReserved = false,
    requireExactPendingChanges = false,
    assertInTransactionFn = null,
  } = fields;
  if (!actor?.uid) throw new Error("enqueuePublishBuild requires an actor");
  if (
    queueId !== null &&
    (typeof queueId !== "string" || queueId.length === 0)
  ) {
    throw new Error("enqueuePublishBuild queueId must be a non-empty string");
  }
  if (queueReserved && queueId === null) {
    throw new Error("enqueuePublishBuild requires queueId for a reserved queue");
  }

  const readiness =
    providedReadiness ??
    (await assertPublishReady({ firestore }, { ...deps, firestore }));
  // The build reads every admitted public page, not only the revisions named in
  // this request. Check the bounded canonical registry before creating a queue
  // row so a snapshot stored before the seed-only source fence cannot leak an
  // uploaded asset through an unrelated later dispatch.
  await assertPublishedMediaSafeFn({ firestore });
  const transport = resolvePublishTransport(
    readiness.transport ?? defaultPublishTransport,
  );
  if (transport === SERIALIZER_TRANSPORT) {
    return enqueueSerializerBuild({
      firestore,
      actor,
      changes,
      source,
      queueId,
      queueReserved,
      adminLogEntryFn: deps.adminLogEntryFn,
      markBuildEnqueuedInTransactionFn:
        deps.markBuildEnqueuedInTransactionFn,
      requireExactPendingChanges,
      assertInTransactionFn,
    });
  }
  const githubDispatchUrl = dispatchUrl ?? defaultDispatchUrl();
  let queueRef;
  let queueOwned = false;
  let terminalFailureWritten = false;

  try {
    queueRef = queueId
      ? firestore.collection(QUEUE_COLLECTION).doc(queueId)
      : firestore.collection(QUEUE_COLLECTION).doc();
    const payload = buildDispatchPayload({
      queueId: queueRef.id,
      triggeredBy: actor.email ?? actor.uid,
    });
    const queue = {
      status: "pending",
      transport: GITHUB_TRANSPORT,
      triggeredBy: actor.uid,
      triggeredByEmail: actor.email ?? null,
      triggeredAt: FieldValue.serverTimestamp(),
      completedAt: null,
      error: null,
      changes: Array.isArray(changes) ? changes : [],
    };
    if (queueReserved) {
      queueOwned = await firestore.runTransaction(async (transaction) => {
        await require("./lib/public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
        // Exact prior reservations can finish across a runtime-pin pause.
        // The initial-install fence above is separate and requires a complete
        // queue drain before it can close.
        await readCmsPublicationRuntimeControlInTransaction({
          firestore,
          transaction,
        });
        const snapshot = await transaction.get(queueRef);
        const existing = snapshot.exists ? snapshot.data() : null;
        if (!existing || existing.transport !== queue.transport ||
            !isDeepStrictEqual(existing.changes, queue.changes)) {
          throw new PublishDispatchError("The reserved publication does not match this request.", { status: 409 });
        }
        if (existing.status !== "reserved") return false;
        await assertRequestedLibraryPublicationAvailable({ firestore, transaction, changes });
        const writeReserved = assertInTransactionFn ? await assertInTransactionFn({ transaction, queue }) : null;
        await markBuildEnqueuedInTransaction(firestore, transaction, { queueId: queueRef.id, changes });
        if (writeReserved) writeReserved();
        transaction.update(queueRef, queue);
        return true;
      });
      if (!queueOwned) return {
        success: true, queueId: queueRef.id, dispatched: false, status: "pending",
        transport, existingBuild: true, message: "This publication is already queued.",
      };
    } else {
      await firestore.runTransaction(async (transaction) => {
        await require("./lib/public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
        const runtimeControl =
          await readCmsPublicationRuntimeControlInTransaction({
            firestore,
            transaction,
          });
        await assertRequestedLibraryPublicationAvailable({ firestore, transaction, changes });
        await assertSerializerPublicationEnabledInTransaction({ firestore, transaction });
        assertCmsPublicationAdmission(runtimeControl);
        Object.assign(queue, await newDevGithubQueueFields({ firestore, transaction,
          control: runtimeControl, transport }));
        const marked = await markBuildEnqueuedInTransaction(firestore, transaction, { queueId: queueRef.id, changes });
        const contentCount = addressedPublishChanges(changes)
          .filter((change) => change.collection !== "cmsSettings").length;
        if (requireExactPendingChanges && marked !== contentCount) {
          throw new PublishDispatchError("The requested publication is no longer pending.", { status: 409 });
        }
        transaction.create(queueRef, queue);
      });
      queueOwned = true;
    }
    await logAdminActionFn({
      actorUid: actor.uid,
      actorEmail: actor.email ?? null,
      action: "cms.publish",
      target: queueRef.id,
      // This append precedes the irreversible external dispatch, so it records
      // the request. The queue row records the outcome.
      after: {
        status: "pending",
        dispatchRequested: true,
        changesCount: Array.isArray(changes) ? changes.length : 0,
      },
      source,
    });

    let dispatchToken;
    try {
      const getDevCredentials = deps.getDevCredentials ?? readDevAppCredentials;
      dispatchToken = await (deps.getDevAppTokenFn ?? getInstallationToken)(getDevCredentials());
    } catch (error) {
      throw new Error(error instanceof AppTokenError
        ? error.message
        : "Development publication App token unavailable");
    }
    const result = await dispatchPublish({
      token: dispatchToken,
      url: githubDispatchUrl,
      payload,
      fetchImpl,
    });
    if (!result.dispatched) {
      const detail =
        `GitHub dispatch failed: ${result.status} ${result.error ?? ""}`.trim();
      await settleBuildQueue(firestore, {
        queueId: queueRef.id,
        status: "failed",
        queueUpdate: {
          status: "failed",
          error: detail,
          completedAt: FieldValue.serverTimestamp(),
        },
      });
      terminalFailureWritten = true;
      log.error("cmsPublish: dispatch failed", {
        queueId: queueRef.id,
        status: result.status,
      });
      throw new PublishDispatchError(detail, {
        status: 502,
        queueId: queueRef.id,
        publicMessage: "Failed to trigger publish build",
      });
    }

    try {
      await firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(queueRef);
        if (current.exists && current.data()?.status === "pending") {
          transaction.update(queueRef, { status: "publishing" });
        }
      });
    } catch (error) {
      // The external dispatch is irreversible. Keep the queue claim and let
      // reconciliation repair the stale pending row.
      log.error("cmsPublish: failed to mark accepted queue publishing", error);
    }
    return {
      success: true,
      queueId: queueRef.id,
      dispatched: true,
      status: "publishing",
      transport: GITHUB_TRANSPORT,
      message: "Publish triggered.",
    };
  } catch (error) {
    if (queueRef && queueOwned && !terminalFailureWritten) {
      try {
        await settleBuildQueue(firestore, {
          queueId: queueRef.id,
          status: "failed",
          queueUpdate: {
            status: "failed",
            completedAt: FieldValue.serverTimestamp(),
            error: error?.message || "Failed to trigger publish",
          },
        });
      } catch (updateError) {
        log.error("cmsPublish: failed to mark queue doc failed", updateError);
      }
    }
    if (error instanceof PublishDispatchError) throw error;
    if (queueRef && error && typeof error === "object") {
      error.queueId = queueRef.id;
    }
    throw error;
  }
}

/**
 * The publish transport's authorization decision (#845).
 *
 * The save path already authorizes a publish against the record's own desk, so a
 * section-scoped editor can commit the published snapshot of a document in their own area.
 * This gate then decides whether the build that makes that snapshot public may be
 * dispatched, and it has to ask the same question against the same document. Asking the
 * unsectioned question instead refused every scoped publisher here -- after their save had
 * already committed -- so the content went live in Firestore and no build ever ran.
 *
 * Settings changes are admitted only for the public homepage banner, the site
 * navigation and the public-site chrome, and require the global settings.manage
 * capability. They need no content-document read.
 * Content then has two authorization tiers, in this order, so the common case
 * costs no reads:
 *
 *   1. Site-wide publish authority covers the whole build, including one that names no
 *      documents at all. That is the scheduler's and the administrator's path.
 *   2. A desk-scoped grant must say which documents it is publishing, and every one of them
 *      must resolve to a desk the grant names. A build that names nothing is a site-wide
 *      act by definition, so a scoped caller cannot ask for one; a change the queue's own
 *      addressing rules would drop is refused rather than waved through unchecked.
 *
 * Read-only and complete before any queue row, audit append or dispatch, so a refusal here
 * changes no state.
 *
 * @returns {Promise<{allowed: boolean, reason: string|null, requireExactPendingChanges?: boolean}>}
 */
async function authorizePublishRequest(
  principal,
  changes,
  firestore,
  { requirePendingState = true } = {},
) {
  const requested = Array.isArray(changes) ? changes : [];
  const addressed = addressedPublishChanges(requested);
  const requestedSettings = requested.filter(
    (change) => change?.collection === "cmsSettings",
  );
  const addressedSettings = addressed.filter(
    (change) => change.collection === "cmsSettings",
  );
  if (requestedSettings.length !== addressedSettings.length) {
    return {
      allowed: false,
      reason: "a settings publish must address a public site setting",
    };
  }
  if (
    requestedSettings.length > 0 &&
    !can(principal, "settings.manage", {})
  ) {
    return {
      allowed: false,
      reason: "settings.manage is required to publish settings",
    };
  }

  const requestedContent = requested.filter(
    (change) => change?.collection !== "cmsSettings",
  );
  if (requestedContent.length === 0 && requestedSettings.length > 0) {
    return { allowed: true, reason: null };
  }
  if (can(principal, "content.publish", {})) {
    return { allowed: true, reason: null };
  }
  const addressedContent = addressed.filter(
    (change) => change.collection !== "cmsSettings",
  );
  if (requestedContent.length === 0) {
    return can(principal, "content.publish", {})
      ? { allowed: true, reason: null }
      : {
          allowed: false,
          reason: "content.publish is required for a site-wide build",
        };
  }
  if (
    addressedContent.length === 0 ||
    addressedContent.length !== requestedContent.length
  ) {
    return {
      allowed: false,
      reason:
        "a publish must address each document it publishes",
    };
  }

  for (const change of addressedContent) {
    const snapshot = await firestore
      .collection(change.collection)
      .doc(change.id)
      .get();
    if (!snapshot.exists) {
      return {
        allowed: false,
        reason: `${change.collection}/${change.id} does not exist`,
      };
    }
    const stored = snapshot.data();
    const resource = {
      ownerId: stored?.createdBy,
      section: contentResourceSection({
        collection: change.collection,
        documentId: change.id,
        stored,
      }),
    };
    if (!can(principal, "content.publish", resource)) {
      return {
        allowed: false,
        reason: `${change.collection}/${change.id} is outside this grant's publish scope`,
      };
    }
    if (
      requirePendingState &&
      !isPendingPublishChange(stored, change) &&
      !isConfirmedPublishChange(stored, change)
    ) {
      return {
        allowed: false,
        reason: `${change.collection}/${change.id} is not an exact pending publication`,
      };
    }
  }

  return { allowed: true, reason: null, requireExactPendingChanges: true };
}

function createCmsPublishHandler(deps = {}) {
  // `requireAdminFn` remains as a test seam for older unit callers. Production
  // resolves the full principal and authorizes the publish capability instead
  // of requiring an administrative role name.
  const requirePrincipalFn =
    deps.requirePrincipalFn ?? deps.requireAdminFn ?? requirePrincipal;
  const trustsLegacyAdminSeam =
    deps.requireAdminFn !== undefined && deps.requirePrincipalFn === undefined;
  const { log = logger } = deps;
  const tryRuntimePublicationFn =
    deps.tryRuntimePublicationFn ?? tryRuntimePublication;
  const enqueuePublishBuildFn =
    deps.enqueuePublishBuildFn ?? enqueuePublishBuild;
  const runtimeCandidateFn = deps.runtimeCandidateFn ?? runtimeCandidate;
  const assertBillingEnabledFn =
    deps.assertBillingEnabledFn ?? assertBillingEnabled;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
      if (Object.hasOwn(req.body ?? {}, "aggregateRetryQueueId")) {
        if (req.body.retry !== true || changes.length || req.body.runtimeFirst) {
          res.status(400).json({ error: "Retry one accepted site update without content changes." });
          return;
        }
        const result = await require("./lib/generic-context-retry").retryGenericPublicContext({
          firestore: deps.firestore ?? db, actor: user, operationId: req.body.aggregateRetryQueueId, source: getClientIp(req),
        });
        res.status(200).json(result);
        return;
      }
      let decision = null;
      if (!trustsLegacyAdminSeam) {
        decision = await authorizePublishRequest(
          user.principal,
          changes,
          deps.firestore ?? db,
          { requirePendingState: req.body?.retry !== true },
        );
        if (!decision.allowed) {
          log.warn("cmsPublish refused a publish", {
            uid: user.uid,
            reason: decision.reason,
          });
          res.status(403).json({ error: "Publish access required" });
          return;
        }
      }
      if (addressedPublishChanges(changes).some(change => change.collection === "cmsSettings")) {
        res.status(409).json({ code: "settings_publication_client_outdated",
          error: "Boardwalk was updated. Reload this page, then publish again." });
        return;
      }
      const recordPublication = await require("./lib/no-build-record-retry").existingNoBuildRecordPublication({
        firestore: deps.firestore ?? db, changes, retry: req.body?.retry === true, actor: user, baseVersion: req.body?.baseVersion });
      if (recordPublication) { res.status(200).json(recordPublication); return; }
      const pagePublication = await existingNoBuildPagePublication({
        firestore: deps.firestore ?? db, changes, retry: req.body?.retry === true,
        actor: user, baseVersion: req.body?.baseVersion,
      });
      if (pagePublication) { res.status(200).json(pagePublication); return; }
      const noBuild = await existingNoBuildPostPublication({
        firestore: deps.firestore ?? db, changes, retry: req.body?.retry === true,
        actor: user, baseVersion: req.body?.baseVersion, buildDeps: deps,
      });
      if (noBuild) { res.status(200).json(noBuild); return; }
      const firestore = deps.firestore ?? db;
      if (addressedPublishChanges(changes).some(change => change.collection === "cmsPosts")) {
        await firestore.runTransaction(transaction => assertRequestedLibraryPublicationAvailable({ firestore, transaction, changes }),
          { readOnly: true });
      }
      let retryReservation = null;
      let retryReadiness = null;
      if (req.body?.retry === true) {
        const firestore = deps.firestore ?? db;
        retryReadiness = await (deps.assertPublishReadyFn ?? assertPublishReady)({ firestore }, deps);
        await (deps.assertPublishedMediaSafeFn ?? assertPublishedMediaSafe)({ firestore });
        retryReservation = await reservePublicationRetry({
          firestore, actor: user, changes, baseVersion: req.body.baseVersion,
          source: getClientIp(req), transport: retryReadiness.transport,
        });
        if (!retryReservation.reserved) {
          res.status(200).json({
            success: true, queueId: retryReservation.queueId, dispatched: false,
            status: "pending", transport: retryReservation.transport, existingBuild: true,
            message: "This publication is already queued.",
          });
          return;
        }
        if (retryReservation.transport !== retryReadiness.transport) {
          const error = new Error("The reserved publication uses a different transport. Contact an administrator.");
          error.status = 409;
          throw error;
        }
      }
      let runtimeResult = null;
      if (req.body?.runtimeFirst === true && !retryReservation) {
        if (runtimeCandidateFn(changes)) {
          await assertBillingEnabledFn(deps.firestore ?? db);
        }
        runtimeResult = await tryRuntimePublicationFn({
          firestore: deps.firestore ?? db,
          actor: user,
          changes,
          source: getClientIp(req),
        }, deps);
        if (runtimeResult?.confirmed) {
          if (runtimeResult.existingQueueId) {
            res.status(200).json({
              success: true,
              queueId: runtimeResult.existingQueueId,
              dispatched: false,
              status: "pending",
              message: "Publish is public; an existing site build remains queued.",
              publicReceipt: runtimeResult.publicReceipt,
              existingBuild: true,
            });
            return;
          }
          res.status(200).json({
            success: true,
            queueId: null,
            dispatched: false,
            status: "runtime_confirmed",
            transport: "runtime",
            message: "Publish confirmed on the public site.",
            publicReceipt: runtimeResult.publicReceipt,
          });
          return;
        }
      }
      const result = await enqueuePublishBuildFn({
        actor: retryReservation?.actor ?? user,
        changes,
        source: getClientIp(req),
        requireExactPendingChanges:
          !retryReservation && decision?.requireExactPendingChanges === true,
        ...(retryReservation ? {
          queueId: retryReservation.queueId, queueReserved: true, readiness: retryReadiness,
        } : {}),
      }, deps);
      res.status(200).json({
        ...result,
        ...(runtimeResult?.publicReceipt
          ? { publicReceipt: runtimeResult.publicReceipt }
          : {}),
      });
    } catch (err) {
      if (res.headersSent) return;
      const status =
        err?.status || (err?.code === "failed-precondition" ? 503 : 500);
      log.error("cmsPublish failed", err);
      const body = {
        error:
          err?.publicMessage || err?.message || "Failed to trigger publish",
        ...(err?.queueId ? { queueId: err.queueId } : {}),
        ...(err?.details?.code === "media_publication_unavailable"
          ? { code: err.details.code }
          : {}),
      };
      res.status(status).json(body);
    }
  };
}

const cmsPublish = cmsOnRequest(
  { cors: true, secrets: [...publishSecretBindings, ...routePurgeSecretNames()] },
  createCmsPublishHandler(),
);

module.exports = {
  cmsPublish,
  createCmsPublishHandler,
  assertPublishReady,
  authorizePublishRequest,
  enqueuePublishBuild,
  buildDispatchPayload,
  dispatchPublish,
  PUBLISH_TRANSPORT,
  CMS_WRITEBACK_CONFIGURED,
  defaultDispatchUrl,
  QUEUE_COLLECTION,
  defaultWritebackConfigured,
  defaultPublishTransport,
  resolvePublishTransport,
  enqueueSerializerBuild,
  tryRuntimePublication,
  WRITEBACK_NOT_CONFIRMED_ERROR,
  PUBLISH_TOKEN_NOT_CONFIGURED_ERROR,
  INVALID_PUBLISH_TRANSPORT_ERROR,
  GITHUB_TRANSPORT,
  SERIALIZER_TRANSPORT,
};
