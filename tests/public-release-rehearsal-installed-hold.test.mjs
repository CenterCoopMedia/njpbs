import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { releasePair } from './helpers/private-public-release-pair.js';
import { assertRehearsalHoldRuntimeSource, createRehearsalHoldActions } from '../scripts/lib/rehearsal-installed-hold.mjs';
import { InstalledRehearsalStop } from '../scripts/lib/rehearsal-installed-stop.mjs';

// Immutable historical fixtures from 9d16bba5 and the pre-hold #4443 parent.
// These are independent of the accepted list under test.
const original = {
  'functions/lib/public-release-rehearsal-hold.js': '017be0ac0de3bd690c5e57ad08a2b6e8949f11ff',
  'functions/lib/public-release-admission.js': 'a50edf43d30b72a3066e03bf7459c39bd59db12d',
  'site/scripts/public-release-original-continuation.ts': '9d63f973df10ca003770cecbfe155e87dde664a4',
  'site/scripts/public-release-publication-terminal.ts': 'e4b22f85bfa2278cf53706ae2b6f9163a798ac5e',
};
const reverted = {
  'functions/lib/public-release-admission.js': 'ecde2ffa4fc41b5262e3563d863264d48b06a4c4',
  'site/scripts/public-release-original-continuation.ts': '3f2323ec0614c5dbd914077b13fea0ba18e70776',
  'site/scripts/public-release-publication-terminal.ts': '92cf479eb9c5f0d65e29f56e53b2063ac9c3ae78',
};
const files = Object.keys(original);
const current = { ...original, 'functions/lib/public-release-admission.js': '437aa9294dc09055ce1bfecddd70ff509749afc7' };
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pairs = () => [releasePair('a', head), releasePair('b', head)];

it('reads the reviewed current owner source from both exact pair commits', () => {
  expect(assertRehearsalHoldRuntimeSource(pairs())).toEqual({ sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
it('accepts both the original reviewed set and the current admission guard, sealing the actual combination', () => {
  const values = pairs(); values[1].commitSha = 'b'.repeat(40);
  const readSource = vi.fn(sha => ({ ...(sha === values[0].commitSha ? original : current) }));
  const mixed = assertRehearsalHoldRuntimeSource(values, readSource);
  expect(readSource.mock.calls).toEqual(values.map(pair => [pair.commitSha]));
  expect(mixed).not.toEqual(assertRehearsalHoldRuntimeSource(values, () => ({ ...original })));
  expect(mixed).not.toEqual(assertRehearsalHoldRuntimeSource(values, () => ({ ...current })));
});
it.each(files)('refuses an installed source with an unreviewed %s blob', file => {
  const values = pairs(); values[1].commitSha = 'b'.repeat(40);
  const readSource = sha => ({ ...current, ...(sha === values[1].commitSha ? { [file]: 'c'.repeat(40) } : {}) });
  expect(() => assertRehearsalHoldRuntimeSource(values, readSource)).toThrow(InstalledRehearsalStop);
});
it.each(files)('refuses a missing mandatory %s owner', file => {
  const source = { ...current }; delete source[file];
  expect(() => assertRehearsalHoldRuntimeSource(pairs(), () => source)).toThrow(InstalledRehearsalStop);
});
it.each(Object.entries(reverted))('refuses a reverted pre-hold %s blob even beside reviewed owners', (file, blob) => {
  expect(() => assertRehearsalHoldRuntimeSource(pairs(), () => ({ ...current, [file]: blob }))).toThrow(InstalledRehearsalStop);
});
it('refuses unavailable, incomplete or extra source-tree entries without a readiness fallback', () => {
  expect(() => assertRehearsalHoldRuntimeSource(pairs(), () => { throw new Error('Unavailable source'); })).toThrow(InstalledRehearsalStop);
  expect(() => assertRehearsalHoldRuntimeSource(pairs(), () => ({}))).toThrow(InstalledRehearsalStop);
  expect(() => assertRehearsalHoldRuntimeSource(pairs(), () => ({ ...current, 'extra.js': 'c'.repeat(40) }))).toThrow(InstalledRehearsalStop);
});
it('keeps hold construction explicitly disabled before source, SDK or provider access', () => {
  const readSource = vi.fn();
  expect(() => createRehearsalHoldActions({ readSource })).toThrow('hold binding refused');
  expect(readSource).not.toHaveBeenCalled();
});
