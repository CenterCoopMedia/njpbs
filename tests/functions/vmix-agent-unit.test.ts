import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { join } from 'node:path';
import { createVmixSimulator, simulatorMapping as mapping } from '../../agents/vmix/src/simulator';
import { VmixClient, readState } from '../../agents/vmix/src/vmix-client';
import { DeviceLock } from '../../agents/vmix/src/device-lock';
import { Journal } from '../../agents/vmix/src/journal';
import { Executor } from '../../agents/vmix/src/executor';
import { parseFences, DeviceBackend, DeviceToken, observationChangeKey } from '../../agents/vmix/src/backend';
import { projectObservedState, type LiveCommandDelivery, type BannerText } from '../../packages/content-core/src/live-production';

let simulator: Awaited<ReturnType<typeof createVmixSimulator>>;
let directory: string;
let journal: Journal;
let executor: Executor;
let now: number;
let fences: { sessionGeneration: number; mappingVersion: number; clearGeneration: number; lastSequence: number; active: boolean };
let beforeFence: () => void;
let beforeBegin: () => void;
function delivery(text: BannerText = { templateId: 'name_title', name: "JULIE O'CONNOR", title: '' }, sequence = 1): LiveCommandDelivery {
  return { schemaVersion: 1, timingId: 'timing', ttlMs: 15000,
    command: { schemaVersion: 1, protocolVersion: 1, id: `command-${sequence}`, requestId: `request-${sequence}`, actorId: 'staff',
      sessionId: mapping.sessionId, deviceId: mapping.deviceId!, sessionGeneration: 1, mappingVersion: 1,
      sequence, clearGeneration: fences.clearGeneration, overlay: 1, createdAtMs: 100, expiresAtMs: 15100,
      expectedObservationSequence: 1, action: 'take', snapshot: { bannerId: 'banner', sessionId: mapping.sessionId,
        version: sequence, mappingVersion: 1, text } } };
}
const client = () => new VmixClient(simulator.port);
const backend = () => ({ begin: async () => beforeBegin(), fence: async () => { beforeFence(); return { allowed: true, fences }; } });

beforeEach(async () => {
  simulator = await createVmixSimulator(); directory = mkdtempSync(join(tmpdir(), 'vmix-test-'));
  journal = new Journal(directory); now = 0;
  fences = { sessionGeneration: 1, mappingVersion: 1, clearGeneration: 0, lastSequence: 0, active: true };
  beforeFence = () => {}; beforeBegin = () => {};
  executor = new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend(), client(), journal, () => now, () => 0);
  await executor.observe(1);
});
afterEach(async () => { vi.unstubAllGlobals(); journal.close(); await simulator.close(); rmSync(directory, { recursive: true, force: true }); });

describe('vMix HTTP boundary', () => {
  it('preserves Unicode, punctuation, whitespace and query-like text without injecting functions', async () => {
    const headline = '  &Function=Cut + 50% #?=é 日本語\nsecond line  ';
    expect((await executor.execute(delivery({ templateId: 'headline', headline }), 0)).outcome).toBe('succeeded');
    expect(simulator.texts['simulation-headline']['TextBlock1.Text']).toBe(headline);
    expect(simulator.calls).toEqual([
      { Function: 'SetText', Input: 'simulation-headline', SelectedName: 'TextBlock1.Text', Value: headline },
      { Function: 'OverlayInput1In', Input: 'simulation-headline' },
    ]);
    const observed = await executor.observe(1);
    expect(observed).toMatchObject({ state: 'on_air', source: 'boardwalk', text: { templateId: 'headline', headline }, correlation: { commandId: 'command-1' } });
  });
  it('writes both fields, including an empty title, before Overlay 1 in', async () => {
    simulator.texts['simulation-name-title']['TextBlock2.Text'] = 'Old title';
    await executor.observe(1);
    expect((await executor.execute(delivery(), 0)).outcome).toBe('succeeded');
    expect(simulator.calls.map(call => [call.Function, call.SelectedName, call.Value])).toEqual([
      ['SetText', 'TextBlock1.Text', "JULIE O'CONNOR"], ['SetText', 'TextBlock2.Text', ''], ['OverlayInput1In', undefined, undefined],
    ]);
    expect((await executor.observe(1)).text).toEqual({ templateId: 'name_title', name: "JULIE O'CONNOR", title: '' });
  });
  it.each(['bad function', 'wrong device', 'wrong generation', 'extra field', 'old sequence'])('refuses %s without native mutation', async kind => {
    const item: any = delivery();
    if (kind === 'bad function') item.command.action = 'Cut';
    if (kind === 'wrong device') item.command.deviceId = 'other';
    if (kind === 'wrong generation') item.command.sessionGeneration = 2;
    if (kind === 'extra field') item.command.url = 'http://example.test/';
    if (kind === 'old sequence') { journal.start(item.command); journal.checkpoint(item.command, 'stopped', 'failed'); item.command.id = 'other'; item.command.requestId = 'other'; }
    try { await executor.execute(item, 0); } catch { /* Parser and admission refusals are safe. */ }
    expect(simulator.calls).toEqual([]);
  });
  it('anchors expiry at the original request start and rechecks between fields', async () => {
    beforeFence = () => { if (simulator.calls.length === 1) now = 15000; };
    expect((await executor.execute(delivery(), 0)).outcome).toBe('outcome_unknown');
    expect(journal.pending()[0].checkpoint).toContain('expired');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText']);
    expect(simulator.state.overlay).toBe('');
  });
  it('refuses an already expired delivery', async () => {
    now = 15000;
    expect((await executor.execute(delivery(), 0)).outcome).toBe('expired');
    expect(simulator.calls).toEqual([]);
  });
  it.each(['clear', 'session', 'mapping', 'ended'])('stops a multi-step Take at the %s fence', async kind => {
    beforeFence = () => {
      if (simulator.calls.length !== 1) return;
      if (kind === 'clear') fences.clearGeneration++;
      if (kind === 'session') fences.sessionGeneration++;
      if (kind === 'mapping') fences.mappingVersion++;
      if (kind === 'ended') fences.active = false;
    };
    expect((await executor.execute(delivery(), 0)).outcome).toBe('outcome_unknown');
    expect(journal.pending()[0].checkpoint).toContain('superseded');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText']);
  });
  it('checks the final fence before overlay-in', async () => {
    beforeFence = () => { if (simulator.calls.length === 2) fences.clearGeneration++; };
    expect((await executor.execute(delivery(), 0)).outcome).toBe('outcome_unknown');
    expect(journal.pending()[0].checkpoint).toContain('superseded');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText', 'SetText']);
  });
  it('journals intent before server start and native effects, and retries only receipts', async () => {
    beforeBegin = () => {
      const durable = JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8'));
      expect(durable.entries[0].receipt.outcome).toBe('started'); expect(simulator.calls).toHaveLength(0);
    };
    const item = delivery();
    const result = await executor.execute(item, 0);
    const count = simulator.calls.length;
    expect(await executor.execute(item, 0)).toEqual(result);
    expect(simulator.calls).toHaveLength(count);
    expect(journal.pending()).toEqual([result]); journal.acknowledge('command-1'); expect(journal.pending()).toEqual([]);
    const changed: any = structuredClone(item); changed.command.snapshot.text.name = 'Other';
    await expect(executor.execute(changed, 0)).rejects.toThrow('identity changed');
  });
  it.each(['before_native', 'TextBlock1.Text', 'TextBlock2.Text', 'overlay_in'])('retains %s crash work as unknown without replay', async checkpoint => {
    const item = delivery(); journal.start(item.command); journal.checkpoint(item.command, checkpoint);
    // A real crash leaves the lock; its removal requires a stopped-process check by the operator.
    journal.close(); journal = new Journal(directory);
    executor = new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend(), client(), journal);
    expect((await executor.execute(item, 0)).outcome).toBe('outcome_unknown');
    expect(simulator.calls).toEqual([]);
  });
  it('refuses a second process holding the same device journal', () => {
    expect(() => new Journal(directory)).toThrow();
  });
  it('opens acknowledged and interrupted legacy updates, refuses replay, and still executes Clear', async () => {
    journal.close();
    const saved = readFileSync(new URL('../fixtures/vmix-legacy-journal.json', import.meta.url), 'utf8');
    writeFileSync(join(directory, 'journal.json'), saved);
    journal = new Journal(directory);
    executor = new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend(), client(), journal);
    expect(journal.lastSequence).toBe(2);
    expect(journal.pending()).toEqual([{ commandId: 'legacy-update-2', requestId: 'legacy-request-2',
      outcome: 'outcome_unknown', checkpoint: 'TextBlock1.Text' }]);
    const entries = JSON.parse(saved).entries;
    for (const { command } of entries) {
      await expect(executor.execute({ ...delivery(), command }, 0)).rejects.toThrow();
      expect(() => journal.start({ ...command, id: 'legacy-readmission', requestId: 'legacy-new-request', sequence: 3 })).toThrow();
    }
    expect(simulator.calls).toEqual([]);
    journal.acknowledge('legacy-update-2');
    expect(journal.pending()).toEqual([]);
    fences.clearGeneration = 1; fences.lastSequence = 3;
    const clear: any = delivery(undefined, 3);
    delete clear.command.snapshot;
    Object.assign(clear.command, { action: 'clear', target: { kind: 'managed_overlay' }, expectedObservationSequence: 0 });
    expect((await executor.execute(clear, 0)).outcome).toBe('succeeded');
    expect(simulator.calls).toEqual([{ Function: 'OverlayInput1Out' }]);
  });
  it('reports an unreachable vMix as unknown without a live correlation', async () => {
    simulator.state.reachable = false;
    expect((await executor.execute(delivery(), 0)).outcome).toBe('failed');
    expect(await executor.observe(1)).toMatchObject({ vmix: 'unreachable', state: 'unknown', correlation: null });
    expect(simulator.calls).toEqual([]);
  });
  it('does not treat HTTP success as on-air proof', async () => {
    simulator.state.ignoreMutations = true;
    expect((await executor.execute(delivery(), 0)).outcome).toBe('outcome_unknown');
    expect((await executor.observe(1)).source).toBe('manual');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText']);
  });
  it('reports manual TD changes and server-receipt staleness honestly', async () => {
    await executor.execute(delivery(), 0);
    simulator.texts['simulation-name-title']['TextBlock1.Text'] = 'TD edit';
    const observation = await executor.observe(1);
    expect(observation).toMatchObject({ source: 'manual', correlation: null });
    expect(projectObservedState(observation, 100, 30100).state).toBe('stale');
    expect(projectObservedState(observation, 100, 101).state).toBe('on_air');
  });
  it.each(['composite', 'active', 'otherOverlay'])('refuses unsupported %s visibility', async kind => {
    if (kind === 'composite') simulator.state.composite = true;
    if (kind === 'active') simulator.state.active = '1';
    if (kind === 'otherOverlay') simulator.state.otherOverlay = '1';
    expect((await executor.execute(delivery(), 0)).outcome).toBe('failed');
    expect(simulator.calls).toEqual([]); expect((await executor.observe(1)).state).toBe('unknown');
  });
  it('does not Clear an unrelated TD graphic', async () => {
    simulator.state.overlay = '3'; await executor.observe(1);
    const item: any = delivery(); delete item.command.snapshot; item.command.action = 'clear'; item.command.target = { kind: 'banner', bannerId: 'banner', version: 1, templateId: 'name_title' };
    expect((await executor.execute(item, 0)).outcome).toBe('failed'); expect(simulator.calls).toEqual([]);
  });
  it('correlates a managed Clear only after the native overlay is empty', async () => {
    await executor.execute(delivery(), 0); await executor.observe(1);
    const item: any = delivery(undefined, 2); delete item.command.snapshot; item.command.action = 'clear'; item.command.target = { kind: 'managed_overlay' };
    expect((await executor.execute(item, 0)).outcome).toBe('succeeded');
    expect(await executor.observe(1)).toMatchObject({ state: 'clear', source: 'boardwalk', correlation: { commandId: 'command-2' } });
    expect(simulator.calls.at(-1)).toEqual({ Function: 'OverlayInput1Out' });
  });
  it('updates live text only by a deliberate correlated command, with no transition', async () => {
    await executor.execute(delivery(), 0); const expectedLive = await executor.observe(1);
    const item: any = delivery({ templateId: 'name_title', name: 'Next name', title: 'Next title' }, 2); item.command.action = 'update_text';
    item.command.expectedLive = expectedLive; item.command.expectedObservationSequence = expectedLive.sequence;
    expect((await executor.execute(item, 0)).outcome).toBe('succeeded');
    expect(simulator.calls.slice(3).map(call => call.Function)).toEqual(['SetText', 'SetText']);
  });
  it('rejects malformed XML, changed commissioning identities and unsafe endpoints', () => {
    expect(() => readState('<!DOCTYPE vmix><vmix/>', mapping)).toThrow();
    expect(() => readState(simulator.xml().replace('synthetic-headline.gtzip', 'other.gtzip'), mapping)).toThrow();
    expect(() => new DeviceBackend('http://example.test/cmsLiveProductionAgent', 'd', 's', new DeviceToken('a', 'r'))).toThrow();
    expect(() => parseFences({ active: true, sessionGeneration: 0 })).toThrow();
  });
});


describe('outbound device protocol', () => {
  it('uses the agreed semantic actions and device binding with a monotonic pull anchor', async () => {
    const requests: { url: string; init: RequestInit; body: any }[] = [];
    const nativeTypes = (await client().read(mapping)).inputTypes;
    const api = new DeviceBackend('https://example.test/api/cmsLiveProductionAgent', mapping.deviceId!, mapping.sessionId,
      new DeviceToken('fixture-api-key', 'fixture-refresh', () => now), () => now);
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      if (String(url).startsWith('https://securetoken.googleapis.com/')) {
        expect(init.body).toContain('grant_type=refresh_token'); now = 20;
        return Response.json({ id_token: 'fixture-token', expires_in: '3600', refresh_token: 'fixture-refresh' });
      }
      const body = JSON.parse(String(init.body)); requests.push({ url: String(url), init, body }); now = 30;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-token' });
      expect(init.redirect).toBe('error');
      expect(body).toMatchObject({ deviceId: mapping.deviceId, sessionId: mapping.sessionId });
      if (body.action === 'pull') return Response.json({ success: true, deliveries: [{ ...delivery(), timingId: body.timingId }], fences, mapping, scannedThroughSequence: 1 });
      if (body.action === 'heartbeat') return Response.json({ success: true, fences, mapping });
      if (body.action === 'fence') return Response.json({ success: true, allowed: true, fences });
      return Response.json({ success: true, mapping });
    });
    const pulled = await api.pull(0);
    expect(pulled.startedAt).toBe(0); expect(now - pulled.startedAt).toBe(30);
    await api.heartbeat(); await api.fence('command-1'); await api.begin(delivery().command);
    const receipt = { commandId: 'x'.repeat(128), requestId: 'request', outcome: 'outcome_unknown' as const, checkpoint: 'stopped' };
    await api.receipt(receipt); await api.receipt(receipt);
    await api.observe(await executor.observe(1)); expect(await api.verify(mapping, nativeTypes)).toEqual(mapping);
    expect(requests.map(request => request.body.action)).toEqual(['pull', 'heartbeat', 'fence', 'receipt', 'receipt', 'receipt', 'observe', 'verify_mapping']);
    expect(requests[4].body.receiptId).toBe(requests[5].body.receiptId);
    expect(requests[4].body.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(requests.at(-1)!.body).toMatchObject({ action: 'verify_mapping',
      inputTypes: { headline: 'GT', name_title: 'GT' }, titleFiles: { headline: null, name_title: null } });
  });
  it('rejects a delivery returned with a different authenticated timing ID', async () => {
    vi.stubGlobal('fetch', async (url: string | URL) => String(url).includes('securetoken.googleapis.com')
      ? Response.json({ id_token: 'fixture-token', expires_in: '3600' })
      : Response.json({ success: true, deliveries: [delivery()], fences, mapping }));
    const api = new DeviceBackend('https://example.test/cmsLiveProductionAgent', mapping.deviceId!, mapping.sessionId,
      new DeviceToken('fixture-key', 'fixture-refresh'));
    await expect(api.pull(0)).rejects.toThrow('timing mismatch');
    expect(simulator.calls).toEqual([]);
  });
  it('holds one device lock across different session journal directories', () => {
    const lock = new DeviceLock(join(directory, 'locks'), mapping.deviceId!);
    try { expect(() => new DeviceLock(join(directory, 'locks'), mapping.deviceId!)).toThrow(); }
    finally { lock.close(); }
  });
  it('refuses a corrupted durable journal instead of resetting it', () => {
    const other = mkdtempSync(join(tmpdir(), 'vmix-corrupt-'));
    const prior = new Journal(other); prior.start(delivery().command); prior.close();
    const file = join(other, 'journal.json');
    const data = JSON.parse(readFileSync(file, 'utf8')); data.entries[0].command.snapshot.text.name = 'Changed';
    writeFileSync(file, JSON.stringify(data));
    try { expect(() => new Journal(other)).toThrow('Invalid journal entry'); }
    finally { rmSync(other, { recursive: true, force: true }); }
  });
  it('drops command correlation after a connection gap before fresh reconciliation', async () => {
    await executor.execute(delivery(), 0); executor.disconnect();
    expect(await executor.observe(1)).toMatchObject({ state: 'on_air', source: 'manual', correlation: null });
  });
});


describe('review regressions and current device API', () => {
  it('compares snapshot text by value when the server returns keys in another order', async () => {
    const text = { title: 'Reporter', name: 'Studio name', templateId: 'name_title' } as const;
    expect((await executor.execute(delivery(text), 0)).outcome).toBe('succeeded');
    expect((await executor.observe(1)).source).toBe('boardwalk');
  });
  it('checks hidden title text again after a fence round trip before overlay-in', async () => {
    beforeFence = () => {
      if (simulator.calls.length === 2) simulator.texts['simulation-name-title']['TextBlock1.Text'] = 'TD changed hidden title';
    };
    expect((await executor.execute(delivery(), 0)).outcome).toBe('outcome_unknown');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText', 'SetText']);
    expect(simulator.state.overlay).toBe('');
  });
  it('reports a partially changed live title as uncertain when the remaining write expires', async () => {
    await executor.execute(delivery({ templateId: 'name_title', name: 'Old name', title: 'Old title' }), 0);
    const expectedLive = await executor.observe(1);
    beforeFence = () => { if (simulator.calls.length === 4) now = 15000; };
    const item: any = delivery({ templateId: 'name_title', name: 'New name', title: 'New title' }, 2); item.command.action = 'update_text';
    item.command.expectedLive = expectedLive; item.command.expectedObservationSequence = expectedLive.sequence;
    expect((await executor.execute(item, 0)).outcome).toBe('outcome_unknown');
    expect(simulator.texts['simulation-name-title']).toEqual({ 'TextBlock1.Text': 'New name', 'TextBlock2.Text': 'Old title' });
    expect(journal.pending().at(-1)!.checkpoint).toContain('expired');
    expect((await executor.observe(1)).source).toBe('manual');
  });
  it('refuses matching remote fences when local mapping or observation generation differs', async () => {
    fences.mappingVersion = 2;
    const item: any = delivery(); item.command.mappingVersion = 2; item.command.snapshot.mappingVersion = 2;
    expect((await executor.execute(item, 0)).outcome).toBe('superseded'); expect(simulator.calls).toEqual([]);
    fences.mappingVersion = 1; fences.sessionGeneration = 2;
    const second: any = delivery(undefined, 2); second.command.sessionGeneration = 2;
    expect((await executor.execute(second, 0)).outcome).toBe('superseded'); expect(simulator.calls).toEqual([]);
  });
  it('drops a previous generation correlation on a new native sample', async () => {
    await executor.execute(delivery(), 0);
    expect(await executor.observe(2)).toMatchObject({ source: 'manual', correlation: null, sessionGeneration: 2 });
  });
  it('persists the server scan cursor so terminal commands cannot starve later pages', () => {
    journal.advanceSequence(20); journal.close(); journal = new Journal(directory);
    expect(journal.lastSequence).toBe(20);
    expect(() => journal.advanceSequence(19)).toThrow();
    const item = delivery(undefined, 21); journal.start(item.command); expect(journal.lastSequence).toBe(21);
  });
});


describe('Clear supersession and shutdown', () => {
  it('keeps the current banner correlation when a queued Take is superseded before any native call', async () => {
    await executor.execute(delivery(), 0); await executor.observe(1);
    const queued: any = delivery({ templateId: 'name_title', name: 'Next name', title: 'Next title' }, 2);
    queued.command.snapshot.bannerId = 'next-banner'; fences.clearGeneration = 1;
    const clear: any = delivery(undefined, 3); delete clear.command.snapshot;
    clear.command.action = 'clear'; clear.command.target = { kind: 'banner', bannerId: 'banner', version: 1, templateId: 'name_title' };
    expect((await executor.execute(queued, 0)).outcome).toBe('superseded');
    expect(await executor.observe(1)).toMatchObject({ source: 'boardwalk', correlation: { commandId: 'command-1' } });
    expect((await executor.execute(clear, 0)).outcome).toBe('succeeded');
    expect(simulator.calls.map(call => call.Function)).toEqual(['SetText', 'SetText', 'OverlayInput1In', 'OverlayInput1Out']);
  });
  it.each(['<mix number="2"><active>1</active></mix>', '<mixes><mix number="2"><active>1</active></mix></mixes>'])('refuses unsupported additional mix structure: %s', mix => {
    expect(readState(simulator.xml().replace('</vmix>', mix + '</vmix>'), mapping).safe).toBe(false);
  });
  it('cancels a native request when shutdown is signaled', async () => {
    const shutdown = new AbortController(); shutdown.abort();
    const vmix = new VmixClient(simulator.port, 1500, undefined, shutdown.signal);
    await expect(vmix.read(mapping)).rejects.toThrow(); expect(simulator.calls).toEqual([]);
  });
  it('releases both locks when stopped during connection backoff', async () => {
    const deviceId = 'shutdown-' + randomUUID();
    const configPath = join(directory, 'config.json');
    const output = join(directory, 'agent.cjs');
    const preload = join(directory, 'network.cjs');
    const childJournal = join(directory, 'child-journal');
    const deviceLock = join(homedir(), '.njpbs-vmix-agent', 'locks', deviceId + '.lock');
    writeFileSync(configPath, JSON.stringify({ endpoint: 'https://example.test/cmsLiveProductionAgent', deviceId,
      sessionId: mapping.sessionId, vmixPort: simulator.port, journalDirectory: childJournal, exclusiveOverlay1: true,
      mapping: { ...mapping, deviceId } }));
    // Fake only the outbound network boundary. No real enrollment or cloud call.
    writeFileSync(preload, `globalThis.fetch = async url => String(url).includes('securetoken.googleapis.com')
      ? Response.json({id_token:'fixture-token',expires_in:'3600'}) : new Response('',{status:503});`);
    await build({ entryPoints: ['agents/vmix/src/service.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const child = spawn(process.execPath, ['--require', preload, output, '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      let stopped = false;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
        child.stderr.on('data', data => {
          if (!stopped && String(data).includes('Studio connector paused.')) { stopped = true; child.kill('SIGTERM'); }
        });
      });
      child.stdin.end(JSON.stringify({ apiKey: 'fixture-key', refreshToken: 'fixture-refresh' }));
      expect(await exited).toEqual({ code: 0, signal: null }); expect(stopped).toBe(true);
      expect(existsSync(join(childJournal, 'agent.lock'))).toBe(false); expect(existsSync(deviceLock)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (existsSync(deviceLock)) unlinkSync(deviceLock);
    }
  });
});


describe('native observation edge cases', () => {
  it.each([['1', ''], ['1', '   '], ['2', ''], ['2', '   ']])('reports visible input %s with blank first field as manual on-air without a banner snapshot', async (overlay, first) => {
    simulator.state.overlay = overlay;
    const key = overlay === '1' ? 'simulation-headline' : 'simulation-name-title';
    simulator.texts[key]['TextBlock1.Text'] = first;
    expect(await executor.observe(1)).toMatchObject({ state: 'on_air', source: 'manual', inputKey: key, text: null, correlation: null });
    expect((await executor.observe(1)).state).toBe('on_air');
  });
  it('sends binding/reachability changes immediately while keeping sample sequence and wall time periodic', async () => {
    const base = await executor.observe(1);
    const key = observationChangeKey(base);
    expect(observationChangeKey({ ...base, sessionGeneration: 2 })).not.toBe(key);
    expect(observationChangeKey({ ...base, mappingVersion: 2 })).not.toBe(key);
    expect(observationChangeKey({ ...base, sequence: base.sequence + 1, observedAtMs: 2000 })).toBe(key);
    const unknown = { ...base, state: 'unknown' as const, text: null, inputKey: null, source: 'unknown' as const, correlation: null };
    expect(observationChangeKey({ ...unknown, vmix: 'unreachable' })).not.toBe(observationChangeKey(unknown));
  });
});


describe('explicit managed Overlay 1 Clear', () => {
  function clear(): LiveCommandDelivery {
    const item: any = delivery(); delete item.command.snapshot;
    item.command.action = 'clear'; item.command.target = { kind: 'managed_overlay' }; item.command.expectedObservationSequence = 0;
    return item;
  }
  it('clears a native TD graphic without any prior observation and retains observed provenance', async () => {
    simulator.state.overlay = '3';
    executor = new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend(), client(), journal, () => now, () => 0);
    const result = await executor.execute(clear(), 0);
    expect(result.outcome).toBe('succeeded'); expect(result.checkpoint).toContain('manual:simulation-camera');
    expect(result.clear).toEqual({ before: { state: 'on_air', source: 'manual', inputKey: 'simulation-camera', visibilityReasons: [] },
      after: { state: 'clear', source: 'boardwalk', inputKey: null, visibilityReasons: [] } });
    expect(JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8')).entries[0].receipt.clear).toEqual(result.clear);
    expect(simulator.calls).toEqual([{ Function: 'OverlayInput1Out' }]);
    expect(await executor.observe(1)).toMatchObject({ state: 'clear', source: 'boardwalk', correlation: { commandId: 'command-1' } });
  });
  it('attempts managed Clear when native state XML is unknown, without claiming the result', async () => {
    simulator.state.overlay = '3'; simulator.state.xmlAvailable = false;
    await executor.observe(1);
    const result = await executor.execute(clear(), 0);
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.clear).toEqual({ before: { state: 'unknown', source: 'unknown', inputKey: null, visibilityReasons: [] } });
    expect(simulator.calls).toEqual([{ Function: 'OverlayInput1Out' }]); expect(simulator.state.overlay).toBe('');
    expect(await executor.observe(1)).toMatchObject({ state: 'unknown', source: 'unknown', correlation: null });
  });
  it('records Boardwalk provenance before removing an observed banner', async () => {
    await executor.execute(delivery(), 0); await executor.observe(1);
    const item = clear() as any; item.command.id = 'clear-2'; item.command.requestId = 'clear-request-2'; item.command.sequence = 2;
    const result = await executor.execute(item, 0);
    expect(result.clear?.before).toMatchObject({ state: 'on_air', source: 'boardwalk', inputKey: 'simulation-name-title' });
  });
  it.each(['other_overlay', 'direct_output', 'composite'] as const)('retains unknown visibility diagnostics for %s without blocking channel Clear', async reason => {
    simulator.state.overlay = '1';
    if (reason === 'other_overlay') simulator.state.otherOverlay = '1';
    if (reason === 'direct_output') simulator.state.active = '1';
    if (reason === 'composite') simulator.state.composite = true;
    expect(await executor.observe(1)).toMatchObject({ state: 'unknown', source: 'unknown' });
    expect(executor.observationDiagnostic).toBe('unsafe_visibility:' + reason);
    const result = await executor.execute(clear(), 0);
    expect(result.outcome).toBe('succeeded');
    expect(result.clear).toEqual({ before: { state: 'unknown', source: 'unknown', inputKey: 'simulation-headline', visibilityReasons: [reason] },
      after: { state: 'unknown', source: 'unknown', inputKey: null, visibilityReasons: [reason] } });
    expect(await executor.observe(1)).toMatchObject({ state: 'unknown', source: 'unknown', correlation: null });
  });
  it('sends OverlayInput1Out even when the channel is already clear', async () => {
    expect((await executor.execute(clear(), 0)).outcome).toBe('succeeded');
    expect(simulator.calls).toEqual([{ Function: 'OverlayInput1Out' }]);
  });
  it('keeps expiry and device binding for explicit managed Clear', async () => {
    now = 15000;
    expect((await executor.execute(clear(), 0)).outcome).toBe('expired'); expect(simulator.calls).toEqual([]);
  });
  it('observes a non-Boardwalk input as manual on-air before a channel Clear', async () => {
    simulator.state.overlay = '3';
    expect(await executor.observe(1)).toMatchObject({ state: 'on_air', inputKey: 'simulation-camera', source: 'manual', text: null, correlation: null });
  });
});


describe('managed Clear remains authenticated and short-lived', () => {
  it.each(['deviceId', 'sessionId', 'sessionGeneration', 'mappingVersion', 'clearGeneration'])('rejects mismatched %s even without a prior observation', async field => {
    const item: any = delivery(); delete item.command.snapshot; item.command.action = 'clear';
    item.command.target = { kind: 'managed_overlay' }; item.command.expectedObservationSequence = 0;
    item.command[field] = ['deviceId', 'sessionId'].includes(field) ? 'different' : 7;
    executor = new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend(), client(), journal, () => now);
    expect((await executor.execute(item, 0)).outcome).toBe('superseded'); expect(simulator.calls).toEqual([]);
  });
});


describe('managed Clear delivery during observation failure', () => {
  it.each(['clear', 'take'] as const)('handles %s safely while observation upload is rejected', async action => {
    simulator.state.overlay = action === 'clear' ? '3' : ''; simulator.state.xmlAvailable = action !== 'clear';
    const deviceId = 'clear-' + randomUUID();
    const configPath = join(directory, 'config-clear.json'); const output = join(directory, 'clear-agent.cjs');
    const preload = join(directory, 'clear-network.cjs'); const childJournal = join(directory, 'clear-journal');
    const deviceLock = join(homedir(), '.njpbs-vmix-agent', 'locks', deviceId + '.lock');
    const configuredMapping = { ...mapping, deviceId };
    const item: any = delivery(); item.command.deviceId = deviceId;
    if (action === 'clear') {
      delete item.command.snapshot; item.command.action = 'clear'; item.command.target = { kind: 'managed_overlay' };
      item.command.expectedObservationSequence = 0;
    } else {
      // Server holds sample 1; the new manual-clear sample 2 is rejected.
      const seed = new Journal(childJournal); seed.nextObservation(); seed.close();
    }
    const expectedStatus = action === 'clear' ? 'outcome_unknown' : 'failed';
    writeFileSync(configPath, JSON.stringify({ endpoint: 'https://example.test/cmsLiveProductionAgent', deviceId,
      sessionId: mapping.sessionId, vmixPort: simulator.port, journalDirectory: childJournal, exclusiveOverlay1: true, mapping: configuredMapping }));
    writeFileSync(preload, `const nativeFetch = globalThis.fetch;
      const mapping = ${JSON.stringify(configuredMapping)}; const item = ${JSON.stringify(item)}; const fences = ${JSON.stringify(fences)};
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init);
        if (String(url).includes('securetoken.googleapis.com')) return Response.json({id_token:'fixture-token',expires_in:'3600'});
        const body = JSON.parse(init.body);
        if (body.action === 'observe') return new Response('',{status:409});
        if (body.action === 'heartbeat') return Response.json({success:true,fences,mapping});
        if (body.action === 'pull') return Response.json({success:true,fences,mapping,scannedThroughSequence:1,deliveries:body.afterSequence ? [] : [{...item,timingId:body.timingId}]});
        if (body.action === 'fence') return Response.json({success:true,allowed:true,fences});
        if (body.action === 'receipt' && body.status === '${expectedStatus}') process.stdout.write('command_handled');
        return Response.json({success:true});
      };`);
    await build({ entryPoints: ['agents/vmix/src/service.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const child = spawn(process.execPath, ['--require', preload, output, '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      let stdout = ''; let stderr = ''; let handled = false;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
        child.stdout.on('data', data => { stdout += data; if (!handled && stdout.includes('command_handled')) { handled = true; child.kill('SIGTERM'); } });
        child.stderr.on('data', data => { stderr += data; if (stderr.includes('Studio connector paused.')) reject(new Error('Observation failure held command pull')); });
      });
      child.stdin.end(JSON.stringify({ apiKey: 'fixture-key', refreshToken: 'fixture-refresh' }));
      expect(await exited).toEqual({ code: 0, signal: null }); expect(handled).toBe(true);
      expect(simulator.calls).toEqual(action === 'clear' ? [{ Function: 'OverlayInput1Out' }] : []); expect(simulator.state.overlay).toBe('');
      const saved = JSON.parse(readFileSync(join(childJournal, 'journal.json'), 'utf8'));
      expect(saved.entries[0].receipt.outcome).toBe(expectedStatus);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (existsSync(deviceLock)) unlinkSync(deviceLock);
    }
  });
});


describe('native GT commissioning evidence', () => {
  it.each(['type="Xaml"', ''])('refuses a renamed input with incorrect or missing native type: %s', type => {
    const xml = simulator.xml().replace('type="GT"', type);
    // Key, display title and text fields still match; @type must come from native XML.
    expect(() => readState(xml, mapping)).toThrow('not a GT title');
  });
  it('takes both GT types from native input attributes without inventing file paths', async () => {
    const native = await client().read(mapping);
    expect(native.inputTypes).toEqual({ headline: 'GT', name_title: 'GT' });
    expect(native).not.toHaveProperty('titleFiles');
  });
});


describe('explicit layered overlay mapping', () => {
  let layered: typeof mapping;
  beforeEach(async () => {
    const { layeredSimulatorMapping } = await import('../../agents/vmix/src/simulator');
    layered = layeredSimulatorMapping;
    await simulator.close(); simulator = await createVmixSimulator(layered);
    executor = new Executor(layered, layered.sessionId, layered.deviceId!, backend(), client(), journal, () => now, () => 0);
    await executor.observe(1);
  });
  it.each([
    [{ templateId: 'headline', headline: 'Studio headline' }, 'simulation-headline', 'simulation-headline-overlay', '113'],
    [{ templateId: 'name_title', name: 'Studio name', title: '' }, 'simulation-name-title', 'simulation-name-title-overlay', '114'],
  ] as const)('writes the GT title and Takes only its named overlay: %s', async (text, textKey, overlayKey, number) => {
    expect((await executor.execute(delivery(text), 0)).outcome).toBe('succeeded');
    const writes = simulator.calls.filter(call => call.Function === 'SetText');
    expect(writes).toHaveLength(text.templateId === 'headline' ? 1 : 2);
    expect(writes.every(call => call.Input === textKey)).toBe(true);
    expect(simulator.calls.at(-1)).toEqual({ Function: 'OverlayInput1In', Input: overlayKey });
    expect(simulator.state.overlay).toBe(number);
    const expectedLive = await executor.observe(1);
    expect(expectedLive).toMatchObject({ state: 'on_air', inputKey: overlayKey, text, source: 'boardwalk' });
    const update: any = delivery(text.templateId === 'headline' ? { ...text, headline: 'Updated' } : { ...text, name: 'Updated' }, 2);
    update.command.action = 'update_text';
    update.command.expectedLive = expectedLive; update.command.expectedObservationSequence = expectedLive.sequence;
    const count = simulator.calls.length;
    expect((await executor.execute(update, 0)).outcome).toBe('succeeded');
    expect(simulator.calls.slice(count).every(call => call.Function === 'SetText' && call.Input === textKey)).toBe(true);
    const clear: any = delivery(undefined, 3); delete clear.command.snapshot;
    clear.command.action = 'clear'; clear.command.target = { kind: 'banner', bannerId: 'banner', version: 2, templateId: text.templateId };
    expect((await executor.execute(clear, 0)).outcome).toBe('succeeded');
    expect(simulator.calls.at(-1)).toEqual({ Function: 'OverlayInput1Out' });
  });
  it('reads a manual layered overlay from its text source, without inventing correlation', async () => {
    simulator.state.overlay = '114';
    simulator.texts['simulation-name-title']['TextBlock1.Text'] = 'TD name';
    simulator.texts['simulation-name-title']['TextBlock2.Text'] = 'TD title';
    expect(await executor.observe(1)).toMatchObject({ state: 'on_air', inputKey: 'simulation-name-title-overlay',
      text: { templateId: 'name_title', name: 'TD name', title: 'TD title' }, source: 'manual', correlation: null });
  });
  it.each(['composite', 'title active', 'overlay active', 'title other overlay', 'overlay other overlay', 'bare title on Overlay 1'])('refuses %s before text writes', async route => {
    if (route === 'composite') simulator.state.composite = true;
    if (route === 'title active') simulator.state.active = '111';
    if (route === 'overlay active') simulator.state.active = '113';
    if (route === 'title other overlay') simulator.state.otherOverlay = '111';
    if (route === 'overlay other overlay') simulator.state.otherOverlay = '113';
    if (route === 'bare title on Overlay 1') simulator.state.overlay = '111';
    await executor.observe(1);
    expect((await executor.execute(delivery(), 0)).outcome).toBe('failed');
    expect(simulator.calls).toEqual([]);
    expect((await executor.observe(1)).state).toBe('unknown');
  });
  it('requires the exact named overlay identity and one direct reference to the text input', () => {
    const xml = simulator.xml();
    for (const changed of [
      xml.replace('number="113"', 'number="115"'), xml.replace('title="Synthetic headline overlay"', 'title="Renamed"'),
      xml.replace('<overlay key="simulation-headline" index="2"/>', ''),
      xml.replace('<overlay key="simulation-headline" index="2"/>', '<overlay key="simulation-headline" index="2"/><overlay key="simulation-headline" index="3"/>'),
    ]) expect(() => readState(changed, layered)).toThrow();
    const nested = xml.replace('</inputs>', '<input key="nested" number="40" type="Virtual" title="Unmapped"><overlay key="simulation-headline-overlay" index="0"/></input></inputs>');
    expect(readState(nested, layered)).toMatchObject({ safe: false, visibilityReasons: ['composite'] });
    expect(readState(xml.replace('</vmix>', '<mixes><mix number="2"><active>113</active></mix></mixes></vmix>'), layered))
      .toMatchObject({ safe: false, visibilityReasons: ['additional_mix'] });
  });
});
