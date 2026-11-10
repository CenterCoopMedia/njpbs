import { createHash } from "node:crypto";
import p from "../../functions/lib/public-release-pair.js";
import cms from "../../functions/lib/cms-preview-pair.js";
import source from "../../functions/lib/cms-reader-retained-replies.js";
import mount from "../../functions/lib/cms-reader-mount-descriptor.js";
import code from "../../functions/lib/pair-current-code-source.js";
import firstCode from "../../functions/lib/cms-reader-first-install-code-source.js";
import { parseCmsReaderBridgeRequest, FIRST_INSTALL_STAGE } from "./cms-reader-bridge-install.mjs";

const scopes = ["publicOld", "publicNew", "previewOld", "previewNew"];
const endpoints = { publicCode: "cmsReadPairCurrentCodeV2", postChrome: "cmsGetPublicPage", capabilities: "cmsGetPublicPage",
  settings: "cmsGetPublishedSettings", previewRequest: "cmsPreviewStatus" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const refuse = () => { throw new Error("First-install reader authority unavailable"); };

export function readerAdapterEnvironment(config) {
  return { CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: config.readerOperationId,
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: config.candidates.functions,
    CMS_READER_BRIDGE_CMS_API_CANDIDATE: config.candidates.cmsApi };
}

/** No installed proof prerequisite. The native mount owner reads either the
 * original complete candidates/legacy deployments or their immutable identity.
 * The exact original reply sources live in the existing immutable H-body store.
 */
export async function readFirstInstallReaderState({ firestore, config, transaction: supplied }) {
  const inspect = async transaction => {
    const seal = await source.readRetainedReplySeal({ firestore, transaction, sourceBodyDigest: config.sourceBodyDigest });
    const root = p.parseVersionedPublicDeployment((await transaction.get(firestore.doc("system/publicDeployment"))).data());
    const descriptor = await mount.readCmsReaderMountDescriptor({ firestore, transaction, environment: readerAdapterEnvironment(config) });
    if ((await transaction.get(firestore.doc("system/billing"))).data()?.disabled === true) refuse();
    if (root.schemaVersion === 1 ? p.publicReleaseDigest(root) !== seal.originalRootDigest :
      ![root.selectedPair, root.recoveryPair].every(ref => [seal.oldPair, seal.newPair].some(pair => same(p.publicReleasePairReference(pair), ref)))) refuse();
    const state = { schemaVersion: 2, publicSelectorDigest: p.publicReleaseDigest(root),
      publicPairs: [seal.oldPair, seal.newPair].map(pair => ({ pairDigest: p.publicReleaseDigest(pair),
        pair: p.publicReleasePairReference(pair), requirements: seal.previewPairs[0].requirements })),
      previewPairs: seal.previewPairs, sourceBodyDigest: config.sourceBodyDigest };
    for (const reader of Object.values(descriptor.readers)) for (const pair of [...state.publicPairs, ...state.previewPairs]) {
      if (cms.CONTRACT_KEYS.some(key => !reader.supported[key].includes(pair.requirements[key]))) refuse();
    }
    return { state, readers: descriptor.readers, seal, root };
  };
  return supplied ? inspect(supplied) : firestore.runTransaction(inspect, { readOnly: true });
}

export function retainedReplyBinding({ observed, config, scope }) {
  const index = scope.endsWith("Old") ? 0 : 1, kind = scope.startsWith("public") ? "public" : "preview";
  const pairDigest = kind === "public" ? observed.state.publicPairs[index].pairDigest : cms.digest(observed.state.previewPairs[index]);
  return { schemaVersion: 1, sourceBodyDigest: config.sourceBodyDigest,
    sourcePair: p.publicReleasePairReference(observed.seal.oldPair), consumer: { kind, pairDigest },
    expectedPublicSelectorDigest: observed.state.publicSelectorDigest };
}

export async function assertFirstInstallReaderSources({ firestore, config, transaction, observed, allowPausedBootstrap = false, now = Date.now }) {
  for (const feature of source.FEATURES) await source.readRetainedReplyInTransaction({ firestore, transaction,
    binding: retainedReplyBinding({ observed, config, scope: feature === "previewRequest" ? "previewOld" : "publicOld" }),
    feature, body: observed.seal.replies[feature].request, allowPausedBootstrap, now });
  // Both candidate pointers/readers are part of the late readset, including a
  // candidate which was healthy before the final HTTP response was received.
  const guarded = allowPausedBootstrap ? { getAll: (...refs) => transaction.getAll(...refs), get: async ref => {
    const row = await transaction.get(ref);
    return ref.path === cms.SELECTOR_PATH ? { ...row, data: () => source.pausedBootstrapRuntime(row.data(), observed.seal) } : row;
  } } : transaction;
  for (const consumer of observed.seal.previewPairs) {
    let request;
    if (observed.root.schemaVersion === 1) request = (await firstCode.readFirstInstallPreviewCodeBinding({ firestore,
      transaction: guarded, consumer: { previewPairId: consumer.pairId, rendererSha: consumer.rendererSha, workerVersion: consumer.workerVersion }, now: now() })).request;
    else request = { schemaVersion: 2, mode: "current-code-v2", rendererSha: consumer.rendererSha,
      selection: { pair: p.publicReleasePairReference(consumer.pairId === observed.seal.previewPairs[0].pairId ? observed.seal.oldPair : observed.seal.newPair),
        expectedPublicSelectorDigest: observed.state.publicSelectorDigest, previewPairId: consumer.pairId, previewCandidateReceiptId: null } };
    await code.readPairCodeAuthority({ firestore, transaction: guarded, request, deployedReaders: observed.readers, now: now() });
  }
  return cms.digest(observed.state);
}

export async function deriveFirstInstallReaderRequest({ firestore, config, operationId, stage, signal }) {
  const before = await readFirstInstallReaderState({ firestore, config });
  const first = before.root.schemaVersion === 1;
  if ((stage === FIRST_INSTALL_STAGE) !== first || stage !== undefined && stage !== FIRST_INSTALL_STAGE) refuse();
  const replies = {};
  for (const feature of source.FEATURES) replies[feature] = await firestore.runTransaction(transaction => source.readRetainedReplyInTransaction({
    firestore, transaction, binding: retainedReplyBinding({ observed: before, config, scope: feature === "previewRequest" ? "previewOld" : "publicOld" }),
    feature, body: before.seal.replies[feature].request }), { readOnly: true });
  if (!first && before.seal.newPair.readerContractDigest !== before.seal.oldPair.readerContractDigest ||
      source.FEATURES.some(feature => before.seal.previewPairs[1].requirements[feature] !== before.seal.previewPairs[0].requirements[feature])) refuse();
  const cases = [], refusals = [], originalCode = new Map();
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const index = scope.endsWith("Old") ? 0 : 1;
    const consumer = before.seal.previewPairs[index];
    const publicSource = first ? before.seal.oldPair : [before.seal.oldPair, before.seal.newPair][index];
    const binding = retainedReplyBinding({ observed: before, config, scope });
    const pairDigest = scope.startsWith("public") ? before.state.publicPairs[index].pairDigest : cms.digest(consumer);
    let original;
    if (originalCode.has(consumer.pairId)) original = originalCode.get(consumer.pairId);
    else if (first && scope !== "publicNew") {
      original = (await firstCode.prepareFirstInstallPreviewCodeSource({ firestore, deployedReaders: before.readers,
        consumer: { previewPairId: consumer.pairId, rendererSha: consumer.rendererSha, workerVersion: consumer.workerVersion } })).evidence.code;
    } else if (!first) {
      const body = { schemaVersion: 2, mode: "current-code-v2", rendererSha: consumer.rendererSha,
        selection: { pair: p.publicReleasePairReference(publicSource), expectedPublicSelectorDigest: before.state.publicSelectorDigest,
          previewPairId: consumer.pairId, previewCandidateReceiptId: null } };
      original = await code.readPairCodeReplaySource({ firestore, request: body, deployedReaders: before.readers });
    }
    if (original) originalCode.set(consumer.pairId, original);
    const features = first && scope === "publicNew" ? ["publicCode"] : ["publicCode", ...source.FEATURES.filter(feature => feature !== "previewRequest" || scope.startsWith("preview"))];
    for (const feature of features) {
      let body, expected;
      if (feature === "publicCode") {
        if (original) { body = original.request; expected = original.expected; }
        else {
          // Native legacy source authority categorically excludes NEW. Keep its
          // exact refusal separate from all successful responses.
          const oldConsumer = before.seal.previewPairs[0];
          body = { schemaVersion: 2, mode: "current-code-v2", rendererSha: oldConsumer.rendererSha,
            selection: { pair: p.publicReleasePairReference(before.seal.newPair), expectedPublicSelectorDigest: before.state.publicSelectorDigest,
              previewPairId: oldConsumer.pairId, previewCandidateReceiptId: null } };
          expected = { status: 503, contentType: "application/json", bodyDigest: hash(JSON.stringify({ error: "Private pair CODE unavailable" })) };
        }
      } else {
        const nativeBody = before.seal.replies[feature].request;
        const reply = replies[feature];
        body = { ...nativeBody, retained: binding };
        expected = { status: 200, contentType: "application/json", bodyDigest: hash(reply.json) };
      }
      for (const version of [1, 2]) {
        const row = { scope, feature, version, pairDigest, endpoint: endpoints[feature], body, expected,
          ...(first ? { sourcePairDigest: p.publicReleaseDigest(scope === "publicNew" ? before.seal.newPair : before.seal.oldPair) } : {}) };
        (first && scope === "publicNew" ? refusals : cases).push(row);
      }
    }
  }
  const after = await readFirstInstallReaderState({ firestore, config });
  if (!same(before, after)) refuse();
  return parseCmsReaderBridgeRequest({ schemaVersion: 2, operationId, expectedStateDigest: cms.digest(before.state),
    readers: before.readers, cases, ...(first ? { stage: FIRST_INSTALL_STAGE, legacyPublicSelectorDigest: before.state.publicSelectorDigest, refusals } : {}) });
}
