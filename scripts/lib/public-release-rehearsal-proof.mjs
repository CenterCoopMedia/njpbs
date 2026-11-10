import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import serving from '../../functions/lib/public-release-serving.js';
import admissions from '../../functions/lib/public-release-admission-contract.js';
import terminal from '../../functions/lib/public-release-terminal.js';
import targets from '../../functions/lib/publication-target.js';
import { hasRehearsalHttpCredential, rehearsalHttpHeaders } from './public-release-rehearsal-http-auth.mjs';

const target = targets.publicationTarget('development');
const rootPath = '/_publication-v2.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => protocol.publicReleaseDigest(left) === protocol.publicReleaseDigest(right);
const refuse = () => { throw new Error('Rehearsal original proof refused'); };

function pairsFor(packet, selector) {
  const pairs = [packet.oldPair, packet.newPair].map(pair => protocol.parsePublicReleasePair(pair));
  if (pairs.some(pair => pair.environment !== 'development') || pairs[0].pairId === pairs[1].pairId) refuse();
  const selected = pairs.find(pair => same(protocol.publicReleasePairReference(pair), selector.selectedPair));
  const recovery = pairs.find(pair => same(protocol.publicReleasePairReference(pair), selector.recoveryPair));
  if (!selected || !recovery || selected.pairId === recovery.pairId) refuse();
  return { selected, recovery };
}

function assertDatabase(firestore, packet) {
  if (firestore?.projectId !== packet.projectId) refuse();
  if (packet.schemaVersion === 2) {
    if (packet.projectId !== target.projectId || packet.emulatorHost !== null ||
        process.env.FIRESTORE_EMULATOR_HOST !== undefined) refuse();
  } else if (packet.schemaVersion !== 1 || !/^demo-[a-z0-9-]+$/.test(packet.projectId) ||
      !/^127\.0\.0\.1:\d+$/.test(packet.emulatorHost) || process.env.FIRESTORE_EMULATOR_HOST !== packet.emulatorHost) refuse();
}

async function bodyBytes(response, limit) {
  const chunks = []; let size = 0;
  try {
    if (!response.body) return Buffer.alloc(0);
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) refuse();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** The parent owns this opaque capability and both loopback listeners. The
 * terminal owner can use this real HTTP transport without a provider token. */
export function createRehearsalIngressProof({ packet, httpCredential }) {
  if (!hasRehearsalHttpCredential(httpCredential, [packet.ingressOrigin, packet.proofOrigin])) refuse();
  return Object.freeze({
    async prove(request, bodyDigest, { status } = {}) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.origin !== target.origin || url.search || url.hash ||
          url.pathname.length > 1024 || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(url.pathname) ||
          url.pathname.split('/').some(part => part === '.' || part === '..') ||
          url.username || url.password || !protocol.digest(bodyDigest) || ![200, 308, 410].includes(status)) refuse();
      let response;
      try {
        response = await fetch(new URL(url.pathname, packet.proofOrigin), { redirect: 'manual', cache: 'no-store',
          headers: { ...rehearsalHttpHeaders(httpCredential, packet.proofOrigin),
            'x-rehearsal-expected-sha256': bodyDigest, 'x-rehearsal-expected-status': String(status) },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(3_000)]) });
        if (response.status !== status || response.headers.get('cache-control') !== 'private, no-store') refuse();
        return response;
      } catch { await response?.body?.cancel().catch(() => {}); refuse(); }
    },
  });
}

function rootHeaders(packet, httpCredential) {
  const bound = hasRehearsalHttpCredential(httpCredential, [packet.ingressOrigin, packet.proofOrigin]);
  if (packet.schemaVersion === 2) {
    if (packet.projectId !== target.projectId || packet.emulatorHost !== null || !bound) refuse();
    return rehearsalHttpHeaders(httpCredential, packet.ingressOrigin);
  }
  if (packet.schemaVersion !== 1 || typeof packet.projectId !== 'string' || !/^demo-[a-z0-9-]+$/.test(packet.projectId) ||
      typeof packet.emulatorHost !== 'string' || !/^127\.0\.0\.1:\d+$/.test(packet.emulatorHost) ||
      process.env.FIRESTORE_EMULATOR_HOST !== packet.emulatorHost || packet.ingressOrigin === packet.proofOrigin) refuse();
  try {
    for (const origin of [packet.ingressOrigin, packet.proofOrigin]) {
      const url = new URL(origin), port = Number(url.port);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== origin ||
          !Number.isInteger(port) || port <= 1023 || port > 65535 || url.username || url.password || url.search || url.hash) refuse();
    }
  } catch { refuse(); }
  if (httpCredential === undefined) return {};
  if (!bound) refuse();
  return rehearsalHttpHeaders(httpCredential, packet.ingressOrigin);
}

/** Root bytes must be the canonical projection of this exact current SDK
 * selector. A successful legacy root or provider deployment is insufficient. */
export async function verifyRehearsalRoot({ packet, selector: raw, httpCredential }) {
  const selector = protocol.parsePublicReleaseSelector(raw), { selected } = pairsFor(packet, selector);
  const headers = rootHeaders(packet, httpCredential);
  let response;
  try {
    response = await fetch(new URL(rootPath, packet.ingressOrigin), { redirect: 'manual', cache: 'no-store',
      headers, signal: AbortSignal.timeout(3_000) });
    if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store' ||
        response.headers.get('publication-refresh') === 'pending' || response.headers.get('x-njpbs-publication-refresh') === 'pending' ||
        response.headers.get('x-njpbs-publication-origin') !== target.workerName ||
        response.headers.get('content-type')?.split(';')[0] !== 'application/json') refuse();
    const bytes = await bodyBytes(response, 64 * 1024);
    const expected = { schemaVersion: 2, environment: 'development', epoch: selector.epoch,
      pair: selector.selectedPair, codeReceiptDigest: selected.codeAssetManifestDigest,
      contentHead: selector.contentHead, selectorDigest: protocol.publicReleaseDigest(selector) };
    if (!same(JSON.parse(bytes.toString('utf8')), expected) || hash(bytes) !== protocol.publicReleaseDigest(expected)) refuse();
    return { selectorDigest: expected.selectorDigest, bodyDigest: hash(bytes), bytes: bytes.length };
  } catch { await response?.body?.cancel().catch(() => {}); refuse(); }
}

/** Read only the original owner's immutable FACT and digest-addressed byte
 * evidence. This reader cannot create acceptance, execution or settlement. */
export async function readOriginalRehearsalProof({ firestore, packet, operationId, path }) {
  assertDatabase(firestore, packet);
  return firestore.runTransaction(async transaction => {
    const admission = admissions.parseAdmission((await transaction.get(
      firestore.doc(`${admissions.ADMISSIONS}/operations/${operationId}`))).data());
    if (admission.operationId !== operationId) refuse();
    const receipt = await terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
      operationId, admissionDigest: protocol.publicReleaseDigest(admission) });
    if (receipt.outcome !== 'success' || !receipt.originalExecution) refuse();
    const rows = await transaction.getAll(firestore.doc(`${admissions.ADMISSIONS}/canonicalProofs/${receipt.canonicalProofDigest}`),
      firestore.doc(`${admissions.ADMISSIONS}/coverageProofs/${receipt.coverageDigest}`));
    const canonical = rows[0].data(), coverage = rows[1].data();
    if (!canonical || !coverage || Buffer.byteLength(JSON.stringify(canonical)) > 750_000 ||
        Buffer.byteLength(JSON.stringify(coverage)) > 750_000 ||
        protocol.publicReleaseDigest(canonical) !== receipt.canonicalProofDigest || protocol.publicReleaseDigest(coverage) !== receipt.coverageDigest ||
        canonical.schemaVersion !== 2 || canonical.operationId !== operationId || canonical.selectorDigest !== receipt.selectorDigest ||
        coverage.schemaVersion !== 2 || coverage.operationId !== operationId || coverage.admissionDigest !== receipt.admissionDigest ||
        !same(coverage.originalExecution, receipt.originalExecution) || !Array.isArray(canonical.proofs) || !canonical.proofs.length) refuse();
    const proofs = canonical.proofs.filter(proof => proof.path === path);
    if (proofs.length !== 1 || ![200, 308, 410].includes(proofs[0].status) || !protocol.digest(proofs[0].bodyDigest) ||
        !Number.isSafeInteger(proofs[0].bytes) || proofs[0].bytes < 0 || proofs[0].bytes > 16 * 1024 * 1024 ||
        proofs[0].status === 410 && (proofs[0].bytes !== 0 || proofs[0].bodyDigest !== hash(''))) refuse();
    const original = ['old', 'new'].find(side => same(protocol.publicReleasePairReference(packet[`${side}Pair`]), admission.pair));
    if (!original) refuse();
    return { operation: { operationId, originalPair: original, snapshotDigest: admission.source.snapshotDigest,
      sourceVersion: admission.source.sourceVersion, claimDigest: receipt.originalExecution.claimDigest,
      acceptedCount: 1, terminalCount: 1, terminalReceiptDigest: protocol.publicReleaseDigest(receipt) },
    proof: proofs[0], admissionDigest: receipt.admissionDigest,
    canonicalProofDigest: receipt.canonicalProofDigest, coverageDigest: receipt.coverageDigest };
  }, { readOnly: true });
}

/** Bind an adapter's expectations to the actual owner and current route before
 * the harness performs its existing unconditional private HTTP byte check. */
export async function verifyOriginalRehearsalProof({ firestore, packet, operation, proof, selector, httpCredential }) {
  assertDatabase(firestore, packet);
  const source = await readOriginalRehearsalProof({ firestore, packet, operationId: operation.operationId, path: proof.path });
  if (!same(source.operation, operation) || source.proof.status !== proof.status || source.proof.bodyDigest !== proof.bodyDigest) refuse();
  const before = await serving.readPublicReleaseSelector({ firestore, environment: 'development' });
  if (!same(before.selector, selector)) refuse();
  const { selected } = pairsFor(packet, before.selector);
  const decision = await serving.readPublicReleaseDecision({ firestore, environment: 'development', selection: before,
    pair: selected, path: proof.path, composedReadersEnabled: true });
  if (decision.kind !== 'decision' || decision.epoch !== before.selector.epoch || decision.pairId !== selected.pairId ||
      decision.route.operationId && (decision.route.operationId !== operation.operationId ||
        decision.route.sourceVersion !== operation.sourceVersion || decision.route.snapshotDigest !== operation.snapshotDigest) ||
      proof.status === 410 && decision.route.kind !== 'gone') refuse();
  const root = await verifyRehearsalRoot({ packet, selector: before.selector, httpCredential });
  const after = await serving.readPublicReleaseSelector({ firestore, environment: 'development' });
  if (!same(before.selector, after.selector)) refuse();
  return { schemaVersion: 1, operationId: operation.operationId, admissionDigest: source.admissionDigest,
    canonicalProofDigest: source.canonicalProofDigest, coverageDigest: source.coverageDigest,
    currentSelectorDigest: root.selectorDigest, rootBodyDigest: root.bodyDigest };
}
