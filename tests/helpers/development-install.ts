import { createHash } from 'node:crypto';
import { publicSlotScenario } from './private-public-release-slot-target.mjs';
import deployment from '../../functions/lib/public-deployment.js';
import adoption from '../../functions/lib/public-release-bootstrap-adoption.js';
import p from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import admissions from '../../functions/lib/public-release-admission.js';
import { installPrivatePublicRelease } from '../../scripts/install-private-public-release.mjs';
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const uid = (i: number) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const credentialIdentity = { projectId: 'njpbs-site-dev', clientEmail: 'fixture-operator@njpbs-site-dev.iam.gserviceaccount.com',
  privateKeyId: 'b'.repeat(40), secretRef: 'pass://fixture/dev/bootstrap' };
export async function developmentInstallFixture(db: any) {
  const f = publicSlotScenario(), plan: any = structuredClone(f.installPlan), source = new TextEncoder().encode('export default {}');
  plan.slotEnabled = [true, true]; plan.developmentIngress = true; plan.ingressBundleDigest = plan.slotBundleDigest = hash(source);
  plan.readerAccess = [0, 1].map(() => ({ enabled: true, audience: 'd'.repeat(64), clientId: 'reader123.access' }));
  const records = new Map<string, any>(); let counter = 100;
  const provider: any = {
    worker: async (name: string) => records.get(name)?.worker ?? null,
    create: async (name: string, tag: string) => { records.set(name, { worker: { name, id: '1'.repeat(32), tags: [`private-pair:${tag}`],
      subdomain: { enabled: false, previews_enabled: false } } }); },
    versions: async (name: string) => records.get(name)?.version ? [records.get(name).version] : [],
    upload: async (name: string, metadata: any, body: Uint8Array) => { const row = records.get(name); row.source = body;
      row.version = { id: uid(++counter), annotations: metadata.annotations, resources: { bindings: metadata.bindings,
        script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; },
    version: async (name: string) => records.get(name).version,
    assertNoPublicRoutes: async () => {}, disableSubdomain: async () => {},
    subdomain: async () => ({ enabled: false, previews_enabled: false }),
    deployment: async (name: string) => records.get(name)?.active ?? null,
    deploy: async (name: string, versionId: string, tag: string) => { records.get(name).active = { id: uid(++counter),
      versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': `private-pair:${tag}` } }; },
    sourceDigest: async (name: string) => hash(records.get(name).source),
  };
  const { privateInstallLedger } = await import('../../scripts/lib/public-release-private-install-ledger.mjs');
  const installed = await installPrivatePublicRelease({ plan, ledger: privateInstallLedger(db), provider, compile: async () => source, dryRun: false });
  const [currentPair, recoveryPair] = installed.pairs;
  const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: currentPair.commitSha,
    activeDeploymentId: 'fixture-old', lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: 'fixture-old', mediaLifecycleReady: true };
  await db.doc('system/publicDeployment').set(pointer);
  const operationId = 'original-bootstrap';
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: { schemaVersion: 2, operationId, environment: 'development',
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
  const attempt = { schemaVersion: 2, operationId, expectedSourceDigest: p.publicReleaseDigest(pointer), currentPair, recoveryPair,
    admittedContractDigest: 'a'.repeat(64), qualifications: [0, 1].map(i => ({ qualificationId: `original-qualification-${i}`, receiptDigest: String(i + 1).repeat(64) })) };
  const selector = p.parsePublicReleaseSelector({ ...pointer, schemaVersion: 2, epoch: 1, selectedPair: p.publicReleasePairReference(currentPair),
    recoveryPair: p.publicReleasePairReference(recoveryPair), contentHead: { pairId: currentPair.pairId, viewId: '1'.repeat(64), manifestDigest: '2'.repeat(64), contextSequence: 0 },
    admittedContractDigest: attempt.admittedContractDigest, priorSelectorDigest: attempt.expectedSourceDigest, switchOperationId: operationId, proofDigest: 'c'.repeat(64) });
  const media = { schemaVersion: 2, epoch: 1, activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
    references: [currentPair, recoveryPair].map(pair => ({ pairId: pair.pairId, manifestDigest: selector.contentHead.manifestDigest })) };
  const head = { schemaVersion: 2, sequence: 0, baselineDigest: 'd'.repeat(64), lastDigest: 'd'.repeat(64) };
  const rows: Record<string, any> = { 'system/publicDeployment': selector,
    [`system/publicDeployment/bootstrapSelectors/${operationId}`]: { schemaVersion: 2, kind: 'public-release-bootstrap', operationId,
      attemptDigest: p.publicReleaseDigest(attempt), sourceDigest: attempt.expectedSourceDigest, selectorDigest: p.publicReleaseDigest(selector),
      storedSelectorDigest: p.publicReleaseDigest(selector), mediaDigest: p.publicReleaseDigest(media), selector },
    'system/cmsPublicationRuntime': { schemaVersion: 1, phase: 'ready', commitSha: currentPair.commitSha, serializerId: 'cloudflare-dev-publisher',
      cloud: { phase: 'ready', commitSha: currentPair.commitSha, serializerId: 'cloudflare-dev-publisher' } },
    'system/publicDeployment/pairMedia/current': media, 'system/publicReleaseChanges': head,
    'system/publicReleaseChangeLog': { schemaVersion: 2, enabled: false, pair: selector.selectedPair, head, logEpoch: 'original-log' },
    [`${admissions.ADMISSIONS}/controls/adoption`]: { schemaVersion: 2, enabled: false }, [admissions.ADMISSIONS]: admissions.initialAdmissionHead() };
  for (const pair of [currentPair, recoveryPair]) { rows[work.publicReleasePairPath(pair.pairId)] = pair;
    rows[`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`] = { schemaVersion: 2, pairId: pair.pairId, status: 'retained' }; }
  await Promise.all(Object.entries(rows).map(([path, row]) => db.doc(path).set(row)));
  const ingress = records.get(plan.ingressName);
  const policies = [{ id: uid(1), decision: 'allow', include: [{ group: { id: uid(2) } }] }];
  const packet: any = { schemaVersion: 1, kind: 'development-public-release-gateway', operatorCommitSha: 'a'.repeat(40),
    operationId: 'dev-staff-binding', credentialIdentity, providerCredentialRef: 'pass://fixture/dev', bootstrapAttempt: attempt, installPlan: plan,
    gateway: { versionId: uid(20), deploymentId: uid(21), sourceDigest: hash(source), audience: 'c'.repeat(64), zoneId: '2'.repeat(32),
      routeId: '3'.repeat(32), applicationId: uid(22), policiesDigest: p.publicReleaseDigest(policies) },
    ingress: { versionId: ingress.version.id, deploymentId: ingress.active.id } };
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname; if ((init.method ?? 'GET') !== 'GET') throw new Error('Unexpected slot mutation');
    const envelope = (result: any) => Response.json({ success: true, result });
    if (path === '/client/v4/zones') return envelope([{ id: packet.gateway.zoneId }]);
    if (path.endsWith('/workers/domains') || path.endsWith('/workers/routes')) return envelope([]);
    const name = [...records.keys()].find(name => path.includes(`/${name}`)); if (!name) throw new Error('Unexpected slot path');
    const row = records.get(name);
    if (path.includes('/workers/workers/')) return envelope(row.worker);
    if (path.endsWith('/versions')) return envelope({ items: [row.version] });
    if (path.includes('/versions/')) return envelope(row.version);
    if (path.endsWith('/deployments')) return envelope([row.active]);
    if (path.endsWith('/content/v2')) return new Response(row.source, { headers: { 'content-type': 'application/javascript' } });
    if (path.endsWith('/subdomain')) return envelope({ enabled: false, previews_enabled: false });
    throw new Error('Unexpected slot read');
  };
  return { packet, policies, source, records, provider, fetchImpl, selector };
}
