import { expect, it, vi } from 'vitest';
import { deferInstalledConsumerProvider } from '../scripts/development-public-release-adoption.mjs';
import { createInstalledConsumerProvider } from '../site/scripts/public-release-installed-consumer-provider';

it('starts one native provider deadline at first use and refuses later reads after that deadline', async () => {
  let elapsed = 0;
  const deadlines: { at: number; controller: AbortController }[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); deadlines.push({ at: elapsed + ms, controller }); return controller.signal;
  });
  const request = vi.fn(async () => Response.json({ functions: [] })), credential = vi.fn(async () => 'fixture-only');
  const createProvider = vi.fn(() => createInstalledConsumerProvider({ environment: 'development', request, readGoogleToken: credential }));
  try {
    const provider = deferInstalledConsumerProvider(createProvider);
    elapsed = 30_001;
    expect(createProvider).not.toHaveBeenCalled(); expect(credential).not.toHaveBeenCalled();
    expect(await provider.readInventory()).toEqual([]);
    expect(createProvider).toHaveBeenCalledTimes(1);
    elapsed += 30_001;
    for (const { at, controller } of deadlines) if (at <= elapsed) controller.abort();
    await expect(provider.readInventory()).rejects.toThrow('Installed consumer provider evidence is unavailable');
    await expect(provider.readProbe([], 'a'.repeat(64))).rejects.toThrow('Installed consumer provider evidence is unavailable');
    expect(createProvider).toHaveBeenCalledTimes(1); expect(credential).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  } finally { timeout.mockRestore(); }
});

it('retains the native deadline for pending credential reads after lazy construction', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const request = vi.fn();
  let entered!: () => void, finish!: (value: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const credential = new Promise<string>(resolve => { finish = resolve; });
  try {
    const provider = deferInstalledConsumerProvider(() => createInstalledConsumerProvider({ environment: 'development', request,
      readGoogleToken: async () => { entered(); return credential; } }));
    const result = provider.readInventory();
    await started; deadline.abort();
    await expect(result).rejects.toThrow('Installed consumer provider evidence is unavailable');
    expect(timeout).toHaveBeenCalledWith(30_000); expect(request).not.toHaveBeenCalled();
    finish('fixture-only'); await credential; await Promise.resolve(); expect(request).not.toHaveBeenCalled();
  } finally { timeout.mockRestore(); }
});
