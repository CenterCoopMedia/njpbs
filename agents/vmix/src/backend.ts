import { readBody, requestSignal } from './http';
import { randomUUID, createHash } from 'node:crypto';
import { parseLiveCommandDelivery, parseTemplateMapping, type LiveCommandDelivery, type TemplateMapping,
  type AgentObservation, type LiveCommand } from '../../../packages/content-core/src/live-production';
import type { Receipt } from './journal';
import { CommandStream } from './command-stream';
import { studioStreamEndpoint } from '../configuration.mjs';

const configuredApiOrigin = process.env.CMS_STUDIO_API_ORIGIN;

export type Fences = { sessionGeneration: number; mappingVersion: number; clearGeneration: number; lastSequence: number; active: boolean };
export type Pulled = { deliveries: LiveCommandDelivery[]; fences: Fences; mapping: TemplateMapping; startedAt: number; timingId: string; scannedThroughSequence: number };
export interface Backend {
  begin(command: LiveCommand): Promise<void>;
  fence(commandId: string): Promise<{ allowed: boolean; fences: Fences }>;
}
export function parseFences(data: any): Fences {
  if (!data || typeof data.active !== 'boolean' ||
      !['sessionGeneration', 'mappingVersion', 'clearGeneration', 'lastSequence'].every(key =>
        Number.isSafeInteger(data[key]) && data[key] >= (['clearGeneration', 'lastSequence'].includes(key) ? 0 : 1))) {
    throw new Error('Invalid device fences');
  }
  return { sessionGeneration: data.sessionGeneration, mappingVersion: data.mappingVersion,
    clearGeneration: data.clearGeneration, lastSequence: data.lastSequence, active: data.active };
}

/** Token provider uses the enrollment refresh credential in process memory only. */
export class DeviceToken {
  private token = '';
  private expiresAt = 0;
  constructor(private apiKey: string, private refreshToken: string, private now = () => performance.now(), private stop?: AbortSignal) {}
  async get(): Promise<string> {
    if (this.now() < this.expiresAt) return this.token;
    const started = this.now();
    const url = new URL('https://securetoken.googleapis.com/v1/token');
    url.searchParams.set('key', this.apiKey);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: requestSignal(5000, this.stop),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }).toString() });
    if (!response.ok) throw new Error('Device token refresh failed');
    const body = JSON.parse(await readBody(response, 64_000));
    const expires = Number(body.expires_in);
    if (typeof body.id_token !== 'string' || !Number.isFinite(expires) || expires <= 60) throw new Error('Invalid device token response');
    this.token = body.id_token;
    if (typeof body.refresh_token === 'string') this.refreshToken = body.refresh_token;
    this.expiresAt = started + (expires - 60) * 1000;
    return this.token;
  }
}

export class DeviceBackend implements Backend {
  private stream?: CommandStream;
  private streamBinding?: { sessionGeneration: number; mappingVersion: number };
  constructor(private endpoint: string, private deviceId: string, private sessionId: string,
    private token: DeviceToken, private now = () => performance.now(), private stop?: AbortSignal) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith('/cmsLiveProductionAgent')) throw new Error('Invalid device endpoint');
    const streamEndpoint = studioStreamEndpoint(endpoint, configuredApiOrigin);
    if (streamEndpoint) this.stream = new CommandStream(streamEndpoint, deviceId, sessionId, stop);
  }
  private async call(action: string, fields: object = {}) {
    const token = await this.token.get();
    const request = JSON.stringify({ action, sessionId: this.sessionId, deviceId: this.deviceId, ...fields });
    if (Buffer.byteLength(request) > 256 * 1024) throw new Error('Device request exceeds budget');
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: requestSignal(5000, this.stop),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: request });
    if (!response.ok) throw new Error('Device request failed');
    const data = JSON.parse(await readBody(response, 6_000_000));
    if (data.success !== true) throw new Error('Invalid device response');
    return data;
  }
  async pull(afterSequence: number): Promise<Pulled> {
    const timingId = randomUUID();
    // Start before token acquisition; token refresh can only shorten the budget.
    const startedAt = this.now();
    const streamed = this.stream && this.streamBinding
      ? await this.stream.pull(await this.token.get(), this.streamBinding, timingId, afterSequence) : null;
    const data = (streamed ?? await this.call('pull', { timingId, afterSequence })) as Record<string, any>;
    if (data.success !== true) throw new Error('Invalid device response');
    if (!Array.isArray(data.deliveries) || data.deliveries.length > 20) throw new Error('Invalid deliveries');
    const deliveries = data.deliveries.map(parseLiveCommandDelivery);
    if (deliveries.some((delivery: LiveCommandDelivery) => delivery.timingId !== timingId)) throw new Error('Delivery timing mismatch');
    const scannedThroughSequence = data.scannedThroughSequence;
    if (!Number.isSafeInteger(scannedThroughSequence) || scannedThroughSequence < afterSequence ||
        deliveries.some((delivery: LiveCommandDelivery, index: number) => delivery.command.sequence <=
          (index ? deliveries[index - 1].command.sequence : afterSequence) || delivery.command.sequence > scannedThroughSequence)) {
      throw new Error('Invalid device scan cursor');
    }
    return { deliveries, scannedThroughSequence, fences: parseFences(data.fences), mapping: parseTemplateMapping(data.mapping), startedAt, timingId };
  }
  async heartbeat() {
    const data = await this.call('heartbeat', { timingId: randomUUID() });
    const fences = parseFences(data.fences);
    this.streamBinding = { sessionGeneration: fences.sessionGeneration, mappingVersion: fences.mappingVersion };
    return { fences, mapping: parseTemplateMapping(data.mapping) };
  }
  async wait(ms: number): Promise<void> {
    if (this.stream) return this.stream.wait(ms);
    await new Promise<void>(resolve => {
      if (this.stop?.aborted) { resolve(); return; }
      const finish = () => { clearTimeout(timer); this.stop?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.stop?.addEventListener('abort', finish, { once: true });
    });
  }
  async fence(commandId: string) {
    const data = await this.call('fence', { commandId });
    if (typeof data.allowed !== 'boolean') throw new Error('Invalid fence response');
    return { allowed: data.allowed, fences: parseFences(data.fences) };
  }
  async begin(command: LiveCommand) {
    await this.receipt({ commandId: command.id, requestId: command.requestId, outcome: 'started', checkpoint: 'before_native' });
  }
  async receipt(receipt: Receipt) {
    // Backend v1 exposes four receipt states; preserve the precise local checkpoint.
    const status = ['expired', 'superseded'].includes(receipt.outcome) ? 'failed' : receipt.outcome;
    await this.call('receipt', { commandId: receipt.commandId, receiptId: createHash('sha256').update(`${receipt.commandId}:${status}`).digest('hex'), status });
  }
  async observe(observation: AgentObservation) { await this.call('observe', { observation }); }
  async verify(mapping: TemplateMapping, inputTypes: { headline: 'GT'; name_title: 'GT' }) {
    const data = await this.call('verify_mapping', { mappingVersion: mapping.version, inputs: mapping.inputs,
      ...(mapping.overlayInputs ? { overlayInputs: mapping.overlayInputs } : {}),
      fields: { headline: ['TextBlock1.Text'], name_title: ['TextBlock1.Text', 'TextBlock2.Text'] },
      inputTypes, titleFiles: { headline: null, name_title: null } });
    return parseTemplateMapping(data.mapping);
  }
}

/** A new native sample is periodic; a changed binding or reachability is immediate. */
export function observationChangeKey(observation: AgentObservation): string {
  const { vmix, sessionGeneration, mappingVersion, state, text, inputKey, source, correlation } = observation;
  return JSON.stringify([vmix, sessionGeneration, mappingVersion, state, text, inputKey, source, correlation]);
}
