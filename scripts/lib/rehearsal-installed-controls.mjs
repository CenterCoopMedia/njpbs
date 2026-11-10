import protocol from '../../functions/lib/public-release-pair.js';
import { readRehearsalInstalledControl } from './rehearsal-installed-state.mjs';
import { assertRehearsalAuditScope } from './rehearsal-installed-audit.mjs';
import { rehearsalOperationId, rehearsalSteps } from './public-release-rehearsal.mjs';
import admission from '../../functions/lib/public-release-admission.js';
import { assertNativeRehearsalDatabase } from './rehearsal-sdk-identity.mjs';

export const REHEARSAL_CONTROL_INTERVAL_MS = 1000;
export const REHEARSAL_CONTROL_MAX_GAP_MS = 5000;
const MAX_SAMPLES = 3600;
const refuse = () => { throw new Error('Installed rehearsal continuous controls refused'); };
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const immutable = row => {
  if (!row.exists || !row.createTime.isEqual(row.updateTime)) refuse();
  return row.data();
};
const references = (firestore, packet) => {
  const base = `publicReleaseRehearsalRuns/${packet.runId}`;
  return { root: firestore.doc(base), head: firestore.doc(`${base}/controls/monitor`),
    failure: firestore.doc(`${base}/controls/failure`), samples: firestore.collection(`${base}/controlSamples`),
    actions: firestore.collection(`${base}/actions`) };
};
function ready(packet, state) {
  const selector = protocol.parsePublicReleaseSelector(state?.selector);
  const pair = [packet.oldPair, packet.newPair].find(pair => same(selector.selectedPair, protocol.publicReleasePairReference(pair)));
  if (!pair || state.admission !== true || state.previewReady !== true || state.providerAttempts !== 0 ||
      [state.primary, state.cloud].some(pin => pin?.phase !== 'ready' || pin.release !== pair.commitSha)) refuse();
}
async function read(options, minimum) {
  const packet = assertRehearsalAuditScope(options), { firestore, signal } = options;
  const refs = references(firestore, packet);
  return firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const [root, headRow, failed] = await transaction.getAll(refs.root, refs.head, refs.failure);
    const run = immutable(root), head = headRow.data();
    const rows = (await transaction.get(refs.samples.limit(MAX_SAMPLES + 1))).docs;
    if (failed.exists || !headRow.exists || rows.length < minimum || rows.length > MAX_SAMPLES ||
        head?.count !== rows.length || run.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
    let previousDigest = protocol.publicReleaseDigest(run), previousAt, maxGapMs = 0, prefixStates, prefixEvidence;
    const states = [];
    for (const [index, row] of rows.entries()) {
      const value = immutable(row);
      protocol.exact(value, ['schemaVersion', 'sequence', 'runDigest', 'previousDigest', 'readAt', 'state', 'stableControls']);
      if (row.id !== String(index + 1).padStart(6, '0') || value.schemaVersion !== 1 || value.sequence !== index + 1 ||
          value.runDigest !== protocol.publicReleaseDigest(run) || value.previousDigest !== previousDigest ||
          !Number.isSafeInteger(value.readAt) || value.readAt < Math.floor(root.createTime.toMillis()) ||
          row.createTime.toMillis() < value.readAt || row.createTime.toMillis() - value.readAt > REHEARSAL_CONTROL_MAX_GAP_MS) refuse();
      ready(packet, value.state);
      if (!Array.isArray(value.stableControls) || value.stableControls.length !== 4 ||
          !same(value.stableControls, rows[0].data().stableControls)) refuse();
      if (previousAt !== undefined) {
        const gap = value.readAt - previousAt;
        if (gap < 0 || gap > REHEARSAL_CONTROL_MAX_GAP_MS) refuse();
        maxGapMs = Math.max(maxGapMs, gap);
        const before = states.at(-1).selector, now = value.state.selector;
        if (now.epoch < before.epoch || now.epoch > before.epoch + 1 ||
            now.contentHead.contextSequence < before.contentHead.contextSequence) refuse();
      }
      if (!states.length || !same(states.at(-1), value.state)) states.push(value.state);
      previousDigest = protocol.publicReleaseDigest(value); previousAt = value.readAt;
      if (options.prefix?.count === index + 1) {
        prefixStates = [...states];
        prefixEvidence = { count: index + 1, digest: previousDigest, firstReadAt: rows[0].data().readAt,
          lastReadAt: previousAt, maxGapMs, controlsContinuous: index + 1 >= 3 && maxGapMs <= REHEARSAL_CONTROL_MAX_GAP_MS };
      }
    }
    const first = rows[0].data();
    const actions = (await transaction.get(refs.actions.limit(rehearsalSteps().length + 1))).docs;
    const baseline = await transaction.get(firestore.doc(`${admission.ADMISSIONS}/operations/${rehearsalOperationId(packet, 'baseline')}`));
    if (actions.length > rehearsalSteps().length || actions.some(row => first.readAt > row.createTime.toMillis()) ||
        baseline.exists && first.readAt > baseline.createTime.toMillis()) refuse();
    if (options.prefix && (!prefixEvidence || !same(options.prefix, prefixEvidence))) refuse();
    if (head.digest !== previousDigest || head.readAt !== previousAt ||
        head.stableControlsDigest !== protocol.publicReleaseDigest(rows[0].data().stableControls) ||
        root.readTime.toMillis() - previousAt < 0 || root.readTime.toMillis() - previousAt > REHEARSAL_CONTROL_MAX_GAP_MS) refuse();
    return protocol.freeze({ count: rows.length, digest: previousDigest, firstReadAt: first.readAt,
      lastReadAt: previousAt, maxGapMs, states, controlsContinuous: rows.length >= 3 && maxGapMs <= REHEARSAL_CONTROL_MAX_GAP_MS,
      ...(prefixStates ? { prefixStates } : {}) });
  }, { readOnly: true });
}

/** Independent read-only verification of every native sample, its SDK time,
 * complete immutable chain, failure latch and freshness. Step snapshots cannot
 * substitute for this evidence; gaps across parent restarts fail closed. */
export const readRehearsalControlEvidence = options => read(options, 3);

export async function openRehearsalControlObserver(options) {
  const packet = assertRehearsalAuditScope(options), { firestore, signal } = options;
  assertNativeRehearsalDatabase(firestore, packet.projectId);
  const refs = references(firestore, packet);
  let stopped = false, error, timer, head, runDigest;
  const start = await firestore.runTransaction(async transaction => {
    const [root, prior, failed] = await transaction.getAll(refs.root, refs.head, refs.failure);
    const run = immutable(root);
    if (failed.exists || run.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
    if (!prior.exists && !(await transaction.get(refs.actions.limit(1))).empty) refuse();
    return { runDigest: protocol.publicReleaseDigest(run), head: prior.exists ? prior.data() : null };
  }, { readOnly: true });
  runDigest = start.runDigest; head = start.head;
  if (head) await read(options, 1);
  async function fail(cause) {
    if (stopped) return;
    error = cause; clearTimeout(timer); options.onFailure?.();
    try { await refs.failure.create({ schemaVersion: 1, runDigest, code: 'native-controls-unobserved-or-not-ready' }); } catch { /* Existing failure or unavailable SDK still refuses locally and by the gap. */ }
  }
  async function sample() {
    if (stopped || error) refuse();
    signal?.throwIfAborted();
    const observed = await readRehearsalInstalledControl({ ...options, packet });
    if (stopped || error) refuse();
    const stableControlsDigest = protocol.publicReleaseDigest(observed.stableControls);
    const sequence = (head?.count ?? 0) + 1;
    if (sequence > MAX_SAMPLES || head && (head.stableControlsDigest !== stableControlsDigest ||
        observed.readAt < head.readAt || observed.readAt - head.readAt > REHEARSAL_CONTROL_MAX_GAP_MS)) refuse();
    const value = { schemaVersion: 1, sequence, runDigest, previousDigest: head?.digest ?? runDigest, ...observed };
    const next = { count: sequence, digest: protocol.publicReleaseDigest(value), readAt: observed.readAt, stableControlsDigest };
    await firestore.runTransaction(async transaction => {
      const [prior, failed] = await transaction.getAll(refs.head, refs.failure);
      if (stopped || error || failed.exists || !same(prior.exists ? prior.data() : null, head)) refuse();
      transaction.create(refs.samples.doc(String(sequence).padStart(6, '0')), value);
      transaction.set(refs.head, next);
    });
    head = next;
  }
  let pending = Promise.resolve();
  const sampleNow = () => {
    pending = pending.then(sample).catch(async cause => { await fail(cause); throw cause; });
    return pending;
  };
  function schedule() {
    timer = setTimeout(() => { sampleNow().then(() => { if (!stopped && !error) schedule(); }).catch(() => {}); }, REHEARSAL_CONTROL_INTERVAL_MS);
    timer.unref();
  }
  try { await sampleNow(); } catch (cause) { stopped = true; throw cause; }
  schedule();
  return Object.freeze({ sampleNow,
    assertHealthy() { if (stopped || error) refuse(); signal?.throwIfAborted(); },
    stop() { stopped = true; clearTimeout(timer); },
  });
}
