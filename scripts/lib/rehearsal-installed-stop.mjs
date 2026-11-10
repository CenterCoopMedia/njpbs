import assert from 'node:assert/strict';

export const INSTALLED_HOLD_ISSUE = 4440;
const reason = 'installed-operation-hold-unavailable';
export class InstalledRehearsalStop extends Error {
  constructor(blockedStep) {
    super(reason);
    assert(['switch-new', 'return-old'].includes(blockedStep));
    this.code = reason;
    this.issue = INSTALLED_HOLD_ISSUE;
    this.blockedStep = blockedStep;
    Object.freeze(this);
  }
}

/** Missing native hold is a named later gate, never a held admission. */
export function requireInstalledRehearsalHold(target) {
  assert(['old', 'new'].includes(target));
  throw new InstalledRehearsalStop(target === 'old' ? 'switch-new' : 'return-old');
}

export function installedRehearsalStopReply(request) {
  assert.equal(request.packet.schemaVersion, 2);
  assert.equal(request.packet.setupMode, 'preinstalled');
  const actions = { 'accept-held-old-operation': ['old', 'old'], 'accept-held-new-operation': ['new', 'new'],
    'switch-new': ['old', 'new'], 'return-old-current-content': ['new', 'old'],
    'settle-original-old-through-new': ['old', 'new'], 'settle-original-new-through-old': ['new', 'old'] };
  assert(Object.hasOwn(actions, request.action));
  const [side, target] = actions[request.action];
  assert.equal(request.target, target);
  return Object.freeze({ schemaVersion: 1, actionId: request.actionId, outcome: 'stopped',
    reason, issue: INSTALLED_HOLD_ISSUE, blockedStep: side === 'old' ? 'switch-new' : 'return-old' });
}

export function readInstalledRehearsalStop(reply, request) {
  assert.deepEqual(reply, installedRehearsalStopReply(request));
  return new InstalledRehearsalStop(reply.blockedStep);
}

/** Preinstalled targets have no provider effect in any rehearsal step.
 * A legacy demo's prepare still performs its one original fixture effect. */
export function assertRehearsalProviderTransition(packet, step, before, after) {
  assert(Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after >= 0);
  const preinstalled = packet.schemaVersion === 2 && packet.setupMode === 'preinstalled';
  assert.equal(after, before + (!preinstalled && step === 'prepare' ? 1 : 0), 'Repeated provider mutation');
}
