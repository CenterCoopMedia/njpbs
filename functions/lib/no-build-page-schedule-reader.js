"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { assertPublicDeploymentPointer } = require("./public-deployment");
const { pagePublicationTarget } = require("./no-build-page-target");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { refuse, digest, readNoBuildPageCapability } = require("./no-build-page-ownership");
const { readCachedPageSchedule } = require("./page-schedule-immutable-cache");
const { withinDeadline } = require("./no-build-post-recovery");

const JSON_PATH = "/_schedule-sources.json";
const PDF_PATH = "/schedule/downloads/nj-pbs-schedule.pdf";
const isPageScheduleExportPath = path => [JSON_PATH, PDF_PATH].includes(path);

/** Only source transport, immutable validation and deadline failures defer an
 * individual scheduled row. Unexpected code/SDK errors still stop the run. */
function isPageScheduleAvailabilityError(error) {
  return error?.status === 409 || ["AbortError", "TimeoutError", "SyntaxError", "PublicArtifactInventoryError", "PublicWorkerArtifactError"].includes(error?.name) ||
    [401, 403, 404, 408, 429, 500, 502, 503, 504].includes(error?.code) ||
    ["fetch failed", "Cloud schedule packet is unavailable", "Retained public context does not match the current publication",
      "Qualified current CODE bytes differ", "Background artifact is too large", "Schedule projection exceeds its bound",
      "Public Post confirmation timed out"].includes(error?.message);
}

/** Schema one uses the root-approved private CODE transport. An explicit pair
 * selector uses its sealed original CODE with fresh actual selection checks.
 * Neither path substitutes mutable Assets or a retained family input. */
function createPageCurrentCodeContextReader({ firestore, rendererSha, target, request, signal, releaseSelector, readSecret }) {
  if (releaseSelector !== undefined) return require("./public-release-page-schedule-code").createPairScheduleCodeContextReader({
    firestore, rendererSha, releaseSelector, signal, environment: pagePublicationTarget({ firestore, target }).environment });
  let reader;
  const getReader = () => {
    target = pagePublicationTarget({ firestore, target });
    // A deadline wrapper must not hide an implicit live fetch from the existing
    // transport's local-fixture guard.
    if ((process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) && !request) {
      refuse("Emulated Page CODE reads require an explicit local fixture transport.");
    }
    const boundedRequest = signal ? (url, options) => (request ?? fetch)(url, {
      ...options, signal: AbortSignal.any([signal, options.signal].filter(Boolean)) }) : request;
    reader ??= require("./home-retained-sources").createCurrentCodeContextReader({
      target, firestore, rendererSha, request: boundedRequest,
      readSecret: readSecret ?? require("./cms-edge").configuredEdgeSecret });
    return reader;
  };
  const read = () => getReader().readCurrentCodeContext();
  read.readHistoricalCodeContext = () => getReader().readHistoricalCodeContext();
  read.readReference = async () => {
    try { return await getReader().readCurrentCodeReference(); }
    catch (error) {
      // An older API/renderer can lack the reference-only RPC during rollout.
      // Its existing full CODE reader still verifies the same current authority.
      if (![400, 404, 405, 501, 503].includes(error?.rpcStatus)) throw error;
      return (await read()).reference;
    }
  };
  return read;
}

async function currentCode(readCurrentCodeContext) {
  if (typeof readCurrentCodeContext !== "function") refuse("Current Page CODE qualification is unavailable.");
  const qualified = structuredClone(await readCurrentCodeContext());
  const publication = qualified?.publication;
  const receipt = qualified?.publicContext?.receipt;
  if (publication?.schemaVersion !== 1 || publication.digestAlgorithm !== "sha256" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(publication.buildBatchId ?? "") ||
      !Number.isSafeInteger(publication.generation) || publication.generation < 1 ||
      !/^[a-f0-9]{40}$/.test(publication.commitSha ?? "") ||
      ["artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"].some(key => !/^[a-f0-9]{64}$/.test(publication[key] ?? "")) ||
      ["buildBatchId", "generation", "commitSha", "mediaManifestDigest"].some(key => receipt?.[key] !== publication[key])) {
    refuse("The qualified current Page CODE context differs.");
  }
  return qualified;
}

/** The qualified actual CODE DTO and exact public context belong to one decision.
 * Provider source/runtime/clock stay original and are never relabeled as CODE. */
async function readScheduleSelectionInTransaction({ firestore, transaction, rendererSha, reference, target }) {
  target = pagePublicationTarget({ firestore, target });
  const [deployment, context] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const pairCode = deployment.data()?.schemaVersion === 2
    ? await require("./public-release-page-schedule-code").readPairScheduleCodeInTransaction({
      firestore, transaction, selector: deployment.data(), rendererSha, reference, environment: target.environment }) : null;
  const pointer = pairCode?.selector ?? assertPublicDeploymentPointer(deployment.data());
  const current = context.data();
  const capability = await readNoBuildPageCapability({ firestore, transaction });
  const publication = reference.publication;
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "") || pointer.state !== "idle" ||
      pointer.activeCommitSha !== rendererSha || publication.commitSha !== rendererSha ||
      pointer.activeGeneration < 1 || !pairCode && pointer.activeGeneration !== publication.generation || current?.schemaVersion !== 1 ||
      !capability?.servingEnabled || capability.rendererSha !== rendererSha || !current.externalInputs?.schedulePacket) {
    refuse("The Page schedule context is unavailable.");
  }
  publicContextDigest(current.revision);
  return { deployment: structuredClone(deployment.data()), context: structuredClone(current), capability,
    ...(pairCode ? { pairCodeReference: pairCode.pairCodeReference } : {}) };
}
async function readPageScheduleAuthorityInTransaction({ firestore, transaction, rendererSha, qualifiedCode, target }) {
  const selection = await readScheduleSelectionInTransaction({ firestore, transaction, rendererSha, reference: qualifiedCode.reference, target });
  const current = selection.context, pointer = selection.deployment, publication = qualifiedCode.publication;
  return { contextRevision: current.revision, contextDigest: publicContextDigest(current.revision),
    code: { ...publication, deploymentId: pointer.activeDeploymentId,
      contextDigest: createHash("sha256").update(JSON.stringify(qualifiedCode.publicContext)).digest("hex") },
    inputs: current.externalInputs,
    // Full private selection is compared after IO; the packet adapter projects
    // only its explicit public receipt fields and never exposes these rows.
    selection };
}

// Captures are process-local and cannot be forged, stored or supplied by a
// browser. Their complete qualified CODE and mutable selection stay private.
class PageScheduleCaptureRequired extends Error {
  constructor(pageId) { super("Qualified schedule authority must be captured before rendering."); this.pageId = pageId; }
}
const captures = new WeakMap();
function captureData(capture, target, rendererSha) {
  const data = captures.get(capture);
  if (!data || data.target !== target || rendererSha && data.rendererSha !== rendererSha || data.now() >= data.deadline) {
    refuse("The qualified Page schedule capture is unavailable.");
  }
  data.signal.throwIfAborted();
  return data;
}
async function capturePageSchedule({ firestore, target, rendererSha, request, releaseSelector, now = Date.now, deadline = now() + 45_000 }) {
  target = pagePublicationTarget({ firestore, target });
  if (!Number.isFinite(deadline) || deadline <= now()) refuse("The Page schedule deadline expired.");
  if (releaseSelector !== undefined) {
    const selected = require("./public-release-media-fence").parseStoredSelector(releaseSelector);
    if (rendererSha !== undefined && rendererSha !== selected.activeCommitSha) refuse("The Page selected CODE differs.");
    rendererSha = selected.activeCommitSha;
  }
  if (!rendererSha) {
    const pointer = assertPublicDeploymentPointer((await firestore.doc("system/publicDeployment").get()).data());
    if (pointer.state !== "idle") refuse("The Page schedule code release is moving.");
    rendererSha = pointer.activeCommitSha;
  }
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) refuse("The Page renderer is invalid.");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  const readCurrentCodeContext = createPageCurrentCodeContextReader({ firestore, target, rendererSha, request, signal,
    ...(releaseSelector !== undefined ? { releaseSelector } : {}) });
  const reference = await readCurrentCodeContext.readReference();
  const readSelection = reference => firestore.runTransaction(transaction => readScheduleSelectionInTransaction({
    firestore, transaction, rendererSha, reference, target }), { readOnly: true });
  const selection = await readSelection(reference);
  const read = qualifiedCode => firestore.runTransaction(transaction => readPageScheduleAuthorityInTransaction({
    firestore, transaction, rendererSha, qualifiedCode, target }), { readOnly: true });
  const data = await withinDeadline(deadline - now(), () => readCachedPageSchedule({ firestore,
    identity: digest({ target: target.environment, reference, selection }), load: async () => {
      const qualifiedCode = await currentCode(readCurrentCodeContext);
      const authority = await read(qualifiedCode);
      if (!isDeepStrictEqual(qualifiedCode.reference, reference) || !isDeepStrictEqual(authority.selection, selection)) refuse("The Page schedule source moved before packet IO.");
      const storage = require("./post-background-storage").createPostBackgroundStorage(target.backgroundBucket);
      const packet = await require("./home-retained-sources").readPageSchedulePacket({ authority, storage: {
        get: (key, options) => storage.get(key, { ...options, signal: AbortSignal.any([signal, options.signal]) }),
        put: () => { refuse("A Page schedule reader cannot generate an output."); },
      } });
      const afterCode = await currentCode(readCurrentCodeContext);
      if (!isDeepStrictEqual(afterCode, qualifiedCode) || !isDeepStrictEqual(await read(afterCode), authority)) refuse("The Page schedule authority moved after packet IO.");
      signal.throwIfAborted();
      return { qualifiedCode, authority, packet };
    } }));
  const afterReference = await readCurrentCodeContext.readReference();
  if (!isDeepStrictEqual(afterReference, reference) || !isDeepStrictEqual(await readSelection(afterReference), selection)) refuse("The Page schedule authority moved after cache reuse.");
  signal.throwIfAborted();
  const capture = Object.freeze({});
  captures.set(capture, { target, rendererSha, ...data, deadline, now, signal });
  return capture;
}
/** Private replay adapter. The source owner has verified immutable baseline/
 * append evidence and exact retained CODE bytes before invoking this method.
 * Its Firestore facade contains only reconstructed public source documents;
 * no current-CODE RPC or mutable-latest fallback is permitted here. */
async function captureHistoricalPageSchedule({ firestore, target, rendererSha, originalPair, qualifiedCode, storage,
  now = Date.now, deadline = now() + 45_000 }) {
  const pair = require("./public-release-pair").parsePublicReleasePair(originalPair);
  require("./public-release-historical-code").verifyPublicReleaseQualifiedCode(qualifiedCode);
  target = pagePublicationTarget({ firestore, target });
  if (pair.commitSha !== rendererSha || qualifiedCode.publication.commitSha !== rendererSha ||
      !Number.isFinite(deadline) || deadline <= now()) refuse("Historical Schedule CODE authority differs.");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  const authority = await firestore.runTransaction(transaction => readPageScheduleAuthorityInTransaction({
    firestore, transaction, rendererSha, qualifiedCode, target }), { readOnly: true });
  const packet = await require("./home-retained-sources").readPageSchedulePacket({ authority, storage });
  signal.throwIfAborted();
  const capture = Object.freeze({});
  captures.set(capture, { target, rendererSha, qualifiedCode, authority, packet, deadline, now, signal });
  return capture;
}
async function readCapturedPageScheduleInTransaction({ firestore, transaction, target, rendererSha, capture }) {
  target = pagePublicationTarget({ firestore, target });
  const data = captureData(capture, target, rendererSha);
  const current = await readPageScheduleAuthorityInTransaction({ firestore, transaction, target,
    rendererSha: data.rendererSha, qualifiedCode: data.qualifiedCode });
  if (!isDeepStrictEqual(current, data.authority)) refuse("The captured Page schedule selection moved.");
  return structuredClone(data.packet.schedule);
}
async function readPageScheduleInputsInTransaction({ firestore, transaction, target, rendererSha, scheduleCapture }) {
  if (!scheduleCapture) refuse("A qualified Page schedule capture is required before the transaction.");
  return readCapturedPageScheduleInTransaction({ firestore, transaction, target, rendererSha, capture: scheduleCapture });
}
async function readNoBuildPageScheduleExport({ firestore, path, target, rendererSha, currentCodeRequest, scheduleCapture }) {
  target = pagePublicationTarget({ firestore, target });
  if (!isPageScheduleExportPath(path)) refuse("The Page schedule route is invalid.");
  const enabled = async transaction => {
    const capability = await require("./no-build-page-ownership").readNoBuildPageCapability({ firestore, transaction });
    return capability?.servingEnabled === true && capability.rendererSha === rendererSha;
  };
  if (!await firestore.runTransaction(enabled, { readOnly: true })) return { kind: "pass", path };
  const capture = scheduleCapture ?? await capturePageSchedule({ firestore, target, rendererSha, request: currentCodeRequest });
  const data = captureData(capture, target, rendererSha);
  const schedule = await firestore.runTransaction(async transaction => {
    if (!await enabled(transaction)) return null;
    return readCapturedPageScheduleInTransaction({ firestore, transaction, target, rendererSha, capture });
  }, { readOnly: true });
  if (!schedule) return { kind: "pass", path };
  return { kind: "schedule-export", path, scheduleReceipt: schedule.receipt,
    bytes: (path === JSON_PATH ? data.packet.json : data.packet.pdf).toString("base64") };
}
function assertPageScheduleCapture({ firestore, target, rendererSha, capture }) {
  captureData(capture, pagePublicationTarget({ firestore, target }), rendererSha);
}
/** A cache key names the freshly qualified immutable packet and all of its
 * selected authority. The opaque capture and private selection stay local. */
function pageScheduleCaptureIdentity({ firestore, target, rendererSha, capture }) {
  const data = captureData(capture, pagePublicationTarget({ firestore, target }), rendererSha);
  return digest({ reference: data.qualifiedCode.reference, authority: data.authority });
}
module.exports = { isPageScheduleAvailabilityError, assertPageScheduleCapture, PageScheduleCaptureRequired, createPageCurrentCodeContextReader, isPageScheduleExportPath, readPageScheduleAuthorityInTransaction,
  capturePageSchedule, captureHistoricalPageSchedule, pageScheduleCaptureIdentity, readCapturedPageScheduleInTransaction, readPageScheduleInputsInTransaction, readNoBuildPageScheduleExport };
