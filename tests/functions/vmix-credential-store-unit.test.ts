import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assertUnpaired, loadCredential, storeCredential } from '../../agents/vmix/src/credential-store';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const dummy = { apiKey: 'dummy-project', refreshToken: 'dummy-private-value', deviceId: 'dummy-device' };
let child: EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.stubEnv('LOCALAPPDATA', 'dummy-account');
  vi.mocked(existsSync).mockReturnValue(false);
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(() => { child.emit('close', null); return true; }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  Object.defineProperty(process, 'platform', platform);
});

describe('Windows credential process boundary', () => {
  it.each([[20, 'acl'], [21, 'dpapi'], [22, 'exists'], [1, 'dpapi'], [null, 'dpapi']] as const)(
    'reports only the fixed class for exit %s', async (exit, reason) => {
      const result = storeCredential(dummy);
      child.emit('close', exit);
      await expect(result).rejects.toMatchObject({ reason, message: `Windows credential storage failed (${reason})` });
    });
  it('keeps a process error secret-free', async () => {
    const result = storeCredential(dummy);
    child.emit('error', new Error(dummy.refreshToken));
    await expect(result).rejects.toThrow('Windows credential storage failed (dpapi)');
  });
  it('reports timeout and stops the credential process', async () => {
    const result = storeCredential(dummy);
    const rejection = expect(result).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('does not overwrite a previous credential', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(assertUnpaired).toThrow('Windows credential storage failed (exists)');
  });
  it('rejects output beyond the credential size limit', async () => {
    const result = loadCredential();
    child.stdout.write(Buffer.alloc(64_001));
    await expect(result).rejects.toMatchObject({ reason: 'dpapi' });
  });
  it('reads the decrypted credential through the private output pipe', async () => {
    const result = loadCredential();
    child.stdout.write(JSON.stringify(dummy));
    child.emit('close', 0);
    await expect(result).resolves.toEqual(dummy);
  });
  it('passes secrets only on stdin and uses owner/DACL persistence', async () => {
    const result = storeCredential(dummy);
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(JSON.stringify([args, options])).not.toContain(dummy.refreshToken);
    expect(child.stdin.read().toString()).toBe(JSON.stringify(dummy));
    const script = args![args!.length - 1];
    expect(script).toContain('$directoryInfo.SetAccessControl($acl)');
    expect(script).not.toMatch(/^Set-Acl\b/m);
    child.emit('close', 0);
    await expect(result).resolves.toBeUndefined();
  });
});
