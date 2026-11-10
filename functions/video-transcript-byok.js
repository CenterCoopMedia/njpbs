"use strict";
const { createHash } = require("node:crypto");
const { transcriptConfig } = require("./video-transcripts");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { verifyAppCheckUnlessAutomation } = require("./lib/automation-accounts");
const { authorizeMediaSource } = require("./lib/media-sources");
const { PAID_FALLBACK_POLICY } = require("./lib/video-transcript-fallback-policy");
const { sourceMatches } = require("./lib/video-transcript-worker");
const {
  runtimeRegistry,
  runtimeAwsConfig,
  FUNCTION_SERVICE_ACCOUNT,
} = require("./source-media");
const {
  activeAsset,
  getTranscriptJob,
  TRANSCRIPT_JOBS,
} = require("./lib/video-transcript-job");
const {
  transcriptInput,
  transcriptSummary,
} = require("./lib/video-transcript-contract");
const {
  credentialIdentity,
  CREDENTIAL_COLLECTION,
} = require("./lib/video-transcription-credentials");
const {
  createJob,
  validJob,
  variantId,
  PROVIDER,
  MODEL,
  MAX_INPUT_BYTES,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
} = require("./lib/video-transcript-byok-job");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { BYOK_ENABLED: ENABLED, DATA_ROLE, KEY_VERSION, isConfigured } = require("./lib/video-transcription-config");
const { LIMITS, budgetRefs, counters, budgetView } = require("./lib/video-transcript-paid-budget");
const { parseNewAttempt, transcriptAttempt, readAttemptSlot, assertAttemptProvider } = require("./lib/video-transcript-attempt");
const CAPABILITY = {
  id: PROVIDER,
  model: MODEL,
  wordTimings: true,
  languageCodes: ["en-US", "es-US"],
  maxSpeakers: { min: 2, max: 10 },
  maxInputBytes: MAX_INPUT_BYTES,
  minDurationSeconds: MIN_DURATION_SECONDS,
  maxDurationSeconds: MAX_DURATION_SECONDS,
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function config() {
  const aws = runtimeAwsConfig();
  return {
    enabled: transcriptConfig().enabled && ENABLED.value() === "true" && isConfigured({ ...aws, roleArn: DATA_ROLE.value(), keyVersion: KEY_VERSION.value() }),
    audioEnabled: transcriptConfig().audioEnabled,
    bucket: aws.renditionBucket,
    accountId: aws.renditionExpectedBucketOwner,
  };
}
function parse(value, operation) {
  const fields = [
    "sourceId",
    "assetId",
    ...(operation === "request"
      ? [
          "provider",
          "credentialScope",
          "credentialRevision",
          "languageCode",
          "maxSpeakers",
          "newAttemptOf",
          "attemptKey",
        ]
      : operation === "list"
        ? ["cursor"]
        : []),
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.sourceId !== "video-library" ||
    typeof value.assetId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId)
  )
    throw fail(400, "Transcript request is invalid");
  if (
    operation === "request" &&
    (value.provider !== PROVIDER ||
      !["personal", "organization"].includes(value.credentialScope) ||
      !Number.isSafeInteger(value.credentialRevision) ||
      value.credentialRevision < 1 ||
      value.credentialRevision >= Number.MAX_SAFE_INTEGER ||
      !CAPABILITY.languageCodes.includes(value.languageCode) ||
      !Number.isInteger(value.maxSpeakers) ||
      value.maxSpeakers < 2 ||
      value.maxSpeakers > 10)
  )
    throw fail(400, "Transcript settings are invalid");
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== "string" || value.cursor.length > 1024)
  )
    throw fail(400, "Transcript cursor is invalid");
  return { ...value, ...parseNewAttempt(value.newAttemptOf, value.attemptKey) };
}
function binding(asset, source) {
  return hash([
    source.id,
    asset.id,
    source.bucket,
    asset.objectKey,
    asset.objectVersionId,
    asset.sizeBytes,
  ]);
}
function cursorAfter(cursor, key) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Object.keys(value).length !== 2 ||
      value.binding !== key ||
      !/^[a-f0-9]{64}$/.test(value.after)
    )
      throw Error();
    return value.after;
  } catch {
    throw fail(400, "Transcript cursor is invalid or the video changed");
  }
}
function safeCredential(record, expected) {
  if (!record)
    return {
      scope: expected.scope,
      provider: PROVIDER,
      revision: 0,
      configured: false,
    };
  if (
    ["id", "scope", "ownerUid", "provider"].some(
      (field) => record[field] !== expected[field],
    ) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  )
    throw fail(503, "Transcript credential is unavailable");
  return {
    scope: record.scope,
    provider: PROVIDER,
    revision: record.revision,
    configured: record.enabled === true,
  };
}
function identityFor(asset, source, request, actor, settings) {
  const input = transcriptInput(asset),
    credential = credentialIdentity(actor, {
      scope: request.credentialScope,
      provider: PROVIDER,
    });
  const identity = {
    ...(settings.audioEnabled ? { inputRevision: "aac-m4a-copy-v1" } : {}),
    sourceId: source.id,
    assetId: asset.id,
    originalBucket: source.bucket,
    originalKey: asset.objectKey,
    originalVersion: asset.objectVersionId,
    originalSize: asset.sizeBytes,
    renditionBucket: settings.bucket,
    renditionKey: input.objectKey,
    renditionVersion: input.objectVersionId,
    renditionSize: input.sizeBytes,
    durationSeconds: input.durationSeconds,
    credentialScope: request.credentialScope,
    credentialId: credential.id,
    credentialRevision: request.credentialRevision,
    languageCode: request.languageCode,
    maxSpeakers: request.maxSpeakers,
  };
  try {
    variantId(identity);
  } catch {
    throw fail(
      400,
      "Video exceeds transcription limits or has no ready viewing copy",
    );
  }
  return { identity, credential };
}
async function admit({
  firestore,
  source,
  request,
  actor,
  settings,
  now,
  audit = adminLogEntry,
  fallbackParentId,
  operatorCanaryId,
}) {
  if (operatorCanaryId !== undefined && !/^[a-f0-9]{64}$/.test(operatorCanaryId)) throw fail(400, "Transcript canary is invalid");
  if (!settings.enabled || !settings.bucket || !settings.accountId)
    throw fail(503, "BYOK transcription is unavailable");
  if (!Number.isFinite(actor.authTime) || actor.authTime <= 0)
    throw fail(401, "Sign in again before requesting transcription");
  const day = new Date(now).toISOString().slice(0, 10);
  return firestore.runTransaction(async (tx) => {
    const parentRef = fallbackParentId ? firestore.collection(TRANSCRIPT_JOBS).doc(fallbackParentId) : null;
    const parent = parentRef ? (await tx.get(parentRef)).data() : null;
    const asset = activeAsset(
      await tx.get(
        firestore.collection("mediaSourceAssets").doc(request.assetId),
      ),
      source,
    );
    if (parentRef && (!parent?.active || parent.processingPolicy !== PAID_FALLBACK_POLICY ||
        parent.paidFallbackState !== "pending" || parent.phase !== "pending" ||
        parent.provider !== "amazon-transcribe" || parent.startIntentAt || parent.leaseUntil > now ||
        parent.requestedBy !== actor.uid || parent.requestedAuthTime !== actor.authTime ||
        parent.languageCode !== request.languageCode || parent.maxSpeakers !== request.maxSpeakers ||
        request.credentialScope !== "organization" || !sourceMatches(asset, parent, source))) {
      throw fail(409, "Transcript fallback changed");
    }
    const { identity, credential } = identityFor(
      asset,
      source,
      request,
      actor,
      settings,
    );
    Object.assign(identity, await transcriptAttempt(tx, firestore, asset, source, request.newAttemptOf, request.attemptKey));
    const job = createJob(identity, actor, now),
      ref = firestore.collection(TRANSCRIPT_JOBS).doc(job.id),
      refs = budgetRefs(firestore, actor.uid, day);
    if (operatorCanaryId) job.operatorCanaryId = operatorCanaryId;
    const [user, billing, key, previous, personal, global, slot] =
      await Promise.all([
        tx.get(firestore.collection("users").doc(actor.uid)),
        tx.get(firestore.doc("system/billing")),
        tx.get(firestore.collection(CREDENTIAL_COLLECTION).doc(credential.id)),
        tx.get(ref),
        tx.get(refs.requester),
        tx.get(refs.global),
        tx.get(refs.slot),
      ]);
    if (
      !user.exists ||
      user.data().active === false ||
      source.access !== "active_staff" ||
      !source.writable
    )
      throw fail(403, "Transcript access denied");
    const available = safeCredential(key.data(), credential);
    if (
      !available.configured ||
      available.revision !== request.credentialRevision
    )
      throw fail(409, "Transcript credential changed");
    if (billing.data()?.disabled === true)
      throw fail(503, "Transcription is unavailable while billing is stopped");
    if (previous.exists) {
      const cached = previous.data();
      validJob(cached, job.id);
      if (parentRef) tx.update(parentRef, { paidFallbackState: "waiting", fallbackTranscriptId: cached.id });
      return { job: cached, cached: true };
    }
    const attemptSlot = await readAttemptSlot(tx, firestore, asset, source, request);
    if (attemptSlot?.job) {
      assertAttemptProvider(attemptSlot.job, PROVIDER, { id: credential.id, revision: request.credentialRevision });
      return { job: attemptSlot.job, cached: true };
    }
    const outstanding = slot.data()?.jobId;
    const held = outstanding
      ? await tx.get(firestore.collection(TRANSCRIPT_JOBS).doc(outstanding))
      : null;
    if (outstanding && (!held.exists || held.data().active === true))
      throw fail(429, "One transcription request is already outstanding");
    const seconds = Math.ceil(job.durationSeconds),
      reservations = [
        [refs.requester, personal.data(), LIMITS.requester],
        [refs.global, global.data(), LIMITS.global],
      ];
    for (const [, record, limits] of reservations) {
      const view = budgetView(record, limits);
      if (view.remainingSubmissions < 1 || view.remainingAudioSeconds < seconds)
        throw fail(429, "Daily transcription budget is reserved or used");
    }
    Object.assign(job, {
      requestedAuthTime: actor.authTime,
      budgetReservation: {
        day,
        audioSeconds: seconds,
        state: "reserved",
        requesterRecord: refs.requester.id,
        globalRecord: refs.global.id,
        slotRecord: refs.slot.id,
      },
    });
    for (const [budgetRef, record] of reservations) {
      const value = counters(record);
      tx.set(budgetRef, {
        ...value,
        reservedSubmissions: value.reservedSubmissions + 1,
        reservedAudioSeconds: value.reservedAudioSeconds + seconds,
      });
    }
    tx.set(refs.slot, { jobId: job.id });
    tx.create(ref, job);
    if (attemptSlot) tx.set(attemptSlot.ref, { activeId: job.id });
    if (parentRef) tx.update(parentRef, { paidFallbackState: "waiting", fallbackTranscriptId: job.id });
    tx.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      audit({
        actorUid: actor.uid,
        action: "media.transcript.request",
        target: `${TRANSCRIPT_JOBS}/${job.id}`,
        after: {
          provider: PROVIDER,
          assetId: asset.id,
          reservedAudioSeconds: seconds,
        },
      }),
    );
    return { job, cached: false };
  });
}
async function optionsFor({
  firestore,
  source,
  request,
  actor,
  settings,
  now,
}) {
  activeAsset(
    await firestore.collection("mediaSourceAssets").doc(request.assetId).get(),
    source,
  );
  const day = new Date(now).toISOString().slice(0, 10),
    refs = budgetRefs(firestore, actor.uid, day);
  const credentials = await Promise.all(
    ["personal", "organization"].map(async (scope) => {
      const expected = credentialIdentity(actor, { scope, provider: PROVIDER });
      return safeCredential(
        (
          await firestore
            .collection(CREDENTIAL_COLLECTION)
            .doc(expected.id)
            .get()
        ).data(),
        expected,
      );
    }),
  );
  const [personal, global, slot] = await Promise.all([
    refs.requester.get(),
    refs.global.get(),
    refs.slot.get(),
  ]);
  const held = slot.data()?.jobId
    ? await firestore.collection(TRANSCRIPT_JOBS).doc(slot.data().jobId).get()
    : null;
  return {
    enabled:
      settings.enabled === true &&
      Boolean(settings.bucket && settings.accountId),
    credentials,
    provider: CAPABILITY,
    limits: LIMITS,
    budget: {
      day,
      requester: {
        ...budgetView(personal.data(), LIMITS.requester),
        outstanding:
          held && (!held.exists || held.data().active === true) ? 1 : 0,
      },
      global: budgetView(global.data(), LIMITS.global),
    },
  };
}
async function listFor({ firestore, source, request, settings }) {
  const asset = activeAsset(
      await firestore
        .collection("mediaSourceAssets")
        .doc(request.assetId)
        .get(),
      source,
    ),
    key = binding(asset, source),
    after = cursorAfter(request.cursor, key);
  let query = firestore
    .collection(TRANSCRIPT_JOBS)
    .where("assetId", "==", request.assetId)
    .orderBy("__name__");
  if (after) query = query.startAfter(after);
  const page = await query.limit(20).get(),
    transcripts = [];
  for (const row of page.docs) {
    try {
      const job = await getTranscriptJob({
        firestore,
        source,
        request: {
          sourceId: request.sourceId,
          assetId: request.assetId,
          transcriptId: row.id,
        },
        renditionBucket: settings.bucket,
      });
      if (job?.id === row.id) transcripts.push(transcriptSummary(job));
    } catch (error) {
      if (![404, 409].includes(error.status)) throw error;
    }
  }
  const current = activeAsset(
    await firestore.collection("mediaSourceAssets").doc(request.assetId).get(),
    source,
  );
  if (
    binding(current, source) !== key ||
    JSON.stringify(current.rendition?.web) !==
      JSON.stringify(asset.rendition?.web)
  )
    throw fail(409, "Video changed. Reload transcripts");
  return {
    transcripts,
    nextCursor:
      page.docs.length === 20
        ? Buffer.from(
            JSON.stringify({ binding: key, after: page.docs.at(-1).id }),
          ).toString("base64url")
        : null,
  };
}
function createByokHandler(operation, dependencies = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    try {
      const firestore = dependencies.firestore ?? db;
      const verifyAppCheckFn =
        dependencies.verifyAppCheckFn ?? verifyAppCheckToken;
      // Only the transcript list admits an automation account without App Check (#4950).
      if (operation !== "list")
        await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(
        req,
      );
      if (operation === "list")
        await verifyAppCheckUnlessAutomation(req, actor, {
          firestore,
          verifyAppCheckFn,
        });
      validateBoundedJsonRequest(req, 8 * 1024);
      const request = parse(req.body, operation),
        source = (dependencies.registryFn ?? runtimeRegistry)().get(
          request.sourceId,
        );
      await (dependencies.authorizeFn ?? authorizeMediaSource)({
        firestore,
        actor,
        source,
        operation: operation === "list" ? "browse" : "transcript",
      });
      const args = {
        firestore,
        source,
        request,
        actor,
        settings: (dependencies.configFn ?? config)(),
        now: (dependencies.now ?? Date.now)(),
        audit: dependencies.audit,
      };
      let result;
      if (operation === "request") {
        const admitted = await admit(args);
        result = {
          transcript: transcriptSummary(admitted.job),
          cached: admitted.cached,
        };
      } else
        result =
          operation === "list" ? await listFor(args) : await optionsFor(args);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 413, 429, 503].includes(
        error?.status,
      )
        ? error.status
        : 503;
      return res.status(status).json({
        error:
          status >= 500 ? "BYOK transcription is unavailable" : error.message,
      });
    }
  };
}
const options = {
  cors: true,
  maxInstances: 3,
  concurrency: 10,
  timeoutSeconds: 60,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT,
};
module.exports = {
  config,
  createByokHandler,
  admit,
  optionsFor,
  listFor,
  parse,
  cursorAfter,
  binding,
  budgetRefs,
  LIMITS,
  cmsGetTranscriptionOptions: cmsOnRequest(
    options,
    createByokHandler("options"),
  ),
  cmsRequestByokVideoTranscript: cmsOnRequest(
    options,
    createByokHandler("request"),
  ),
  cmsListVideoTranscripts: cmsOnRequest(options, createByokHandler("list")),
};
