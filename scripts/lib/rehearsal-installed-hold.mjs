import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import nativeHolds from '../../functions/lib/public-release-rehearsal-hold.js';
import work from '../../functions/lib/public-release-pair-work.js';
import visibility from '../../functions/lib/public-video-references.js';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { rehearsalOperationId } from './public-release-rehearsal.mjs';
import { InstalledRehearsalStop } from './rehearsal-installed-stop.mjs';
import { REHEARSAL_HOLD_OWNER_BLOBS } from './rehearsal-hold-owner-blobs.mjs';

const { require: typedRequire } = createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api');
const { releaseRehearsalPublicationHold } = typedRequire('../../site/scripts/public-release-rehearsal-hold.ts', import.meta.url);
const files = Object.keys(REHEARSAL_HOLD_OWNER_BLOBS);
const root = fileURLToPath(new URL('../../', import.meta.url));
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Installed rehearsal hold binding refused'); };
const bindings = new WeakMap();
export function assertRehearsalHoldActions(handle, firestore, packet) {
  const binding = bindings.get(handle);
  if (binding?.firestore !== firestore || binding.packetDigest !== protocol.publicReleaseDigest(packet)) refuse();
}

function gitFiles(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) refuse();
  const output = execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    'ls-tree', '-r', '--full-tree', sha, '--', ...files], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const entries = output.trim().split('\n').map(line => /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line));
  if (entries.length !== files.length || entries.some(row => !row || !files.includes(row[2]))) refuse();
  return Object.fromEntries(entries.map(row => [row[2], row[1]]));
}

/** Source presence is necessary, not an installed-provider certificate. The
 * session must separately verify the immutable pair/image/provider identity.
 * Exact files cover admission, continuation and final terminal enforcement;
 * ancestry alone would incorrectly accept a later revert of any hook.
 */
export function assertRehearsalHoldRuntimeSource(pairs, readSource = gitFiles) {
  try {
    if (!Array.isArray(pairs) || pairs.length !== 2) refuse();
    const sources = [];
    for (const raw of pairs) {
      const pair = protocol.parsePublicReleasePair(raw); work.assertPrivatePairResources(pair);
      if (pair.environment !== 'development') refuse();
      const source = readSource(pair.commitSha);
      if (!same(Object.keys(source).sort(), [...files].sort()) || files.some(file =>
        !REHEARSAL_HOLD_OWNER_BLOBS[file].some(entry => entry.blob === source[file]))) refuse();
      sources.push(source);
    }
    return Object.freeze({ sourceDigest: protocol.publicReleaseDigest(sources) });
  } catch { throw new InstalledRehearsalStop('switch-new'); }
}

/** All mutations call the native
 * reserve/release/cancel owners; the packet supplies no readiness callback. */
export function createRehearsalHoldActions({ firestore, packet, cases, initialEpoch, durationMs, store, ingress,
  fieldValues, signal, authorized = false, readSource = gitFiles }) {
  if (authorized !== true || !packet || !['old', 'new'].every(side => cases?.[side]) || !protocol.positive(initialEpoch)) refuse();
  packet = protocol.freeze(structuredClone(packet));
  const pairs = [packet.oldPair, packet.newPair].map(protocol.parsePublicReleasePair);
  const environment = () => {
    if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
    else if (packet.schemaVersion === 2 && packet.setupMode === 'preinstalled') assertDevelopmentRehearsalEnvironment();
    else refuse();
    if (firestore.projectId !== packet.projectId || ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
    pairs.forEach(pair => { work.assertPrivatePairResources(pair); work.assertPublicReleasePairDatabase(firestore, pair); });
    signal?.throwIfAborted();
  };
  environment();
  const plans = Object.fromEntries(['old', 'new'].map((side, index) => {
    const item = cases[side], document = item.nextDocument;
    if (!document?.published || document.id !== item.documentId || document.type !== 'post') refuse();
    const source = admission.publicationSource({ kind: 'post', family: 'posts', id: item.documentId,
      action: visibility.publiclyVisible(document) ? 'publish' : 'withdraw', snapshot: document.published });
    const plan = nativeHolds.parsePlan({ schemaVersion: 2, runId: packet.runId,
      operationId: rehearsalOperationId(packet, `hold-${side}`), pair: pairs[index], targetPair: pairs[1 - index],
      expectedEpoch: initialEpoch + index, source, durationMs,
      releaseActionId: `${packet.runId}-settle-${side}`, cancelActionId: `${packet.runId}-cancel-${side}` });
    return [side, plan];
  }));
  const plan = side => { environment(); if (!Object.hasOwn(plans, side)) refuse(); return plans[side]; };
  const available = () => { environment(); return assertRehearsalHoldRuntimeSource(pairs, readSource); };
  const original = async side => {
    const selected = plan(side), state = await nativeHolds.readRehearsalPublicationHold({ firestore, plan: selected });
    if (!state) refuse(); return { selected, state, holdDigest: protocol.publicReleaseDigest(state.intent) };
  };
  const handle = Object.freeze({
    available,
    async reserve(side) {
      available(); const selected = plan(side);
      const intent = await nativeHolds.reserveRehearsalPublicationHold({ firestore, plan: selected, enabled: true });
      return { intent, holdDigest: protocol.publicReleaseDigest(intent) };
    },
    async read(side) { return nativeHolds.readRehearsalPublicationHold({ firestore, plan: plan(side) }); },
    async release(side, actionId) {
      available(); const { selected, holdDigest } = await original(side);
      if (actionId !== selected.releaseActionId) refuse();
      return releaseRehearsalPublicationHold({ firestore, plan: selected, holdDigest, actionId, enabled: true,
        store, ingress, fieldValues, signal });
    },
    async cancel(side, actionId) {
      const { selected, holdDigest } = await original(side);
      if (actionId !== selected.cancelActionId) refuse();
      return nativeHolds.cancelRehearsalPublicationHold({ firestore, plan: selected, holdDigest, actionId, enabled: true });
    },
  });
  bindings.set(handle, { firestore, packetDigest: protocol.publicReleaseDigest(packet) });
  return handle;
}
