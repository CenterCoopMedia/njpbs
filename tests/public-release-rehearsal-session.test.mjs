import { afterEach, expect, it, vi } from 'vitest';
import { createInstalledRehearsalSession, installedRehearsalSession, hasInstalledRehearsalSession } from '../scripts/lib/rehearsal-installed-session.mjs';
import { openInstalledRehearsalLauncher } from '../scripts/lib/rehearsal-installed-launcher.mjs';

afterEach(() => vi.unstubAllEnvs());
it('keeps both installed execution entrypoints disabled before opening SDK or credential sources', async () => {
  await expect(createInstalledRehearsalSession()).rejects.toThrow('Installed rehearsal execution refused');
  await expect(openInstalledRehearsalLauncher()).rejects.toThrow('Installed development rehearsal launcher refused');
});
it('refuses genuine emulator mode before any real development transport can open', async () => {
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:18398');
  for (const run of [createInstalledRehearsalSession, openInstalledRehearsalLauncher]) {
    await expect(run({ authorized: true })).rejects.toThrow();
  }
});
it('refuses a production project or ambient credentials before reading a launcher file or pipe', async () => {
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    vi.stubEnv(key, key === 'GCLOUD_PROJECT' ? 'njpbs-site' : '/not-opened');
    await expect(openInstalledRehearsalLauncher({ authorized: true })).rejects.toThrow();
    vi.unstubAllEnvs();
  }
});
it('a JSON copy cannot provide an installed execution capability', () => {
  const copied = JSON.parse('{}');
  expect(hasInstalledRehearsalSession(copied)).toBe(false);
  expect(() => installedRehearsalSession(copied, {})).toThrow('Installed rehearsal execution refused');
});
it('refuses unsupported recovery modes before opening a transport or SDK source', async () => {
  await expect(createInstalledRehearsalSession({ authorized: true, recoveryOnly: 'yes' })).rejects.toThrow();
  await expect(openInstalledRehearsalLauncher({ authorized: true, recoveryOnly: 'yes' })).rejects.toThrow();
});
