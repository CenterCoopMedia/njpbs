import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startAgentProcess } from '../helpers/vmix-agent-process';

let agent: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
afterEach(async () => { await agent?.close(); agent = undefined; });
describe('Studio connector command transport', () => {
  it('delivers only over the socket, observes before intake, and changes no text on connection', async () => {
    agent = await startAgentProcess(undefined, 'websocket');
    await agent.waitFor(() => agent!.requests.some(request => request.transport === 'websocket'));
    expect(agent.simulator.calls).toHaveLength(0);
    expect(agent.requests.filter(request => request.action === 'pull').every(request => request.transport === 'websocket')).toBe(true);
    const firstPull = agent.requests.findIndex(request => request.action === 'pull');
    expect(agent.requests.slice(0, firstPull).some(request => request.action === 'observe')).toBe(true);
    const command = agent.enqueue('Socket headline');
    await agent.waitFor(() => agent!.observations.some(item => item.report.correlation?.commandId === command.commandId));
    expect(agent.simulator.calls.filter(call => call.Function === 'OverlayInput1In')).toHaveLength(1);
    expect(agent.stderr()).toContain('Studio command delivery: WebSocket.');
  });
  it('uses one HTTP fallback for a blocked or dropped socket without replaying a Take', async () => {
    agent = await startAgentProcess(undefined, 'websocket');
    await agent.waitFor(() => agent!.requests.some(request => request.transport === 'websocket'));
    const command = agent.enqueue('Before network block');
    await agent.waitFor(() => agent!.observations.some(item => item.report.correlation?.commandId === command.commandId));
    agent.blockSocket();
    const next = agent.enqueue('After network block');
    await agent.waitFor(() => agent!.observations.some(item => item.report.correlation?.commandId === next.commandId));
    expect(agent.requests.filter(request => request.action === 'pull' && request.transport === 'http').length).toBeGreaterThan(0);
    expect(agent.simulator.calls.filter(call => call.Function === 'OverlayInput1In')).toHaveLength(2);
    expect(agent.requests.filter(request => request.action === 'receipt' && request.body.status === 'started').map(request => request.body.commandId))
      .toEqual([command.commandId, next.commandId]);
    expect(agent.stderr().match(/Studio command delivery: HTTPS fallback\./g)).toHaveLength(1);
    await agent.close(); agent = undefined;
    agent = await startAgentProcess(undefined, 'blocked');
    await agent.waitFor(() => agent!.requests.some(request => request.action === 'pull'));
    expect(agent.requests.filter(request => request.action === 'pull').every(request => request.transport === 'http')).toBe(true);
    expect(agent.simulator.calls).toHaveLength(0);
  });
  it('retries a lost outcome receipt across fallback without another native action', async () => {
    agent = await startAgentProcess(undefined, 'websocket');
    await agent.waitFor(() => agent!.requests.some(request => request.transport === 'websocket'));
    agent.rejectReceipts(true);
    const command = agent.enqueue('Lost acknowledgment');
    const outcomes = () => agent!.requests.filter(request => request.action === 'receipt' &&
      request.body.commandId === command.commandId && request.body.status === 'succeeded');
    await agent.waitFor(() => outcomes().length === 1);
    agent.blockSocket(); agent.rejectReceipts(false);
    await agent.waitFor(() => outcomes().length === 2);
    await agent.waitFor(() => agent!.requests.some(request => request.action === 'pull' && request.transport === 'http'));
    expect(agent.simulator.calls.filter(call => call.Function === 'OverlayInput1In')).toHaveLength(1);
    expect(agent.requests.filter(request => request.action === 'receipt' && request.body.status === 'started')).toHaveLength(1);
  });
});

// An opt-in measurement uses real network waits, never artificial CPU or memory load.
if (process.env.VMIX_STREAM_LATENCY_SAMPLES) {
  it('measures socket and fallback admission to native readback and server observation', async () => {
    const count = Number(process.env.VMIX_STREAM_LATENCY_SAMPLES);
    if (!Number.isInteger(count) || count < 2 || count > 100) throw new Error('Use 2 to 100 samples');
    const results: Record<string, unknown> = {};
    for (const transport of ['websocket', 'blocked'] as const) {
      agent = await startAgentProcess(undefined, transport);
      await agent.waitFor(() => agent!.requests.some(request => request.action === 'pull'));
      const receiptMs: number[] = [], observedMs: number[] = [], deliveryMs: number[] = [];
      for (let index = 0; index < count; index++) {
        await delay((index * 613) % 1000);
        const command = agent.enqueue('Synthetic latency ' + index, index % 2 ? 'name_title' : 'headline');
        await agent.waitFor(() => agent!.observations.some(item => item.report.correlation?.commandId === command.commandId));
        const started = agent.requests.find(request => request.action === 'receipt' && request.body.commandId === command.commandId && request.body.status === 'started')!;
        const receipt = agent.requests.find(request => request.action === 'receipt' && request.body.commandId === command.commandId && request.body.status === 'succeeded')!;
        const observation = agent.observations.find(item => item.report.correlation?.commandId === command.commandId)!;
        deliveryMs.push(started.at - command.at); receiptMs.push(receipt.at - command.at); observedMs.push(observation.at - command.at);
      }
      const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return { count: sorted.length, p50Ms: Math.round(sorted[Math.ceil(sorted.length * .5) - 1]),
          p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: Math.round(sorted.at(-1)!) };
      };
      results[transport] = { admissionToStartedReceipt: stats(deliveryMs), nativeReadback: stats(receiptMs),
        acceptedObservation: stats(observedMs), rawNativeMs: receiptMs.map(Math.round), rawObservedMs: observedMs.map(Math.round) };
      await agent.close(); agent = undefined;
    }
    if (process.env.VMIX_LATENCY_REPORT) writeFileSync(process.env.VMIX_LATENCY_REPORT, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results));
  }, 180000);
}
