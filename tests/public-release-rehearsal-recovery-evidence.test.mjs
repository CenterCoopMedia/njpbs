import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRehearsalRecoveryEvidence } from '../scripts/lib/rehearsal-recovery-evidence.mjs';

// Real filesystem fault boundary only; these fixtures claim no native owner
// success, installed readiness or rehearsal PASS.
let parent;
const binding = { packet: { runId: 'lost-local-binding' }, sourceCommitSha: 'a'.repeat(40), adapterDigest: 'b'.repeat(64) };
const history = [{ receipt: { step: 'baseline' }, bytes: '{"original":"verified-sdk-bytes"}\n' }];
const result = { kind: 'recovery-only', runId: binding.packet.runId, sourceSha: binding.sourceCommitSha,
  scenarioPassed: false, controlsContinuous: false, productionAdoption: false, measurementsAccepted: false };
beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), 'rehearsal-recovery-evidence-')); });
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
it('recovers a crash before even the evidence directory or packet binding exists', async () => {
  const directory = join(parent, 'missing', 'evidence');
  const evidence = await openRehearsalRecoveryEvidence(directory, binding, history);
  try {
    expect(await readFile(join(directory, 'packet.json'), 'utf8')).toBe(JSON.stringify(binding, null, 2) + '\n');
    expect(await readFile(join(directory, 'baseline.json'), 'utf8')).toBe(history[0].bytes);
    await evidence.write(result); await evidence.write(result);
    expect(JSON.parse(await readFile(join(directory, 'recovery-only.json'), 'utf8'))).toEqual(result);
  } finally { await evidence.close(); }
});
it('refuses a live evidence lock and never removes that other owner lock', async () => {
  const first = await openRehearsalRecoveryEvidence(parent, binding, []);
  try { await expect(openRehearsalRecoveryEvidence(parent, binding, [])).rejects.toMatchObject({ code: 'EEXIST' }); }
  finally { await first.close(); }
  await mkdir(join(parent, 'running')); await first.close();
  expect((await stat(join(parent, 'running'))).isDirectory()).toBe(true);
  await expect(first.write(result)).rejects.toThrow();
});
it('preserves conflicting original packet bytes and releases only its own failed lock', async () => {
  await writeFile(join(parent, 'packet.json'), 'conflicting-original\n');
  await expect(openRehearsalRecoveryEvidence(parent, binding, [])).rejects.toThrow();
  expect(await readFile(join(parent, 'packet.json'), 'utf8')).toBe('conflicting-original\n');
  await expect(stat(join(parent, 'running'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses altered verified receipts and traversal without overwriting either', async () => {
  await writeFile(join(parent, 'baseline.json'), 'preserved-uncertain-local\n');
  await expect(openRehearsalRecoveryEvidence(parent, binding, history)).rejects.toThrow();
  expect(await readFile(join(parent, 'baseline.json'), 'utf8')).toBe('preserved-uncertain-local\n');
  await expect(openRehearsalRecoveryEvidence(parent, binding, [{ receipt: { step: '../escape' }, bytes: 'refused' }])).rejects.toThrow();
});
it('refuses symlink aliases before creating missing descendants', async () => {
  await mkdir(join(parent, 'real')); await symlink(join(parent, 'real'), join(parent, 'alias'));
  await expect(openRehearsalRecoveryEvidence(join(parent, 'alias', 'missing'), binding, [])).rejects.toThrow();
  await expect(stat(join(parent, 'real', 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(join(parent, 'real', 'original.json'), JSON.stringify(binding, null, 2) + '\n');
  await symlink(join(parent, 'real', 'original.json'), join(parent, 'packet.json'));
  await expect(openRehearsalRecoveryEvidence(parent, binding, [])).rejects.toThrow();
});
it('cannot write a scenario PASS or replace a different recovery result', async () => {
  const evidence = await openRehearsalRecoveryEvidence(parent, binding, []);
  try {
    await expect(evidence.write({ ...result, scenarioPassed: true })).rejects.toThrow();
    await evidence.write(result);
    await expect(evidence.write({ ...result, operations: ['different'] })).rejects.toThrow();
    expect(JSON.parse(await readFile(join(parent, 'recovery-only.json'), 'utf8'))).toEqual(result);
  } finally { await evidence.close(); }
});
