import { expect, it } from 'vitest';
import { requireInstalledRehearsalHold, installedRehearsalStopReply, readInstalledRehearsalStop,
  assertRehearsalProviderTransition, InstalledRehearsalStop } from '../scripts/lib/rehearsal-installed-stop.mjs';

const packet = { schemaVersion: 2, setupMode: 'preinstalled' };
const request = target => ({ packet, actionId: `run-hold-${target}`, target,
  action: target === 'old' ? 'accept-held-old-operation' : 'accept-held-new-operation' });
it.each(['old', 'new'])('stops before a %s hold and identifies the dependent real switch', side => {
  expect(() => requireInstalledRehearsalHold(side)).toThrow(InstalledRehearsalStop);
  const reply = installedRehearsalStopReply(request(side));
  expect(reply).not.toHaveProperty('operation'); expect(reply).not.toHaveProperty('state');
  const stop = readInstalledRehearsalStop(reply, request(side));
  expect(stop.issue).toBe(4440); expect(stop.blockedStep).toBe(side === 'old' ? 'switch-new' : 'return-old');
});
it.each(['prepare', 'switch-new', 'return-old', 'baseline', 'audit'])('requires zero new provider effects at preinstalled %s', step => {
  expect(() => assertRehearsalProviderTransition(packet, step, 0, 0)).not.toThrow();
  expect(() => assertRehearsalProviderTransition(packet, step, 0, 1)).toThrow('Repeated provider mutation');
});
it('preserves the legacy demo prepare effect and refuses other provider mutations', () => {
  expect(() => assertRehearsalProviderTransition({ schemaVersion: 1 }, 'prepare', 0, 1)).not.toThrow();
  expect(() => assertRehearsalProviderTransition({ schemaVersion: 1 }, 'baseline', 0, 1)).toThrow();
  expect(() => assertRehearsalProviderTransition(packet, 'prepare', 1, 0)).toThrow();
});
it.each(['issue', 'blockedStep', 'actionId', 'reason', 'extra'])('refuses changed or extended STOP %s evidence', field => {
  const reply = { ...installedRehearsalStopReply(request('old')), [field]: 'changed' };
  expect(() => readInstalledRehearsalStop(reply, request('old'))).toThrow();
});
it('refuses STOP substitution at an ordinary action or outside installed mode', () => {
  expect(() => installedRehearsalStopReply({ ...request('old'), action: 'publish-and-prove' })).toThrow();
  expect(() => installedRehearsalStopReply({ ...request('old'), packet: { schemaVersion: 1 } })).toThrow();
});
it.each([['switch-new', 'new', 'switch-new'], ['return-old-current-content', 'old', 'return-old'],
  ['settle-original-old-through-new', 'new', 'switch-new'], ['settle-original-new-through-old', 'old', 'return-old']])(
  'preserves named hold STOP at %s', (action, target, blockedStep) => {
    const input = { packet, actionId: `run-${action}`, action, target };
    const reply = installedRehearsalStopReply(input);
    expect(readInstalledRehearsalStop(reply, input)).toMatchObject({ issue: 4440, blockedStep });
    expect(() => installedRehearsalStopReply({ ...input, target: target === 'old' ? 'new' : 'old' })).toThrow();
  });
