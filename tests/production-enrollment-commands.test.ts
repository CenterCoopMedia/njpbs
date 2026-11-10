import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
it('runs every documented attended enrollment block with only the required inherited pipes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'enrollment-command-')); directories.push(directory);
  const bin = path.join(directory, 'bin'); mkdirSync(bin);
  const log = path.join(directory, 'calls');
  writeFileSync(path.join(bin, 'pass'), '#!/bin/bash\nprintf "synthetic-%s\\n" "$2"\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'node'), `#!/bin/bash
exec '${process.execPath}' '${path.join(directory, 'child.cjs')}' "$@"
`, { mode: 0o700 });
  writeFileSync(path.join(directory, 'child.cjs'), `const fs=require('node:fs');
const [command,mode,...args]=process.argv.slice(2);
if(command!=='scripts/enroll-public-release-change-log.mjs'||args[0]!=='--project'||args[1]!=='njpbs-site'||!args.includes('--production-sdk-packet'))process.exit(3);
const channels=['dry-run','apply'].includes(mode)?[3,4]:[3];
for(const fd of channels){if(!fs.fstatSync(fd).isFIFO()||fs.readFileSync(fd,'utf8')!=='synthetic-'+(fd===3?'sdk':'edge')+'\\n')process.exit(4);}
fs.appendFileSync('${log}',JSON.stringify({mode,channels})+'\\n');process.stdout.write('{}\\n');
`);
  const env = { PATH: bin + ':' + process.env.PATH, HOME: directory, SDK_ENTRY: 'sdk', EDGE_ENTRY: 'edge',
    ENROLLMENT_SDK_PACKET: path.join(directory, 'sdk.json'), ENROLLMENT_SDK_PACKET_SHA256: 'a'.repeat(64),
    ENROLLMENT_REQUEST: path.join(directory, 'request.json'), RESULT: '' };
  const blocks = [...readFileSync('tests/preflight/fixtures/commands/enrollment.md', 'utf8').matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
  expect(blocks).toHaveLength(4);
  for (const [index, block] of blocks.entries()) { env.RESULT = path.join(directory, `${index}.json`);
    expect(spawnSync('bash', ['-c', block], { env, encoding: 'utf8', timeout: 8000 }).status).toBe(0); }
  expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { mode: 'inspect', channels: [3] }, { mode: 'dry-run', channels: [3, 4] },
    { mode: 'apply', channels: [3, 4] }, { mode: 'readback', channels: [3] },
  ]);
  expect(spawnSync('bash', ['-c', blocks[3]], { env, encoding: 'utf8', timeout: 8000 }).status).not.toBe(0);
});
