"use strict";

const { isDeepStrictEqual } = require("node:util");
const { createHash } = require("node:crypto");
const { readPublicDeploymentPointer } = require("./public-deployment-pointer");
const { pagePublicationTarget } = require("./no-build-page-target");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { refuse } = require("./no-build-page-ownership");
const { createPageCurrentCodeContextReader } = require("./no-build-page-schedule-reader");

const captures = new WeakMap();

async function authority({ firestore, transaction, rendererSha, reference, pairCode, qualifiedCode }) {
  if (pairCode !== undefined) {
    const p = require("./public-release-pair");
    const [deployment, context] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
    const pointer = p.parseStoredPublicReleaseSelector(deployment.data());
    const resolved = await require("./public-release-pair-code-reference").assertPairCodeReferenceInTransaction({
      firestore, transaction, reference: pairCode.reference });
    const original = resolved.publication.historicalCode;
    const json = JSON.stringify(require("./public-release-historical-code").verifyPublicReleaseQualifiedCode(qualifiedCode));
    if (!isDeepStrictEqual(pointer.selectedPair, pairCode.pair) || !isDeepStrictEqual(pairCode.pair, p.publicReleasePairReference(resolved.pair)) ||
        pointer.activeCommitSha !== rendererSha || resolved.pair.commitSha !== rendererSha || reference.publication.commitSha !== rendererSha ||
        !isDeepStrictEqual(original.reference, reference) || Buffer.byteLength(json) !== original.qualifiedCodeBytes ||
        createHash("sha256").update(json).digest("hex") !== original.qualifiedCodeDigest || context.data()?.schemaVersion !== 1 ||
        !Number.isSafeInteger(context.data().revision) || context.data().revision < 1) refuse("The sealed Home pair CODE publication is unavailable.");
    // Publication generation belongs to the original CODE DTO. The selector's
    // new generation/epoch names current authority; returning to OLD preserves
    // the original publication bytes and proves their exact pair seal instead.
    return { deployment: deployment.data(), context: context.data(), manifest: original.reference.manifest,
      pairCodeDigest: p.publicReleaseDigest(resolved.publication) };
  }
  const [deployment, context, manifest] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc(`cmsPreviewPublicContexts/${reference.publication.buildBatchId}`));
  const pointer = readPublicDeploymentPointer(deployment.data());
  const stored = manifest.data();
  if (pointer.state !== "idle" || pointer.activeCommitSha !== rendererSha ||
      reference.publication.commitSha !== rendererSha || pointer.activeGeneration !== reference.publication.generation ||
      context.data()?.schemaVersion !== 1 || !Number.isSafeInteger(context.data().revision) || context.data().revision < 1 ||
      Object.keys(reference.manifest).some(key => stored?.[key] !== reference.manifest[key])) {
    refuse("The Home CODE publication is unavailable.");
  }
  return { deployment: deployment.data(), context: context.data(), manifest: stored };
}

/** Read the full private CODE object before final writes. Its original Home
 * publication and provider clocks remain separate from current Page rendering. */
async function capturePageHomeCodeSources({ firestore, target, rendererSha, request,
  now = Date.now, deadline = now() + 45_000 }) {
  target = pagePublicationTarget({ firestore, target });
  if (!Number.isFinite(deadline) || deadline <= now()) refuse("The Home CODE deadline expired.");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  const readCode = createPageCurrentCodeContextReader({ firestore, rendererSha, target, request, signal });
  const code = await readCode();
  if (!code.publicContext.homeSources) refuse("The current CODE Home sources are unavailable.");
  const read = reference => firestore.runTransaction(transaction => authority({ firestore, transaction,
    rendererSha, reference }), { readOnly: true });
  const before = await read(code.reference);
  const afterCode = await readCode();
  const after = await read(afterCode.reference);
  if (!isDeepStrictEqual(code, afterCode) || !isDeepStrictEqual(before, after)) refuse("The Home CODE source moved after IO.");
  signal.throwIfAborted();
  const capture = Object.freeze({});
  captures.set(capture, { target, rendererSha, reference: code.reference, homeSources: code.publicContext.homeSources,
    selection: after, now, deadline, signal });
  return capture;
}

/** Replay-only capture over the owner's immutable reader facade and retained
 * qualified CODE. No current transport or provider fallback is installed. */
async function captureHistoricalPageHomeCodeSources({ firestore, target, rendererSha, originalPair, qualifiedCode,
  now = Date.now, deadline = now() + 45_000 }) {
  const pair = require("./public-release-pair").parsePublicReleasePair(originalPair);
  require("./public-release-historical-code").verifyPublicReleaseQualifiedCode(qualifiedCode);
  target = pagePublicationTarget({ firestore, target });
  if (pair.commitSha !== rendererSha || qualifiedCode.publication.commitSha !== rendererSha ||
      !qualifiedCode.publicContext.homeSources || !Number.isFinite(deadline) || deadline <= now()) refuse("Historical Home CODE authority differs.");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  // Branch on the reconstructed event's reference schema. A schema-two event
  // never probes or falls back to a mutable legacy CMS context manifest.
  const descriptor = (await firestore.doc("system/publicReleaseHistoricalCode").get()).data();
  let pairCode;
  if (descriptor?.reference?.schemaVersion === 2) {
    const p = require("./public-release-pair");
    pairCode = { reference: require("./public-release-pair-code-reference").parsePairCodeReference(descriptor.reference),
      pair: p.parsePublicReleasePairReference(descriptor.pair) };
    if (!isDeepStrictEqual(pairCode.pair, p.publicReleasePairReference(pair))) refuse("Historical Home pair CODE identity differs.");
  }
  const selection = await firestore.runTransaction(transaction => authority({ firestore, transaction, rendererSha,
    reference: qualifiedCode.reference, pairCode, qualifiedCode }), { readOnly: true });
  const capture = Object.freeze({});
  captures.set(capture, { target, rendererSha, reference: qualifiedCode.reference, pairCode, qualifiedCode,
    homeSources: qualifiedCode.publicContext.homeSources, selection, now, deadline, signal });
  return capture;
}

/** A private process-local seal is mandatory. Re-read local authority on every
 * SDK retry; this path contains no HTTP, CODE, R2 or provider IO. */
async function readCapturedPageHomeCodeSourcesInTransaction({ firestore, transaction, target, rendererSha, capture }) {
  target = pagePublicationTarget({ firestore, target });
  const data = captures.get(capture);
  if (!data || data.target !== target || data.rendererSha !== rendererSha || data.now() >= data.deadline) {
    refuse("The sealed Home CODE capture is unavailable.");
  }
  data.signal.throwIfAborted();
  const current = await authority({ firestore, transaction, rendererSha, reference: data.reference, pairCode: data.pairCode, qualifiedCode: data.qualifiedCode });
  if (!isDeepStrictEqual(current, data.selection)) refuse("The captured Home CODE authority moved.");
  return { homeSources: structuredClone(data.homeSources), codeSource: structuredClone(data.reference) };
}

/** Owned Home uses its retained or accepted provider source when one exists.
 * Unowned Home and first transfer must qualify the actual CODE baseline. */
async function capturePageHomeCodeSourcesIfNeeded(options) {
  const { firestore } = options;
  const needed = await firestore.runTransaction(async transaction => {
    const [owner, background, context] = await transaction.getAll(
      firestore.doc("system/publicDeployment/noBuildPageOwners/home"), firestore.doc("cmsBackgroundOutputs/home"),
      firestore.doc(PUBLIC_CONTEXT_PATH));
    return !owner.exists || background.data()?.retainedSource == null && context.data()?.externalInputs == null;
  }, { readOnly: true });
  return needed ? capturePageHomeCodeSources(options) : undefined;
}

module.exports = { captureHistoricalPageHomeCodeSources, capturePageHomeCodeSources, capturePageHomeCodeSourcesIfNeeded, readCapturedPageHomeCodeSourcesInTransaction };
