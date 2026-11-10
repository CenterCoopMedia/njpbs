import { createRequire } from 'node:module';
import pairs from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import { BRIDGE_PROOFS, BRIDGE_ATTEMPTS, prepareInstalledCmsReaderConsumers } from './cms-reader-bridge-install.mjs';
import { createPairedAdminPagesHttp } from './paired-admin-pages-provider.mjs';
import { armRehearsalPreviewFault } from './rehearsal-preview-fault.mjs';

const require = createRequire(import.meta.url);
const preview = require('../../functions/lib/cms-preview-pair.js');
const sessions = require('../../functions/lib/cms-reader-session.js');
const bridge = require('../../functions/lib/cms-reader-bridge-proof.js');
const prepared = new WeakMap();
const same = (a, b) => pairs.publicReleaseDigest(a) === pairs.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal deployed reader proof refused'); };

function inputs({ firestore, packet, retainedState, admin }) {
  const demo = packet?.schemaVersion === 1 && /^demo-[a-z0-9-]+$/.test(packet.projectId) &&
    /^127\.0\.0\.1:\d+$/.test(packet.emulatorHost) && process.env.FIRESTORE_EMULATOR_HOST === packet.emulatorHost &&
    typeof admin?.fetchImpl === 'function' && admin.fetchImpl !== fetch;
  const development = packet?.schemaVersion === 2 && packet.projectId === 'njpbs-site-dev' && packet.emulatorHost === null &&
    process.env.FIRESTORE_EMULATOR_HOST === undefined;
  if ((!demo && !development) || firestore?.projectId !== packet.projectId ||
      admin?.target?.environment !== 'development' || admin.target.projectId !== 'njpbs-site-dev' ||
      !retainedState || Buffer.byteLength(JSON.stringify(retainedState)) > 64 * 1024) refuse();
  pairs.exact(retainedState, ['schemaVersion', 'publicSelectorDigest', 'publicPairs', 'previewPairs']);
  if (retainedState.schemaVersion !== 2 || !pairs.digest(retainedState.publicSelectorDigest) ||
      !Array.isArray(retainedState.publicPairs) || retainedState.publicPairs.length !== 2 ||
      !Array.isArray(retainedState.previewPairs) || retainedState.previewPairs.length !== 2) refuse();
  const publicPairs = [packet.oldPair, packet.newPair].map(pair => pairs.parsePublicReleasePair(pair));
  publicPairs.forEach((pair, index) => {
    work.assertPrivatePairResources(pair);
    const entry = retainedState.publicPairs[index];
    pairs.exact(entry, ['pairDigest', 'requirements']); pairs.exact(entry.requirements, preview.CONTRACT_KEYS);
    if (pair.environment !== 'development' || entry.pairDigest !== pairs.publicReleaseDigest(pair) ||
        Object.values(entry.requirements).some(value => !Number.isSafeInteger(value) || value < 1 || value > 100)) refuse();
  });
  if (publicPairs[0].pairId === publicPairs[1].pairId) refuse();
  retainedState.previewPairs.forEach((value, index) => {
    const pair = preview.parsePair(value), reference = packet.previewPairs[index === 0 ? 'old' : 'new'];
    if (['pairId', 'rendererSha', 'serializerId'].some(key => pair[key] !== reference?.[key])) refuse();
  });
  if (retainedState.previewPairs[0].pairId === retainedState.previewPairs[1].pairId) refuse();
  return { publicPairs, retainedState: pairs.freeze(structuredClone(retainedState)) };
}

function readerStatePaths({ publicPairs, retainedState }) {
  return ['system/publicDeployment', ...publicPairs.map(pair => work.publicReleasePairPath(pair.pairId)),
    preview.SELECTOR_PATH, ...retainedState.previewPairs.map(pair => `${preview.PAIRS}/${pair.pairId}`),
    ...['functions', 'cmsApi'].map(component => `${preview.READER_RECEIPTS}/${component}`)];
}
function readerReadset(context) {
  return Object.freeze([...new Set([...readerStatePaths(context),
    `${BRIDGE_PROOFS}/${context.bridgeOperationId}`, `${BRIDGE_ATTEMPTS}/${context.bridgeOperationId}`,
    `${BRIDGE_PROOFS}/${bridge.cmsReaderBridgeProofKey(context.record.proof.readers)}`])]);
}

async function snapshot(context, transaction, records = null) {
  const { firestore, publicPairs, retainedState } = context;
  const paths = readerStatePaths(context);
  const [publicRoot, publicOld, publicNew, previewRoot, previewOld, previewNew, functionsReader, cmsApiReader] =
    records ? paths.map(path => records.get(path)) : await transaction.getAll(...paths.map(path => firestore.doc(path)));
  const selector = pairs.parseStoredPublicReleaseSelector(publicRoot.data());
  if (pairs.publicReleaseDigest(selector) !== retainedState.publicSelectorDigest ||
      ![selector.selectedPair, selector.recoveryPair].every(reference => publicPairs.some(pair => same(reference, pairs.publicReleasePairReference(pair))))) refuse();
  publicPairs.forEach((pair, index) => { if (!same(pair, pairs.parsePublicReleasePair([publicOld, publicNew][index].data()))) refuse(); });
  const previewSelector = preview.parseSelector(previewRoot.data());
  const previewPairs = [previewOld, previewNew].map(row => preview.parsePair(row.data()));
  if (!same(previewPairs, retainedState.previewPairs) ||
      ![previewSelector.selectedPairId, previewSelector.recoveryPairId].every(id => previewPairs.some(pair => pair.pairId === id))) refuse();
  preview.assertProjection(previewSelector, previewPairs.find(pair => pair.pairId === previewSelector.selectedPairId));
  const readers = Object.fromEntries(Object.entries({ functions: functionsReader, cmsApi: cmsApiReader }).map(([component, row]) => {
    const receipt = row.data(), reader = preview.currentReader(receipt, component);
    for (const pair of [...retainedState.publicPairs, ...previewPairs]) {
      if (preview.CONTRACT_KEYS.some(key => !reader.supported[key].includes(pair.requirements[key]))) refuse();
    }
    return [component, { schemaVersion: receipt.schemaVersion, component: receipt.component,
      state: receipt.state, lastComplete: reader }];
  }));
  return { attested: retainedState, state: pairs.freeze({ ...retainedState, readers }) };
}

/** This consumes an actual installed bridge proof. Requirements and expected
 * cases are never certified by copying a caller's hashes: the complete state
 * must match the original bridge owner's immutable state digest first. */
export async function prepareRehearsalPreviewReaders({ firestore, packet, retainedState, bridgeOperationId, admin, signal, now = Date.now }) {
  const checked = inputs({ firestore, packet, retainedState, admin });
  if (typeof bridgeOperationId !== 'string' || !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(bridgeOperationId) ||
      typeof now !== 'function' || !Number.isSafeInteger(now())) refuse();
  const http = createPairedAdminPagesHttp({ ...admin, signal });
  const context = { firestore, ...checked, bridgeOperationId, http, signal, now,
    adminOptions: Object.freeze({ ...admin, target: structuredClone(admin.target) }) };
  const record = bridge.parseInstalledCmsReaderProof((await firestore.collection(BRIDGE_PROOFS).doc(bridgeOperationId).get()).data(), bridgeOperationId);
  if (record.proof.stateDigest !== preview.digest(checked.retainedState)) refuse();
  const expectedPairs = { publicOld: checked.retainedState.publicPairs[0].pairDigest, publicNew: checked.retainedState.publicPairs[1].pairDigest,
    previewOld: preview.digest(checked.retainedState.previewPairs[0]), previewNew: preview.digest(checked.retainedState.previewPairs[1]) };
  if (record.proof.results.some(row => row.pairDigest !== expectedPairs[row.scope])) refuse();
  const guard = await prepareInstalledCmsReaderConsumers({ firestore, operationId: bridgeOperationId,
    readProviders: () => http.readLiveReaderIdentities(), now, signal,
    assertStateInTransaction: async ({ transaction }) => preview.digest((await snapshot(context, transaction)).attested) });
  context.record = pairs.freeze(structuredClone(record)); context.guard = guard;
  const handle = Object.freeze({ digest: pairs.publicReleaseDigest({ bridgeOperationId, evidenceDigest: guard.digest,
    stateDigest: record.proof.stateDigest, targetDigest: http.targetDigest }) });
  prepared.set(handle, context);
  await current(context);
  return handle;
}

async function current(context, transaction = null) {
  context.signal?.throwIfAborted();
  const at = context.now();
  if (!Number.isSafeInteger(at) || at < Date.parse(context.record.proof.verifiedAt) || at - Date.parse(context.record.proof.verifiedAt) > 300_000) refuse();
  const providers = transaction ? null : await context.http.readLiveReaderIdentities();
  const read = async tx => {
    const rows = await tx.getAll(...readerReadset(context).map(path => context.firestore.doc(path)));
    const records = new Map(rows.map(row => [row.ref.path, row]));
    await context.guard.assertCurrentInTransaction({ transaction: tx });
    const record = records.get(`${BRIDGE_PROOFS}/${context.bridgeOperationId}`);
    const attempt = records.get(`${BRIDGE_ATTEMPTS}/${context.bridgeOperationId}`);
    if (!same(record.data(), context.record) || attempt.data()?.state !== 'complete' ||
        attempt.data()?.requestDigest !== context.record.proof.requestDigest || !same(attempt.data()?.proof, context.record.proof)) refuse();
    const result = await snapshot(context, tx, records);
    for (const component of ['functions', 'cmsApi']) {
      const reader = preview.currentReader(result.state.readers[component], component);
      if (sessions.readerSessionDigest(reader) !== context.record.proof.readerIdentities[component] ||
          providers && !same(providers[component], reader.providerIdentities)) refuse();
    }
    return result;
  };
  return transaction ? read(transaction) : context.firestore.runTransaction(read, { readOnly: true });
}

function stateFor(handle) { const context = prepared.get(handle); if (!context) refuse(); return context; }

/** The guard and audit share the same exact source references. The operation
 * comes from the opaque handle, never the retained identity's older proof. */
export function rehearsalPreviewReaderReadset(handle) {
  return readerReadset(stateFor(handle));
}

/** Reader-source evidence only. The caller still uses the real selection and
 * Admin owners; this handle grants no provider or selector mutation. */
export function rehearsalPreviewReaderAdapter(handle) {
  const context = stateFor(handle);
  const projection = (component, side) => context.record.proof.results.filter(row => row.component === component &&
    [side === 'old' ? 'publicOld' : 'publicNew', side === 'old' ? 'previewOld' : 'previewNew'].includes(row.scope));
  return Object.freeze({
    async readLiveState() { return (await current(context)).state; },
    async replayDeployedReader({ component, reader, state }) {
      if (!['functions', 'cmsApi'].includes(component)) refuse();
      const observed = (await current(context)).state;
      const actual = preview.currentReader(observed.readers[component], component);
      if (!same(observed, state) || !same(actual, reader)) refuse();
      return { digest: pairs.publicReleaseDigest({ bridgeOperationId: context.bridgeOperationId,
        originalRequestDigest: context.record.proof.requestDigest, old: projection(component, 'old'), next: projection(component, 'new') }),
      readerDigest: preview.digest(actual), stateDigest: preview.digest(observed) };
    },
    async provePrivate(pair) {
      if (!context.retainedState.previewPairs.some(value => same(value, preview.parsePair(pair)))) refuse();
      const observed = (await current(context)).state;
      return { pairDigest: preview.digest(pair), savedInputsDigest: pairs.publicReleaseDigest({
        bridgeOperationId: context.bridgeOperationId, originalRequestDigest: context.record.proof.requestDigest,
        stateDigest: context.record.proof.stateDigest, results: context.record.proof.results }),
      readerDigests: Object.fromEntries(['functions', 'cmsApi'].map(component => [component,
        preview.digest(preview.currentReader(observed.readers[component], component))])),
      replays: Object.fromEntries(['functions', 'cmsApi'].flatMap(component => ['old', 'new'].map(side => [
        `${component}${side === 'old' ? 'Old' : 'New'}`, pairs.publicReleaseDigest(projection(component, side))]))) };
    },
  });
}

/** Actual installed proof/readset guard for the owning selector CAS. */
export async function assertRehearsalPreviewReadersCurrent(handle, firestore, transaction) {
  const context = stateFor(handle);
  if (context.firestore !== firestore) refuse();
  await current(context, transaction);
  return handle.digest;
}

/** Keep the same original proof/readset while interrupting one actual reader
 * provider request. Arming verifies the opaque fault before using its fetch;
 * a copied transport cannot substitute a successful reader identity. */
export function withRehearsalPreviewReaderFault(handle, fault) {
  const context = stateFor(handle);
  if (fault?.boundary !== 'functions') refuse();
  armRehearsalPreviewFault(fault);
  const signal = AbortSignal.any([fault.signal, ...(context.signal ? [context.signal] : [])]);
  const child = Object.freeze({ digest: handle.digest });
  prepared.set(child, { ...context, signal, http: createPairedAdminPagesHttp({ ...context.adminOptions,
    fetchImpl: fault.fetch, signal }) });
  return child;
}
