import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import type { VisibilityReason } from './vmix-client';
import { join } from 'node:path';
import { parseLiveCommand, parsePersistedLiveCommand, type LiveCommand, type PersistedLiveCommand } from '../../../packages/content-core/src/live-production';

export type Outcome = 'started' | 'succeeded' | 'failed' | 'expired' | 'superseded' | 'outcome_unknown';
export type ClearSample = { state: 'on_air' | 'clear' | 'unknown'; source: 'boardwalk' | 'manual' | 'unknown';
  inputKey: string | null; visibilityReasons: VisibilityReason[] };
export type ClearDiagnostics = { before: ClearSample; after?: ClearSample };
export type Receipt = { commandId: string; requestId: string; outcome: Outcome; checkpoint: string; clear?: ClearDiagnostics };
type Entry = { command: PersistedLiveCommand; hash: string; receipt: Receipt; acknowledged: boolean };
type State = { version: 1; observationSequence: number; lastSequence: number; entries: Entry[] };
function canonical(value: any): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const hash = (command: PersistedLiveCommand) => createHash('sha256').update(canonical(command)).digest('hex');

/** One journal for the enrolled device, on local disk; never a network share. */
export class Journal {
  private state: State;
  private lock: string;
  private file: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = join(directory, 'agent.lock');
    this.file = join(directory, 'journal.json');
    const fd = openSync(this.lock, 'wx', 0o600);
    try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8'))
        : { version: 1, observationSequence: 0, lastSequence: 0, entries: [] };
      if (this.state.version !== 1 || !Array.isArray(this.state.entries) ||
          !Number.isSafeInteger(this.state.observationSequence) || this.state.observationSequence < 0 ||
          !Number.isSafeInteger(this.state.lastSequence) || this.state.lastSequence < 0) {
        throw new Error('Invalid journal');
      }
      const commands = new Set<string>();
      const requests = new Set<string>();
      for (const entry of this.state.entries) {
        const command = parsePersistedLiveCommand(entry.command);
        if (entry.hash !== hash(command) || commands.has(command.id) || requests.has(command.requestId) ||
            typeof entry.acknowledged !== 'boolean' || entry.receipt.commandId !== command.id ||
            entry.receipt.requestId !== command.requestId || typeof entry.receipt.checkpoint !== 'string' ||
            !['started', 'succeeded', 'failed', 'expired', 'superseded', 'outcome_unknown'].includes(entry.receipt.outcome) ||
            command.sequence > this.state.lastSequence) throw new Error('Invalid journal entry');
        commands.add(command.id); requests.add(command.requestId);
        if (entry.receipt.outcome === 'started') {
          entry.receipt.outcome = 'outcome_unknown'; entry.acknowledged = false;
        }
      }
      this.save();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  private save() {
    const temp = `${this.file}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
  }
  get lastSequence() { return this.state.lastSequence; }
  advanceSequence(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < this.lastSequence) throw new Error('Invalid scan cursor');
    this.state.lastSequence = sequence; this.save();
  }
  nextObservation() { this.state.observationSequence++; this.save(); return this.state.observationSequence; }
  find(command: LiveCommand): Receipt | null {
    const prior = this.state.entries.find(entry => entry.command.id === command.id || entry.command.requestId === command.requestId);
    if (!prior) return null;
    if (prior.hash !== hash(command)) throw new Error('Command identity changed');
    return structuredClone(prior.receipt);
  }
  start(command: LiveCommand) {
    command = parseLiveCommand(command);
    if (this.find(command)) throw new Error('Command already journaled');
    if (command.sequence <= this.lastSequence) throw new Error('Command sequence moved backwards');
    this.state.lastSequence = command.sequence;
    this.state.entries.push({ command, hash: hash(command), acknowledged: false,
      receipt: { commandId: command.id, requestId: command.requestId, outcome: 'started', checkpoint: 'before_native' } });
    this.save();
  }
  checkpoint(command: LiveCommand, checkpoint: string, outcome: Outcome = 'started', clear?: ClearDiagnostics): Receipt {
    const entry = this.state.entries.find(entry => entry.command.id === command.id);
    if (!entry) throw new Error('Missing journal intent');
    entry.receipt = { ...entry.receipt, ...(clear ? { clear } : {}), commandId: command.id, requestId: command.requestId, checkpoint, outcome };
    entry.acknowledged = false; this.save(); return structuredClone(entry.receipt);
  }
  pending(): Receipt[] {
    return this.state.entries.filter(entry => !entry.acknowledged && entry.receipt.outcome !== 'started').map(entry => structuredClone(entry.receipt));
  }
  acknowledge(commandId: string) {
    const entry = this.state.entries.find(entry => entry.command.id === commandId);
    if (entry) { entry.acknowledged = true; this.save(); }
  }
  close() { unlinkSync(this.lock); }
}
