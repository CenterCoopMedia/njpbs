import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import { parseRehearsalPacket, rehearsalOperationId, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { BOOTSTRAP_PREFLIGHTS, readOnlyBootstrapFirestore } from './public-release-bootstrap-preflight.mjs';
import { assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { InstalledRehearsalStop } from './rehearsal-installed-stop.mjs';
import { readRehearsalInstalledState } from './rehearsal-installed-state.mjs';
import { captureRehearsalInstalledCensus, readRehearsalInstalledCensus } from './rehearsal-installed-census.mjs';
import { readRehearsalPairQualifications } from './rehearsal-public-qualification.mjs';
import { inspectPrivatePairPublisherTarget } from './private-pair-publisher-target.mjs';
import { cloudflarePrivatePairProvider } from './public-release-private-provider.mjs';
import { readRehearsalPrivateWorker } from './rehearsal-private-worker-readback.mjs';
import { readRehearsalReaderGateways } from './rehearsal-reader-gateways.mjs';
import { parsePrivateBridgePacket } from './public-release-private-bridge-operator.mjs';
import { verifyRehearsalRoot, readOriginalRehearsalProof } from './public-release-rehearsal-proof.mjs';
import { rehearsalPreviewReaderAdapter, assertRehearsalPreviewReadersCurrent } from './rehearsal-preview-readers.mjs';
import { createPairedAdminPagesHttp } from './paired-admin-pages-provider.mjs';
import { assertRehearsalHoldRuntimeSource } from './rehearsal-installed-hold.mjs';
import { readRehearsalCompletion } from './rehearsal-installed-completion.mjs';
import { matchesInstalledPublisherIntent, readInstalledPublisherCompletion } from './installed-publisher-pair.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const native = path => typedRequire(path, import.meta.url);
const { readGuardedPublicReleaseSwitchAttempt, readGuardedPublicReleaseSwitchReceipt } = native('../../site/scripts/public-release-switch-operator.ts');
const { openStagedPublicReleasePairCodePack } = native('../../site/scripts/public-release-pair-code-pack-executor.ts');
const { createPrivatePairReaderClient } = native('../../site/scripts/public-release-pair-reader-client.ts');
const { readerSealPath } = native('../../site/scripts/public-release-pair-private-reader.ts');
export const INSTALLED_REHEARSAL_PUBLICATIONS = Object.freeze(['baseline', 'during-preparation', 'while-corrupt', 'hold-old',
  'after-switch', 'retry-new', 'withdraw', 'scheduled', 'hold-new', 'after-return']);
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal preflight refused'); };
const result = (layer, evidence) => Object.freeze({ receiptDigest: protocol.publicReleaseDigest({
  kind: 'installed-development-rehearsal-preflight', layer, evidence }) });

/** Seven native read-only consumers. Credential functions are transport
 * boundaries; no callback can supply a qualification, switch or PASS result.
 * Construction is inert. Every invocation rechecks current SDK authority.
 */
export function createInstalledRehearsalPreflights({ firestore, packet: raw, probeDocumentId, installed, census,
  qualifications, store, readToken, readerCredentials, httpCredential, previewReaders, admin,
  completion, sourceSha, adapterDigest, executionDigest, signal, authorized = false, fetchImpl = fetch } = {}) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !protocol.digest(adapterDigest)) refuse();
  if (rehearsalSourceCommit() !== sourceSha) refuse();
  if (createHash('sha256').update(readFileSync(packet.adapter)).digest('hex') !== adapterDigest) refuse();
  if (admin?.target?.environment !== 'development' || admin.target.projectId !== 'njpbs-site-dev') refuse();
  if (!Array.isArray(installed?.publishers) || installed.publishers.length !== 2 ||
      !Array.isArray(installed.workers) || installed.workers.length !== 4 || typeof readToken !== 'function' ||
      !Array.isArray(readerCredentials) || readerCredentials.length !== 2 || readerCredentials.some(fn => typeof fn !== 'function')) refuse();
  const readonly = readOnlyBootstrapFirestore(firestore);
  const pairs = [packet.oldPair, packet.newPair];
  const publishers = installed.publishers.map(value => Object.freeze({ plan: protocol.freeze(structuredClone(value.plan)), prepared: value.prepared }));
  const workers = installed.workers.map(value => Object.freeze({ ...value, config: protocol.freeze(structuredClone(value.config)), source: Uint8Array.from(value.source) }));
  const gateways = (installed.gateways ?? []).map(parsePrivateBridgePacket);
  if (packet.schemaVersion === 2 && (gateways.length !== 2 || fetchImpl !== fetch)) refuse();
  const accountId = publishers[0].plan.accountId;
  if (publishers.some((value, index) => value.plan.accountId !== accountId || !matchesInstalledPublisherIntent(value.plan, pairs[index]))) refuse();
  const provider = cloudflarePrivatePairProvider({ accountId, credential: readToken, fetcher: fetchImpl });
  const observe = () => readRehearsalInstalledState({ firestore, packet, probeDocumentId, signal, authorized: true });
  const stable = action => async () => {
    signal?.throwIfAborted();
    if (rehearsalSourceCommit() !== sourceSha) refuse();
    const before = await observe(), evidence = await action(before), after = await observe();
    if (!same(before, after)) refuse();
    if (rehearsalSourceCommit() !== sourceSha) refuse();
    signal?.throwIfAborted(); return evidence;
  };
  const originals = async () => {
    if (!Array.isArray(completion?.publications) || completion.publications.length !== INSTALLED_REHEARSAL_PUBLICATIONS.length) refuse();
    const rows = [];
    for (const step of INSTALLED_REHEARSAL_PUBLICATIONS) {
      const entry = completion.publications.filter(row => row.step === step);
      if (entry.length !== 1) refuse();
      protocol.exact(entry[0], ['step', 'path']);
      rows.push(await readOriginalRehearsalProof({ firestore: readonly, packet,
        operationId: rehearsalOperationId(packet, step), path: entry[0].path }));
    }
    return rows;
  };
  const switches = async () => {
    assertRehearsalHoldRuntimeSource(pairs);
    const receipts = [];
    for (const [step, from, to] of [['switch-new', 0, 1], ['return-old', 1, 0]]) {
      const operationId = rehearsalOperationId(packet, step);
      const attempt = await readGuardedPublicReleaseSwitchAttempt({ firestore: readonly, operationId });
      const receipt = await readGuardedPublicReleaseSwitchReceipt({ firestore: readonly, operationId });
      if (!attempt || !receipt || !same(attempt.oldPair, pairs[from]) || !same(attempt.newPair, pairs[to]) ||
          !same(receipt.selector.selectedPair, protocol.publicReleasePairReference(pairs[to]))) refuse();
      receipts.push(receipt);
    }
    if (receipts[1].selector.epoch !== receipts[0].selector.epoch + 1) refuse();
    return receipts;
  };
  return Object.freeze({
    1: stable(async state => {
      const original = await readonly.runTransaction(transaction => enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({
        firestore: readonly, transaction }), { readOnly: true });
      return result(1, { state, enrollment: original });
    }),
    2: stable(async () => {
      if (packet.schemaVersion === 1 && fetchImpl === fetch) refuse();
      const seal = await readRehearsalInstalledCensus(census, census?.receiptDigest);
      const current = await captureRehearsalInstalledCensus({ firestore: readonly, packet, sourceSha, authorized: true,
        publishers: publishers.map(value => value.plan), ...(gateways.length ? { gateways } : {}), workers: workers.map((value, index) => {
          const config = { ...value.config }; delete config.main;
          return { role: ['slot-old', 'slot-new', 'ingress', 'operator'][index], attemptId: value.attemptId,
            attemptPlanDigest: value.attemptPlanDigest, workerName: value.config.name, versionId: value.versionId,
            workerPlanDigest: protocol.publicReleaseDigest({ config, sourceDigest: createHash('sha256').update(value.source).digest('hex') }) };
        }) });
      if (current.receiptDigest !== seal.receiptDigest) refuse();
      await readRehearsalInstalledCensus(current, seal.receiptDigest);
      const targets = [];
      for (const [index, value] of publishers.entries()) {
        await readInstalledPublisherCompletion({ firestore: readonly, plan: value.plan, pair: pairs[index] });
        const target = await inspectPrivatePairPublisherTarget({ firestore: readonly, ...value, readToken, fetchImpl });
        if (!same(target.pair, pairs[index]) || !target.evidence.trigger) refuse();
        targets.push(target);
      }
      const receipts = [];
      for (const value of workers) receipts.push(await readRehearsalPrivateWorker({ firestore: readonly, provider, ...value, signal }));
      const readerGateways = gateways.length ? await readRehearsalReaderGateways({ firestore: readonly, packet, gateways,
        readToken, sourceSha, signal, authorized: true, fetchImpl }) : null;
      return result(2, { seal, targets, receipts, readerGateways });
    }),
    3: stable(async () => readRehearsalPairQualifications({ firestore: readonly, packet, qualifications, store, signal, authorized: true })),
    4: stable(async state => {
      const root = await verifyRehearsalRoot({ packet, selector: state.selector, httpCredential });
      const receipts = [];
      for (const [index, pair] of pairs.entries()) {
        const opened = await openStagedPublicReleasePairCodePack({ firestore: readonly, store, pair, signal });
        const view = (await readonly.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${opened.record.viewManifestDigest}`).get()).data();
        const seals = (await readonly.doc(readerSealPath(pair)).get()).data();
        const read = createPrivatePairReaderClient({ pair, seals, credentials: readerCredentials[index] });
        const path = '/', bytes = await opened.readMember(path);
        const reply = await read({ identity: opened.record.identity, claimDigest: opened.record.claimDigest,
          manifestDigest: opened.record.viewManifestDigest, manifestBytes: view?.manifestBytes, paths: [path], signal });
        if (reply.stagedReadbackDigest !== opened.record.readbackDigest || reply.outputs.length !== 1 ||
            !Buffer.from(reply.outputs[0].bodyBase64, 'base64').equals(Buffer.from(bytes))) refuse();
        receipts.push({ record: opened.record, reply });
      }
      return result(4, { root, receipts });
    }),
    5: stable(async () => result(5, { switches: await switches(), operations: await originals() })),
    6: stable(async () => {
      const readers = rehearsalPreviewReaderAdapter(previewReaders), state = await readers.readLiveState();
      await readonly.runTransaction(transaction => assertRehearsalPreviewReadersCurrent(previewReaders, firestore, transaction), { readOnly: true });
      const http = createPairedAdminPagesHttp({ ...admin, signal });
      const providers = await http.readLiveReaderIdentities();
      const active = await http.activeId();
      if (active !== admin?.baseline?.deploymentId) refuse();
      await http.verifyDeployment(active, null, admin.baseline.artifact);
      await http.verifyActiveBytes(admin.baseline.artifact, active);
      return result(6, { state, providers, active, baseline: admin.baseline });
    }),
    7: stable(async state => result(7, await readRehearsalCompletion({ firestore: readonly, packet, sourceSha, executionDigest,
      adapterDigest, completion, state, switches: await switches(), originals: await originals(), signal }))),
  });
}

/** Explicit installed-development mode. The old emulator runner keeps its
 * closed target contract. This entrypoint constructs only the seven native
 * consumers above; callers cannot replace individual checks with callbacks.
 */
export async function runInstalledRehearsalPreflights(options) {
  const packet = parseRehearsalPacket(options?.packet);
  if (options?.authorized !== true || packet.schemaVersion !== 2 || packet.setupMode !== 'preinstalled' ||
      packet.projectId !== 'njpbs-site-dev' || options.firestore?.projectId !== packet.projectId) refuse();
  assertDevelopmentRehearsalEnvironment();
  const adapters = createInstalledRehearsalPreflights(options), results = [];
  for (const { layer, name } of BOOTSTRAP_PREFLIGHTS) {
    try {
      const observation = await adapters[layer]();
      if (!protocol.digest(observation?.receiptDigest)) refuse();
      results.push({ layer, name, status: 'PASS', receiptDigest: observation.receiptDigest });
    } catch (error) {
      results.push(error instanceof InstalledRehearsalStop
        ? { layer, name, status: 'STOP', code: error.code, issue: error.issue, blockedStep: error.blockedStep }
        : { layer, name, status: 'FAIL', code: 'installed-rehearsal-preflight-refused' });
    }
  }
  const context = { projectId: packet.projectId, sourceSha: options.sourceSha,
    adapterDigest: options.adapterDigest, packetDigest: protocol.publicReleaseDigest(packet) };
  return protocol.freeze({ schemaVersion: 1, kind: 'rnp-bootstrap-installed-development-preflight', context, results,
    passed: results.every(row => row.status === 'PASS'), productionAuthority: false,
    digest: protocol.publicReleaseDigest({ context, results }) });
}
