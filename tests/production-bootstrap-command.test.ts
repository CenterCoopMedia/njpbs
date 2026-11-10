import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the OS process/credential-source boundary is fake. Native transactions
// and source-pinned CLI plans have their own emulator/process coverage.
it.each([
  ['pause', 'plan', []], ['pause', 'apply', ['sdk']],
  ['pause-recovery', 'plan', [], 2], ['pause-recovery', 'apply', [], 2], ['pause-recovery', 'readback', [], 2],
  ['preview-pause', 'apply', ['sdk']], ['preview-restore', 'apply', ['sdk']],
  ['restore-node-compute', 'apply', ['sdk']], ['controls', 'apply', ['google', 'sdk']],
  ['initial', 'apply', ['google', 'r2', 'sdk']], ['resume', 'apply', ['google', 'r2', 'sdk']],
  ['initial', 'readback', ['sdk']], ['close', 'abandon', ['sdk']],
])('runs the documented Bash %s %s block with only its required inherited pipes', async (step, mode, entries, expectedStatus = 0) => {
  const directory = await mkdtemp(join(tmpdir(), 'production-command-'));
  try {
    const bin = join(directory, 'bin'), log = join(directory, 'entries'); await mkdir(bin);
    await writeFile(join(bin, 'pass'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$2" >> "$FAKE_ENTRY_LOG"\nprintf "synthetic-fixture-only\\n"\n', { mode: 0o700 });
    await writeFile(join(bin, 'node'), `#!/bin/bash
set -eu
if [[ "$1" == --input-type=module ]]; then
  if [[ "$3" == *readFileSync* ]]; then printf '%s\\n' "$FAKE_STEP"; fi
  exit
fi
if [[ "$FAKE_STEP" == pause-recovery ]]; then printf '{"stop":true,"gapIssue":4582}\\n'; exit 2; fi
if [[ "$*" == *--apply* || "$*" == *--readback* || "$*" == *--abandon* ]]; then
  read -r -u 3 value
  if [[ "$*" == *--apply* && "$FAKE_STEP" == controls ]]; then read -r -u 5 value; fi
  if [[ "$*" == *--apply* && ( "$FAKE_STEP" == initial || "$FAKE_STEP" == resume ) ]]; then read -r -u 4 value; read -r -u 5 value; fi
fi
printf '{"boundary":"synthetic-command-proof"}\\n'
`, { mode: 0o700 });
    const output = join(directory, 'result.json');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STEP: step, FAKE_ENTRY_LOG: log,
      PROD_BOOTSTRAP_PACKET: join(directory, 'packet.json'), PROD_BOOTSTRAP_PACKET_SHA256: 'a'.repeat(64),
      PROD_BOOTSTRAP_OUTPUT: output, PROD_SDK_ENTRY: 'sdk', PROD_GOOGLE_READ_ENTRY: 'google', PROD_R2_READ_ENTRY: 'r2' };
    const result = spawnSync('bash', ['scripts/production-install/bootstrap.sh', mode], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(expectedStatus); expect(result.stdout).toBe('');
    if (expectedStatus === 2) expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ stop: true, gapIssue: 4582 });
    else expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ boundary: 'synthetic-command-proof' });
    const fetched = await readFile(log, 'utf8').catch(() => '');
    expect(fetched.trim().split('\n').filter(Boolean).sort()).toEqual(entries);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
