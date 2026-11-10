import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import { parseOperatorArgs, readOperatorPacket, assertOperatorSource, operatorRefused as refuse } from './public-release-operator-io.mjs';
import { parseProductionInstallIdentity, assertProductionInstallEnvironment, openProductionInstallSdk,
  productionInstallCredential as pipe, productionInstallToken as token } from './production-install-binding.mjs';
import { parseProductionAdoptionPacket, runProductionAdoption } from './development-public-release-adoption.mjs';
import { parseProductionPreviewAttempt, runProductionPreview } from './production-public-release-preview.mjs';
import { deferInstalledConsumerProvider } from '../development-public-release-adoption.mjs';
const { require: native } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { createInstalledConsumerProvider } = native('../../site/scripts/public-release-installed-consumer-provider.ts', import.meta.url);
const { createBootstrapS3Reads } = native('../../site/scripts/public-release-bootstrap-s3-read.ts', import.meta.url);
const { parsePreviewStorageCredential } = native('../../site/scripts/cms-preview-storage-credential.ts', import.meta.url);

export function parseProductionPublicReleasePacket(raw) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'credentialIdentity', 'step', 'attempt']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'production-public-release-adoption' || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '')) refuse();
  parseProductionInstallIdentity(raw.credentialIdentity);
  if (['pause', 'restore-legacy-runtime'].includes(raw.step)) pause.parsePublicReleasePauseAttempt(raw.attempt);
  else if (raw.step === 'pause-recovery') {
    protocol.exact(raw.attempt, ['schemaVersion', 'pauseAttempt', 'pauseReceiptDigest', 'failureReceiptDigest']);
    if (raw.attempt.schemaVersion !== 1 || !protocol.digest(raw.attempt.pauseReceiptDigest) || !protocol.digest(raw.attempt.failureReceiptDigest)) refuse();
    pause.parsePublicReleasePauseAttempt(raw.attempt.pauseAttempt);
  }
  else if (['preview-pause', 'preview-restore'].includes(raw.step)) parseProductionPreviewAttempt(raw.attempt);
  else return parseProductionAdoptionPacket(raw);
  if (['pause', 'restore-legacy-runtime', 'pause-recovery'].includes(raw.step) &&
      (raw.attempt.pauseAttempt ?? raw.attempt).environment !== 'production') refuse();
  return protocol.freeze(structuredClone(raw));
}
/** Public canonical reads carry no private credential and never follow a
 * redirect to another authority. The packet cannot choose an HTTP destination. */
export function productionCanonicalRequest(request = fetch) {
  return async (input, init = {}) => {
    const url = new URL(String(input)), headers = new Headers(init.headers);
    if (url.origin !== 'https://njpbs.org' || url.username || url.password || url.search || url.hash ||
        !['GET', 'HEAD'].includes(init.method ?? 'GET') || init.body ||
        init.redirect !== undefined && !['manual', 'error'].includes(init.redirect) ||
        [...headers.keys()].some(name => ['authorization', 'cookie', 'cf-access-client-id', 'cf-access-client-secret'].includes(name))) refuse();
    return request(url, { ...init, headers, redirect: init.redirect ?? 'error', cache: 'no-store' });
  };
}
export async function runProductionPublicReleaseOperator(args, { openSdk = openProductionInstallSdk,
  credential = pipe, createObjects = createBootstrapS3Reads, createProvider = createInstalledConsumerProvider,
  request = productionCanonicalRequest(), environment = process.env, signal = AbortSignal.timeout(120_000), evidence = {} } = {}) {
  const options = parseOperatorArgs(args), packet = parseProductionPublicReleasePacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha); signal.throwIfAborted();
  const { step, attempt } = packet;
  if (step === 'pause-recovery') return { step, mode: options.mode, stop: true, canContinue: false,
    reason: 'production-failed-pause-recovery-unavailable',
    recoveryCommitted: false, drainCommitted: false, acceptedWorkChanged: 0,
    authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  if (options.mode === 'plan') return { step, mode: 'plan', authorityReads: 0, authorityWrites: 0, providerWrites: 0 };
  // The injected SDK opener is the process boundary for loopback tests; the
  // production opener enforces the shared ambient/emulator guard before fd3.
  assertProductionInstallEnvironment(environment);
  const pipes = []; let connection, objects;
  try {
    let provider;
    if (options.mode === 'apply' && ['controls', 'initial', 'resume'].includes(step)) {
      const google = credential(5, token); pipes.push(google);
      provider = deferInstalledConsumerProvider(() => createProvider({ environment: 'production', readGoogleToken: google.read }));
      if (step !== 'controls') {
        const r2 = credential(4, parsePreviewStorageCredential); pipes.push(r2);
        objects = createObjects({ environment: 'production', readCredential: r2.read });
      }
    }
    connection = await openSdk(packet.credentialIdentity, 3); signal.throwIfAborted();
    const firestore = connection.firestore;
    if (firestore.projectId !== 'njpbs-site') refuse();
    let result;
    if (step === 'pause') result = await (options.mode === 'readback' ? pause.readPublicReleasePause : pause.pausePublicRelease)({ firestore, attempt });
    else if (step === 'restore-legacy-runtime') result = await (options.mode === 'readback' ? pause.readPublicReleaseRuntimeRestore : pause.restorePublicReleasePausedRuntime)({ firestore, attempt });
    else if (['preview-pause', 'preview-restore'].includes(step)) result = await runProductionPreview({ firestore, attempt,
      mode: options.mode, restore: step === 'preview-restore', signal });
    else result = await runProductionAdoption({ firestore, packet, objects, provider, request, signal, evidence, mode: options.mode });
    return { step, mode: options.mode, acceptedWorkChanged: 0, providerWrites: 0, ...result,
      ...(result.stop ? { reason: 'production-failed-pause-recovery-unavailable' } : {}) };
  } finally { objects?.close(); pipes.forEach(value => value.close()); await connection?.close(); }
}
