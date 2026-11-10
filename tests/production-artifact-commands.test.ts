import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(step = 'qualify') {
  const directory = mkdtempSync(path.join(tmpdir(), 'production-command-')); directories.push(directory);
  const bin = path.join(directory, 'bin'); mkdirSync(bin);
  const log = path.join(directory, 'calls'), vault = path.join(directory, 'vault'), packet = path.join(directory, 'packet.json');
  const bytes = JSON.stringify({ kind: 'production-initial-pairs', step }); writeFileSync(packet, bytes);
  writeFileSync(path.join(bin, 'pass'), `#!/bin/bash
printf '%s\\n' "$2" >> '${vault}'
printf 'synthetic-%s\\n' "$2"
`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'node'), `#!/bin/bash
if [[ "$1" == --input-type=module ]]; then exec '${process.execPath}' "$@"; fi
exec '${process.execPath}' '${path.join(directory, 'child.cjs')}' "$@"
`, { mode: 0o700 });
  writeFileSync(path.join(directory, 'child.cjs'), `const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const code = command === 'scripts/prepare-production-pair-code-pack.mjs';
if (!code && command !== 'scripts/prepare-production-initial-pairs.mjs') process.exit(3);
const mode = code ? args[0] : args.includes('--apply') ? 'apply' : args.includes('--readback') ? 'readback' : 'plan';
const channels = code ? mode === 'freeze' ? [3,4] : [] : mode === 'apply' ? ${step === 'qualify' ? '[3,4,5,6,7]' : '[3,4,5]'} : mode === 'readback' ? [3] : [];
const names = {3:'sdk',4:'read',5:'write',6:'old-reader',7:'new-reader'};
for (const fd of channels) {
  if (!fs.fstatSync(fd).isFIFO() || fs.readFileSync(fd,'utf8') !== 'synthetic-' + names[fd] + '\\n') process.exit(4);
}
fs.appendFileSync('${log}', JSON.stringify({mode,channels}) + '\\n');
const status = fs.existsSync('${path.join(directory, 'waiting')}') ? 'waiting' : ${JSON.stringify(step === 'qualify' ? 'qualified' : step === 'stage' ? 'retained' : 'old-code-sealed')};
process.stdout.write(JSON.stringify({status})+'\\n');
`);
  const env = { PATH: bin + ':' + process.env.PATH, HOME: directory,
    PACKET: packet, PACKET_SHA256: createHash('sha256').update(bytes).digest('hex'), RESULT: path.join(directory, 'result.json'),
    SDK_ENTRY: 'sdk', R2_READ_ENTRY: 'read', R2_WRITE_ENTRY: 'write', OLD_READER_ACCESS_ENTRY: 'old-reader', NEW_READER_ACCESS_ENTRY: 'new-reader' };
  let sequence = 0;
  const run = (block: string, fresh = true) => { if (fresh) env.RESULT = path.join(directory, `result-${++sequence}.json`);
    return spawnSync('bash', ['-c', block], { env, encoding: 'utf8', timeout: 10_000 }); };
  return { directory, env, log, vault, run };
}
it('runs every documented Bash block as written and preserves distinct inherited read/write/reader pipes', () => {
  const f = fixture(), doc = readFileSync('tests/preflight/fixtures/commands/artifacts.md', 'utf8');
  const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
  expect(blocks).toHaveLength(7);
  for (const block of blocks) expect(f.run(block).status).toBe(0);
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(call => [call.mode, call.channels])).toEqual([
    ['freeze', [3, 4]], ['image-context', []], ['extract', []], ['build', []],
    ['plan', []], ['apply', [3, 4, 5, 6, 7]], ['readback', [3]],
  ]);
});
it.each(['old-code', 'stage'])('opens no reader credential for %s', step => {
  const f = fixture(step);
  delete (f.env as any).OLD_READER_ACCESS_ENTRY; delete (f.env as any).NEW_READER_ACCESS_ENTRY;
  expect(f.run('bash scripts/production-install/initial-pairs.sh apply').status).toBe(0);
  expect(readFileSync(f.vault, 'utf8').trim().split('\n').sort()).toEqual(['read', 'sdk', 'write']);
});
it('stops on pending original work, preserves receipts, and refuses missing qualification Access before vault reads', () => {
  const f = fixture(); writeFileSync(path.join(f.directory, 'waiting'), '');
  expect(f.run('bash scripts/production-install/initial-pairs.sh apply').status).not.toBe(0);
  const original = readFileSync(f.env.RESULT, 'utf8');
  expect(f.run('bash scripts/production-install/initial-pairs.sh apply', false).status).not.toBe(0);
  expect(readFileSync(f.env.RESULT, 'utf8')).toBe(original);
  const missing = fixture(); delete (missing.env as any).NEW_READER_ACCESS_ENTRY;
  expect(missing.run('bash scripts/production-install/initial-pairs.sh apply').status).not.toBe(0);
  expect(existsSync(missing.vault)).toBe(false);
});
