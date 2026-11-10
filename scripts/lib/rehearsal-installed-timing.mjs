import { assertDevelopmentSource } from "../render-development-config.mjs";
import { devAccessOrigin } from "./deployment-settings.mjs";
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import targets from '../../functions/lib/publication-target.js';
import { assertDevelopmentRehearsalEnvironment, openDevelopmentRehearsalContext } from './development-rehearsal-credentials.mjs';
import { parsePrivatePublisherOperatorPacket } from './private-pair-publisher-operator.mjs';
import { preparePrivatePairPublisher } from './private-pair-publisher-provider.mjs';
import { inspectPrivatePairPublisherTarget } from './private-pair-publisher-target.mjs';
import { cloudflarePrivatePairProvider, privateWorkerMetadata } from './public-release-private-provider.mjs';
import { configurePublicReleaseIngress, configurePublicReleaseSlot } from '../configure-public-release-ingress.mjs';
import { readRehearsalPrivateWorker } from './rehearsal-private-worker-readback.mjs';
import { createRehearsalTimingDispatch } from './rehearsal-timing-dispatch.mjs';
import { parseRehearsalOperatorAccessTarget, createRehearsalOperatorAccess } from './rehearsal-operator-access.mjs';
import { bindInstalledTimingSetup } from './rehearsal-installed-timing-gate.mjs';
import { matchesInstalledPublisherIntent, readInstalledPublisherCompletion } from './installed-publisher-pair.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { createBootstrapS3Reads } = typedRequire('../../site/scripts/public-release-bootstrap-s3-read.ts', import.meta.url);
const { parsePreviewStorageCredential } = typedRequire('../../site/scripts/cms-preview-storage-credential.ts', import.meta.url);
const { createPrivatePairOperatorClient } = typedRequire('../../site/scripts/public-release-pair-operator-client.ts', import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed development timing setup refused'); };
const portable = value => { const config = { ...value }; delete config.main; return config; };

function environment() {
  assertDevelopmentRehearsalEnvironment();
  if (![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
}
function source(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) refuse();
  const options = { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] };
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  if (execFileSync('/usr/bin/git', [...args, 'rev-parse', 'HEAD'], options).trim() !== sha ||
      !assertDevelopmentSource(options.cwd)) refuse();
}
async function bytes(reference, maximum) {
  protocol.exact(reference, ['filename', 'digest']);
  if (typeof reference.filename !== 'string' || reference.filename.length > 1024 || !protocol.digest(reference.digest)) refuse();
  const filename = await realpath(reference.filename), metadata = await stat(filename);
  if (filename !== resolve(reference.filename) || !metadata.isFile() || metadata.size < 1 || metadata.size > maximum) refuse();
  const value = await readFile(filename);
  if (value.length > maximum || hash(value) !== reference.digest) refuse();
  return value;
}
const json = async reference => JSON.parse((await bytes(reference, 750_000)).toString('utf8'));
async function privateWorker(reference) {
  protocol.exact(reference, ['attemptId', 'attemptPlanDigest', 'versionId', 'configuration', 'source']);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(reference.attemptId ?? '') || !protocol.digest(reference.attemptPlanDigest)) refuse();
  const config = await json(reference.configuration), body = await bytes(reference.source, 1024 * 1024);
  const planDigest = protocol.publicReleaseDigest({ config: portable(config), sourceDigest: hash(body) });
  // Unsupported owner/configuration bindings refuse before any credential.
  privateWorkerMetadata(config, protocol.publicReleaseDigest({ attemptId: reference.attemptId, planDigest }));
  return { ...reference, config, source: body };
}
function pipe(fd) {
  const metadata = fstatSync(fd);
  if (!metadata.isFIFO() && !metadata.isSocket()) refuse();
  return new Socket({ fd, readable: true, writable: false, pauseOnCreate: true });
}
function credential(stream, parse) {
  let pending;
  return () => pending ??= (async () => {
    const chunks = []; let size = 0, joined;
    stream.setTimeout(10_000, () => stream.destroy(new Error('Timing credential source expired')));
    try {
      for await (const chunk of stream) {
        const value = Buffer.from(chunk); chunks.push(value); size += value.length;
        if (size > 4096) refuse();
      }
      joined = Buffer.concat(chunks); return parse(joined.toString('utf8'));
    } finally { joined?.fill(0); chunks.forEach(value => value.fill(0)); stream.destroy(); }
  })();
}


export async function readInstalledPublisherInputs(reference, pair) {
  protocol.exact(reference, ['packet', 'multipart', 'configuration']);
  const packet = parsePrivatePublisherOperatorPacket(await json(reference.packet));
  if (packet.credentialIdentity.projectId !== 'njpbs-site-dev' || packet.intent.executorReady !== true || packet.intent.continuationEnabled !== true) refuse();
  const publisherConfig = await json(reference.configuration);
  const prepared = await preparePrivatePairPublisher({ multipart: await bytes(reference.multipart, 64 * 1024 * 1024),
    config: publisherConfig, imageReference: packet.intent.imageReference });
  const upload = packet.preparation.plan;
  if (!prepared.executorReady || !prepared.continuationEnabled || prepared.bundleDigest !== upload.bundleDigest ||
      prepared.configurationDigest !== upload.configurationDigest || !same(prepared.moduleManifest, packet.preparation.moduleManifest) ||
      !matchesInstalledPublisherIntent(upload, pair)) refuse();
  return { upload, publisherConfig, prepared };
}

export { bytes as readInstalledInputBytes, json as readInstalledInputJson };

/** Explicit installed-development entrypoint for the timing CLI. The plan
 * holds nonsecret original references only. Fd3=development SDK credential,
 * fd4=provider read token, fd5=R2 read credential, fd6=operator Access headers.
 * No provider/runtime probe or source mutation occurs at construction.
 */
export async function openInstalledPublicationTimingSetup(options) {
  try { return await openBoundSetup(options); }
  catch { return refuse(); }
}
export async function readInstalledTimingInputs({ plan: raw, pair: rawPair, authorized = false, signal } = {}) {
  if (authorized !== true) refuse();
  environment(); signal?.throwIfAborted();
  const plan = protocol.freeze(structuredClone(raw)), pair = protocol.parsePublicReleasePair(rawPair);
  protocol.exact(plan, ['schemaVersion', 'kind', 'projectId', 'sourceSha', 'publisher', 'slots', 'ingress', 'operator', 'operatorAccess', 'publications']);
  if (plan.schemaVersion !== 1 || plan.kind !== 'installed-development-publication-timing' || plan.projectId !== 'njpbs-site-dev' ||
      pair.environment !== 'development' || !Array.isArray(plan.slots) || plan.slots.length !== 2) refuse();
  work.assertPrivatePairResources(pair); source(plan.sourceSha);
  const { upload, publisherConfig, prepared } = await readInstalledPublisherInputs(plan.publisher, pair);
  const slots = [], ingress = await privateWorker(plan.ingress), operator = await privateWorker(plan.operator);
  const pairs = JSON.parse(ingress.config.vars.PUBLIC_PAIR_IDENTITIES_JSON);
  if (!Array.isArray(pairs) || pairs.length !== 2 || !pairs.some(value => same(protocol.parsePublicReleasePair(value), pair))) refuse();
  pairs.forEach(value => { if (value.environment !== 'development') refuse(); work.assertPrivatePairResources(value); });
  const expectedIngress = configurePublicReleaseIngress({ oldPair: pairs[0], newPair: pairs[1], accountId: upload.accountId,
    ingressName: ingress.config.name, compatibilityDate: ingress.config.compatibility_date,
    developmentIngress: ingress.config.vars.PUBLIC_PAIR_BOOTSTRAP_ID === "" });
  expectedIngress.vars.PUBLIC_PAIR_INGRESS_ENABLED = 'true';
  for (const key of ['PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED', 'PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED']) {
    if (!['true', 'false'].includes(ingress.config.vars[key])) refuse();
    expectedIngress.vars[key] = ingress.config.vars[key];
  }
  if (!same(portable(ingress.config), portable(expectedIngress)) || publisherConfig.services?.[0]?.service !== ingress.config.name) refuse();
  for (const [index, reference] of plan.slots.entries()) {
    const slot = await privateWorker(reference), vars = slot.config.vars;
    const expected = configurePublicReleaseSlot({ pair: pairs[index], accountId: upload.accountId, readerOrigin: vars.PAIR_PRIVATE_ORIGIN,
      readerAccess: { enabled: true, audience: vars.PAIR_ACCESS_AUDIENCE, clientId: vars.PAIR_ACCESS_CLIENT_ID }, slotEnabled: true,
      compatibilityDate: slot.config.compatibility_date });
    if (!same(portable(slot.config), portable(expected)) || slot.versionId !== pairs[index].publicWorker.versionId) refuse();
    slots.push(slot);
  }
  const vars = operator.config.vars, origin = new URL(vars.PAIR_PRIVATE_ORIGIN);
  protocol.exact(plan.operatorAccess, ['domainId', 'zoneId', 'applicationId', 'policyId', 'serviceTokenId']);
  const operatorTarget = parseRehearsalOperatorAccessTarget({ ...plan.operatorAccess, accountId: upload.accountId,
    workerName: operator.config.name, versionId: operator.versionId, origin: origin.origin,
    audience: vars.PAIR_ACCESS_AUDIENCE, clientId: vars.PAIR_ACCESS_CLIENT_ID });
  if (origin.protocol !== 'https:' || origin.origin !== vars.PAIR_PRIVATE_ORIGIN || origin.username || origin.password ||
      vars.PAIR_PRIVATE_HTTP_ENABLED !== 'true' || vars.CMS_DEV_ACCESS_ORIGIN !== devAccessOrigin() || vars.PAIR_PROOF_ORIGIN !== targets.publicationTarget('development').origin ||
      !/^[a-f0-9]{64}$/.test(vars.PAIR_ACCESS_AUDIENCE ?? '') || !/^[A-Za-z0-9]+\.access$/.test(vars.PAIR_ACCESS_CLIENT_ID ?? '') ||
      !same(JSON.parse(vars.PAIR_READER_ACCESS_JSON), slots.map(slot => ({ audience: slot.config.vars.PAIR_ACCESS_AUDIENCE, clientId: slot.config.vars.PAIR_ACCESS_CLIENT_ID }))) ||
      operator.config.name === ingress.config.name || slots.some(slot => slot.config.vars.PAIR_PRIVATE_ORIGIN === origin.origin) ||
      operator.config.services?.length !== 1 || !same(operator.config.services[0], { binding: 'PAIR_INGRESS_PROOF', service: ingress.config.name,
        entrypoint: 'PublicReleaseIngressProofEntrypoint' }) || operator.config.account_id !== upload.accountId) refuse();
  source(plan.sourceSha); signal?.throwIfAborted();
  return { plan, pair, upload, publisherConfig, prepared, slots, ingress, operator, operatorTarget, origin, vars, pairs };
}
async function openBoundSetup({ plan: raw, pair: rawPair, cases, authorized = false, signal } = {}) {
  const { plan, pair, upload, prepared, slots, ingress, operator, operatorTarget, origin, vars } =
    await readInstalledTimingInputs({ plan: raw, pair: rawPair, authorized, signal });
  const streams = []; let context, objects, gate, closed = false;
  const close = async () => {
    closed = true; gate?.close(); streams.forEach(stream => stream.destroy());
    try { objects?.close(); } finally { await context?.close(); }
  };
  try {
    for (const fd of [3, 4, 5, 6]) streams.push(pipe(fd));
    const readToken = credential(streams[1], value => { const token = value.trim(); if (!/^[A-Za-z0-9_-]{20,256}$/.test(token)) refuse(); return token; });
    const readStorage = credential(streams[2], parsePreviewStorageCredential);
    const readAccess = credential(streams[3], value => {
      const headers = JSON.parse(value); protocol.exact(headers, ['CF-Access-Client-Id', 'CF-Access-Client-Secret']);
      if (headers['CF-Access-Client-Id'] !== vars.PAIR_ACCESS_CLIENT_ID || typeof headers['CF-Access-Client-Secret'] !== 'string' || !headers['CF-Access-Client-Secret']) refuse();
      return headers;
    });
    context = await openDevelopmentRehearsalContext(streams[0]);
    const firestore = context.firestore;
    await readInstalledPublisherCompletion({ firestore, plan: upload, pair });
    objects = createBootstrapS3Reads({ environment: 'development', readCredential: readStorage });
    const provider = cloudflarePrivatePairProvider({ accountId: upload.accountId, credential: readToken });
    const operatorAccess = createRehearsalOperatorAccess({ target: operatorTarget, readToken, authorized: true });
    const client = createPrivatePairOperatorClient({ origin: origin.origin, credentials: readAccess });
    const current = () => {
      environment(); signal?.throwIfAborted(); if (closed) refuse();
    };
    const ingressProof = Object.freeze({ async prove(request, digest, expected) {
      current(); const url = new URL(request.url);
      if (request.method !== 'GET' || url.origin !== targets.publicationTarget('development').origin || url.search || url.hash ||
          !protocol.digest(digest) || ![200, 308, 410].includes(expected?.status)) refuse();
      return client.prove({ path: url.pathname, bodyDigest: digest, status: expected.status, signal: request.signal });
    } });
    const dispatch = createRehearsalTimingDispatch({ firestore, pair, cases, publications: plan.publications, authorized: true });
    gate = bindInstalledTimingSetup({ firestore, assertCurrent: current,
      store: { get(key) { return objects.getWithSignal(key, AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])); } },
      ingress: ingressProof, async verifyInstalled(requested) {
        if (!same(requested, pair)) refuse();
        await readInstalledPublisherCompletion({ firestore, plan: upload, pair });
        const target = await inspectPrivatePairPublisherTarget({ firestore, plan: upload, prepared, readToken });
        if (!same(target.pair, pair) || !target.evidence.trigger) refuse();
        for (const worker of [...slots, ingress]) await readRehearsalPrivateWorker({ firestore, provider, ...worker, signal });
        await readRehearsalPrivateWorker({ firestore, provider, ...operator, signal, operatorAccess });
      }, async dispatch(input, sampleSignal) { await dispatch(input, AbortSignal.any([sampleSignal, ...(signal ? [signal] : [])])); } });
    return { setup: gate.setup, close };
  } catch { await close(); return refuse(); }
}
