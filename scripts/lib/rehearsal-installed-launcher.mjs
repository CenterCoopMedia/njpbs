import { createRequire } from 'node:module';
import { fstatSync } from 'node:fs';
import { Socket } from 'node:net';
import protocol from '../../functions/lib/public-release-pair.js';
import { parseRehearsalPacket, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { readInstalledTimingInputs, readInstalledPublisherInputs, readInstalledInputBytes as bytes,
  readInstalledInputJson as json } from './rehearsal-installed-timing.mjs';
import { assertDevelopmentRehearsalEnvironment, createDevelopmentCredentialSource, openDevelopmentSourceContext,
  closeDevelopmentCredentialSource } from './development-rehearsal-credentials.mjs';
import { parsePrivateBridgePacket } from './public-release-private-bridge-operator.mjs';
import { createRehearsalOperatorAccess } from './rehearsal-operator-access.mjs';
import { createRehearsalQualificationStore } from './rehearsal-qualification-store.mjs';
import { preparePrivatePreviewPair } from './private-preview-pair-provider.mjs';
import { preparePairedAdminArtifact } from './paired-admin-pages-artifact.mjs';
import { createInstalledRehearsalSession, closeInstalledRehearsalSession } from './rehearsal-installed-session.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const native = path => typedRequire(path, import.meta.url);
const { createBootstrapS3Reads } = native('../../site/scripts/public-release-bootstrap-s3-read.ts');
const { parsePreviewStorageCredential } = native('../../site/scripts/cms-preview-storage-credential.ts');
const { createPrivatePairOperatorClient } = native('../../site/scripts/public-release-pair-operator-client.ts');
const { startDevelopmentRehearsalHttp } = native('../../site/scripts/public-release-rehearsal-http.ts');
const refuse = () => { throw new Error('Installed development rehearsal launcher refused'); };
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function pipe(fd) {
  const state = fstatSync(fd); if (!state.isFIFO() && !state.isSocket()) refuse();
  return new Socket({ fd, readable: true, writable: false, pauseOnCreate: true });
}
function credential(stream, parse) {
  let pending;
  return () => pending ??= (async () => {
    const chunks = []; let size = 0, joined;
    const timer = setTimeout(() => stream.destroy(new Error('Credential source refused')), 10_000);
    try {
      for await (const chunk of stream) { const value = Buffer.from(chunk); chunks.push(value); size += value.length; if (size > 32_768) refuse(); }
      joined = Buffer.concat(chunks); return parse(joined.toString('utf8'));
    } finally { clearTimeout(timer); joined?.fill(0); chunks.forEach(value => value.fill(0)); stream.destroy(); }
  })();
}
const token = value => {
  const result = value.trim(); if (!/^[\x21-\x7e]{1,32768}$/.test(result)) refuse(); return result;
};
const access = clientId => value => {
  const result = JSON.parse(value); protocol.exact(result, ['CF-Access-Client-Id', 'CF-Access-Client-Secret']);
  if (result['CF-Access-Client-Id'] !== clientId || typeof result['CF-Access-Client-Secret'] !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(result['CF-Access-Client-Secret'])) refuse();
  return result;
};
async function artifact(reference) {
  protocol.exact(reference, ['directory', 'sourceSha', 'manifestDigest']);
  if (!protocol.digest(reference.manifestDigest)) refuse();
  const result = await preparePairedAdminArtifact({ directory: reference.directory, sourceSha: reference.sourceSha, environment: 'development' });
  if (result.manifestDigest !== reference.manifestDigest) refuse(); return result;
}

/** Fixed installed-development composition. This function never installs a
 * resource or changes a flag. All file references are nonsecret, hash-bound
 * original packets/build artifacts. Credentials arrive on inherited pipes.
 * No caller-supplied fetch, SDK identity, success callback or module path.
 */
export async function openInstalledRehearsalLauncher({ plan: raw, authorized = false, signal, recoveryOnly = false } = {}) {
  if (authorized !== true || typeof recoveryOnly !== 'boolean') refuse();
  assertDevelopmentRehearsalEnvironment();
  const plan = protocol.freeze(structuredClone(raw));
  protocol.exact(plan, ['schemaVersion', 'kind', 'sourceSha', 'packet', 'timing', 'companionPublisher', 'gateways',
    'publications', 'scheduledPath', 'probeDocumentId', 'holdDurationMs', 'preview', 'readerRefresh', 'viewerClientId', 'adminClientId']);
  if (plan.schemaVersion !== 1 || plan.kind !== 'installed-development-rehearsal' || rehearsalSourceCommit() !== plan.sourceSha ||
      ![plan.viewerClientId, plan.adminClientId].every(value => /^[A-Za-z0-9]+\.access$/.test(value ?? ''))) refuse();
  const packet = parseRehearsalPacket(await json(plan.packet));
  if (packet.schemaVersion !== 2 || packet.setupMode !== 'preinstalled') refuse();
  const timing = await readInstalledTimingInputs({ plan: await json(plan.timing), pair: packet.oldPair, signal, authorized: true });
  if (timing.plan.sourceSha !== plan.sourceSha || !same(timing.pairs, [packet.oldPair, packet.newPair]) ||
      timing.ingress.config.vars.PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED !== 'true') refuse();
  const companion = await readInstalledPublisherInputs(plan.companionPublisher, packet.newPair);
  if (companion.publisherConfig.services?.[0]?.service !== timing.ingress.config.name) refuse();
  if (!Array.isArray(plan.gateways) || plan.gateways.length !== 2) refuse();
  const gateways = (await Promise.all(plan.gateways.map(json))).map(parsePrivateBridgePacket);
  for (const [index, gateway] of gateways.entries()) {
    const target = gateway.accessReadback.targets[index], slot = timing.slots[index].config.vars;
    if (gateway.role !== ['old-reader', 'new-reader'][index] || gateway.enabled !== true ||
        !same(gateway.pairs, [packet.oldPair, packet.newPair]) || target.origin !== slot.PAIR_PRIVATE_ORIGIN ||
        target.clientId !== slot.PAIR_ACCESS_CLIENT_ID || target.audience !== slot.PAIR_ACCESS_AUDIENCE) refuse();
  }
  protocol.exact(plan.preview, ['pair', 'configuration', 'multipart', 'image', 'resourceOperationId', 'request',
    'adminTarget', 'baselineArtifact', 'candidateArtifact', 'baselineDeploymentId']);
  const preview = plan.preview;
  const preparedPreview = await preparePrivatePreviewPair({ pair: await json(preview.pair), config: await json(preview.configuration),
    multipart: await bytes(preview.multipart, 32 * 1024 * 1024), image: preview.image });
  const baselineArtifact = await artifact(preview.baselineArtifact), candidateArtifact = await artifact(preview.candidateArtifact);
  const previewRequest = await json(preview.request), adminTarget = await json(preview.adminTarget);
  if (preparedPreview.environment !== 'development' || adminTarget.environment !== 'development' || adminTarget.projectId !== packet.projectId ||
      candidateArtifact.sourceSha !== previewRequest.candidate?.sourceSha) refuse();
  protocol.exact(plan.readerRefresh, ['baseline', 'templates', 'targets', 'candidates']);
  const refresh = Object.fromEntries(await Promise.all(Object.entries(plan.readerRefresh).map(async ([key, reference]) => [key, await json(reference)])));
  const publications = await json(plan.publications);
  const controller = new AbortController();
  signal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const streams = []; let developmentCredential, context, reads, store, http, operatorAccess, installedSession, closed = false;
  async function close() {
    if (closed) return; closed = true;
    controller.abort(); closeInstalledRehearsalSession(installedSession);
    streams.forEach(stream => stream.destroy()); operatorAccess?.close();
    try { await http?.close(); } finally {
      try { store?.close(); reads?.close(); } finally {
        try { await context?.close(); } finally { if (developmentCredential) closeDevelopmentCredentialSource(developmentCredential); }
      }
    }
  }
  try {
    // Reserve every inherited descriptor before the SDK opens sockets. Merely
    // wrapping these paused pipes does not fetch their credential values.
    for (let fd = 3; fd <= 14; fd++) streams.push(pipe(fd));
    developmentCredential = createDevelopmentCredentialSource(streams[0]);
    const readToken = credential(streams[1], token), readStorage = credential(streams[2], parsePreviewStorageCredential);
    const operatorCredentials = credential(streams[3], access(timing.vars.PAIR_ACCESS_CLIENT_ID));
    const ingressCredentials = credential(streams[4], access(plan.viewerClientId));
    const readerCredentials = timing.slots.map((slot, index) => credential(streams[5 + index], access(slot.config.vars.PAIR_ACCESS_CLIENT_ID)));
    const readCloudflareToken = credential(streams[7], token), readGoogleToken = credential(streams[8], token);
    const readAccessHeaders = credential(streams[9], access(plan.adminClientId));
    const readStaffToken = credential(streams[10], token), readEdgeSecret = credential(streams[11], token);
    context = await openDevelopmentSourceContext(developmentCredential);
    reads = createBootstrapS3Reads({ environment: 'development', readCredential: readStorage });
    store = createRehearsalQualificationStore({ pairs: [packet.oldPair, packet.newPair],
      reads: { get: key => reads.getWithSignal(key, AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])) },
      readCredential: readStorage, signal, authorized: true });
    http = await startDevelopmentRehearsalHttp({ projectId: packet.projectId, operatorOrigin: timing.origin.origin,
      operatorCredentials, ingressCredentials, ingressPort: Number(new URL(packet.ingressOrigin).port),
      proofPort: Number(new URL(packet.proofOrigin).port), authorized: true });
    if (http.ingressOrigin !== packet.ingressOrigin || http.proofOrigin !== packet.proofOrigin) refuse();
    operatorAccess = createRehearsalOperatorAccess({ target: timing.operatorTarget, readToken, authorized: true });
    const operator = createPrivatePairOperatorClient({ origin: timing.origin.origin, credentials: operatorCredentials });
    const admin = { target: adminTarget, prepared: candidateArtifact, baseline: { deploymentId: preview.baselineDeploymentId, artifact: baselineArtifact },
      readCloudflareToken, readGoogleToken, readAccessHeaders, authorized: true };
    const { FieldValue } = createRequire(import.meta.url)('firebase-admin/firestore');
    installedSession = await createInstalledRehearsalSession({ packet, firestore: context.firestore, sourceSha: plan.sourceSha,
      executionDigest: protocol.publicReleaseDigest(plan),
      installed: { publishers: [timing, companion].map(value => ({ plan: value.upload, prepared: value.prepared })), gateways,
        workers: [...timing.slots, timing.ingress, { ...timing.operator, operatorAccess }] },
      store, readerCredentials, readToken, developmentCredential, httpCredential: http.httpCredential, fieldValues: FieldValue,
      captureRecovery: signal => operator.captureRecovery(signal), publications, scheduledPath: plan.scheduledPath,
      probeDocumentId: plan.probeDocumentId, holdDurationMs: plan.holdDurationMs,
      preview: { admin, runtime: { prepared: preparedPreview, resourceOperationId: preview.resourceOperationId, request: previewRequest,
        readToken, readSecret: async () => refuse() } },
      readerRefresh: { ...refresh, readStaffToken, readEdgeSecret }, signal, recoveryOnly, authorized: true });
    return Object.freeze({ packet, installedSession, developmentCredential, httpCredential: http.httpCredential, close });
  } catch { await close(); return refuse(); }
}
