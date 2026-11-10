import { isDeepStrictEqual } from 'node:util';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseTemplateMapping, type BannerText, type TemplateMapping, type AgentObservation } from '../../../packages/content-core/src/live-production';
import { CredentialStorageError, loadCredential } from './credential-store';
import { pair } from './pair';
import { assertConnectorInstallReady, ConnectorInstallError } from './install-guard';
import { DeviceBackend, DeviceToken, observationChangeKey } from './backend';
import { Journal } from './journal';
import { DeviceLock } from './device-lock';
import { Executor } from './executor';
import { VmixClient } from './vmix-client';
import { createVmixSimulator, layeredSimulatorMapping } from './simulator';

type Config = { endpoint: string; deviceId: string; sessionId: string; vmixPort: number;
  journalDirectory: string; mapping: TemplateMapping; exclusiveOverlay1: boolean };

async function simulate() {
  const simulator = await createVmixSimulator(layeredSimulatorMapping);
  const directory = mkdtempSync(join(tmpdir(), 'vmix-simulation-'));
  const journal = new Journal(directory);
  try {
    const fences = { sessionGeneration: 1, mappingVersion: 1, clearGeneration: 0, lastSequence: 0, active: true };
    const executor = new Executor(layeredSimulatorMapping, 'simulation-session', 'simulation-device',
      { begin: async () => {}, fence: async () => ({ allowed: true, fences }) }, new VmixClient(simulator.port), journal);
    let observed = await executor.observe(1);
    const texts: BannerText[] = [{ templateId: 'headline', headline: 'Simulation: A & B + 50%' },
      { templateId: 'name_title', name: 'Simulation name', title: '' }];
    for (const [index, text] of texts.entries()) {
      const startedAt = performance.now();
      const command = { schemaVersion: 1, protocolVersion: 1, id: `simulation-command-${index}`, requestId: `simulation-request-${index}`,
        actorId: 'simulation-actor', sessionId: 'simulation-session', deviceId: 'simulation-device', sessionGeneration: 1,
        mappingVersion: 1, sequence: index + 1, clearGeneration: 0, overlay: 1, createdAtMs: 0, expiresAtMs: 15000,
        expectedObservationSequence: observed.sequence, action: 'take', snapshot: { bannerId: 'simulation-banner', sessionId: 'simulation-session',
          version: index + 1, mappingVersion: 1, text } } as const;
      const receipt = await executor.execute({ schemaVersion: 1, timingId: 'simulation-timing', ttlMs: 15000, command }, startedAt);
      observed = await executor.observe(1);
      if (receipt.outcome !== 'succeeded' || observed.source !== 'boardwalk') throw new Error('Simulation failed');
    }
    console.log('Simulation passed. No native vMix or Boardwalk endpoint was used.');
  } finally { journal.close(); await simulator.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function credentials(): Promise<{ apiKey: string; refreshToken: string; vmix?: { username: string; password: string } }> {
  if (process.stdin.isTTY) throw new Error('Credential provider must use stdin');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 64_000) throw new Error('Credential provider exceeds budget'); chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data.apiKey !== 'string' || typeof data.refreshToken !== 'string' || !data.refreshToken ||
      (data.vmix && (typeof data.vmix.username !== 'string' || typeof data.vmix.password !== 'string'))) {
    throw new Error('Invalid credential provider response');
  }
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--simulate') return simulate();
  if (args.length === 2 && args[0] === '--pair') return pair(args[1]);
  const options = args.slice(2);
  if (args[0] !== '--config' || !args[1] || options.length > 2 ||
      new Set(options).size !== options.length || options.some(option => !['--verify-mapping', '--stored-credentials'].includes(option))) {
    throw new Error('Usage: vmix-agent --simulate | --pair path | --config path [--verify-mapping] [--stored-credentials]');
  }
  assertConnectorInstallReady(dirname(resolve(process.argv[1])));
  const config: Config = JSON.parse(readFileSync(args[1], 'utf8'));
  const mapping = parseTemplateMapping(config.mapping);
  if (config.exclusiveOverlay1 !== true || mapping.sessionId !== config.sessionId || mapping.deviceId !== config.deviceId) {
    throw new Error('Commission the exclusive Overlay 1 mapping first');
  }
  let stopped = false;
  const shutdown = new AbortController();
  const stop = () => { stopped = true; shutdown.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const secret = options.includes('--stored-credentials') ? await loadCredential() : await credentials();
  if ('deviceId' in secret && secret.deviceId !== config.deviceId) throw new Error('Stored credential belongs to another device');
  const backend = new DeviceBackend(config.endpoint, config.deviceId, config.sessionId, new DeviceToken(secret.apiKey, secret.refreshToken, undefined, shutdown.signal), undefined, shutdown.signal);
  const vmix = new VmixClient(config.vmixPort, 1500, secret.vmix, shutdown.signal);
  const deviceLock = new DeviceLock(join(homedir(), '.njpbs-vmix-agent', 'locks'), config.deviceId);
  let journal: Journal;
  try { journal = new Journal(config.journalDirectory); } catch (error) { deviceLock.close(); throw error; }
  try {
    if (options.includes('--verify-mapping')) {
      const state = await vmix.read(mapping);
      if (!state.safe) throw new Error('Unsupported native visibility');
      const commissioned = await backend.verify(mapping, state.inputTypes);
      console.log(JSON.stringify(commissioned, null, 2)); return;
    }
    const executor = new Executor(mapping, config.sessionId, config.deviceId, {
      begin: command => backend.begin(command),
      fence: async commandId => {
        const result = await backend.fence(commandId);
        return { ...result, allowed: result.allowed && !stopped };
      },
    }, vmix, journal);
    let failures = 0;
    let lastHeartbeat = -Infinity;
    let lastSent = '';
    let lastDiagnostic = '';
    const reportObservation = async (observation: AgentObservation, force = false) => {
      const diagnostic = executor.observationDiagnostic;
      if (diagnostic !== lastDiagnostic) {
        if (!stopped) console.error(`Native observation: ${diagnostic}.`);
        lastDiagnostic = diagnostic;
      }
      const changed = observationChangeKey(observation);
      if (!force && changed === lastSent && performance.now() - lastHeartbeat < 12_000) return;
      try {
        await backend.observe(observation); lastSent = changed; lastHeartbeat = performance.now();
      } catch {
        // Only managed Clear can proceed without an accepted native sample.
        executor.disconnect();
        lastSent = ''; lastHeartbeat = -Infinity;
        if (!stopped) console.error('Native observation report failed.');
      }
    };
    while (!stopped) {
      try {
        const heartbeat = await backend.heartbeat();
        if (!isDeepStrictEqual(heartbeat.mapping, mapping)) throw new Error('Mapping changed; recommission locally');
        // Fresh native poll on every reconnect and before command intake. Never send buffered samples.
        const observation = await executor.observe(heartbeat.fences.sessionGeneration);
        await reportObservation(observation);
        for (const receipt of journal.pending()) { await backend.receipt(receipt); journal.acknowledge(receipt.commandId); }
        if (heartbeat.fences.active) {
          const pulled = await backend.pull(journal.lastSequence);
          if (!isDeepStrictEqual(pulled.mapping, mapping)) throw new Error('Mapping changed; recommission locally');
          for (const delivery of pulled.deliveries) {
            if (stopped) break;
            await executor.execute(delivery, pulled.startedAt);
            for (const receipt of journal.pending()) { await backend.receipt(receipt); journal.acknowledge(receipt.commandId); }
            await reportObservation(await executor.observe(delivery.command.sessionGeneration), true);
          }
          if (!stopped) journal.advanceSequence(pulled.scannedThroughSequence);
        }
        failures = 0;
      } catch {
        if (stopped) break;
        // Error payloads/URLs can carry credentials or editorial text. Never print them.
        executor.disconnect();
        console.error('Studio connector paused. Reconcile connection, credentials, mapping and journal.');
        failures++;
        lastSent = ''; lastHeartbeat = -Infinity;
      }
      if (stopped) break;
      if (failures) await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined,
        { signal: shutdown.signal }).catch(error => { if (!stopped) throw error; });
      else await backend.wait(1000);
    }
  } finally { journal.close(); deviceLock.close(); }
}
main().catch(error => {
  if (error instanceof CredentialStorageError || error instanceof ConnectorInstallError) console.error(error.message);
  console.error(process.argv[2] === '--pair'
    ? 'Pairing stopped. Revoke the affected device in Boardwalk and create a new code. Check the interactive Windows terminal, account storage and configuration. Remove the old credential only after revocation.'
    : 'Studio connector stopped. Check configuration, credential provider and journal lock.');
  process.exitCode = 1;
});
