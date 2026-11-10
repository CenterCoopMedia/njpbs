import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVmixSimulator, simulatorMapping, layeredSimulatorMapping } from '../../agents/vmix/src/simulator';
import { VmixClient } from '../../agents/vmix/src/vmix-client';
import { Journal } from '../../agents/vmix/src/journal';
import { Executor } from '../../agents/vmix/src/executor';
import type { BannerText, LiveCommand, LiveCommandDelivery } from '../../packages/content-core/src/live-production';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function studio(mapping = simulatorMapping, text: BannerText = { templateId: 'name_title', name: 'Old name', title: 'Old title' }) {
  const simulator = await createVmixSimulator(mapping), directory = mkdtempSync(join(tmpdir(), 'vmix-update-'));
  let journal = new Journal(directory), now = 0;
  const fences = { sessionGeneration: 1, mappingVersion: 1, clearGeneration: 0, lastSequence: 0, active: true };
  let beforeFence = () => {};
  const backend = { begin: async () => {}, fence: async () => { beforeFence(); return { allowed: true, fences }; } };
  const createExecutor = () => new Executor(mapping, mapping.sessionId, mapping.deviceId!, backend,
    new VmixClient(simulator.port), journal, () => now, () => 100);
  let executor = createExecutor();
  cleanup.push(async () => { journal.close(); await simulator.close(); rmSync(directory, { recursive: true, force: true }); });
  const take: LiveCommandDelivery & { command: Extract<LiveCommand, { action: 'take' }> } = { schemaVersion: 1, timingId: 'timing', ttlMs: 15000,
    command: { schemaVersion: 1, protocolVersion: 1, id: 'take', requestId: 'take-request', actorId: 'staff',
      sessionId: mapping.sessionId, deviceId: mapping.deviceId!, sessionGeneration: 1, mappingVersion: 1,
      sequence: 1, clearGeneration: 0, overlay: 1, createdAtMs: 100, expiresAtMs: 15100,
      expectedObservationSequence: 1, action: 'take', snapshot: { bannerId: 'banner', sessionId: mapping.sessionId,
        version: 1, mappingVersion: 1, text } } };
  await executor.observe(1);
  expect((await executor.execute(take, 0)).outcome).toBe('succeeded');
  const expectedLive = await executor.observe(1);
  simulator.calls.length = 0;
  const nextText: BannerText = text.templateId === 'headline' ? { templateId: 'headline', headline: '  Updated & 李\nsecond line  ' }
    : { templateId: 'name_title', name: '  Updated & 李  ', title: '' };
  const update: any = { ...take, command: { ...take.command, id: 'update', requestId: 'update-request', sequence: 2,
    expectedObservationSequence: expectedLive.sequence, action: 'update_text', expectedLive,
    snapshot: { ...take.command.snapshot, version: 2, text: nextText } } };
  return { simulator, mapping, nextText, update, take, fences, get executor() { return executor; },
    get journal() { return journal; }, beforeFence(fn: () => void) { beforeFence = fn; }, expire() { now = 15000; },
    restart() { journal.close(); journal = new Journal(directory); executor = createExecutor(); } };
}

describe('deliberate Update live through the vMix simulator', () => {
  it.each([simulatorMapping, layeredSimulatorMapping])('keeps Overlay 1 in place and confirms every field for mapping $inputs.headline.number', async mapping => {
    const s = await studio(mapping);
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('succeeded');
    expect(s.simulator.calls).toEqual([
      { Function: 'SetText', Input: mapping.inputs.name_title!.key, SelectedName: 'TextBlock1.Text', Value: '  Updated & 李  ' },
      { Function: 'SetText', Input: mapping.inputs.name_title!.key, SelectedName: 'TextBlock2.Text', Value: '' },
    ]);
    expect(await s.executor.observe(1)).toMatchObject({ state: 'on_air', source: 'boardwalk', text: s.nextText,
      correlation: { commandId: 'update', bannerId: 'banner', bannerVersion: 2 } });
    const count = s.simulator.calls.length;
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('succeeded');
    expect(s.simulator.calls).toHaveLength(count);
  });
  it('preserves a complete headline without adding a transition or second field', async () => {
    const s = await studio(simulatorMapping, { templateId: 'headline', headline: 'Old headline' });
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('succeeded');
    expect(s.simulator.calls).toEqual([{ Function: 'SetText', Input: simulatorMapping.inputs.headline!.key,
      SelectedName: 'TextBlock1.Text', Value: '  Updated & 李\nsecond line  ' }]);
    expect((await s.executor.observe(1)).text).toEqual(s.nextText);
  });
  it.each([0, 1])('lets Clear supersede an update after %i writes without another overlay-in', async writes => {
    const s = await studio();
    s.beforeFence(() => { if (s.simulator.calls.length === writes) s.fences.clearGeneration = 1; });
    expect((await s.executor.execute(s.update, 0)).outcome).toBe(writes ? 'outcome_unknown' : 'superseded');
    expect(s.simulator.calls).toHaveLength(writes);
    s.beforeFence(() => {});
    const clear: any = { ...s.take, command: { ...s.take.command, id: 'clear', requestId: 'clear-request', sequence: 3,
      clearGeneration: 1, action: 'clear', target: { kind: 'managed_overlay' } } };
    delete clear.command.snapshot;
    expect((await s.executor.execute(clear, 0)).outcome).toBe('succeeded');
    expect(await s.executor.observe(1)).toMatchObject({ state: 'clear', correlation: { commandId: 'clear' } });
    expect(s.simulator.calls.map(call => call.Function)).toEqual([...Array(writes).fill('SetText'), 'OverlayInput1Out']);
    await s.executor.execute(s.update, 0);
    expect(s.simulator.state.overlay).toBe('');
  });
  it.each(['manual', 'later_take'])('refuses stale intent after %s with the same banner identity', async change => {
    const s = await studio();
    if (change === 'manual') {
      s.simulator.texts[simulatorMapping.inputs.name_title!.key]['TextBlock2.Text'] = 'TD title';
      await s.executor.observe(1);
    } else {
      const later: any = { ...s.take, command: { ...s.take.command, id: 'later-take', requestId: 'later-take-request', sequence: 2 } };
      await s.executor.execute(later, 0); await s.executor.observe(1);
      s.update.command.sequence = 3;
      s.simulator.calls.length = 0;
    }
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('failed');
    expect(s.simulator.calls).toEqual([]);
  });
  it.each(['expiry', 'manual', 'field_failure'])('reports partial text honestly after %s and never retries after restart', async failure => {
    const s = await studio();
    s.beforeFence(() => {
      if (s.simulator.calls.length !== 1) return;
      if (failure === 'expiry') s.expire();
      if (failure === 'manual') s.simulator.texts[simulatorMapping.inputs.name_title!.key]['TextBlock2.Text'] = 'TD title';
      if (failure === 'field_failure') s.simulator.state.ignoreMutations = true;
    });
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('outcome_unknown');
    expect(await s.executor.observe(1)).toMatchObject({ state: 'on_air', source: 'manual', correlation: null,
      text: { templateId: 'name_title', name: '  Updated & 李  ', title: failure === 'manual' ? 'TD title' : 'Old title' } });
    const count = s.simulator.calls.length;
    s.restart();
    expect((await s.executor.execute(s.update, 0)).outcome).toBe('outcome_unknown');
    expect(s.simulator.calls).toHaveLength(count);
  });
});
