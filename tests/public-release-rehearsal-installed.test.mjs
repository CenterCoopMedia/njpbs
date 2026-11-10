import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openInstalledPublicationTimingSetup } from '../scripts/lib/public-release-rehearsal-adapter.mjs';
import { releasePair } from './helpers/private-public-release-pair.js';
import { bindInstalledTimingSetup } from '../scripts/lib/rehearsal-installed-timing-gate.mjs';

beforeEach(() => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

it('keeps installed timing setup explicitly disabled before opening any credential pipe', async () => {
  await expect(openInstalledPublicationTimingSetup()).rejects.toThrow('Installed development timing setup refused');
});
it('refuses production configuration and SDK project metadata before reading setup files or credentials', async () => {
  vi.stubEnv('CMS_DEPLOYMENT_ENVIRONMENT', 'production');
  await expect(openInstalledPublicationTimingSetup({ authorized: true })).rejects.toThrow('Installed development timing setup refused');
  vi.stubEnv('CMS_DEPLOYMENT_ENVIRONMENT', 'development'); vi.stubEnv('GCLOUD_PROJECT', 'njpbs-site');
  await expect(openInstalledPublicationTimingSetup({ authorized: true })).rejects.toThrow('Installed development timing setup refused');
});
it('refuses an emulator in the installed-development entrypoint', async () => {
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:18398');
  await expect(openInstalledPublicationTimingSetup({ authorized: true })).rejects.toThrow('Installed development timing setup refused');
});
it('refuses a production packet and redacts invalid setup details', async () => {
  const plan = { schemaVersion: 1, kind: 'installed-development-publication-timing', projectId: 'njpbs-site', sourceSha: 'a'.repeat(40),
    publisher: {}, slots: [{}, {}], ingress: {}, operator: {}, operatorAccess: {}, publications: [] };
  await expect(openInstalledPublicationTimingSetup({ authorized: true, plan, pair: releasePair(), cases: [] }))
    .rejects.toThrow('Installed development timing setup refused');
  await expect(openInstalledPublicationTimingSetup({ authorized: true, plan: { unrelated: 'fixture-private-error-canary' } }))
    .rejects.toThrow(/^Installed development timing setup refused$/);
});

function installedBoundaries(verifyInstalled = vi.fn().mockResolvedValue(undefined)) {
  const store = { get: vi.fn().mockResolvedValue({ body: 'native-object' }) };
  const ingress = { prove: vi.fn().mockResolvedValue(new Response('native-proof')) };
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const bound = bindInstalledTimingSetup({ firestore: {}, store, ingress, dispatch, verifyInstalled, assertCurrent() {} });
  const exercise = async () => {
    await bound.setup.store.get('object-key');
    await bound.setup.ingress.prove(new Request('https://dev-public.example.org/story/'), 'digest', { status: 200 });
    await bound.setup.dispatch({ operationId: 'native-operation' }, new AbortController().signal);
  };
  const refused = async () => {
    await expect(bound.setup.store.get('object-key')).rejects.toThrow('setup refused');
    await expect(bound.setup.ingress.prove()).rejects.toThrow('setup refused');
    await expect(bound.setup.dispatch()).rejects.toThrow('setup refused');
  };
  return { ...bound, store, ingress, dispatch, exercise, refused, verifyInstalled };
}

it('admits timing reads, proof and original dispatch only after successful installed verification', async () => {
  const bound = installedBoundaries(), pair = releasePair();
  await bound.refused();
  expect(bound.store.get).not.toHaveBeenCalled(); expect(bound.ingress.prove).not.toHaveBeenCalled(); expect(bound.dispatch).not.toHaveBeenCalled();
  await bound.setup.assertInstalled(pair);
  expect(bound.verifyInstalled).toHaveBeenCalledExactlyOnceWith(pair);
  await bound.exercise();
  expect(bound.store.get).toHaveBeenCalledOnce(); expect(bound.ingress.prove).toHaveBeenCalledOnce(); expect(bound.dispatch).toHaveBeenCalledOnce();
  bound.close(); await bound.refused();
  await expect(bound.setup.assertInstalled(pair)).rejects.toThrow('setup refused');
});

it('revokes prior proof on a failed revalidation and permits only a later successful observation', async () => {
  const verify = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('provider drift')).mockResolvedValueOnce(undefined);
  const bound = installedBoundaries(verify), pair = releasePair();
  await bound.setup.assertInstalled(pair); await bound.exercise();
  await expect(bound.setup.assertInstalled(pair)).rejects.toThrow('provider drift'); await bound.refused();
  expect(bound.dispatch).toHaveBeenCalledOnce();
  await bound.setup.assertInstalled(pair); await bound.exercise(); expect(bound.dispatch).toHaveBeenCalledTimes(2);
});

it('cannot restore readiness when closed during an installed observation', async () => {
  let finish;
  const bound = installedBoundaries(() => new Promise(resolve => { finish = resolve; }));
  const pending = bound.setup.assertInstalled(releasePair());
  bound.close(); finish();
  await expect(pending).rejects.toThrow('setup refused'); await bound.refused();
  expect(bound.dispatch).not.toHaveBeenCalled();
});

it('cannot restore readiness from an older observation after a newer one failed', async () => {
  let finish;
  const verify = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('newer drift'));
  const bound = installedBoundaries(verify), older = bound.setup.assertInstalled(releasePair());
  await expect(bound.setup.assertInstalled(releasePair())).rejects.toThrow('newer drift');
  finish(); await expect(older).rejects.toThrow('setup refused'); await bound.refused();
  expect(bound.dispatch).not.toHaveBeenCalled();
});
