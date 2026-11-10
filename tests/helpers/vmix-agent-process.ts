import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { createVmixSimulator, simulatorMapping } from '../../agents/vmix/src/simulator';
import type { AgentObservation, LiveCommand, TemplateMapping } from '../../packages/content-core/src/live-production';

/** Real agent process, journal and native HTTP; only the cloud network is synthetic. */
export async function startAgentProcess(preset: TemplateMapping = simulatorMapping, transport?: 'websocket' | 'blocked', options: { manualClock?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'vmix-loop-'));
  const clockPath = join(directory, 'monotonic-clock');
  let clock = 0;
  const now = () => options.manualClock ? clock : performance.now();
  if (options.manualClock) writeFileSync(clockPath, '0');
  const simulator = await createVmixSimulator(preset);
  const mapping = { ...preset, deviceId: 'loop-' + randomUUID() };
  const fences = { sessionGeneration: 1, mappingVersion: 1, clearGeneration: 0, lastSequence: 0, active: true };
  const observations: { report: AgentObservation; at: number; accepted: boolean }[] = [];
  const requests: { action: string; at: number; body: any; transport: 'http' | 'websocket' }[] = [];
  const events = new EventEmitter();
  let pending: LiveCommand | null = null;
  let rejectObservations = false;
  let rejectReceipts = false;
  let allowCommands = true;
  let sequence = 0;
  const handle = (body: any, delivery: 'http' | 'websocket') => {
    const at = now();
    requests.push({ action: body.action, body, at, transport: delivery });
    const result: any = { success: true, fences, mapping };
    let status = 200;
    if (body.action === 'pull') {
      result.deliveries = pending && pending.sequence > body.afterSequence
        ? [{ schemaVersion: 1, timingId: body.timingId, ttlMs: 15000, command: pending }] : [];
      result.scannedThroughSequence = pending?.sequence ?? body.afterSequence;
    }
    if (body.action === 'fence') result.allowed = allowCommands;
    if (body.action === 'observe') {
      observations.push({ report: body.observation, at, accepted: !rejectObservations });
      if (rejectObservations) status = 503;
    }
    if (body.action === 'receipt' && rejectReceipts && body.status !== 'started') status = 503;
    events.emit('request');
    return { status, result };
  };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { status, result } = handle(JSON.parse(Buffer.concat(chunks).toString()), 'http');
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  const stream = new WebSocketServer({ noServer: true });
  let blockSocket = transport === 'blocked';
  server.on('upgrade', (request, socket, head) => {
    if (blockSocket) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    stream.handleUpgrade(request, socket, head, ws => stream.emit('connection', ws));
  });
  stream.on('connection', socket => {
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      const { result } = handle({ ...frame, action: 'pull' }, 'websocket');
      socket.send(JSON.stringify({ type: 'delivery', timingId: frame.timingId, data: result }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const output = join(directory, 'agent.cjs');
  const preload = join(directory, 'network.cjs');
  const config = join(directory, 'config.json');
  await build({ entryPoints: ['agents/vmix/src/service.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    define: { 'process.env.CMS_STUDIO_API_ORIGIN': JSON.stringify('https://studio.example.test') } });
  writeFileSync(config, JSON.stringify({ endpoint: transport ? 'https://studio.example.test/cmsLiveProductionAgent' : 'https://example.test/cmsLiveProductionAgent', deviceId: mapping.deviceId,
    sessionId: mapping.sessionId, vmixPort: simulator.port, journalDirectory: join(directory, 'journal'), exclusiveOverlay1: true, mapping }));
  writeFileSync(preload, `const nativeFetch = globalThis.fetch;
    if (${Boolean(options.manualClock)}) {
      const { readFileSync } = require('node:fs');
      Object.defineProperty(performance, 'now', { value: () => Number(readFileSync(${JSON.stringify(clockPath)}, 'utf8')) });
    }
    const https = require('node:https'), http = require('node:http');
    const nativeRequest = https.request;
    https.request = (options, callback) => (options.hostname ?? options.host) === 'studio.example.test'
      ? http.request({ ...options, hostname: '127.0.0.1', host: '127.0.0.1', port: ${port}, protocol: 'http:', agent: undefined, createConnection: undefined }, callback)
      : nativeRequest(options, callback);
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'securetoken.googleapis.com') return Promise.resolve(Response.json({id_token:'synthetic-token',expires_in:'3600'}));
      if (url.hostname === 'example.test' || url.hostname === 'studio.example.test') return nativeFetch('http://127.0.0.1:${port}/', init);
      if (url.hostname === '127.0.0.1' && url.port === '${simulator.port}') return nativeFetch(input, init);
      throw new Error('Unexpected network target');
    };`);
  const child = spawn(process.execPath, ['--require', preload, output, '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify({ apiKey: 'synthetic-key', refreshToken: 'synthetic-refresh' }));
  const waitFor = async (predicate: () => boolean, timeout = 16000) => {
    const signal = AbortSignal.timeout(timeout);
    while (!predicate()) await once(events, 'request', { signal });
  };
  return { directory, simulator, mapping, fences, observations, requests, waitFor,
    advanceClock: (milliseconds: number) => {
      if (!options.manualClock || !Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid manual clock advance');
      clock += milliseconds;
      writeFileSync(clockPath, String(clock));
    },
    blockSocket: () => { blockSocket = true; for (const socket of stream.clients) socket.terminate(); },
    rejectObservations: (value: boolean) => { rejectObservations = value; },
    allowCommands: (value: boolean) => { allowCommands = value; },
    rejectReceipts: (value: boolean) => { rejectReceipts = value; },
    stderr: () => stderr,
    enqueue: (text: string, template: 'headline' | 'name_title' = 'headline') => {
      const number = ++sequence;
      const snapshot = { bannerId: 'banner-' + number, sessionId: mapping.sessionId, version: 1, mappingVersion: 1,
        text: template === 'headline' ? { templateId: 'headline' as const, headline: text }
          : { templateId: 'name_title' as const, name: text, title: 'Synthetic title' } };
      pending = { schemaVersion: 1, protocolVersion: 1, id: 'command-' + number, requestId: 'request-' + number,
        actorId: 'synthetic-producer', sessionId: mapping.sessionId, deviceId: mapping.deviceId, sessionGeneration: 1,
        mappingVersion: 1, sequence: number, clearGeneration: fences.clearGeneration, overlay: 1, createdAtMs: 0, expiresAtMs: 15000,
        expectedObservationSequence: observations.at(-1)?.report.sequence ?? 1, action: 'take', snapshot };
      fences.lastSequence = number;
      for (const socket of stream.clients) socket.send('{"type":"wake"}');
      return { commandId: pending.id, at: now() };
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      for (const socket of stream.clients) socket.terminate();
      await new Promise<void>(resolve => stream.close(() => resolve()));
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await simulator.close(); rmSync(directory, { recursive: true, force: true });
    },
  };
}
