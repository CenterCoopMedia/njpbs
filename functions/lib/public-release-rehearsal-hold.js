"use strict";

// Private rehearsal owner only. No handler, timer, provider transport or global
// fence. An absent intent is the default; production cannot arm a hold.
const p = require("./public-release-pair");
const a = require("./public-release-admission-contract");
const work = require("./public-release-pair-work");
const HOLD_MS_LIMIT = 600_000;
const HOLDS = `${a.ADMISSIONS}/rehearsalHolds`;
const same = (x, y) => p.publicReleaseDigest(x) === p.publicReleaseDigest(y);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function id(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) refuse(); }
function path(operationId) { id(operationId); return `${HOLDS}/${operationId}`; }
function serverTime(row) {
  const now = row.readTime?.toMillis();
  if (!Number.isFinite(now) || now <= 0) refuse();
  return Math.floor(now);
}
function parsePlan(raw) {
  p.exact(raw, ["schemaVersion", "runId", "operationId", "pair", "targetPair", "expectedEpoch", "source", "durationMs", "releaseActionId", "cancelActionId"]);
  const pair = p.parsePublicReleasePair(raw.pair), targetPair = p.parsePublicReleasePair(raw.targetPair);
  work.assertPrivatePairResources(pair); work.assertPrivatePairResources(targetPair);
  [raw.runId, raw.releaseActionId, raw.cancelActionId].forEach(id);
  if (raw.schemaVersion !== 2 || !/^[A-Za-z0-9]{20}$/.test(raw.operationId ?? "") ||
      pair.environment !== "development" || targetPair.environment !== "development" || pair.pairId === targetPair.pairId ||
      raw.releaseActionId === raw.cancelActionId || !p.positive(raw.expectedEpoch) ||
      !Number.isSafeInteger(raw.durationMs) || raw.durationMs < 1_000 || raw.durationMs > HOLD_MS_LIMIT) refuse();
  // Keep publication-source parsing with its original owner.
  const source = require("./public-release-admission-contract").parsePublicationSource(raw.source);
  return p.freeze({ ...raw, pair, targetPair, source });
}
function parseIntent(raw) {
  p.exact(raw, ["schemaVersion", "kind", "plan", "planDigest", "createdAt", "expiresAt"]);
  const plan = parsePlan(raw.plan);
  if (raw.schemaVersion !== 2 || raw.kind !== "rehearsal-terminal-hold" || raw.planDigest !== p.publicReleaseDigest(plan) ||
      !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 || raw.expiresAt !== raw.createdAt + plan.durationMs) refuse();
  return p.freeze({ ...raw, plan });
}
function bindingFor(intent, accepted) {
  const plan = intent.plan;
  if (accepted.operationId !== plan.operationId || accepted.epoch !== plan.expectedEpoch ||
      accepted.pairDigest !== p.publicReleaseDigest(plan.pair) || !same(accepted.pair, p.publicReleasePairReference(plan.pair)) ||
      !same(accepted.source, plan.source)) refuse();
  return { schemaVersion: 2, holdDigest: p.publicReleaseDigest(intent), admissionDigest: p.publicReleaseDigest(accepted) };
}
function parseOutcome(raw, intent, binding) {
  p.exact(raw, ["schemaVersion", "kind", "holdDigest", "bindingDigest", "outcome", "actionId", "observedAt", "evidence"]);
  if (raw.schemaVersion !== 2 || raw.kind !== "rehearsal-hold-outcome" || raw.holdDigest !== p.publicReleaseDigest(intent) ||
      raw.bindingDigest !== (binding ? p.publicReleaseDigest(binding) : null) || !Number.isSafeInteger(raw.observedAt) ||
      raw.observedAt < intent.createdAt || !["released", "cancelled"].includes(raw.outcome) ||
      raw.actionId !== intent.plan[raw.outcome === "released" ? "releaseActionId" : "cancelActionId"]) refuse();
  if (raw.outcome === "cancelled") { if (raw.evidence !== null) refuse(); }
  else {
    p.exact(raw.evidence, ["epoch", "selectedPair", "selectorDigest", "executionDigest", "inclusion", "canonicalProofDigest", "coverageDigest"]);
    const e = raw.evidence;
    if (!binding || raw.observedAt >= intent.expiresAt || e.epoch !== intent.plan.expectedEpoch + 1 ||
        !same(p.parsePublicReleasePairReference(e.selectedPair), p.publicReleasePairReference(intent.plan.targetPair)) ||
        ![e.selectorDigest, e.executionDigest, e.canonicalProofDigest, e.coverageDigest].every(p.digest)) refuse();
    p.exact(e.inclusion, ["switchOperationId", "switchReceiptDigest", "switchWitnessDigest", "switchCoverageDigest", "workCensusDigest", "originalEntryDigest"]);
    id(e.inclusion.switchOperationId);
    if (!Object.entries(e.inclusion).filter(([key]) => key !== "switchOperationId").every(([, value]) => p.digest(value))) refuse();
  }
  return p.freeze(structuredClone(raw));
}
async function stateInTransaction({ firestore, transaction, pair, accepted }) {
  if (pair.environment !== "development") return null;
  work.assertPublicReleasePairDatabase(firestore, pair);
  const base = path(accepted.operationId);
  const [row, binding, outcome] = await transaction.getAll(firestore.doc(base), firestore.doc(`${base}/receipts/admission`), firestore.doc(`${base}/receipts/outcome`));
  if (!row.exists) { if (binding.exists || outcome.exists) refuse(); return null; }
  const intent = parseIntent(row.data()), expected = bindingFor(intent, accepted);
  if (!same(intent.plan.pair, pair) || !binding.exists || !same(binding.data(), expected)) refuse();
  const result = outcome.exists ? parseOutcome(outcome.data(), intent, expected) : null;
  return { intent, binding: expected, outcome: result, observedAt: serverTime(row),
    status: result?.outcome ?? (serverTime(row) >= intent.expiresAt ? "expired" : "held") };
}
class RehearsalPublicationHeldError extends Error {
  constructor() { super("The original development publication is held for its rehearsal switch"); this.name = "RehearsalPublicationHeldError"; }
}
async function assertNotHeldInTransaction(input) {
  const state = await stateInTransaction(input);
  if (state?.status === "held") throw new RehearsalPublicationHeldError();
  return state;
}
/** Read before any acceptance write. The returned binding is created by the
 * SAME original acceptance transaction; there is no post-acceptance race. */
async function prepareAdmissionInTransaction({ firestore, transaction, pair, accepted }) {
  if (pair.environment !== "development") return () => {};
  const base = path(accepted.operationId);
  const [row, bound, outcome] = await transaction.getAll(firestore.doc(base), firestore.doc(`${base}/receipts/admission`), firestore.doc(`${base}/receipts/outcome`));
  if (!row.exists) { if (bound.exists || outcome.exists) refuse(); return () => {}; }
  const intent = parseIntent(row.data()), binding = bindingFor(intent, accepted);
  if (!same(intent.plan.pair, pair) || bound.exists || outcome.exists || serverTime(row) >= intent.expiresAt) refuse();
  return () => transaction.create(bound.ref, binding);
}
async function reserveRehearsalPublicationHold({ firestore, plan: rawPlan, enabled = false }) {
  if (enabled !== true) refuse();
  const plan = parsePlan(rawPlan), base = path(plan.operationId);
  for (const pair of [plan.pair, plan.targetPair]) work.assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(base), existing = await transaction.get(ref);
    if (existing.exists) {
      const original = parseIntent(existing.data());
      if (!same(original.plan, plan)) refuse();
      return original;
    }
    const index = firestore.doc(`${a.ADMISSIONS}/rehearsalRuns/${p.publicReleaseDigest(plan.runId)}/pairs/${work.publicReleasePairKey(plan.pair.pairId)}`);
    const paths = [`${a.ADMISSIONS}/operations/${plan.operationId}`, `cmsPublishQueue/${plan.operationId}`,
      `${a.ADMISSIONS}/terminalReceipts/${plan.operationId}`, "system/publicDeployment", `${a.ADMISSIONS}/controls/adoption`,
      ...[plan.pair, plan.targetPair].flatMap(pair => [work.publicReleasePairPath(pair.pairId), `${work.publicReleasePairPath(pair.pairId)}/controls/runtime`])];
    const [claim, ...rows] = await transaction.getAll(index, ...paths.map(value => firestore.doc(value)));
    const selector = p.parseStoredPublicReleaseSelector(rows[3].data());
    if (claim.exists || rows.slice(0, 3).some(row => row.exists) ||
        selector.epoch !== plan.expectedEpoch || !same(selector.selectedPair, p.publicReleasePairReference(plan.pair)) ||
        !same(rows[4].data(), { schemaVersion: 2, enabled: true })) refuse();
    for (const [i, pair] of [plan.pair, plan.targetPair].entries()) {
      if (!same(p.parsePublicReleasePair(rows[5 + i * 2].data()), pair) ||
          !same(rows[6 + i * 2].data(), { schemaVersion: 2, pairId: pair.pairId, status: i === 0 ? "retained" : rows[6 + i * 2].data()?.status }) ||
          !["retained", "candidate"].includes(rows[6 + i * 2].data()?.status)) refuse();
    }
    const createdAt = serverTime(existing), intent = parseIntent({ schemaVersion: 2, kind: "rehearsal-terminal-hold", plan,
      planDigest: p.publicReleaseDigest(plan), createdAt, expiresAt: createdAt + plan.durationMs });
    transaction.create(ref, intent); transaction.create(index, { schemaVersion: 2, operationId: plan.operationId, holdDigest: p.publicReleaseDigest(intent) });
    return intent;
  });
}
async function readRehearsalPublicationHold({ firestore, plan: rawPlan }) {
  const plan = parsePlan(rawPlan); work.assertPublicReleasePairDatabase(firestore, plan.pair);
  return firestore.runTransaction(async transaction => {
    const base = path(plan.operationId), [row, accepted] = await transaction.getAll(firestore.doc(base), firestore.doc(`${a.ADMISSIONS}/operations/${plan.operationId}`));
    if (!row.exists) return null;
    const intent = parseIntent(row.data()); if (!same(intent.plan, plan)) refuse();
    if (accepted.exists) {
      const admission = a.parseAdmission(accepted.data());
      const state = await stateInTransaction({ firestore, transaction, pair: plan.pair, accepted: admission });
      if (state.status === "held") {
        const [queue, pending, terminal] = await transaction.getAll(firestore.doc(`cmsPublishQueue/${plan.operationId}`),
          firestore.doc(`${a.ADMISSIONS}/pending/${plan.operationId}`), firestore.doc(`${a.ADMISSIONS}/terminalReceipts/${plan.operationId}`));
        a.assertQueue(queue.data(), admission);
        if (!["pending", "publishing"].includes(queue.data()?.status) || terminal.exists ||
            !same(pending.data(), { schemaVersion: 2, operationId: plan.operationId, admissionDigest: p.publicReleaseDigest(admission) })) refuse();
      }
      return state;
    }
    const [binding, outcome] = await transaction.getAll(firestore.doc(`${base}/receipts/admission`), firestore.doc(`${base}/receipts/outcome`));
    if (binding.exists) refuse();
    const result = outcome.exists ? parseOutcome(outcome.data(), intent, null) : null;
    return { intent, binding: null, outcome: result, observedAt: serverTime(row),
      status: result?.outcome ?? (serverTime(row) >= intent.expiresAt ? "expired" : "reserved") };
  }, { readOnly: true });
}
async function cancelRehearsalPublicationHold({ firestore, plan: rawPlan, enabled = false, holdDigest, actionId }) {
  if (enabled !== true) refuse();
  const plan = parsePlan(rawPlan); work.assertPublicReleasePairDatabase(firestore, plan.pair);
  return firestore.runTransaction(async transaction => {
    const base = path(plan.operationId), [row, binding, prior] = await transaction.getAll(firestore.doc(base),
      firestore.doc(`${base}/receipts/admission`), firestore.doc(`${base}/receipts/outcome`));
    const intent = parseIntent(row.data());
    if (!same(intent.plan, plan) || p.publicReleaseDigest(intent) !== holdDigest || actionId !== plan.cancelActionId) refuse();
    if (prior.exists) {
      const outcome = parseOutcome(prior.data(), intent, binding.exists ? binding.data() : null);
      if (outcome.outcome !== "cancelled") refuse(); return outcome;
    }
    const outcome = parseOutcome({ schemaVersion: 2, kind: "rehearsal-hold-outcome", holdDigest,
      bindingDigest: binding.exists ? p.publicReleaseDigest(binding.data()) : null, outcome: "cancelled", actionId,
      observedAt: serverTime(row), evidence: null }, intent, binding.exists ? binding.data() : null);
    transaction.create(prior.ref, outcome); return outcome;
  });
}
module.exports = { HOLD_MS_LIMIT, HOLDS, path, parsePlan, parseIntent, parseOutcome, stateInTransaction,
  assertNotHeldInTransaction, prepareAdmissionInTransaction, reserveRehearsalPublicationHold, readRehearsalPublicationHold,
  cancelRehearsalPublicationHold, RehearsalPublicationHeldError };
