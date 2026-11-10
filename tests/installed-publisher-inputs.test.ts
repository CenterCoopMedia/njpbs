import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { firstInstallScenario } from './helpers/private-pair-first-install.mjs';
import * as fixture from './helpers/private-pair-publisher-provider.mjs';
import { preparePrivatePairPublisher } from '../scripts/lib/private-pair-publisher-provider.mjs';
import { createInstalledRehearsalPreflights } from '../scripts/lib/rehearsal-installed-preflights.mjs';
import { readInstalledPublisherInputs } from '../scripts/lib/rehearsal-installed-timing.mjs';
import protocol from '../functions/lib/public-release-pair.js';
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

async function inputs() {
  const current = await firstInstallScenario({ continuationEnabled: true });
  const pairs = current.intents.map((intent: any) => {
    const publicWorker = { ...intent.plan.pairTemplate.publicWorker, versionId: randomUUID() };
    return { ...intent.plan.pairTemplate, publicWorker,
      publisher: { ...intent.plan.pairTemplate.publisher, workerVersionId: current.publishers.get(intent.prepared.applicationName).versionId },
      readerReceiptDigest: protocol.publicReleaseDigest({ schemaVersion: 1, environment: 'development', service: publicWorker.service,
        versionId: publicWorker.versionId, commitSha: intent.plan.pairTemplate.commitSha, origin: intent.plan.slotInstall.readerOrigin,
        contractDigest: intent.plan.pairTemplate.readerContractDigest }) };
  });
  return { current, pairs };
}
it('constructs the seven inert rehearsal preflights for versionless publisher intents without SDK/provider authority', async () => {
  const { current, pairs } = await inputs(), adapter = resolve('scripts/lib/public-release-rehearsal-adapter.mjs');
  const packet = { schemaVersion: 1, projectId: 'demo-installed-inputs', emulatorHost: '127.0.0.1:19561',
    runId: 'installed-publisher-inputs', ingressOrigin: 'http://127.0.0.1:18396', proofOrigin: 'http://127.0.0.1:18397', adapter,
    oldPair: pairs[0], newPair: pairs[1], previewPairs: { old: { pairId: 'preview-old', rendererSha: 'a'.repeat(40), serializerId: 'preview-old' },
      new: { pairId: 'preview-new', rendererSha: 'b'.repeat(40), serializerId: 'preview-new' } } };
  const read = vi.fn(() => { throw new Error('Inert construction touched authority'); });
  const options = { firestore: { doc: read, runTransaction: read }, packet, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapterDigest: createHash('sha256').update(readFileSync(adapter)).digest('hex'), installed: {
      publishers: current.intents.map((intent: any) => ({ plan: intent.plan, prepared: intent.prepared })),
      workers: Array.from({ length: 4 }, () => ({ config: {}, source: new Uint8Array([1]) })) },
    readToken: read, readerCredentials: [read, read], authorized: true,
    admin: { target: { environment: 'development', projectId: 'njpbs-site-dev' } } };
  expect(Object.keys(createInstalledRehearsalPreflights(options))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  expect(read).not.toHaveBeenCalled();
  expect(() => createInstalledRehearsalPreflights({ ...options, packet: { ...packet,
    oldPair: { ...pairs[0], readerReceiptDigest: 'f'.repeat(64) } } })).toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('opens exact offline timing publisher bytes for a first-install intent and rejects a substituted slot identity', async () => {
  const { current, pairs } = await inputs(), original = current.intents[0], accountId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const config = structuredClone(current.publishers.get(original.prepared.applicationName).config);
  config.account_id = accountId;
  config.containers[0].image = config.containers[0].image.replace(fixture.accountId, accountId);
  const metadata = fixture.metadata(config); metadata.containers = [{ name: config.name, class_name: 'PairPublicationRuntime' }];
  const multipart = await fixture.multipart(metadata);
  const prepared = await preparePrivatePairPublisher({ multipart, config, imageReference: config.containers[0].image });
  const plan = { ...original.plan, accountId, imageReference: config.containers[0].image,
    bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest };
  const packet = { schemaVersion: 1, kind: 'private-pair-publisher-operator',
    intent: { pairTemplate: plan.pairTemplate, slotInstall: plan.slotInstall, retainedPairs: [], legacyConfig: {},
      imageReference: plan.imageReference, executorReady: true, continuationEnabled: true, ingressProofService: 'njpbs-private-ingress-development' },
    preparation: { schemaVersion: 2, kind: 'private-pair-publisher-preparation', plan, executorReady: true,
      moduleManifest: prepared.moduleManifest, providerWrites: 0, runtimePreflight: 'not-run' },
    preflightOperationId: 'first-install-timing', credentialIdentity: { projectId: 'njpbs-site-dev',
      clientEmail: 'pair-test@njpbs-site-dev.iam.gserviceaccount.com', privateKeyId: 'a'.repeat(40) } };
  const directory = mkdtempSync(join(tmpdir(), 'first-install-timing-')); directories.push(directory);
  const file = (name: string, value: any) => {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
    const filename = join(directory, name); writeFileSync(filename, bytes);
    return { filename, digest: createHash('sha256').update(bytes).digest('hex') };
  };
  const reference = { packet: file('packet.json', packet), multipart: file('worker.multipart', multipart), configuration: file('config.json', config) };
  expect((await readInstalledPublisherInputs(reference, pairs[0])).upload).toEqual(plan);
  await expect(readInstalledPublisherInputs(reference, { ...pairs[0], readerReceiptDigest: 'f'.repeat(64) })).rejects.toThrow();
  await expect(readInstalledPublisherInputs(reference, { ...pairs[0], publicWorker: { ...pairs[0].publicWorker, versionId: pairs[1].publicWorker.versionId } })).rejects.toThrow();
});
