import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { releasePair } from './helpers/private-public-release-pair.js';
import { createRehearsalQualificationStore } from '../scripts/lib/rehearsal-qualification-store.mjs';
import protocol from '../functions/lib/public-release-pair.js';
const { require: typedRequire } = createRequire(new URL('../site/package.json', import.meta.url))('tsx/cjs/api');
const { createQualificationEvidenceWriter, readQualificationEvidence } = typedRequire('../site/scripts/public-release-pair-qualification-evidence.ts', import.meta.url);

beforeEach(() => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CMS_DEPLOYMENT_ENVIRONMENT']) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
function fixture(sendFailure) {
  const objects = new Map(), calls = [], pairs = [releasePair(), releasePair('b', 'b'.repeat(40))];
  const readCredential = vi.fn(() => { throw new Error('Supplied transport needs no credential'); });
  const client = { async send(command) {
    const value = command.input; calls.push(value);
    if (sendFailure) throw sendFailure;
    if (objects.has(value.Key)) throw { $metadata: { httpStatusCode: 412 } };
    objects.set(value.Key, { bytes: Uint8Array.from(value.Body), metadata: { ...value.Metadata } }); return {};
  } };
  const reads = { async get(key) {
    const value = objects.get(key);
    return value ? { size: value.bytes.length, customMetadata: value.metadata, body: new Response(value.bytes).body } : null;
  } };
  const options = { pairs, reads, readCredential, client, authorized: true };
  const store = createRehearsalQualificationStore(options);
  const signal = AbortSignal.timeout(5000), pair = pairs[1], qualificationId = 'native-evidence-boundary', witnessDigest = 'a'.repeat(64);
  const row = { kind: 'baseline', path: '/', manifestDigest: 'b'.repeat(64), claimDigest: 'c'.repeat(64),
    inputManifestDigest: 'd'.repeat(64), bodyDigest: 'e'.repeat(64), bytes: 1, status: 200,
    headersDigest: 'f'.repeat(64), requestDigest: '1'.repeat(64) };
  const write = async () => {
    const owner = createQualificationEvidenceWriter({ store, pair, qualificationId, witnessDigest, signal });
    await owner.append(row); return owner.finish();
  };
  return { store, options, calls, objects, readCredential, pair, qualificationId, witnessDigest, signal, row, write };
}
it('serves the native create-only evidence writer and full reader through only the fixed development bucket', async () => {
  const f = fixture(), receipt = await f.write(), observed = [];
  for await (const row of readQualificationEvidence({ store: f.store, pair: f.pair, qualificationId: f.qualificationId,
    witnessDigest: f.witnessDigest, ...receipt, signal: f.signal })) observed.push(row);
  expect(observed).toEqual([f.row]); expect(f.calls).toHaveLength(2);
  expect(f.calls.every(value => value.Bucket === 'njpbs-dev-cms-publication' && value.IfNoneMatch === '*')).toBe(true);
  expect(f.calls.every(value => value.Metadata.pairdigest === protocol.publicReleaseDigest(f.pair))).toBe(true);
  expect(f.readCredential).not.toHaveBeenCalled();
});
it('retains exact original immutable bytes on a 412 and still requires the native full readback', async () => {
  const f = fixture(), receipt = await f.write();
  expect(await f.write()).toEqual(receipt); expect(f.objects.size).toBe(2);
  const entry = f.objects.values().next().value; entry.bytes[0] ^= 1;
  await expect(f.write()).rejects.toThrow(); // A conditional conflict cannot certify corrupt retained evidence.
});
it('refuses source/render object writes before sending or consuming any credential', async () => {
  const f = fixture();
  await expect(f.store.put(`release-pair-inputs/v2/${f.pair.pairId}/objects/${'a'.repeat(64)}.json`, new Uint8Array([1]), {})).rejects.toThrow();
  expect(f.calls).toHaveLength(0); expect(f.readCredential).not.toHaveBeenCalled();
});
it('refuses production pairs, disabled construction and ambiguous environment before transport', () => {
  const f = fixture();
  expect(() => createRehearsalQualificationStore({ ...f.options, authorized: false })).toThrow();
  expect(() => createRehearsalQualificationStore({ ...f.options, pairs: f.options.pairs.map(value => ({ ...value, environment: 'production' })) })).toThrow();
  vi.stubEnv('CMS_DEPLOYMENT_ENVIRONMENT', 'production');
  expect(() => createRehearsalQualificationStore(f.options)).toThrow();
  expect(f.calls).toHaveLength(0); expect(f.readCredential).not.toHaveBeenCalled();
});
it('refuses uncertain provider failure and closure without a successful native evidence record', async () => {
  const f = fixture({ $metadata: { httpStatusCode: 503 } });
  await expect(f.write()).rejects.toThrow('evidence storage refused'); expect(f.objects.size).toBe(0);
  f.store.close(); await expect(f.write()).rejects.toThrow();
});
