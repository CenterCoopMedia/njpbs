import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'first-install-command-')); directories.push(directory);
  mkdirSync(path.join(directory, 'bin'));
  // Only the child process/vault boundaries are fixtures. Execute each Bash
  // command file, its noclobber guards and its real inherited FDs as written.
  writeFileSync(path.join(directory, 'bin/pass'), '#!/bin/bash\nprintf "%s\\n" "$2" >> "$CALL_VAULT"\nprintf "synthetic-%s\\n" "$2"\n', { mode: 0o755 });
  writeFileSync(path.join(directory, 'bin/node'), `#!/bin/bash
exec '${process.execPath}' '${path.join(directory, 'child.cjs')}' "$@"
`, { mode: 0o755 });
  writeFileSync(path.join(directory, 'child.cjs'), `const fs = require('node:fs');
const [command, mode, ...args] = process.argv.slice(2);
if (command !== 'scripts/prepare-development-pair-code-pack.mjs') process.exit(3);
const channels = mode === 'freeze' ? [3, 4] : [];
for (const fd of channels) {
  if (!fs.fstatSync(fd).isFIFO()) process.exit(4);
  const expected = fd === 3 ? 'synthetic-sdk-entry\\n' : 'synthetic-r2-entry\\n';
  if (fs.readFileSync(fd, 'utf8') !== expected) process.exit(5);
}
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ mode, args, channels }) + '\\n');
if (process.env.CALL_FAIL === '1') process.exit(7);
process.stdout.write(JSON.stringify({ status: mode === 'freeze' ? 'frozen' : 'prepared' }) + '\\n');
`);
  const env: Record<string, string> = { PATH: path.join(directory, 'bin') + ':' + process.env.PATH,
    DEV_INSTALL_EVIDENCE: path.join(directory, 'evidence'), DEV_PAIR_CODE_PACK_PACKET: path.join(directory, 'packet.json'),
    DEV_PAIR_CODE_PACK_PACKET_SHA256: 'a'.repeat(64), DEV_PAIR_CODE_PACK_LABEL: 'old',
    DEV_SDK_ENTRY: 'sdk-entry', DEV_R2_READ_ENTRY: 'r2-entry', CALL_LOG: path.join(directory, 'calls'), CALL_VAULT: path.join(directory, 'vault') };
  const run = (mode: string) => spawnSync('bash', ['scripts/development-install/code-pack/' + mode + '.sh'], { env, encoding: 'utf8', timeout: 10_000 });
  return { directory, env, run };
}
it('runs each attended block as written and gives only freeze the SDK and R2 read pipes', () => {
  const f = fixture();
  for (const mode of ['freeze', 'image-context', 'extract', 'build']) expect(f.run(mode).status).toBe(0);
  const calls = readFileSync(f.env.CALL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(call => [call.mode, call.channels])).toEqual([['freeze', [3, 4]], ['image-context', []], ['extract', []], ['build', []]]);
  expect(readFileSync(f.env.CALL_VAULT, 'utf8').trim().split('\n').sort()).toEqual(['r2-entry', 'sdk-entry']);
});
it('preserves the first receipt on repetition and stops a failed child without dispatching a later block', () => {
  const f = fixture(); expect(f.run('build').status).toBe(0);
  const receipt = path.join(f.env.DEV_INSTALL_EVIDENCE, 'old-code-pack-preparation.json');
  const original = readFileSync(receipt, 'utf8');
  expect(f.run('build').status).not.toBe(0); expect(readFileSync(receipt, 'utf8')).toBe(original);
  f.env.DEV_PAIR_CODE_PACK_LABEL = 'new'; f.env.CALL_FAIL = '1';
  expect(f.run('build').status).toBe(7);
  expect(readFileSync(f.env.CALL_LOG, 'utf8').trim().split('\n')).toHaveLength(2);
});
it('refuses a missing packet seal or invalid label before opening either vault entry', () => {
  for (const key of ['DEV_PAIR_CODE_PACK_PACKET', 'DEV_PAIR_CODE_PACK_PACKET_SHA256', 'DEV_PAIR_CODE_PACK_LABEL']) {
    const f = fixture(); delete f.env[key]; expect(f.run('freeze').status).not.toBe(0);
    expect(existsSync(f.env.CALL_VAULT)).toBe(false);
  }
  const f = fixture(); f.env.DEV_PAIR_CODE_PACK_LABEL = '../outside';
  expect(f.run('freeze').status).not.toBe(0); expect(existsSync(f.env.CALL_VAULT)).toBe(false);
});
