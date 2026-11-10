import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { initialPairsPacket } from './helpers/development-initial-pairs';
import { parseDevelopmentInitialPairsPacket, runDevelopmentInitialPairs } from '../scripts/lib/development-initial-pairs.mjs';
import { createDevelopmentInitialPairStore } from '../scripts/lib/development-initial-pair-store.mjs';
import protocol from '../functions/lib/public-release-pair.js';

it('plans offline and refuses production, duplicate identities, relative artifacts and caller proof fields', async () => {
  const packet = initialPairsPacket();
  expect(await runDevelopmentInitialPairs({ packet })).toMatchObject({ authorityReads: 0, authorityWrites: 0 });
  for (const change of [
    (p: any) => { p.credentialIdentity.projectId = 'njpbs-site'; },
    (p: any) => { p.recoveryPair.environment = 'production'; },
    (p: any) => { p.recoveryPair = p.currentPair; },
    (p: any) => { p.artifacts[0].distDirectory = 'relative'; },
    (p: any) => { p.qualificationIds[1] = p.qualificationIds[0]; },
    (p: any) => { p.witnessDigest = 'e'.repeat(64); },
  ]) { const changed = structuredClone(packet); change(changed); expect(() => parseDevelopmentInitialPairsPacket(changed)).toThrow(); }
  await expect(runDevelopmentInitialPairs({ packet, firestore: { projectId: 'njpbs-site' }, mode: 'apply' })).rejects.toThrow();
});
it('limits actual S3 commands to conditional native H/replay/evidence keys and bounds reads before credentials', async () => {
  const packet = initialPairsPacket(), pairs = [packet.currentPair, packet.recoveryPair], calls: any[] = [];
  let reads = 0, credentials = 0;
  const store = createDevelopmentInitialPairStore({ pairs, reads: { async getWithSignal() { reads++; return null; } },
    readCredential: async () => { credentials++; throw new Error('No credential expected with supplied client'); },
    client: { async send(command: any, options: any) { calls.push(command.input); expect(options.abortSignal.aborted).toBe(false); } } });
  const bytes = new TextEncoder().encode('native immutable bytes'), digest = createHash('sha256').update(bytes).digest('hex');
  const metadata = { schemaversion: '2', pairdigest: protocol.publicReleaseDigest(pairs[0]), bodydigest: digest };
  const options = { onlyIf: { etagDoesNotMatch: '*' }, sha256: digest, customMetadata: metadata };
  const key = `release-pair-inputs/v2/${pairs[0].pairId}/objects/${digest}.json`;
  await store.put(key, bytes, options);
  expect(calls[0]).toMatchObject({ Bucket: 'njpbs-dev-cms-publication', Key: key, IfNoneMatch: '*', Metadata: metadata });
  expect(credentials).toBe(0);
  for (const wrong of ['arbitrary/key', key.replace(pairs[0].pairId, 'unknown'), `release-pairs/${pairs[0].pairId}/objects/${digest}.json`]) {
    await expect(store.put(wrong, bytes, options)).rejects.toThrow();
  }
  await expect(store.put(key, bytes, { ...options, onlyIf: { etagDoesNotMatch: 'overwrite' } })).rejects.toThrow();
  await expect(store.put(key, new Uint8Array([1]), options)).rejects.toThrow();
  expect(() => store.get('production/object')).toThrow(); expect(reads).toBe(0); expect(calls).toHaveLength(1);
  store.close(); expect(() => store.get(key)).toThrow();
});
