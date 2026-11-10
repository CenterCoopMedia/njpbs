import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_PAGES } from '../../packages/content-core/src/public-pages';
import { installedConsumerFixture } from './public-release-installed-consumers';
import { publicReleaseCodePackFixture } from './public-release-code-pack';
import { sealedPair } from './sealed-public-release-pair';
import { releasePair } from './private-public-release-pair.js';
import { privateReaderTransport } from './private-pair-reader-fixture';
import { stagedPublicReleasePairCompositeFixture } from './staged-public-release-pair-composite';
import { initialPairsPacket } from './development-initial-pairs';
import { schedulePacketFixture } from '../functions/page-schedule-packet-fixture';
import { finalizePublicArtifactInventoryReceipt } from '../../site/src/lib/public-artifact-inventory';
import { preparePublicWorkerArtifact } from '../../site/src/lib/public-worker-artifact';
import { publicationFromPrepared } from '../../site/src/lib/public-publication-receipt';
import { derivePublicReleasePairCodePack } from '../../site/scripts/public-release-pair-code-pack';
import { publicReleasePairSourceInputsBytes } from '../../site/scripts/public-release-pair-source-inputs';
import { createPublicReleasePairExecutor } from '../../site/scripts/public-release-pair-executor';
import { createPrivatePairReader, readerSealPath } from '../../site/scripts/public-release-pair-private-reader';
import { prepareInstalledPublicReleaseConsumers } from '../../site/scripts/public-release-installed-consumer-owner';
import { inspectBootstrapControls, installBootstrapOldControls } from '../../site/scripts/public-release-bootstrap-controls';
import { prepareBootstrapQualificationGuard } from '../../site/scripts/bootstrap-public-release-selector';
import { prepareInitialBootstrapInstalledGuard } from '../../site/scripts/public-release-bootstrap-installed-guard';
import bootstrap from '../../functions/lib/public-release-bootstrap.js';
import { runInitialPairs } from '../../scripts/lib/initial-pairs.mjs';
import targets from '../../functions/lib/publication-target.js';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import admission from '../../functions/lib/public-release-bootstrap-adoption.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';
import pause from '../../functions/lib/dev-public-release-pause.js';
import snapshots from '../../functions/lib/publish-snapshot.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Exact command composition over real SDK transactions and loopback readers.
 * Small sealed artifact/G bodies avoid builds. The object store exposes actual
 * immutable streams; workerd R2 corruption is covered by the byte-boundary suite. */
export async function developmentInitialPairInstallFixture(firestore: any, { environment = 'development' }: { environment?: 'development' | 'production' } = {}) {
  const target = targets.publicationTarget(environment);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'initial-pair-install-'));
  const objects = new Map<string, { bytes: Uint8Array; metadata: any }>();
  const store = { async put(key: string, bytes: Uint8Array, options: any) {
    if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: options.customMetadata });
  }, async get(key: string) { const value = objects.get(key); return value ? { size: value.bytes.length,
    customMetadata: value.metadata, body: new Response(new Uint8Array(value.bytes)).body! } : null; } };
  const consumer = installedConsumerFixture(environment), packets: Awaited<ReturnType<typeof schedulePacketFixture>>[] = [];
  const transports = [await privateReaderTransport(environment), await privateReaderTransport(environment)];
  try {
    const batch = firestore.batch(); for (const [name, value] of consumer.data) batch.set(firestore.doc(name), value);
    const oldRuntime = { schemaVersion: 1, phase: environment === 'production' ? 'ready' : 'paused', commitSha: 'a'.repeat(40), serializerId: target.serializerId,
      cloud: { phase: environment === 'production' ? 'ready' : 'paused', commitSha: 'a'.repeat(40), serializerId: target.serializerId } };
    batch.set(firestore.doc('system/cmsPublicationRuntime'), oldRuntime);
    batch.set(firestore.doc('system/publicDeployment/contexts/public'), { schemaVersion: 1, revision: 1 });
    const schedule = snapshots.createPublishedSnapshot({ collection: 'cmsPages', document: { id: 'schedule', version: 1, title: 'Schedule', blocks: [] },
      publishedAt: '2026-10-01T12:00:00.000Z', publishedBy: 'original-editor' });
    batch.set(firestore.doc('cmsPages/schedule'), { version: 1, status: 'published', publiclyVisible: true, publishAt: schedule.publishedAt, published: schedule });
    await batch.commit();
    const artifacts = [];
    async function artifact(index: number) {
      const root = path.join(directory, String(index)), sha = (index ? 'b' : 'a').repeat(40);
      const files = await publicReleaseCodePackFixture(root, sha);
      const prepared = await schedulePacketFixture({ firestore, target, rendererSha: sha, generation: 1, includeHomeSources: true,
        attachExternalInputs: index === 0, preparePublication: async ({ codeContext }) => {
          for (const page of PUBLIC_PAGES) for (const route of [page.path, ...('aliases' in page ? page.aliases : [])]) {
            const file = path.join(files.distDirectory, route.endsWith('/') ? `${route.slice(1)}index.html` : route.slice(1));
            await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `<html>Sealed ${route}</html>`);
          }
          for (const route of codeContext.receipt.aggregateRoutes) {
            const file = path.join(files.distDirectory, route.endsWith('/') ? `${route.slice(1)}index.html` : route.slice(1));
            await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `<html>Sealed ${route}</html>`);
          }
          await finalizePublicArtifactInventoryReceipt({ receipt: codeContext.receipt, distDirectory: files.distDirectory, outputPath: path.join(root, 'inventory.json') });
          files.preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt: codeContext.receipt, distDirectory: files.distDirectory, outputPath: path.join(root, 'prepared.json') });
          await writeFile(path.join(root, 'context.json'), JSON.stringify(codeContext), { mode: 0o600 });
          return publicationFromPrepared(files.preparedArtifact);
        } });
      packets.push(prepared); artifacts.push({ ...files, publicContextPath: path.join(root, 'context.json') });
    }
    await artifact(0);
    await firestore.doc('system/publicDeployment/noBuildPages/capability').update({ dataHubReportingVersion: 1 });
    const operationId = 'initial-pair-command';
    if (environment === 'production') await pause.pausePublicRelease({ firestore, attempt: { schemaVersion: 1, operationId, environment,
      projectId: target.projectId, oldRuntime, legacyPointerDigest: admission.legacyBootstrapPointerDigest(consumer.root) } });
    else await admission.closePublicReleaseBootstrapAdmission({ firestore, attempt: { schemaVersion: 2, operationId, environment,
      legacyPointerDigest: admission.legacyBootstrapPointerDigest(consumer.root) } });
    const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore });
    const enrolled = await enrollment.enrollPublicReleaseChangeLog({ firestore, dryRun: false, currentCodeRequest: packets[0].request,
      request: { schemaVersion: 1, operationId, logEpoch: 'initial-pair-epoch', baselineDigest: 'f'.repeat(64), expected: observed.expected } });
    const capRef = firestore.doc('system/publicDeployment/noBuildPages/capability'), beforeCap = (await capRef.get()).data();
    await artifact(1); await capRef.set(beforeCap); packets.forEach(packet => packet.refuseCode());
    const pairs = [];
    for (const [index, files] of artifacts.entries()) {
      const bytes = publicReleasePairSourceInputsBytes(enrolled.receipt.baseline.receipt, enrolled.receipt.baseline.logBaselineDigest);
      await writeFile(path.join(files.compiledDirectory, 'pair-source-inputs.json'), bytes);
      const graphPath = path.join(files.compiledDirectory, 'pair-renderer-release.json'), graph = JSON.parse(await readFile(graphPath, 'utf8'));
      graph.files['pair-source-inputs.json'] = hash(bytes); const graphBytes = JSON.stringify(graph) + '\n'; await writeFile(graphPath, graphBytes);
      files.pair.rendererDigest = hash(graphBytes);
      const built = await derivePublicReleasePairCodePack(files);
      const { pair, seals } = sealedPair(transports[index].origin, { ...releasePair(index ? 'b' : 'a', files.pair.commitSha), environment,
        rendererDigest: files.pair.rendererDigest, codeAssetManifestDigest: built.manifest.codeAssetManifestDigest });
      await work.registerPublicReleasePair({ firestore, pair }); await firestore.doc(readerSealPath(pair)).create(seals);
      await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/rollouts/publisher`).create({ schemaVersion: 2, pairId: pair.pairId,
        pairDigest: protocol.publicReleaseDigest(pair), state: 'verified', readbackDigest: 'd'.repeat(64) });
      pairs.push(pair); transports[index].install(createPrivatePairReader({ firestore, store, pair, installed: seals }));
    }
    const packet = initialPairsPacket(); Object.assign(packet, { kind: `${environment}-initial-pairs`,
      credentialIdentity: { ...initialPairsPacket().credentialIdentity, projectId: target.projectId, clientEmail: `install-operator@${target.projectId}.iam.gserviceaccount.com` }, bootstrapOperationId: operationId, enrollmentRequestDigest: enrolled.receipt.requestDigest,
      currentPair: pairs[0], recoveryPair: pairs[1], artifacts: artifacts.map(({ pair, ...files }) => files) });
    const providerStore = { put: async () => { throw new Error('Read-only provider'); }, async get(key: string) {
      const bytes = packets[0].boundary.objects.get(key); return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null;
    } };
    const credentialsForPair = (_pair: unknown, index: number) => transports[index].credentials;
    const run = (step: string, mode = 'apply', qualificationIds = packet.qualificationIds) => runInitialPairs({ environment, firestore, store, providerStore,
      packet: { ...packet, step, qualificationIds }, credentialsForPair, mode });
    async function complete() {
      for (const pair of pairs) {
        const rows = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get();
        for (const row of rows.docs.sort((a, b) => Number(b.data().identity.sourceOperationId.startsWith('baseline-codepack-')) - Number(a.data().identity.sourceOperationId.startsWith('baseline-codepack-')))) {
          const task = row.data(); if (task.status === 'complete') continue;
          if (task.identity.sourceOperationId.startsWith('baseline-codepack-')) {
            const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId: row.id });
            if (!claim) throw new Error('Original CODE claim missing');
            const executor = createPublicReleasePairExecutor({ firestore, store, pair });
            const result = await executor.execute({ identity: claim.identity, outputPrefix: claim.outputPrefix, signal: AbortSignal.timeout(20_000),
              renew: () => work.renewPublicReleasePairWork({ firestore, pair, taskId: row.id, token: claim.token }) });
            await work.settlePublicReleasePairWork({ firestore, pair, taskId: row.id, token: claim.token, manifestDigest: result.manifestDigest });
            await executor.stage({ identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token), manifestDigest: result.manifestDigest });
          } else await stagedPublicReleasePairCompositeFixture({ firestore, pair, taskId: row.id } as any, store);
        }
      }
    }
    const controls = async () => {
      const expected = await inspectBootstrapControls({ firestore, pair: pairs[0] });
      const installed = await prepareInstalledPublicReleaseConsumers({ ...consumer.options, firestore });
      return installBootstrapOldControls({ firestore, installed, dryRun: false, attempt: { schemaVersion: 2, operationId, pair: pairs[0], ...expected,
        enrollmentReceiptDigest: enrolled.receiptDigest, admittedContractDigest: consumer.contractDigest, consumerSourceSha: consumer.options.sourceSha,
        familyAdmission: { schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: 'all' } }, backgroundBucket: target.backgroundBucket } } });
    };
    const convert = async (qualifications: any[]) => {
      const root = (await firestore.doc('system/publicDeployment').get()).data();
      const attempt = { schemaVersion: 2, operationId, expectedSourceDigest: protocol.publicReleaseDigest(root), currentPair: pairs[0], recoveryPair: pairs[1],
        admittedContractDigest: consumer.contractDigest, qualifications };
      const qualificationGuard = await prepareBootstrapQualificationGuard({ firestore, attempt, store });
      return bootstrap.bootstrapPublicReleaseSelector({ firestore, attempt, qualificationGuard, dryRun: false,
        ...await prepareInitialBootstrapInstalledGuard({ firestore, attempt, evidence: consumer.options }) });
    };
    return { firestore, store, packet, pairs, run, complete, controls, convert,
      evidence: consumer.options, credentials: transports[0].credentials, credentialsForPair, async close() {
      for (const packet of packets.reverse()) await packet.close(); for (const transport of transports) await transport.close(); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) { for (const packet of packets.reverse()) await packet.close(); for (const transport of transports) await transport.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
