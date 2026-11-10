import { createHash } from 'node:crypto';
import { privatePairPublisherScenario } from './private-pair-publisher-install.mjs';
import * as fixture from './private-pair-publisher-provider.mjs';
import { preparePrivatePairPublisher } from '../../scripts/lib/private-pair-publisher-provider.mjs';
import { installPrivatePairPublisher } from '../../scripts/lib/private-pair-publisher-install.mjs';
import { privateInstallLedger } from '../../scripts/lib/public-release-private-install-ledger.mjs';
import { installPrivateWorker } from '../../scripts/lib/public-release-private-provider.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import { PAIR_READER_CONTRACT, privatePairReaderCapabilities } from '../../packages/content-core/src/private-pair-http.mjs';

/** Real native install owners and SDK; only external provider/runtime I/O is
 * synthetic. This does not prove an executable renderer or live installation. */
export async function rehearsalInstalledCensusFixture(firestore, { accountId = fixture.accountId, readerOrigins } = {}) {
  const bindReader = (pair, origin) => {
    if (!origin) return;
    pair.readerContractDigest = protocol.publicReleaseDigest(PAIR_READER_CONTRACT);
    pair.capabilityDigest = protocol.publicReleaseDigest(privatePairReaderCapabilities(pair.commitSha));
    pair.readerReceiptDigest = protocol.publicReleaseDigest({ schemaVersion: 1, environment: pair.environment,
      service: pair.publicWorker.service, versionId: pair.publicWorker.versionId, commitSha: pair.commitSha,
      origin, contractDigest: pair.readerContractDigest });
  };
  const first = await privatePairPublisherScenario(firestore, { continuationEnabled: true, accountId });
  bindReader(first.input.plan.pairTemplate, readerOrigins?.[0]);
  const old = await installPrivatePairPublisher(first.input);
  const second = await privatePairPublisherScenario(firestore, { continuationEnabled: true, accountId });
  const changes = [
    [fixture.incarnation, '77777777-7777-4777-8777-777777777777'],
    [fixture.versionId, '88888888-8888-4888-8888-888888888888'],
    [first.input.plan.pairTemplate.publicWorker.versionId, 'bbbbbbbb-2222-4222-8222-111111111111'],
    [fixture.deploymentId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    [fixture.applicationId, '99999999-9999-4999-8999-999999999999'],
    [fixture.namespaceId, 'c'.repeat(32)], [fixture.workerId, '7'.repeat(32)],
    [fixture.identity.commitSha, 'f'.repeat(40)], [fixture.identity.journalNamespace, 'pair-journal-two'],
  ];
  const text = value => changes.reduce((value, [from, to]) => value.replaceAll(from, to), value);
  const transform = value => typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(transform)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, row]) => [key, transform(row)])) : value;
  const config = transform(fixture.configuration());
  const imageReference = fixture.imageReference.replace(fixture.accountId, accountId);
  config.account_id = accountId; config.containers[0].image = imageReference;
  config.vars.PAIR_EXECUTOR_READY = 'true';
  for (const flag of ['PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED', 'PUBLIC_PAIR_OWNER_WRITE_ENABLED', 'PUBLIC_PAIR_TERMINAL_ENABLED', 'PUBLIC_PAIR_SWITCH_CODE_ENABLED']) config.vars[flag] = 'true';
  config.services = [{ binding: 'PUBLIC_RELEASE_INGRESS_PROOF', service: 'njpbs-private-ingress-development', entrypoint: 'PublicReleaseIngressProofEntrypoint' }];
  const metadata = fixture.metadata(config);
  metadata.containers[0].name = config.name;
  const prepared = await preparePrivatePairPublisher({ multipart: await fixture.multipart(metadata), config, imageReference });
  const plan = { ...transform(first.input.plan), bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest };
  bindReader(plan.pairTemplate, readerOrigins?.[1]);
  const reverse = value => [...changes].reverse().reduce((value, [from, to]) => value.replaceAll(to, from), value);
  const fetchImpl = async (url, options) => {
    const response = await second.input.fetchImpl(reverse(String(url)), options);
    return Response.json(transform(await response.json()), { status: response.status });
  };
  const next = await installPrivatePairPublisher({ ...second.input, plan, prepared, fetchImpl });
  const pairs = [old.pair, next.pair], privateProviders = [], workers = [];
  for (const [index, role] of ['slot-old', 'slot-new', 'ingress', 'operator'].entries()) {
    const workerName = index < 2 ? pairs[index].publicWorker.service :
      role === 'operator' ? 'njpbs-private-operator-census' : `njpbs-private-ingress-census-${role}`;
    const versionId = index < 2 ? pairs[index].publicWorker.versionId : `${String(index).repeat(8)}-3333-4333-8333-333333333333`;
    const config = { name: workerName, main: '/fixture/census-worker.ts', account_id: accountId,
      compatibility_date: '2026-07-09', compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
      routes: [], r2_buckets: [], services: [], vars: { CENSUS_FIXTURE: role } };
    const source = new TextEncoder().encode('export default {fetch(){return new Response(null,{status:404})}}');
    const { main, ...portable } = config;
    const workerPlanDigest = protocol.publicReleaseDigest({ config: portable, sourceDigest: createHash('sha256').update(source).digest('hex') });
    const attemptId = `census-${role}`, attemptPlanDigest = protocol.publicReleaseDigest({ attemptId, workerPlanDigest });
    let worker = null, version = null, deployed = null, writes = 0;
    const deploymentId = `${String(index + 1).repeat(8)}-4444-4444-8444-444444444444`;
    const provider = {
      worker: async () => worker,
      create: async (_name, tag) => { writes++; worker = { id: String(index + 1).repeat(32), name: workerName,
        tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } }; return worker; },
      versions: async () => version ? [version] : [],
      upload: async (_name, metadata) => { writes++; version = { id: versionId, annotations: metadata.annotations,
        resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date,
          compatibility_flags: metadata.compatibility_flags } } }; return versionId; },
      version: async () => version,
      deployment: async () => deployed,
      deploy: async (_name, id, tag) => { writes++; deployed = { id: deploymentId,
        versions: [{ version_id: id, percentage: 100 }], annotations: { 'workers/message': `private-pair:${tag}` } }; },
      subdomain: async () => ({ enabled: false, previews_enabled: false }),
      disableSubdomain: async () => { writes++; }, assertNoPublicRoutes: async () => {},
      sourceDigest: async () => createHash('sha256').update(source).digest('hex'),
    };
    const ledger = privateInstallLedger(firestore);
    await ledger.bindAttempt(attemptId, attemptPlanDigest);
    await installPrivateWorker({ ledger, provider, attemptId, config, source, dryRun: false });
    privateProviders.push(() => writes);
    workers.push({ role, attemptId, attemptPlanDigest, workerName, workerPlanDigest, versionId });
  }
  return { publishers: [first.input.plan, plan], pairs, workers,
    providerWrites: () => first.writes().length + second.writes().length + privateProviders.reduce((count, read) => count + read(), 0) };
}
