import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('the exact Bash runbook helper preserves streamed credentials without echo or argv', async () => {
  const helper = await readFile(new URL("./fixtures/routing-credential-forwarding.sh", import.meta.url), "utf8");
  const directory = await mkdtemp(resolve(tmpdir(), 'routing-runbook-'));
  try {
    const bin = resolve(directory, 'node_modules/wrangler/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(resolve(bin, 'wrangler.js'), `let text='';
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', () => {
  if (process.env.CLOUDFLARE_API_TOKEN !== 'fixture-first-line-never-a-real-credential' ||
      text !== 'fixture-second-line-never-a-real-credential\\n' || process.argv.length !== 2) process.exitCode=1;
  else process.stdout.write('forwarding-ok\\n');
});\n`);
    const result = spawnSync('bash', ['-c', `${helper}\ncf_m28`], { cwd: directory, encoding: 'utf8', timeout: 10000,
      input: 'fixture-first-line-never-a-real-credential\nfixture-second-line-never-a-real-credential\n' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'forwarding-ok\n'); assert.equal(result.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
