#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Protected source check precedes repository modules, ignored dependencies,
// pipes and network initialization. Run in the documented clean Node22 shell.
try {
  const args = process.argv.slice(2);
  if (![4, 5].includes(args.length) || args[0] !== '--packet' || !args[1] || args[2] !== '--packet-digest' ||
      !/^[a-f0-9]{64}$/.test(args[3] ?? '') || args.length === 5 && !['--apply', '--readback', '--observe', '--capture-recovery'].includes(args[4])) throw new Error();
  const bytes = readFileSync(args[1]);
  if (!bytes.length || bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== args[3]) throw new Error();
  const sha = JSON.parse(bytes.toString('utf8')).operatorCommitSha;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error();
  const options = { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], options).trim();
  if (git(['rev-parse', 'HEAD']) !== sha || !assertDevelopmentSource(options.cwd)) throw new Error();
  const { runProductionSwitchCommand } = await import('./lib/production-public-release-switch.mjs');
  const result = await runProductionSwitchCommand(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.outcome === 'unconfirmed') process.exitCode = 1;
} catch {
  process.stderr.write('Production switch was not confirmed; preserve the original packet and use --readback\n');
  process.exitCode = 1;
}
