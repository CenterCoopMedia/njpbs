import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startAgentProcess } from '../helpers/vmix-agent-process';
import { layeredSimulatorMapping } from '../../agents/vmix/src/simulator';

let agent: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
afterEach(async () => { await agent?.close(); agent = undefined; });

describe('production vMix observation loop', () => {
  it('runs both layered templates through native Take and manual text readback', async () => {
    agent = await startAgentProcess(layeredSimulatorMapping);
    await agent.waitFor(() => agent!.observations.length === 1);
    for (const [template, inputKey, textKey, number] of [
      ['headline', 'simulation-headline-overlay', 'simulation-headline', '113'],
      ['name_title', 'simulation-name-title-overlay', 'simulation-name-title', '114'],
    ] as const) {
      const command = agent.enqueue('Layered text', template);
      await agent.waitFor(() => agent!.observations.some(o => o.report.correlation?.commandId === command.commandId));
      expect(agent.simulator.state.overlay).toBe(number);
      expect(agent.observations.at(-1)!.report).toMatchObject({ inputKey, state: 'on_air', source: 'boardwalk' });
      agent.simulator.texts[textKey]['TextBlock1.Text'] = 'TD replacement';
      await agent.waitFor(() => agent!.observations.at(-1)!.report.source === 'manual');
      expect(agent.observations.at(-1)!.report).toMatchObject({ inputKey, correlation: null,
        text: template === 'headline' ? { headline: 'TD replacement' } : { name: 'TD replacement' } });
    }
    expect(agent.simulator.calls.filter(c => c.Function === 'OverlayInput1In').map(c => c.Input))
      .toEqual(['simulation-headline-overlay', 'simulation-name-title-overlay']);
  });
  it('sends changed TD state immediately and renews unchanged native samples only on the periodic cadence', async () => {
    agent = await startAgentProcess(undefined, undefined, { manualClock: true });
    await agent.waitFor(() => agent!.observations.length === 1);
    agent.simulator.state.overlay = '1';
    agent.simulator.texts['simulation-headline']['TextBlock1.Text'] = 'Native TD headline';
    await agent.waitFor(() => agent!.observations.length === 2);
    expect(agent.observations[1].report).toMatchObject({ state: 'on_air', source: 'manual', text: { headline: 'Native TD headline' }, correlation: null });
    await agent.waitFor(() => agent!.requests.filter(r => r.action === 'heartbeat').length >= 4);
    expect(agent.observations).toHaveLength(2);
    const heartbeats = agent.requests.filter(r => r.action === 'heartbeat').length;
    agent.advanceClock(11999);
    await agent.waitFor(() => agent!.requests.filter(r => r.action === 'heartbeat').length > heartbeats);
    expect(agent.observations).toHaveLength(2);
    agent.advanceClock(1);
    await agent.waitFor(() => agent!.observations.length === 3);
    expect(agent.observations[2].report.sequence).toBeGreaterThan(agent.observations[1].report.sequence);
    expect(agent.observations[2].at - agent.observations[1].at).toBeGreaterThanOrEqual(12000);
  });
});

// Opt-in timing receipt, not a machine-speed CI assertion. Uses the unchanged production poll cadence.
if (process.env.VMIX_LATENCY_SAMPLES) {
  it('measures local admission to native readback and accepted observation', async () => {
    const count = Number(process.env.VMIX_LATENCY_SAMPLES);
    if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('Use 2 to 100 samples');
    agent = await startAgentProcess();
    await agent.waitFor(() => agent!.observations.length === 1);
    const air: number[] = [], observed: number[] = [];
    for (let index = 0; index < count; index++) {
      // Even phase coverage across the one-second poll, no synthetic CPU load.
      await delay(((index * 613) % 1000));
      const template = index % 2 ? 'name_title' : 'headline';
      const text = 'Synthetic latency ' + index;
      const command = agent.enqueue(text, template);
      await agent.waitFor(() => agent!.observations.some(o => o.report.correlation?.commandId === command.commandId));
      // Receipt is sent only after native XML readback verifies exact visible text.
      const receipt = agent.requests.find(r => r.action === 'receipt' && r.body.commandId === command.commandId && r.body.status === 'succeeded')!;
      const observation = agent.observations.find(o => o.report.correlation?.commandId === command.commandId)!;
      air.push(receipt.at - command.at); observed.push(observation.at - command.at);
    }
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a,b) => a-b);
      const p = (fraction: number) => Math.round(sorted[Math.ceil(fraction * sorted.length)-1]);
      return { count: sorted.length, p50Ms: p(.5), p95Ms: p(.95), maxMs: Math.round(sorted.at(-1)!) };
    };
    const result = JSON.stringify({ nativeReadback: stats(air), acceptedObservation: stats(observed), rawNativeMs: air.map(Math.round), rawObservedMs: observed.map(Math.round) }, null, 2);
    if (process.env.VMIX_LATENCY_REPORT) writeFileSync(process.env.VMIX_LATENCY_REPORT, result + '\n');
    console.log(result);
    expect(observed).toHaveLength(count);
  }, 180000);
}

describe('observation failure and recovery', () => {
  it('retries a newly sampled unchanged state on the next loop after a refused command report fails', async () => {
    agent = await startAgentProcess();
    await agent.waitFor(() => agent!.observations.length === 1);
    agent.rejectObservations(true);
    agent.allowCommands(false);
    agent.enqueue('Refused command');
    await agent.waitFor(() => agent!.observations.length === 2);
    const failed = agent.observations[1];
    expect(failed.accepted).toBe(false);
    agent.rejectObservations(false);
    const heartbeats = agent.requests.filter(r => r.action === 'heartbeat').length;
    await agent.waitFor(() => agent!.requests.filter(r => r.action === 'heartbeat').length >= heartbeats + 2);
    const recovered = agent.observations.find(o => o.accepted && o.report.sequence > failed.report.sequence);
    expect(recovered).toBeDefined();
    expect(recovered!.report.sequence).toBeGreaterThan(failed.report.sequence);
    expect(recovered!.report).toMatchObject({ state: 'clear', source: 'manual', correlation: null });
  });
  it('reports native outage, unsafe visibility and recovered manual text without replay', async () => {
    agent = await startAgentProcess();
    await agent.waitFor(() => agent!.observations.length === 1);
    const command = agent.enqueue('Boardwalk headline');
    await agent.waitFor(() => agent!.observations.some(o => o.report.correlation?.commandId === command.commandId));
    agent.simulator.state.reachable = false;
    await agent.waitFor(() => agent!.observations.some(o => o.report.vmix === 'unreachable'));
    agent.simulator.state.reachable = true;
    agent.simulator.state.otherOverlay = '1';
    await agent.waitFor(() => agent!.observations.some(o => o.report.vmix === 'reachable' && o.report.state === 'unknown'));
    agent.simulator.state.otherOverlay = '';
    agent.simulator.texts['simulation-headline']['TextBlock1.Text'] = 'Native replacement';
    await agent.waitFor(() => agent!.observations.some(o => o.report.text?.templateId === 'headline' && o.report.text.headline === 'Native replacement'));
    expect(agent.observations.at(-1)!.report).toMatchObject({ state: 'on_air', source: 'manual', correlation: null });
    expect(agent.simulator.calls.map(c => c.Function)).toEqual(['SetText', 'OverlayInput1In']);
    expect(agent.stderr()).not.toContain('Native replacement');
    expect(agent.stderr()).not.toContain('synthetic-token');
  });
  it('reconciles a fresh native sample before retrying a lost outcome receipt', async () => {
    agent = await startAgentProcess();
    await agent.waitFor(() => agent!.observations.length === 1);
    agent.rejectReceipts(true);
    const command = agent.enqueue('Receipt recovery');
    await agent.waitFor(() => agent!.requests.some(r => r.action === 'receipt' && r.body.status === 'succeeded'));
    agent.rejectReceipts(false);
    await agent.waitFor(() => agent!.requests.filter(r => r.action === 'receipt' && r.body.status === 'succeeded').length === 2);
    const outcomes = agent.requests.filter(r => r.action === 'receipt' && r.body.status === 'succeeded');
    const sample = agent.observations.find(o => o.at > outcomes[0].at)!;
    expect(sample.report).toMatchObject({ state: 'on_air', source: 'manual', correlation: null });
    expect(sample.at).toBeLessThan(outcomes[1].at);
    expect(outcomes[0].body.receiptId).toBe(outcomes[1].body.receiptId);
    expect(outcomes[0].body.commandId).toBe(command.commandId);
    expect(agent.simulator.calls.map(c => c.Function)).toEqual(['SetText', 'OverlayInput1In']);
  });
});
