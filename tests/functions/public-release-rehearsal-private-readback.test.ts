import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { releasePair } from '../helpers/private-public-release-pair.js';
import { configurePublicReleaseIngress } from '../../scripts/configure-public-release-ingress.mjs';
import { installPrivateWorker } from '../../scripts/lib/public-release-private-provider.mjs';
import { privateInstallLedger } from '../../scripts/lib/public-release-private-install-ledger.mjs';
import { readRehearsalPrivateWorker } from '../../scripts/lib/rehearsal-private-worker-readback.mjs';
import { readOnlyBootstrapFirestore } from '../../scripts/lib/public-release-bootstrap-preflight.mjs';
import protocol from '../../functions/lib/public-release-pair.js';

const firestore = isolatedFirestore('rehearsal-private-readback');
const source = new TextEncoder().encode('export default {fetch(){return new Response(null,{status:404})}}');
const attemptId = 'original-private-readback', attemptPlanDigest = protocol.publicReleaseDigest({ kind: 'local-provider-boundary' });
const versionId = '11111111-1111-4111-8111-111111111111', deploymentId = '22222222-2222-4222-8222-222222222222';
const config = configurePublicReleaseIngress({ oldPair: releasePair(), newPair: releasePair('b', 'b'.repeat(40)),
  accountId: 'a'.repeat(32), ingressName: 'njpbs-private-ingress-development' });
let worker: any, version: any, deployed: any, provider: any;
beforeEach(async () => {
  await firestore.recursiveDelete(firestore.collection('system'));
  provider = {
    worker: vi.fn(async () => worker ?? null),
    create: vi.fn(async (name, tag) => { worker = { id: 'f'.repeat(32), name, tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } }; }),
    versions: vi.fn(async () => version ? [version] : []),
    upload: vi.fn(async (_name, metadata) => { version = { id: versionId, annotations: metadata.annotations,
      resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; return versionId; }),
    version: vi.fn(async () => version),
    deployment: vi.fn(async () => deployed ?? null),
    deploy: vi.fn(async (_name, id, tag) => { deployed = { id: deploymentId, versions: [{ version_id: id, percentage: 100 }], annotations: { 'workers/message': `private-pair:${tag}` } }; }),
    subdomain: vi.fn(async () => ({ enabled: false, previews_enabled: false })),
    disableSubdomain: vi.fn(async () => {}), assertNoPublicRoutes: vi.fn(async () => {}),
    sourceDigest: vi.fn(async () => createHash('sha256').update(source).digest('hex')),
    preflight: vi.fn(async () => { throw new Error('Never warm the runtime'); }), wake: vi.fn(async () => { throw new Error('Never start the runtime'); }),
  };
  worker = version = deployed = undefined;
  const ledger = privateInstallLedger(firestore);
  await ledger.bindAttempt(attemptId, attemptPlanDigest);
  await installPrivateWorker({ ledger, provider, attemptId, config, source, dryRun: false });
  for (const method of Object.values(provider) as any[]) method.mockClear();
});
const read = () => readRehearsalPrivateWorker({ firestore: readOnlyBootstrapFirestore(firestore), provider,
  attemptId, attemptPlanDigest, versionId, config, source });

it('reads actual original SDK/provider identities twice with no runtime or provider effect', async () => {
  expect(await read()).toEqual(await read());
  for (const name of ['create', 'upload', 'deploy', 'disableSubdomain', 'preflight', 'wake']) expect(provider[name]).not.toHaveBeenCalled();
});
it('refuses an installed binding mismatch without replacing its original readback', async () => {
  version.resources.bindings.pop();
  const before = await firestore.doc(`system/publicReleasePrivateInstalls/plans/${attemptId}`).get();
  await expect(read()).rejects.toThrow();
  expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
});
it('refuses provider source and deployment drift', async () => {
  provider.sourceDigest.mockResolvedValue('0'.repeat(64)); await expect(read()).rejects.toThrow();
  provider.sourceDigest.mockResolvedValue(createHash('sha256').update(source).digest('hex'));
  deployed.versions[0].percentage = 99; await expect(read()).rejects.toThrow();
});
it('refuses an unbound original attempt before any provider read', async () => {
  await firestore.doc(`system/publicReleasePrivateInstalls/plans/${attemptId}`).delete();
  await expect(read()).rejects.toThrow(); expect(provider.worker).not.toHaveBeenCalled();
});
