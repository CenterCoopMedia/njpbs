import { beforeEach, expect, it, vi } from 'vitest';
import { clearEmulatorFirestore, isolatedFirestore } from '../helpers/emulator-firestore.js';
import { developmentInstallFixture, uid, hash } from '../helpers/development-install';
import { bindDevelopmentPublicReleaseGateway, developmentGatewayConfiguration } from '../../scripts/lib/development-public-release-gateway.mjs';
const rawDb = isolatedFirestore('development-public-release-gateway.test.ts');
const db = new Proxy(rawDb, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: 'DELETE' }, rawDb); });
async function fixture() {
  const f = await developmentInstallFixture(db), { packet } = f, { config } = developmentGatewayConfiguration(packet);
  const resources = (config: any) => ({ bindings: config.bindings,
    script_runtime: { compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags } });
  const original = { ...config, bindings: config.bindings.map((row: any) => row.name === 'DEV_PUBLIC' ? { ...row, service: 'template-dev-public' } : row) };
  const versions = new Map<string, any>([[packet.gateway.versionId, { id: packet.gateway.versionId, resources: resources(original) }]]);
  let active: any = { id: packet.gateway.deploymentId, versions: [{ version_id: packet.gateway.versionId, percentage: 100 }] };
  const route = { id: packet.gateway.routeId, pattern: 'dev-public.example.org/*', script: 'njpbs-dev-staff-sites' };
  const writes: string[] = [];
  const provider: any = {
    api: vi.fn(async (path: string) => {
      if (path === `/zones/${packet.gateway.zoneId}`) return { id: packet.gateway.zoneId, name: 'njpbs.org', account: { id: packet.installPlan.accountId } };
      if (path.endsWith('/workers/routes')) return [route];
      if (path.endsWith('/workers/domains')) return [];
      if (path.endsWith('/policies')) return f.policies;
      if (path.endsWith(`/access/apps/${packet.gateway.applicationId}`)) return { id: packet.gateway.applicationId, domain: 'dev-public.example.org', aud: packet.gateway.audience };
      throw new Error('Unexpected gateway request');
    }),
    upload: vi.fn(async (metadata: any) => { writes.push('upload'); versions.set(uid(30), { id: uid(30), annotations: metadata.annotations, resources: resources(metadata) }); }),
    deploy: vi.fn(async (versionId: string, tag: string) => { writes.push('deploy'); active = { id: uid(31), versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': tag } }; }),
    version: vi.fn(async (id: string) => structuredClone(versions.get(id))),
    versions: async () => [...versions.values()], deployment: async () => structuredClone(active),
    sourceDigest: async () => hash(f.source), exposure: async () => ({ enabled: false, previews_enabled: false }),
  };
  const input = { firestore: db, packet, provider, ingressProvider: f.provider, compile: async () => f.source,
    readToken: async () => 'synthetic-slot-api', fetchImpl: f.fetchImpl };
  return { ...f, provider, versions, writes, input, route };
}
it('binds only the staff gateway service, retaining Access and the original install/closed OLD authority', async () => {
  const f = await fixture(), first = await bindDevelopmentPublicReleaseGateway(f.input);
  expect(f.writes).toEqual(['upload', 'deploy']); expect(first).toMatchObject({ original: true, complete: true, versionId: uid(30) });
  expect(await bindDevelopmentPublicReleaseGateway(f.input)).toEqual(first);
  expect(await bindDevelopmentPublicReleaseGateway({ ...f.input, readback: true })).toEqual(first);
  expect(f.writes).toHaveLength(2); expect(f.route.script).toBe('njpbs-dev-staff-sites');
  expect((await db.doc('system/publicDeployment').get()).data()).toEqual(f.selector);
  expect((await db.doc('system/publicReleaseChangeLog').get()).data()?.enabled).toBe(false);
  expect(f.provider.api.mock.calls.every((call: any) => call.length === 1)).toBe(true);
});
it.each(['install-ledger', 'ingress-version', 'Access', 'route', 'fence', 'provider-binding'])( 'refuses changed %s before gateway effects', async fault => {
  const f = await fixture();
  if (fault === 'install-ledger') await db.doc(`system/publicReleasePrivateInstalls/plans/${f.packet.installPlan.operationId}`).delete();
  if (fault === 'ingress-version') f.packet.ingress.versionId = uid(99);
  if (fault === 'Access') f.policies.push({ id: uid(8), decision: 'bypass' } as any);
  if (fault === 'route') f.route.script = 'njpbs-private-ingress-foreign';
  if (fault === 'fence') await db.doc('system/publicReleaseAdmissions/controls/bootstrapFence').update({ status: 'open', resumeReceiptDigest: 'f'.repeat(64) });
  if (fault === 'provider-binding') f.versions.get(f.packet.gateway.versionId).resources.bindings[0].text = 'wrong';
  await expect(bindDevelopmentPublicReleaseGateway(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it.each(['upload', 'deploy'])('reconciles a lost %s reply once without another send', async action => {
  const f = await fixture(), effect = f.provider[action].getMockImplementation();
  f.provider[action].mockImplementation(async (...args: any[]) => { await effect(...args); throw new Error('Original reply lost'); });
  expect((await bindDevelopmentPublicReleaseGateway(f.input)).complete).toBe(true);
  await bindDevelopmentPublicReleaseGateway({ ...f.input, readback: true }); expect(f.writes).toEqual(['upload', 'deploy']);
});
it('never repeats an uncertain upload with no visible version', async () => {
  const f = await fixture(); f.provider.upload.mockImplementation(async () => { f.writes.push('upload'); throw new Error('Uncertain send'); });
  await expect(bindDevelopmentPublicReleaseGateway(f.input)).rejects.toThrow();
  await expect(bindDevelopmentPublicReleaseGateway(f.input)).rejects.toThrow(); expect(f.writes).toEqual(['upload']);
});
it('holds after authority changes during upload and refuses production tuples offline', async () => {
  const f = await fixture(), effect = f.provider.upload.getMockImplementation();
  f.provider.upload.mockImplementation(async (...args: any[]) => { await effect(...args);
    await db.doc('system/publicReleaseChangeLog').update({ enabled: true }); });
  await expect(bindDevelopmentPublicReleaseGateway(f.input)).rejects.toThrow(); expect(f.writes).toEqual(['upload']);
  const wrong = structuredClone(f.packet); wrong.bootstrapAttempt.currentPair.environment = 'production'; expect(() => developmentGatewayConfiguration(wrong)).toThrow();
});
