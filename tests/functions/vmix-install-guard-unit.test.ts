import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const windowsNode = '/mnt/c/Program Files/nodejs/node.exe';
const hasWindowsNode = process.platform === 'linux' && existsSync(windowsNode);

let root: string, directory: string, agent: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vmix-install-gate-')); directory = join(root, 'vmix-agent'); mkdirSync(directory);
  agent = join(directory, 'vmix-agent.cjs');
  await build({ entryPoints: ['agents/vmix/src/service.ts'], outfile: agent, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('normal connector launch installation gate', () => {
  it.each(['self-test.pending', 'vmix-agent-setup.lock'])('refuses %s before reading config or credentials, including direct Node launches', marker => {
    const path = marker === 'self-test.pending' ? join(directory, marker) : join(root, marker);
    writeFileSync(path, 'synthetic recovery state');
    try {
      const result = spawnSync(process.execPath, [agent, '--config', join(root, 'deliberately-missing-config.json'), '--stored-credentials'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Studio setup needs recovery or its self-test has not passed');
    } finally { rmSync(path); }
  });
  // #4639: execute the compiled consumer with native Windows path semantics on
  // the WSL worker; Linux hosted CI executes the platform-neutral cases above.
  it.runIf(hasWindowsNode).each(['self-test.pending', 'vmix-agent-setup.lock'])('blocks native Windows Node through %s', marker => {
    const path = marker === 'self-test.pending' ? join(directory, marker) : join(root, marker);
    writeFileSync(path, 'synthetic recovery state');
    try {
      const file = execFileSync('wslpath', ['-w', agent], { encoding: 'utf8' }).trim();
      const result = spawnSync(windowsNode, [file, '--config', 'Z:\\deliberately-missing-config.json', '--stored-credentials'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Studio setup needs recovery or its self-test has not passed');
    } finally { rmSync(path); }
  });
  it('allows offline simulation to verify a package while normal startup stays blocked', () => {
    writeFileSync(join(directory, 'self-test.pending'), 'synthetic pending self-test');
    const result = spawnSync(process.execPath, [agent, '--simulate'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Simulation passed');
  });
});
