import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { rehearsalAdminProvider } from './helpers/rehearsal-admin-provider';
import { preparePairedAdminArtifact } from '../scripts/lib/paired-admin-pages-artifact.mjs';
import { createPairedAdminPagesHttp } from '../scripts/lib/paired-admin-pages-provider.mjs';
import { createRehearsalPreviewFault, armRehearsalPreviewFault, readRehearsalPreviewFault } from '../scripts/lib/rehearsal-preview-fault.mjs';

it('uses the native Pages parser to verify actual sealed baseline bytes and intercept candidate assets before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-admin-contract-'));
  const originalEmulator = process.env.FIRESTORE_EMULATOR_HOST;
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    const candidate = join(directory, 'candidate'); await mkdir(candidate);
    await writeFile(join(candidate, 'index.html'), '<html>Candidate fixture</html>');
    await writeFile(join(candidate, 'admin-status.json'), JSON.stringify({ schemaVersion: 2, status: 'current', environment: 'Development',
      build: { revision: 'b'.repeat(40) } }));
    const prepared = await preparePairedAdminArtifact({ directory: candidate, sourceSha: 'b'.repeat(40), environment: 'development' });
    const fixture = await rehearsalAdminProvider({ directory, candidateArtifact: prepared,
      functions: [{ name: 'projects/njpbs-site-dev/locations/us-central1/functions/cmsPreviewStatus', state: 'ACTIVE' }],
      cmsApiDeployment: '44444444-4444-4444-8444-444444444444' });
    const http = createPairedAdminPagesHttp(fixture.admin), baseline = fixture.admin.baseline;
    expect(await http.activeId()).toBe(baseline.deploymentId);
    await expect(http.verifyDeployment(baseline.deploymentId, null, baseline.artifact)).resolves.toHaveProperty('providerReceiptDigest');
    await http.verifyActiveBytes(baseline.artifact, baseline.deploymentId);
    await expect(http.readLiveReaderIdentities()).resolves.toHaveProperty('cmsApi');
    const fault = createRehearsalPreviewFault({ boundary: 'admin-assets', projectId: 'njpbs-site-dev', emulatorHost: null,
      fetchImpl: fixture.admin.fetchImpl, authorized: true });
    armRehearsalPreviewFault(fault);
    await expect(createPairedAdminPagesHttp({ ...fixture.admin, fetchImpl: fault.fetch }).uploadAssets()).rejects.toThrow();
    expect(readRehearsalPreviewFault(fault)).toMatchObject({ boundary: 'admin-assets', dispatched: false });
    expect(fixture.calls.every(call => call.method === 'GET')).toBe(true);
  } finally {
    if (originalEmulator === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
    else process.env.FIRESTORE_EMULATOR_HOST = originalEmulator;
    await rm(directory, { recursive: true, force: true });
  }
});
