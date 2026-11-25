import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the real script against stub jawn-ops, node and pass binaries that log
// their arguments, the descriptors they were given, CMS_TARGET and whether a
// Cloudflare API token is in their environment.
const script = resolve('scripts/setup-dev.sh');
let bin; let log;
const stub = (name, body = '') => {
  const path = join(bin, name);
  // One write per call: process substitutions run beside the caller.
  writeFileSync(path, `#!/usr/bin/env bash\nline="${name}"; for arg in "$@"; do line+=" $arg"; done; [ -n "\${CMS_TARGET:-}" ] && line+=" target=$CMS_TARGET"; for fd in 3 4 5; do [ -e /proc/self/fd/$fd ] && line+=" fd$fd"; done; [ -n "\${CLOUDFLARE_API_TOKEN:-}" ] && line+=" api-token"; echo "$line" >> "${log}"\n${body}\n`);
  chmodSync(path, 0o755);
};
const env = { DEV_PUBLISHER_KEY_ENTRY: 'dev/publisher-key', DEV_OPERATOR_CREDENTIAL_ENTRY: 'dev/operator', DEV_CLOUDFLARE_READ_ENTRY: 'dev/cf-read',
  DEV_PUBLISHER_DEPLOY_ENTRY: 'dev/publisher-deploy', DEV_PUBLISHER_ACTIVATION_ENTRY: 'dev/publisher-activation',
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_PUBLIC_WORKER_TAG: 'c'.repeat(32), PUBLISHER_SHA: 'a'.repeat(40), PUBLISHER_IMAGE_RUN: '123' };
const ACCESS_CHECK = 'node --import ./node_modules/tsx/dist/loader.mjs scripts/check-public-worker-activation-access.ts --target development fd3';
const SECRET_PUT = 'node node_modules/wrangler/bin/wrangler.js secret put ACTIVATION_TOKEN --name njpbs-dev-cms-publisher api-token';
const run = (args = [], extra = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8',
  env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, JAWN_OPS: join(bin, 'jawn-ops'), ...env, ...extra } });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(line => !line.startsWith('pass '));

const publisher = (change = {}) => JSON.stringify({ schema: 1, check: true, source_sha: 'a'.repeat(40), deploy_needed: false,
  live: { version: 'v1', commit: 'a'.repeat(40) }, ...change });

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'setup-dev-')); log = join(bin, 'calls.log'); writeFileSync(log, '');
  stub('jawn-ops'); stub('node', `[ "$1" = node_modules/wrangler/bin/wrangler.js ] && cat > "${log}.stdin"; [ "$1" = scripts/install-dev-publisher.mjs ] && echo '${publisher()}'; exit 0`);
  stub('pass', 'echo "secret-value-$2"');
});
afterEach(() => rmSync(bin, { recursive: true }));

it.each([['still needs its deploy', { deploy_needed: true }], ['runs another commit', { live: { version: 'v1', commit: 'b'.repeat(40) } }],
  ['has no single live version', { live: { version: null, commit: 'a'.repeat(40) } }]])('refuses a publisher check that succeeds for a publisher that %s', (_label, change) => {
  stub('node', `[ "$1" = scripts/install-dev-publisher.mjs ] && echo '${publisher(change)}'; exit 0`);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('run install-dev-publisher.mjs first');
  expect(result.stderr).toContain('setup-dev: publisher check: refused (exit 1)');
  expect(result.stdout).not.toContain('every step passed');
});

it('installs, then reads back every step in order', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('setup-dev: every step passed');
  expect(result.stdout + result.stderr + readFileSync(log, 'utf8')).not.toContain('secret-value');
  // The activation token arrives on stdin without its newline, never in an argument.
  expect(readFileSync(`${log}.stdin`, 'utf8')).toBe('secret-value-dev/publisher-activation');
  expect(calls()).toEqual([
    'jawn-ops njpbs release admission --target development --install',
    'node scripts/component-runner.mjs functions provision-config target=development',
    'jawn-ops njpbs release admission --target development',
    'node scripts/component-runner.mjs functions verify-config target=development',
    'node scripts/check-dev-setup.mjs fd3',
    ACCESS_CHECK,
    SECRET_PUT,
    `node scripts/install-dev-publisher.mjs --sha ${'a'.repeat(40)} --image-run 123 --check fd3 fd5`,
  ]);
});

it('runs only the read-only checks with --check', () => {
  expect(run(['--check']).status).toBe(0);
  expect(calls().some(line => line.includes('--install') || line.includes('provision-config') || line.includes('secret put'))).toBe(false);
  expect(calls()).toContain(ACCESS_CHECK);
  expect(calls()).toHaveLength(5);
});

it('stops at the first refused step and names it', () => {
  stub('node', '[ "$3" = provision-config ] && exit 7; exit 0');
  const result = run();
  expect(result.status).toBe(7);
  expect(result.stderr).toContain('setup-dev: functions provision-config: refused (exit 7)');
  expect(calls()).toHaveLength(2);
});

it('sets no secret when the activation token reads refuse', () => {
  stub('node', '[ "$3" = scripts/check-public-worker-activation-access.ts ] && exit 1; exit 0');
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('setup-dev: activation token reads: refused (exit 1)');
  expect(calls().at(-1)).toBe(ACCESS_CHECK);
});

it('refuses missing inputs and unknown arguments before any step', () => {
  expect(run([], { DEV_PUBLISHER_KEY_ENTRY: '' }).status).not.toBe(0);
  expect(run(['--apply']).status).toBe(64);
  expect(run([], { PUBLISHER_SHA: 'main' }).status).toBe(64);
  expect(run([], { DEV_PUBLISHER_ACTIVATION_ENTRY: '' }).status).not.toBe(0);
  expect(run([], { CLOUDFLARE_PUBLIC_WORKER_TAG: 'tag' }).status).toBe(64);
  expect(readFileSync(log, 'utf8')).toBe('');
});
