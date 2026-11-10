import { describe, expect, it } from 'vitest';
import { parseLiveCommand, type AgentObservation } from '../../packages/content-core/src/live-production';
import { simulatorMapping as mapping } from '../../agents/vmix/src/simulator';
import { commandAllowed } from '../../functions/lib/live-production-journal';

const oldText = { templateId: 'name_title', name: 'Old name', title: 'Old title' } as const;
const report: AgentObservation = { schemaVersion: 1, protocolVersion: 1, sessionId: mapping.sessionId,
  deviceId: mapping.deviceId!, sessionGeneration: 1, mappingVersion: 1, sequence: 3,
  observedAtMs: 100, vmix: 'reachable', overlay: 1, state: 'on_air', inputKey: mapping.inputs.name_title!.key,
  text: oldText, source: 'boardwalk', correlation: { commandId: 'old-take', bannerId: 'banner', bannerVersion: 1 } };
function update() {
  return { schemaVersion: 1, protocolVersion: 1, id: 'update', requestId: 'update-request', actorId: 'staff',
    sessionId: mapping.sessionId, deviceId: mapping.deviceId!, sessionGeneration: 1, mappingVersion: 1,
    sequence: 2, clearGeneration: 0, overlay: 1, createdAtMs: 100, expiresAtMs: 15100,
    expectedObservationSequence: 3, action: 'update_text', expectedLive: structuredClone(report),
    snapshot: { bannerId: 'banner', sessionId: mapping.sessionId, version: 2, mappingVersion: 1,
      text: { templateId: 'name_title', name: 'New name', title: '' } } };
}
const session = { id: mapping.sessionId, deviceId: mapping.deviceId, generation: 1, mappingVersion: 1, state: 'active' };
const control = { report, receivedAtMs: 100, clearGeneration: 0, lastSequence: 2 };

describe('Update live immutable context', () => {
  it('carries the exact prior observed version separately from the saved draft', () => {
    const value: any = update();
    const command = parseLiveCommand(value);
    value.expectedLive.text = { ...oldText, name: 'Changed after admission' };
    expect(command).toMatchObject({ action: 'update_text', expectedLive: report, snapshot: { version: 2 } });
  });
  it.each(['missing', 'manual', 'sequence', 'device', 'generation', 'mapping', 'banner', 'template', 'unchanged', 'old_version'])('rejects %s update context', kind => {
    const command: any = update();
    if (kind === 'missing') delete command.expectedLive;
    if (kind === 'manual') { command.expectedLive.source = 'manual'; command.expectedLive.correlation = null; }
    if (kind === 'sequence') command.expectedLive.sequence++;
    if (kind === 'device') command.expectedLive.deviceId = 'other';
    if (kind === 'generation') command.expectedLive.sessionGeneration++;
    if (kind === 'mapping') command.expectedLive.mappingVersion++;
    if (kind === 'banner') command.expectedLive.correlation.bannerId = 'other';
    if (kind === 'template') command.snapshot.text = { templateId: 'headline', headline: 'Other template' };
    if (kind === 'unchanged') command.snapshot.text = oldText;
    if (kind === 'old_version') command.snapshot.version = 1;
    expect(() => parseLiveCommand(command)).toThrow();
  });
  it('allows new native polls of the same output but rejects a later Take of the same banner', () => {
    const command = parseLiveCommand(update());
    expect(commandAllowed(command, session, mapping, { ...control, report: { ...report, sequence: 4 } }, 101)).toBe(true);
    expect(commandAllowed(command, session, mapping, { ...control, report: { ...report, sequence: 4,
      correlation: { ...report.correlation!, commandId: 'later-take' } } }, 101)).toBe(false);
  });
  it.each(['text', 'input', 'clear', 'stale', 'expiry', 'session', 'mapping'])('fences a pending update after %s changes', kind => {
    const changed: any = structuredClone(control), current = { ...session }, currentMapping = { ...mapping };
    let now = 101;
    if (kind === 'text') changed.report.text = { ...oldText, title: 'TD change' };
    if (kind === 'input') changed.report.inputKey = 'other-input';
    if (kind === 'clear') changed.clearGeneration++;
    if (kind === 'stale') now = 30100;
    if (kind === 'expiry') now = 15100;
    if (kind === 'session') current.generation++;
    if (kind === 'mapping') { current.mappingVersion++; currentMapping.version++; }
    expect(commandAllowed(parseLiveCommand(update()), current, currentMapping, changed, now)).toBe(false);
  });
});
