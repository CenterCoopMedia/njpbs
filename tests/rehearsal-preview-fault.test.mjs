import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createRehearsalPreviewFault, armRehearsalPreviewFault, readRehearsalPreviewFault } from '../scripts/lib/rehearsal-preview-fault.mjs';
import { createPairedAdminPagesHttp } from '../scripts/lib/paired-admin-pages-provider.mjs';
import { preparePairedAdminArtifact } from '../scripts/lib/paired-admin-pages-artifact.mjs';
import { createPrivatePreviewPairProvider } from '../scripts/lib/private-preview-pair-provider.mjs';
import { previewProviderFixture, versionId } from './helpers/private-preview-provider-fixture.js';
import { DEV_TARGETS } from '../scripts/assert-dev-cms-targets.mjs';

let server, origin, directory, artifact;
const received = [];
const originalEmulator = process.env.FIRESTORE_EMULATOR_HOST;
beforeAll(async () => {
  delete process.env.FIRESTORE_EMULATOR_HOST;
  directory = await mkdtemp(join(tmpdir(), 'rehearsal-preview-boundary-'));
  await writeFile(join(directory, 'index.html'), '<html>Candidate fixture</html>');
  await writeFile(join(directory, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current',
    environment: 'Development', build: { revision: 'b'.repeat(40) } }));
  artifact = await preparePairedAdminArtifact({ directory, environment: 'development', sourceSha: 'b'.repeat(40) });
  server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    received.push({ method: request.method, path: request.url });
    const body = request.url.startsWith('/v2/projects/')
      ? { functions: [{ name: 'projects/njpbs-site-dev/locations/us-central1/functions/cmsPreviewStatus', state: 'ACTIVE' }] }
      : { success: true, result: request.url.endsWith('/upload-token') ? { jwt: 'fixture-assets' }
        : { deployments: [{ id: '44444444-4444-4444-8444-444444444444', versions: [{ version_id: '77777777-7777-4777-8777-777777777777', percentage: 100 }] }] } };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
  if (originalEmulator === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
  else process.env.FIRESTORE_EMULATOR_HOST = originalEmulator;
});
const external = (input, init) => {
  const url = new URL(input); return fetch(origin + url.pathname + url.search, init);
};
const faultOptions = boundary => ({ boundary, projectId: 'njpbs-site-dev', emulatorHost: null,
  fetchImpl: external, authorized: true });
const http = fault => createPairedAdminPagesHttp({ prepared: artifact, authorized: true,
  target: { environment: 'development', projectId: 'njpbs-site-dev', accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID,
    pagesProjectId: '33333333-3333-4333-8333-333333333333', branch: 'main', configurationDigest: 'c'.repeat(64) },
  readCloudflareToken: () => 'fixture-api', readGoogleToken: () => 'fixture-google', readAccessHeaders: () => ({}),
  fetchImpl: fault.fetch, signal: fault.signal });

it('lets baseline native reader HTTP pass, then intercepts only the named first Functions inventory before dispatch', async () => {
  const fault = createRehearsalPreviewFault(faultOptions('functions')), transport = http(fault);
  await expect(transport.readLiveReaderIdentities()).resolves.toHaveProperty('functions');
  expect(() => readRehearsalPreviewFault(fault)).toThrow();
  armRehearsalPreviewFault(fault); const before = received.length;
  await expect(transport.readLiveReaderIdentities()).rejects.toThrow();
  expect(received).toHaveLength(before);
  expect(readRehearsalPreviewFault(fault)).toMatchObject({ boundary: 'functions', dispatched: false, method: 'GET' });
  expect(readRehearsalPreviewFault(fault).requestDigest).toMatch(/^[a-f0-9]{64}$/);
  await expect(transport.readLiveReaderIdentities()).resolves.toHaveProperty('cmsApi');
  expect(() => armRehearsalPreviewFault(fault)).toThrow();
});

it.each(['admin-assets', 'cancellation'])('stops native %s at asset HTTP before any Pages deployment POST', async boundary => {
  const fault = createRehearsalPreviewFault(faultOptions(boundary)), transport = http(fault);
  armRehearsalPreviewFault(fault); const before = received.length;
  await expect(transport.uploadAssets()).rejects.toThrow();
  expect(received.slice(before)).toEqual([{ method: 'GET', path: expect.stringMatching(/\/upload-token$/) }]);
  expect(readRehearsalPreviewFault(fault)).toMatchObject({ boundary, dispatched: false, method: 'POST' });
  expect(fault.signal.aborted).toBe(boundary === 'cancellation');
});

it('interrupts the actual private provider code readback and resumes read-only without a second fault or resource write', async () => {
  const fixture = await previewProviderFixture({ environment: 'development' });
  fixture.state.deployed = true;
  const fault = createRehearsalPreviewFault({ ...faultOptions('preview-rollout'), prepared: fixture.prepared, fetchImpl: fixture.request });
  const provider = createPrivatePreviewPairProvider({ prepared: fixture.prepared, operationDigest: 'a'.repeat(64),
    readToken: () => 'fixture-api', readSecret: () => 'fixture-binding', fetchImpl: fault.fetch, signal: fault.signal });
  armRehearsalPreviewFault(fault);
  await expect(provider.version(versionId)).rejects.toThrow();
  expect(readRehearsalPreviewFault(fault)).toMatchObject({ boundary: 'preview-rollout', dispatched: false, method: 'GET' });
  expect(fixture.state.requests).toHaveLength(1);
  await expect(provider.version(versionId)).resolves.toMatchObject({ versionId, bundleDigest: fixture.prepared.bundleDigest });
  expect(fixture.state.writes).toEqual([]);
});

it('does not treat an unrelated native HTTP failure as the named negative witness', async () => {
  const fault = createRehearsalPreviewFault({ ...faultOptions('functions'), fetchImpl: async () => { throw new Error('External failure'); } });
  armRehearsalPreviewFault(fault);
  await expect(fault.fetch('https://example.test/unrelated')).rejects.toThrow('External failure');
  expect(() => readRehearsalPreviewFault(fault)).toThrow();
  expect(() => readRehearsalPreviewFault({ ...fault })).toThrow();
});

it.each([{ authorized: false }, { projectId: 'njpbs-site' }, { boundary: 'unknown' },
  { projectId: 'demo-njpbs', emulatorHost: null }, { boundary: 'preview-rollout', prepared: { environment: 'production' } }])(
  'refuses an unauthorized, production or malformed fault target before any external access: %j', overrides => {
    expect(() => createRehearsalPreviewFault({ ...faultOptions('functions'), ...overrides })).toThrow();
  });
