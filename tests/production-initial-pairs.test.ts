import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { initialPairsPacket } from './helpers/development-initial-pairs';
import { parseProductionInitialPairsPacket, runProductionInitialPairs } from '../scripts/lib/production-initial-pairs.mjs';
import { createProductionInitialPairStore } from '../scripts/lib/production-initial-pair-store.mjs';
import { parseDevelopmentInitialPairsPacket } from '../scripts/lib/development-initial-pairs-packet.mjs';
import protocol from '../functions/lib/public-release-pair.js';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

function productionPacket() {
  const packet = initialPairsPacket(); packet.kind = 'production-initial-pairs';
  packet.credentialIdentity = { ...packet.credentialIdentity, projectId: 'njpbs-site',
    clientEmail: 'install-operator@njpbs-site.iam.gserviceaccount.com', secretRef: 'pass://production/install' };
  for (const pair of [packet.currentPair, packet.recoveryPair]) pair.environment = 'production';
  return packet;
}
it('runs the actual production offline CLI from a protected snapshot without credential descriptors', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'production-initial-cli-'));
  try {
    const operator = path.join(scratch, 'operator');
    execFileSync('git', ['clone', '--shared', '--quiet', process.cwd(), operator], { stdio: 'pipe' });
    await symlink(path.resolve('node_modules'), path.join(operator, 'node_modules'));
    await symlink(path.resolve('site/node_modules'), path.join(operator, 'site/node_modules'));
    const packet = productionPacket();
    packet.operatorCommitSha = execFileSync('git', ['-C', operator, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const bytes = JSON.stringify(packet), filename = path.join(scratch, 'packet.json'); await writeFile(filename, bytes);
    const args = ['--packet', filename, '--packet-digest', createHash('sha256').update(bytes).digest('hex')];
    const result = spawnSync(process.execPath, ['scripts/prepare-production-initial-pairs.mjs', ...args],
      { cwd: operator, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ projectId: 'njpbs-site', authorityReads: 0, authorityWrites: 0 });
    const wrong = spawnSync(process.execPath, ['scripts/prepare-development-initial-pairs.mjs', ...args],
      { cwd: operator, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000 });
    expect(wrong.status).toBe(1); expect(wrong.stdout).toBe('');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
it('plans offline with one production identity and refuses mixed packets before authority', async () => {
  const packet = productionPacket();
  expect(await runProductionInitialPairs({ packet })).toMatchObject({ projectId: 'njpbs-site', authorityReads: 0, authorityWrites: 0 });
  expect(() => parseDevelopmentInitialPairsPacket(packet)).toThrow();
  for (const change of [(p: any) => { p.currentPair.environment = 'development'; },
    (p: any) => { p.credentialIdentity.projectId = 'njpbs-site-dev'; }, (p: any) => { p.recoveryPair = p.currentPair; },
    (p: any) => { p.kind = 'development-initial-pairs'; }, (p: any) => { p.witnessDigest = 'f'.repeat(64); }]) {
    const wrong = structuredClone(packet); change(wrong); expect(() => parseProductionInitialPairsPacket(wrong)).toThrow();
  }
  await expect(runProductionInitialPairs({ packet, firestore: { projectId: 'njpbs-site-dev' }, mode: 'apply' })).rejects.toThrow();
});
it('sends only conditional pair-owned H/replay/evidence writes to the fixed production bucket', async () => {
  const packet = productionPacket(), pairs = [packet.currentPair, packet.recoveryPair], calls: any[] = [];
  let readCalls = 0, credentialCalls = 0;
  const store = createProductionInitialPairStore({ pairs,
    reads: { async getWithSignal() { readCalls++; return null; } },
    readCredential: async () => { credentialCalls++; throw new Error('No credentials with boundary client'); },
    client: { async send(command: any) { calls.push(command.input); } } });
  const bytes = Buffer.from('immutable production protocol fixture'), digest = createHash('sha256').update(bytes).digest('hex');
  const pairDigest = protocol.publicReleaseDigest(pairs[0]);
  const options = { onlyIf: { etagDoesNotMatch: '*' }, sha256: digest,
    customMetadata: { schemaversion: '2', pairdigest: pairDigest, bodydigest: digest } };
  const keys = [`release-pair-inputs/v2/${pairs[0].pairId}/objects/${digest}.json`,
    `release-pair-replay/v2/${pairDigest}/pages/${digest}.json`];
  for (const key of keys) await store.put(key, bytes, options);
  const witnessDigest = 'f'.repeat(64);
  const evidence = `release-pair-qualifications/v1/${pairDigest}/${witnessDigest}/pages/${digest}.json`;
  await store.put(evidence, bytes, { ...options, customMetadata: { ...options.customMetadata, schemaversion: '1', witnessdigest: witnessDigest } });
  expect(calls).toHaveLength(3);
  for (const call of calls) expect(call).toMatchObject({ Bucket: 'njpbs-cms-publication', IfNoneMatch: '*', Body: bytes });
  for (const key of ['other/object', keys[0].replace(pairs[0].pairId, 'foreign-pair'),
    `release-pairs/${pairs[0].pairId}/objects/${digest}.json`, keys[1].replace(pairDigest, '0'.repeat(64))])
    await expect(store.put(key, bytes, options)).rejects.toThrow();
  await expect(store.put(keys[0], bytes, { ...options, onlyIf: { etagDoesNotMatch: 'overwrite' } })).rejects.toThrow();
  expect(() => store.get('other/object')).toThrow(); expect(readCalls).toBe(0); expect(credentialCalls).toBe(0);
  expect(calls).toHaveLength(3); store.close(); expect(() => store.get(keys[0])).toThrow();
});
