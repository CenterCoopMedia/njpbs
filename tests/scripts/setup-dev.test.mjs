import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the real script against stub jawn-ops, node and pass binaries that log
// their arguments, the descriptors they were given and CMS_TARGET.
const script = resolve('scripts/setup-dev.sh');
let bin; let log;
const stub = (name, body = '') => {
  const path = join(bin, name);
  // One write per call: process substitutions run beside the caller.
  writeFileSync(path, `#!/usr/bin/env bash\nline="${name}"; for arg in "$@"; do line+=" $arg"; done; [ -n "\${CMS_TARGET:-}" ] && line+=" target=$CMS_TARGET"; for fd in 3 4 5; do [ -e /proc/self/fd/$fd ] && line+=" fd$fd"; done; echo "$line" >> "${log}"\n${body}\n`);
  chmodSync(path, 0o755);
};
const env = { DEV_PUBLISHER_KEY_ENTRY: 'dev/publisher-key', DEV_OPERATOR_CREDENTIAL_ENTRY: 'dev/operator', DEV_CLOUDFLARE_READ_ENTRY: 'dev/cf-read',
  PUBLISHER_SHA: 'a'.repeat(40), PUBLISHER_IMAGE_RUN: '123' };
const run = (args = [], extra = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8',
  env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, JAWN_OPS: join(bin, 'jawn-ops'), ...env, ...extra } });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(line => !line.startsWith('pass '));

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'setup-dev-')); log = join(bin, 'calls.log'); writeFileSync(log, '');
  stub('jawn-ops'); stub('node'); stub('pass', 'echo secret-value');
});
afterEach(() => rmSync(bin, { recursive: true }));

it('installs, then reads back every step in order', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('setup-dev: every step passed');
  expect(result.stdout + result.stderr).not.toContain('secret-value');
  expect(calls()).toEqual([
    'jawn-ops njpbs release admission --target development --install',
    'node scripts/component-runner.mjs functions provision-config target=development',
    'jawn-ops njpbs release admission --target development',
    'node scripts/component-runner.mjs functions verify-config target=development',
    'node scripts/check-dev-setup.mjs fd3',
    `node scripts/install-dev-publisher.mjs --sha ${'a'.repeat(40)} --image-run 123 --check fd3 fd5`,
  ]);
});

it('runs only the read-only checks with --check', () => {
  expect(run(['--check']).status).toBe(0);
  expect(calls().some(line => line.includes('--install') || line.includes('provision-config'))).toBe(false);
  expect(calls()).toHaveLength(4);
});

it('stops at the first refused step and names it', () => {
  stub('node', '[ "$3" = provision-config ] && exit 7; exit 0');
  const result = run();
  expect(result.status).toBe(7);
  expect(result.stderr).toContain('setup-dev: functions provision-config: refused (exit 7)');
  expect(calls()).toHaveLength(2);
});

it('refuses missing inputs and unknown arguments before any step', () => {
  expect(run([], { DEV_PUBLISHER_KEY_ENTRY: '' }).status).not.toBe(0);
  expect(run(['--apply']).status).toBe(64);
  expect(run([], { PUBLISHER_SHA: 'main' }).status).toBe(64);
  expect(readFileSync(log, 'utf8')).toBe('');
});
