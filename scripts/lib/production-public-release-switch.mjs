import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import { parseOperatorArgs, readOperatorPacket, assertOperatorSource } from './public-release-operator-io.mjs';
import { assertProductionInstallEnvironment, parseProductionInstallIdentity, openProductionInstallSdk,
  productionInstallCredential, productionInstallAccess, productionInstallToken } from './production-install-binding.mjs';
import { initialPairNative as native } from './initial-pair-native.mjs';
import { createProductionSwitchStore } from './production-public-release-switch-store.mjs';
const { runCurrentPublicReleaseSwitch, readPublicReleaseSwitchOutcome, observeCurrentPublicReleaseOperation } =
  native('../../site/scripts/public-release-switch-runner.ts', import.meta.url);
const { parseReaderSeals, canonicalPath } = native('../../site/scripts/public-release-pair-reader-contract.ts', import.meta.url);
const { parsePreviewStorageCredential } = native('../../site/scripts/cms-preview-storage-credential.ts', import.meta.url);
const { createPrivatePairOperatorClient } = native('../../site/scripts/public-release-pair-operator-client.ts', import.meta.url);
const { readCommittedPairRecovery, committedRecoveryKey } = native('../../workers/src/public-release-recovery.ts', import.meta.url);
const refuse = () => { throw new Error('Production public release switch refused; preserve the original packet'); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function accessTarget(value) {
  protocol.exact(value, ['origin', 'clientId']);
  const url = new URL(value.origin);
  if (url.protocol !== 'https:' || url.origin !== value.origin || url.username || url.password ||
      !/^[a-z][a-z0-9-]{0,62}\.njpbs\.org$/.test(url.hostname) || url.hostname.startsWith('dev-') ||
      !/^[A-Za-z0-9]+\.access$/.test(value.clientId ?? '')) refuse();
}
export function parseProductionSwitchPacket(raw) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'credentialIdentity', 'oldPair', 'newPair',
    'direction', 'operationId', 'forwardOperationId', 'qualificationAttemptId', 'readers', 'operator', 'ingressAdoption', 'observations']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'production-public-release-switch' || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') ||
      !['new', 'old'].includes(raw.direction) || !id(raw.operationId) || !id(raw.qualificationAttemptId) ||
      (raw.direction === 'new' ? raw.forwardOperationId !== null : !id(raw.forwardOperationId) || raw.forwardOperationId === raw.operationId)) refuse();
  parseProductionInstallIdentity(raw.credentialIdentity);
  const pairs = [raw.oldPair, raw.newPair].map(protocol.parsePublicReleasePair);
  if (pairs.some(pair => pair.environment !== 'production') || pairs[0].pairId === pairs[1].pairId) refuse();
  pairs.forEach(work.assertPrivatePairResources);
  if (!Array.isArray(raw.readers) || raw.readers.length !== 2) refuse();
  raw.readers.forEach(accessTarget); accessTarget(raw.operator);
  protocol.exact(raw.ingressAdoption, ['filename', 'digest']);
  if (typeof raw.ingressAdoption.filename !== 'string' || !raw.ingressAdoption.filename.startsWith('/') ||
      !protocol.digest(raw.ingressAdoption.digest)) refuse();
  if (new Set([...raw.readers, raw.operator].map(row => row.origin)).size !== 3 ||
      !Array.isArray(raw.observations) || raw.observations.length > 32) refuse();
  for (const observation of raw.observations) {
    protocol.exact(observation, ['operationId', 'path', 'sourceVersion', 'snapshotDigest', 'status']);
    if (!id(observation.operationId) || !canonicalPath(observation.path) || observation.path.startsWith('/_pair-') ||
        !Number.isSafeInteger(observation.sourceVersion) || observation.sourceVersion < 1 ||
        !protocol.digest(observation.snapshotDigest) || ![200, 308, 410].includes(observation.status)) refuse();
  }
  return protocol.freeze(structuredClone(raw));
}
const access = expected => raw => {
  const headers = productionInstallAccess(raw);
  if (headers['CF-Access-Client-Id'] !== expected.clientId) refuse();
  return headers;
};

export async function runProductionSwitchCommand(args) {
  const observe = args[4] === '--observe', capture = args[4] === '--capture-recovery';
  const options = parseOperatorArgs(observe || capture ? [...args.slice(0, 4), '--readback', ...args.slice(5)] : args);
  const packet = parseProductionSwitchPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha); assertProductionInstallEnvironment();
  const mode = observe ? 'observe' : capture ? 'capture-recovery' : options.mode;
  if (mode === 'plan') return { mode, direction: packet.direction, operationId: packet.operationId, authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  if (observe && !packet.observations.length) refuse();
  // Reserve ALL needed pipes before the SDK can allocate those descriptors.
  const pipes = []; let context, store;
  const pipe = (fd, parse) => { const value = productionInstallCredential(fd, parse); pipes.push(value); return value; };
  try {
    const storage = mode === 'readback' ? null : pipe(4, parsePreviewStorageCredential);
    const readers = mode === 'apply' ? packet.readers.map((row, index) => pipe(5 + index, access(row))) : [];
    const operator = observe || capture ? pipe(7, access(packet.operator)) : null;
    const provider = mode === 'apply' && packet.direction === 'new' ? pipe(8, productionInstallToken) : null;
    context = await openProductionInstallSdk(packet.credentialIdentity, 3);
    const firestore = context.firestore;
    const [from, to] = packet.direction === 'new' ? [packet.oldPair, packet.newPair] : [packet.newPair, packet.oldPair];
    const input = { firestore, from, to, operationId: packet.operationId };
    if (packet.direction === 'old') {
      const forward = await readPublicReleaseSwitchOutcome({ firestore, from: packet.oldPair, to: packet.newPair, operationId: packet.forwardOperationId });
      if (!forward.receipt) refuse(); // Return binds the original OLD, never a reconstructed baseline.
    }
    if (mode === 'readback') return { mode, ...await readPublicReleaseSwitchOutcome(input) };
    if (mode === 'apply') {
      const prior = await readPublicReleaseSwitchOutcome(input);
      if (prior.attempt || prior.receipt) return { mode, ...prior, recovered: true };
      if (packet.direction === 'new') {
        const adoption = await readOperatorPacket({ filename: packet.ingressAdoption.filename, packetDigest: packet.ingressAdoption.digest });
        const { adoptProductionPublicReleaseIngress, productionIngressAdoptionConfiguration } = await import('./production-public-release-ingress-adoption.mjs');
        const parsed = productionIngressAdoptionConfiguration(adoption);
        if (!same(parsed.attempt.currentPair, packet.oldPair) || !same(parsed.attempt.recoveryPair, packet.newPair)) refuse();
        const gate = await adoptProductionPublicReleaseIngress({ firestore, packet: adoption, readToken: provider.read, mode: 'readback' });
        if (gate.original !== true || gate.complete !== true || gate.recoveryCaptureEnabled !== true) refuse();
      }
    }
    store = createProductionSwitchStore({ pairs: [packet.oldPair, packet.newPair], readCredential: storage.read, readOnly: observe || capture });
    if (capture) {
      const client = createPrivatePairOperatorClient({ origin: packet.operator.origin, credentials: operator.read });
      await client.captureRecovery();
      const recovery = await readCommittedPairRecovery({ store, environment: 'production', pairs: [packet.oldPair, packet.newPair] });
      const current = (await readPublicReleaseSwitchOutcome(input)).currentSelector;
      if (!same(recovery.selector, current)) refuse();
      return { mode, operationId: packet.operationId, key: committedRecoveryKey('production'), selectorDigest: protocol.publicReleaseDigest(current),
        selection: recovery, advisoryOnly: true, sourceWrites: 0, terminalWrites: 0 };
    }
    if (observe) {
      const outcome = await readPublicReleaseSwitchOutcome(input);
      const pair = [packet.oldPair, packet.newPair].find(pair => same(protocol.publicReleasePairReference(pair), outcome.currentSelector.selectedPair));
      if (!pair) refuse();
      const client = createPrivatePairOperatorClient({ origin: packet.operator.origin, credentials: operator.read });
      const ingress = { prove(request, bodyDigest, expected) {
        return client.prove({ path: new URL(request.url).pathname, bodyDigest, status: expected.status, signal: request.signal });
      } };
      const observations = [];
      for (const observation of packet.observations) observations.push(await observeCurrentPublicReleaseOperation({
        firestore, store, ingress, pair, ...observation }));
      if (observations.some(row => !same(row.selector, observations[0].selector))) refuse();
      return { mode, switch: outcome, observations, terminalWrites: 0, sourceWrites: 0 };
    }
    // The native seals pin the credential destination before either Access
    // pipe is consumed. No caller-selected reader or redirect receives it.
    for (const [index, pair] of [packet.oldPair, packet.newPair].entries()) {
      const seals = parseReaderSeals((await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`).get()).data(), pair);
      if (seals.deployment.origin !== packet.readers[index].origin) refuse();
    }
    const credentials = packet.direction === 'new' ? readers.map(row => row.read) : readers.map(row => row.read).reverse();
    return { mode, ...await runCurrentPublicReleaseSwitch({ ...input, store,
      qualificationAttemptId: packet.qualificationAttemptId, credentials }) };
  } finally { store?.close(); pipes.forEach(pipe => pipe.close()); await context?.close(); }
}
