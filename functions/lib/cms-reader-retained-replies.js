"use strict";

const p = require("./public-release-pair");
const cms = require("./cms-preview-pair");
const work = require("./public-release-pair-work");
const code = require("./public-release-pair-code-reference");
const bodies = require("./public-release-source-body");
const { recordReaderSourceReads } = require("./cms-reader-source-readset");
const FEATURES = Object.freeze(["postChrome", "settings", "capabilities", "previewRequest"]);
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new Error("Retained CMS reply source unavailable"); }

function requests(value, source) {
  p.exact(value, FEATURES);
  for (const feature of ["postChrome", "capabilities"]) {
    const body = value[feature];
    p.exact(body, ["mode", "path", "rendererSha", "method"]);
    if (body.mode !== (feature === "postChrome" ? "no-build-post-v1" : "no-build-page-v1") ||
        body.rendererSha !== source.commitSha || body.method !== "GET" || typeof body.path !== "string" ||
        body.path.length > 512 || /[%?#\\]/.test(body.path) ||
        !(feature === "postChrome" ? /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/ : /^(?:\/|\/[a-z0-9]+(?:-[a-z0-9]+)*\/)$/).test(body.path) ||
        ["/schedule/", "/live/"].includes(body.path)) refuse();
  }
  p.exact(value.settings, ["id"]);
  if (!Object.hasOwn(require("./cms-settings-contract").CMS_SETTINGS_SCHEMAS, value.settings.id)) refuse();
  p.exact(value.previewRequest, ["collection", "pageId"]);
  if (!["cmsPages", "cmsPosts"].includes(value.previewRequest.collection) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.previewRequest.pageId ?? "")) refuse();
  return value;
}

// The facade changes only the already-sealed ORIGINAL OLD root seen by OLD's
// native projector. Every editorial/owner/query read still uses this SDK tx.
// The actual current root is checked separately; no NEW reply is synthesized.
function originalRootReads(recorded, originalRoot) {
  const get = async ref => {
    const row = await recorded.transaction.get(ref);
    return ref.path === "system/publicDeployment" ? { ...row, exists: true, data: () => originalRoot } : row;
  };
  return { firestore: recorded.firestore, transaction: { get, getAll: (...refs) => Promise.all(refs.map(get)) } };
}

async function nativeReply({ firestore, transaction, feature, body, sourcePreview, now }) {
  if (feature === "postChrome") {
    const value = await require("./no-build-post-publication").readNoBuildPostDecisionInTransaction({ firestore, transaction, ...body });
    if (!["post", "alias", "gone", "receipts"].includes(value.kind)) refuse();
    return value;
  }
  if (feature === "capabilities") {
    const value = await require("./no-build-page-serving").readNoBuildPageDecisionInTransaction({ firestore, transaction, ...body,
      target: require("./publication-target").publicationTarget(sourcePreview.environment) });
    if (!["page", "context-page"].includes(value.kind)) refuse();
    return value;
  }
  if (feature === "settings") {
    const row = await transaction.get(firestore.doc(`cmsSettings/${body.id}`));
    const value = require("./cms-published-settings-reply").publishedSettingsReply({ id: body.id, document: row.data() });
    if (!value.found) refuse();
    return value;
  }
  const preview = require("../preview");
  const document = (await transaction.get(firestore.doc(`${body.collection}/${body.pageId}`))).data();
  if (!document || document.deleted || document.status === "archived") refuse();
  const current = await preview.readPreviewHead(firestore, body.collection, body.pageId, transaction);
  const ready = current.ready?.data;
  // Only a genuinely admitted saved request. Candidate health is not a queue.
  if (!ready || ready.status !== "ready" || ready.transport !== preview.SERIALIZER_TRANSPORT ||
      ready.rendererSha !== sourcePreview.rendererSha || !p.positive(ready.sourceVersion) ||
      ready.snapshot?.version !== ready.sourceVersion ||
      ready.previewPairId !== undefined && ready.previewPairId !== sourcePreview.pairId) refuse();
  const value = preview.previewHeadResponse(current, now);
  if (value.ready?.status !== "ready" || !value.ready.previewUrl ||
      value.latest && !["ready", "failed", "expired"].includes(value.latest.status)) refuse();
  return value;
}

function sourceIdentity(value, feature, seal) {
  if (!["postChrome", "capabilities"].includes(feature)) return;
  const receipt = value.receipt ?? value.contextReceipt;
  if (receipt?.rendererSha !== seal.oldPair.commitSha ||
      receipt.codeGeneration !== undefined && receipt.codeGeneration !== seal.originalRoot.activeGeneration ||
      value.publication?.commitSha !== undefined && value.publication.commitSha !== seal.oldPair.commitSha) refuse();
}

async function assertPairs({ firestore, transaction, seal }) {
  const pairs = [seal.oldPair, seal.newPair].map(p.parsePublicReleasePair);
  const previews = seal.previewPairs.map(cms.parsePair);
  if (pairs.length !== 2 || previews.length !== 2 || pairs[0].pairId === pairs[1].pairId || previews[0].pairId === previews[1].pairId) refuse();
  const paths = [...pairs.map(pair => work.publicReleasePairPath(pair.pairId)), ...previews.map(pair => `${cms.PAIRS}/${pair.pairId}`)];
  const rows = await transaction.getAll(...paths.map(path => firestore.doc(path)));
  [...pairs, ...previews].forEach((pair, index) => { if (!same(rows[index].data(), pair)) refuse(); });
  pairs.forEach(pair => work.assertPublicReleasePairDatabase(firestore, pair));
  const original = p.parseVersionedPublicDeployment(seal.originalRoot);
  if (!p.digest(seal.originalRootDigest)) refuse();
  if (original.state !== "idle" || original.activeCommitSha !== pairs[0].commitSha || original.schemaVersion === 2 &&
      (!same(original.selectedPair, p.publicReleasePairReference(pairs[0])) || !same(original.recoveryPair, p.publicReleasePairReference(pairs[1])))) refuse();
  const resolved = await code.assertPairCodeReferenceInTransaction({ firestore, transaction, reference: seal.sourcePublication });
  if (!same(resolved.pair, pairs[0]) || resolved.publication.historicalCode.reference.publication.generation !== original.activeGeneration) refuse();
}

/** Explicit source capture, independent of any bridge proof. Native projectors
 * run in this original SDK transaction; the existing immutable body writer is
 * the only persistence owner. No handler, queue, selector or provider write. */
async function captureRetainedReaderReplySources({ firestore, oldPair, newPair, previewPairs, requests: input, now = Date.now, signal }) {
  oldPair = p.parsePublicReleasePair(oldPair); newPair = p.parsePublicReleasePair(newPair);
  if (!Array.isArray(previewPairs) || previewPairs.length !== 2) refuse();
  const nativeRequests = requests(structuredClone(input), oldPair);
  return firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const authority = p.parseVersionedPublicDeployment((await transaction.get(firestore.doc("system/publicDeployment"))).data());
    // SDK Timestamp instances cannot round-trip through an immutable JSON body.
    // Preserve the complete actual authority digest separately; native read
    // projection needs no operational updatedAt field.
    const originalRoot = { ...authority }; delete originalRoot.updatedAt;
    const originalRootDigest = p.publicReleaseDigest(authority);
    const publication = code.parsePairCodePublication((await transaction.get(firestore.doc(code.pairCodePublicationPath(oldPair)))).data(), oldPair);
    const originalPreviewRuntime = require("./cms-preview-pair-candidate").previewRuntimeIdentity(
      (await transaction.get(firestore.doc(cms.SELECTOR_PATH))).data());
    if (originalPreviewRuntime.schemaVersion !== originalRoot.schemaVersion || originalPreviewRuntime.phase !== "ready" ||
        originalPreviewRuntime.rendererSha !== previewPairs[0].rendererSha || originalPreviewRuntime.schemaVersion === 2 &&
        (originalPreviewRuntime.selectedPairId !== previewPairs[0].pairId || originalPreviewRuntime.recoveryPairId !== previewPairs[1].pairId)) refuse();
    const seal = { schemaVersion: 1, kind: "original-cms-reader-replies", oldPair, newPair, previewPairs, originalPreviewRuntime,
      originalRoot, originalRootDigest, sourcePublication: publication.reference, capturedAt: now(), replies: {} };
    if (!Number.isSafeInteger(seal.capturedAt) || seal.capturedAt < 0 ||
        (await transaction.get(firestore.doc("system/billing"))).data()?.disabled === true) refuse();
    await assertPairs({ firestore, transaction, seal });
    for (const feature of FEATURES) {
      const recorded = recordReaderSourceReads({ firestore, transaction });
      const value = await nativeReply({ ...recorded, feature, body: nativeRequests[feature], now: seal.capturedAt,
        sourcePreview: { ...previewPairs[0], environment: oldPair.environment } });
      sourceIdentity(value, feature, seal);
      seal.replies[feature] = { request: nativeRequests[feature], json: JSON.stringify(value), readset: recorded.readset() };
    }
    const body = bodies.makePublicReleaseSourceBody({ kind: "provider", id: "cms-reader-replies", action: "dependency",
      sourceVersion: 1, snapshot: seal, sourceDocuments: [] });
    const write = await bodies.preparePublicReleaseSourceBodies({ firestore, transaction, values: [body] });
    signal?.throwIfAborted(); write();
    return { sourceBodyDigest: body.contentDigest };
  });
}

async function readRetainedReplySeal({ firestore, transaction, sourceBodyDigest }) {
  const body = await bodies.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: sourceBodyDigest });
  const seal = body.snapshot;
  if (body.kind !== "provider" || body.id !== "cms-reader-replies" || body.documents.length || seal?.schemaVersion !== 1 ||
      seal.kind !== "original-cms-reader-replies" || !Number.isSafeInteger(seal.capturedAt)) refuse();
  p.exact(seal, ["schemaVersion", "kind", "oldPair", "newPair", "previewPairs", "originalRoot", "originalRootDigest", "originalPreviewRuntime", "sourcePublication", "capturedAt", "replies"]);
  p.exact(seal.replies, FEATURES);
  requests(Object.fromEntries(FEATURES.map(feature => [feature, seal.replies[feature].request])), seal.oldPair);
  await assertPairs({ firestore, transaction, seal });
  return seal;
}

async function readRetainedReplyInTransaction({ firestore, transaction, binding, feature, body, now = Date.now, allowPausedBootstrap = false }) {
  p.exact(binding, ["schemaVersion", "sourceBodyDigest", "sourcePair", "consumer", "expectedPublicSelectorDigest"]);
  p.exact(binding.consumer, ["kind", "pairDigest"]);
  if (binding.schemaVersion !== 1 || !FEATURES.includes(feature)) refuse();
  const seal = await readRetainedReplySeal({ firestore, transaction, sourceBodyDigest: binding.sourceBodyDigest });
  if (!same(p.parsePublicReleasePairReference(binding.sourcePair), p.publicReleasePairReference(seal.oldPair))) refuse();
  const root = p.parseVersionedPublicDeployment((await transaction.get(firestore.doc("system/publicDeployment"))).data());
  if (p.publicReleaseDigest(root) !== binding.expectedPublicSelectorDigest || (await transaction.get(firestore.doc("system/billing"))).data()?.disabled === true) refuse();
  const publicPairs = [seal.oldPair, seal.newPair], previews = seal.previewPairs;
  if (root.schemaVersion === 1 ? p.publicReleaseDigest(root) !== seal.originalRootDigest :
    ![root.selectedPair, root.recoveryPair].every(ref => publicPairs.some(pair => same(p.publicReleasePairReference(pair), ref)))) refuse();
  const candidates = binding.consumer.kind === "public" ? publicPairs : binding.consumer.kind === "preview" ? previews : [];
  const consumer = candidates.find(pair => (binding.consumer.kind === "public" ? p.publicReleaseDigest(pair) : cms.digest(pair)) === binding.consumer.pairDigest);
  if (!consumer || root.schemaVersion === 1 && binding.consumer.kind === "public" && !same(consumer, seal.oldPair)) refuse();
  if (binding.consumer.kind === "preview") {
    const authority = await require("./cms-preview-pair-candidate").readPreviewPairRuntimeAuthority({
      read: async path => {
        const value = (await transaction.get(firestore.doc(path))).data();
        return path === cms.SELECTOR_PATH && allowPausedBootstrap ? pausedBootstrapRuntime(value, seal) : value;
      }, pairId: consumer.pairId,
      rendererSha: consumer.rendererSha, workerVersion: consumer.workerVersion, now: now() });
    if (root.schemaVersion === 1 && authority.mode === "candidate" &&
        !same(authority.bootstrapPublicPair, p.publicReleasePairReference(seal.oldPair))) refuse();
  }
  // Public reply-contract identity is sealed in each installed pair. Preview
  // consumers declare the endpoint schema separately in their native contract.
  if (binding.consumer.kind === "public" ? consumer.readerContractDigest !== seal.oldPair.readerContractDigest :
    consumer.requirements[feature] !== previews[0].requirements[feature]) refuse();
  if (feature === "previewRequest" && binding.consumer.kind !== "preview") refuse();
  const original = seal.replies[feature];
  if (!same(body, original.request) || now() < seal.capturedAt) refuse();
  const recorded = recordReaderSourceReads({ firestore, transaction });
  const value = await nativeReply({ ...originalRootReads(recorded, seal.originalRoot), feature, body, now: now(),
    sourcePreview: { ...previews[0], environment: seal.oldPair.environment } });
  sourceIdentity(value, feature, seal);
  if (!same(recorded.readset(), original.readset) || JSON.stringify(value) !== original.json) refuse();
  return { value: JSON.parse(original.json), json: original.json, sourcePair: p.publicReleasePairReference(seal.oldPair), seal };
}

function pausedBootstrapRuntime(value, seal) {
  const actual = require("./cms-preview-pair-candidate").previewRuntimeIdentity(value);
  if (actual.schemaVersion !== 1 || actual.phase !== "paused" ||
      !same({ ...actual, phase: seal.originalPreviewRuntime.phase }, seal.originalPreviewRuntime)) refuse();
  return seal.originalPreviewRuntime;
}

module.exports = { FEATURES, captureRetainedReaderReplySources, readRetainedReplySeal, readRetainedReplyInTransaction, pausedBootstrapRuntime };
