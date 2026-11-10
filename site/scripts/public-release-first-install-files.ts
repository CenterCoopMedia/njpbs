import { assertDevelopmentSource } from "../../scripts/render-development-config.mjs";
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isPairCodePackPath } from './public-release-pair-code-pack';
import { MAX_RETAINED_IMAGE_BYTES } from './retained-public-images';

export const firstInstallHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const firstInstallRefused = (): never => { throw new Error('First-install code-pack preparation refused'); };
export function assertFirstInstallSource(directory: string, commitSha: string) {
  if (!path.isAbsolute(directory) || !/^[a-f0-9]{40}$/.test(commitSha)) firstInstallRefused();
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  if (git('rev-parse', 'HEAD') !== commitSha || !assertDevelopmentSource(directory)) firstInstallRefused();
  return git('rev-parse', 'HEAD^{tree}');
}
export async function firstInstallFile(directory: string, relative: string,
  limit = /^images\/[a-f0-9]{64}$/.test(relative) ? MAX_RETAINED_IMAGE_BYTES : 16 * 1024 * 1024) {
  if (!isPairCodePackPath('/' + relative)) firstInstallRefused();
  const file = path.join(directory, relative);
  if (await realpath(file) !== file) firstInstallRefused();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) firstInstallRefused();
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.ino !== after.ino || before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) firstInstallRefused();
    return bytes;
  } finally { await handle.close(); }
}
export async function writeFirstInstallFile(directory: string, relative: string, bytes: Uint8Array | string) {
  if (!isPairCodePackPath('/' + relative)) firstInstallRefused();
  await mkdir(path.dirname(path.join(directory, relative)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, relative), bytes, { flag: 'wx', mode: 0o600 });
}
export async function createFirstInstallDirectory(directory: string, sourceDirectory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await realpath(sourceDirectory) !== sourceDirectory ||
      directory === sourceDirectory || directory.startsWith(sourceDirectory + path.sep)) firstInstallRefused();
  if (await realpath(path.dirname(directory)) !== path.dirname(directory)) firstInstallRefused();
  await mkdir(directory, { mode: 0o700 });
}
export async function firstInstallInventory(directory: string, prefix = ''): Promise<{ path: string; size: number; sha256: string }[]> {
  const state = await lstat(path.join(directory, prefix));
  if (!state.isDirectory() || state.isSymbolicLink()) firstInstallRefused();
  const files = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = prefix + name, state = await lstat(path.join(directory, relative));
    if (state.isSymbolicLink()) firstInstallRefused();
    if (state.isDirectory()) files.push(...await firstInstallInventory(directory, relative + '/'));
    else {
      const bytes = await firstInstallFile(directory, relative);
      files.push({ path: relative, size: bytes.length, sha256: firstInstallHash(bytes) });
    }
    if (files.length > 100_000) firstInstallRefused();
  }
  return files;
}
