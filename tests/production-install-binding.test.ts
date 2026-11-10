import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { assertProductionInstallEnvironment, parseProductionInstallIdentity, productionInstallCredential } from '../scripts/lib/production-install-binding.mjs';
import { operatorAccount } from '../scripts/lib/public-release-operator-io.mjs';

const identity = { projectId: 'njpbs-site', clientEmail: 'install-operator@njpbs-site.iam.gserviceaccount.com',
  privateKeyId: 'c'.repeat(40), secretRef: 'pass://production/install' };
it('binds explicit production identity and refuses ambient, emulator and mixed authority', () => {
  expect(assertProductionInstallEnvironment({})).toMatchObject({ projectId: 'njpbs-site', publicationBucket: 'njpbs-cms-publication' });
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FUNCTIONS_EMULATOR',
    'FIREBASE_DATABASE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST',
    'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG',
    'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT'])
    expect(() => assertProductionInstallEnvironment({ [key]: 'development' })).toThrow();
  expect(parseProductionInstallIdentity(identity)).toEqual(identity);
  for (const change of [{ projectId: 'njpbs-site-dev' }, { clientEmail: 'dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com' },
    { privateKeyId: '' }, { secretRef: '/account.json' }])
    expect(() => parseProductionInstallIdentity({ ...identity, ...change })).toThrow();
});
it('consumes only at use, binds the actual serialized account, and bounds credential bytes', async () => {
  let consumed = 0;
  const account = { type: 'service_account', project_id: identity.projectId, client_email: identity.clientEmail,
    private_key_id: identity.privateKeyId, private_key: 'synthetic fixture key'.repeat(3) };
  const stream = Readable.from((async function* () { consumed++; yield JSON.stringify(account); })());
  const pipe = productionInstallCredential(3, raw => operatorAccount(raw, identity), stream);
  expect(consumed).toBe(0);
  expect(await pipe.read()).toMatchObject({ projectId: 'njpbs-site', clientEmail: identity.clientEmail });
  expect(consumed).toBe(1); await pipe.read(); expect(consumed).toBe(1); pipe.close();
  for (const raw of [JSON.stringify({ ...account, project_id: 'njpbs-site-dev' }),
    JSON.stringify({ ...account, private_key_id: 'e'.repeat(40) }), 'x'.repeat(32769)]) {
    const source = productionInstallCredential(3, value => operatorAccount(value, identity), Readable.from([raw]));
    await expect(source.read()).rejects.toThrow(); source.close();
  }
});
