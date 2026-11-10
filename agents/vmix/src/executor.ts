import { isDeepStrictEqual } from 'node:util';
import { assertCommandBinding, mappedOverlayInput, parseAgentObservation, parseBannerText, parseLiveCommandDelivery, parseTemplateMapping,
  type LiveCommand, type LiveCommandDelivery, type TemplateMapping, type AgentObservation } from '../../../packages/content-core/src/live-production';
import { Journal, type Outcome, type Receipt, type ClearSample } from './journal';
import type { Backend } from './backend';
import { VmixClient, NativeStateError, type NativeState } from './vmix-client';

class Refusal extends Error { constructor(readonly outcome: Outcome) { super(outcome); } }
const managedClear = (command: LiveCommand) => command.action === 'clear' && command.target.kind === 'managed_overlay';
type Mutate = (checkpoint: string, expected: NativeState, effect: () => Promise<void>) => Promise<NativeState>;

function nativeDiagnostic(state: NativeState | null, vmix: 'reachable' | 'unreachable', hasText: boolean, boardwalk: boolean): string {
  if (vmix === 'unreachable') return 'vmix_unreachable';
  if (!state) return 'native_state_invalid';
  if (!state.safe) return 'unsafe_visibility:' + state.visibilityReasons.join(',');
  if (!state.inputKey) return 'clear';
  if (!hasText) return 'on_air_text_unavailable';
  return boardwalk ? 'on_air_boardwalk' : 'on_air_manual';
}

export class Executor {
  private correlation: LiveCommand | null = null;
  private native: NativeState | null = null;
  private sequence = 0;
  private sessionGeneration: number | null = null;
  observationDiagnostic = 'unknown';
  constructor(readonly mapping: TemplateMapping, private sessionId: string, private deviceId: string,
    private backend: Backend, private vmix: VmixClient, readonly journal: Journal,
    private now = () => performance.now(), private wall = () => Date.now()) {
    this.mapping = parseTemplateMapping(mapping);
    if (mapping.state !== 'commissioned' || mapping.deviceId !== deviceId || mapping.sessionId !== sessionId) {
      throw new Error('Local mapping is not commissioned for this device');
    }
  }
  disconnect() { this.correlation = null; this.native = null; }
  async observe(sessionGeneration: number): Promise<AgentObservation> {
    if (this.sessionGeneration !== sessionGeneration) this.disconnect();
    this.sessionGeneration = sessionGeneration;
    let vmix: 'reachable' | 'unreachable' = 'reachable';
    try {
      const current = await this.vmix.read(this.mapping);
      if (this.native && !isDeepStrictEqual(current, this.native)) this.correlation = null;
      this.native = current;
    } catch (error) { this.disconnect(); vmix = error instanceof NativeStateError ? 'reachable' : 'unreachable'; }
    this.sequence = this.journal.nextObservation();
    const state = this.native;
    let text = state?.text ?? null;
    if (text) {
      try { text = parseBannerText(text); } catch { text = null; this.correlation = null; }
    }
    const known = state?.safe;
    const command = known ? this.correlation : null;
    this.observationDiagnostic = nativeDiagnostic(state, vmix, text !== null, command !== null);
    const correlation = command ? command.action === 'clear' ? { commandId: command.id }
      : { commandId: command.id, bannerId: command.snapshot.bannerId, bannerVersion: command.snapshot.version } : null;
    return parseAgentObservation({ schemaVersion: 1, protocolVersion: 1, sessionId: this.sessionId, deviceId: this.deviceId,
      sessionGeneration, mappingVersion: this.mapping.version, sequence: this.sequence, observedAtMs: this.wall(), vmix,
      overlay: 1, state: known ? state!.inputKey === null ? 'clear' : 'on_air' : 'unknown',
      inputKey: known ? state!.inputKey : null, text: known ? text : null,
      source: command ? 'boardwalk' : known ? 'manual' : 'unknown', correlation });
  }
  private clearSample(state: NativeState | null, source: ClearSample['source']): ClearSample {
    return { state: state?.safe ? state.inputKey === null ? 'clear' : 'on_air' : 'unknown', source,
      inputKey: state?.inputKey ?? null, visibilityReasons: state?.visibilityReasons ?? [] };
  }
  private async guard(delivery: LiveCommandDelivery, startedAt: number, lastSequence: number) {
    const { allowed, fences } = await this.backend.fence(delivery.command.id);
    if (!allowed || !fences.active || fences.mappingVersion !== this.mapping.version ||
        (!managedClear(delivery.command) && fences.sessionGeneration !== this.sessionGeneration)) throw new Refusal('superseded');
    const check = () => {
      try {
        assertCommandBinding(delivery, { sessionId: this.sessionId, deviceId: this.deviceId,
        sessionGeneration: fences.sessionGeneration, mappingVersion: fences.mappingVersion, clearGeneration: fences.clearGeneration,
        lastSequence, timingId: delivery.timingId, timing: { kind: 'request', elapsedMs: this.now() - startedAt } });
      } catch { throw new Refusal(this.now() - startedAt >= delivery.ttlMs ? 'expired' : 'superseded'); }
    };
    check(); return check;
  }
  async execute(value: LiveCommandDelivery, startedAt: number): Promise<Receipt> {
    const delivery = parseLiveCommandDelivery(value);
    const command = delivery.command;
    const previous = this.journal.find(command);
    if (previous) return previous; // Only its receipt can be retried.
    const lastSequence = this.journal.lastSequence;
    if (command.sequence <= lastSequence) throw new Refusal('superseded');
    this.journal.start(command);
    let attempted = false;
    try {
      await this.backend.begin(command);
      await this.guard(delivery, startedAt, lastSequence);
      if (managedClear(command)) {
        let before: NativeState | null = null;
        try { before = await this.vmix.read(this.mapping); } catch { /* Clear needs no prior sample. */ }
        const source = before?.safe && before.inputKey ? this.correlation && this.native && isDeepStrictEqual(before, this.native)
          ? 'boardwalk' : 'manual' : 'unknown';
        const detail = before?.inputKey ? `${source}:${before.inputKey}` : source;
        const checkDeadline = await this.guard(delivery, startedAt, lastSequence);
        const beforeSample = this.clearSample(before, source);
        this.journal.checkpoint(command, `overlay_out:${detail}`, 'started', { before: beforeSample }); checkDeadline();
        attempted = true;
        await this.vmix.clear();
        const cleared = await this.vmix.read(this.mapping);
        this.journal.checkpoint(command, `clear_readback:${detail}`, 'started', { before: beforeSample,
          after: this.clearSample(cleared, cleared.safe && cleared.inputKey === null ? 'boardwalk' : 'unknown') });
        if (cleared.inputKey !== null) throw new Refusal('outcome_unknown');
        this.native = cleared; this.correlation = command; this.sessionGeneration = command.sessionGeneration;
        return this.journal.checkpoint(command, `observed_clear:${detail}`, 'succeeded');
      }
      if (command.expectedObservationSequence > this.sequence || !this.native) throw new Refusal('failed');
      let state = await this.vmix.read(this.mapping);
      if (!state.safe || !isDeepStrictEqual(state, this.native)) throw new Refusal('failed');
      const mutate = async (checkpoint: string, expected: NativeState, effect: () => Promise<void>) => {
        // Authenticate the fence, read current fields, then recheck elapsed time.
        const checkDeadline = await this.guard(delivery, startedAt, lastSequence);
        const latest = await this.vmix.read(this.mapping);
        if (!latest.safe || !isDeepStrictEqual(latest, state)) throw new Refusal('failed');
        this.journal.checkpoint(command, checkpoint);
        checkDeadline();
        attempted = true;
        await effect();
        state = await this.vmix.read(this.mapping);
        if (!state.safe || !isDeepStrictEqual(state, expected)) throw new Refusal('outcome_unknown');
        return state;
      };
      state = await this.apply(command, state, mutate);
      this.native = state;
      this.correlation = command;
      return this.journal.checkpoint(command, 'observed', 'succeeded');
    } catch (error) {
      if (attempted) this.disconnect();
      const reason = error instanceof Refusal ? error.outcome : 'native_or_transport_error';
      const outcome = attempted ? 'outcome_unknown' : error instanceof Refusal ? error.outcome : 'failed';
      const checkpoint = this.journal.find(command)!.checkpoint;
      return this.journal.checkpoint(command, `${checkpoint}:${reason}`, outcome);
    }
  }
  private async apply(command: LiveCommand, state: NativeState, mutate: Mutate): Promise<NativeState> {
    if (command.action === 'clear') {
      if (!state.inputKey || !state.text) throw new Refusal('failed');
      if (command.target.kind === 'banner') {
        const prior = this.correlation;
        if (!prior || prior.action === 'clear' || prior.snapshot.bannerId !== command.target.bannerId ||
            prior.snapshot.version !== command.target.version || prior.snapshot.text.templateId !== command.target.templateId) {
          throw new Refusal('failed');
        }
      }
      state = await mutate('overlay_out', { ...state, inputKey: null, text: null }, () => this.vmix.clear());
      if (state.inputKey !== null) throw new Refusal('failed');
    } else {
      const input = this.mapping.inputs[command.snapshot.text.templateId]!;
      const overlay = mappedOverlayInput(this.mapping, command.snapshot.text.templateId)!;
      if (command.action === 'update_text') {
        const prior = this.correlation;
        const expected = command.expectedLive;
        if (!prior || prior.action === 'clear' || state.inputKey !== overlay.key ||
            prior.id !== expected.correlation?.commandId || prior.snapshot.bannerId !== command.snapshot.bannerId ||
            !expected.correlation || !('bannerVersion' in expected.correlation) ||
            prior.snapshot.version !== expected.correlation.bannerVersion || state.inputKey !== expected.inputKey ||
            !isDeepStrictEqual(state.text, expected.text)) throw new Refusal('failed');
      } else if (state.inputKey && !state.text) {
        throw new Refusal('failed');
      }
      const text = command.snapshot.text;
      const fields = text.templateId === 'headline' ? [['TextBlock1.Text', text.headline]]
        : [['TextBlock1.Text', text.name], ['TextBlock2.Text', text.title]];
      for (const [field, value] of fields) {
        const titles = structuredClone(state.titles) as Record<string, any>;
        const title = titles[text.templateId];
        if (text.templateId === 'headline') title.headline = value;
        else if (field === 'TextBlock1.Text') title.name = value;
        else title.title = value;
        const expected = { ...state, titles, text: state.inputKey === overlay.key ? title : state.text };
        state = await mutate(field, expected, () => this.vmix.field(input.key, field, value));
      }
      if (!isDeepStrictEqual(state.titles[text.templateId], text)) throw new Refusal('failed');
      if (command.action === 'take') state = await mutate('overlay_in', { ...state, inputKey: overlay.key, text }, () => this.vmix.take(overlay.key));
      if (state.inputKey !== overlay.key || !isDeepStrictEqual(state.text, text)) throw new Refusal('failed');
    }
    return state;
  }
}
