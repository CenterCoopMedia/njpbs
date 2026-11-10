import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import rollout from '../../functions/lib/public-release-pair-rollout.js';
import { parsePrivateBridgePacket, privateBridgeConfiguration } from './public-release-private-bridge-operator.mjs';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { matchesInstalledPublisherIntent, assertInstalledPublisherCompletion } from './installed-publisher-pair.mjs';

const captures = new WeakMap();
const roles = ['slot-old', 'slot-new', 'ingress', 'operator'];
const privateActions = ['create', 'upload', 'private-subdomain', 'deploy'];
const publisherActions = ['identity', 'version', 'deployment', 'container', 'trigger'];
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Preinstalled rehearsal census refused'); };
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? '');
const version = row => ({ seconds: row.updateTime.seconds, nanoseconds: row.updateTime.nanoseconds });

function environment(context) {
  if (context.packet.schemaVersion === 1) assertDemoRehearsalEnvironment(context.packet);
  else if (context.packet.schemaVersion === 2) {
    assertDevelopmentRehearsalEnvironment();
    if (context.packet.projectId !== 'njpbs-site-dev' || context.packet.setupMode !== 'preinstalled' ||
        ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
  } else refuse();
  if (context.firestore.projectId !== context.packet.projectId) refuse();
}

function inputs({ firestore, packet, sourceSha, publishers, workers, gateways, authorized }) {
  if (authorized !== true || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(packet?.runId ?? '') ||
      !Array.isArray(publishers) || publishers.length !== 2 || !Array.isArray(workers) || workers.length !== 4) refuse();
  const pairs = [packet.oldPair, packet.newPair].map(protocol.parsePublicReleasePair);
  if (pairs[0].pairId === pairs[1].pairId) refuse();
  const plans = publishers.map(rollout.parsePublicReleasePairUploadPlan);
  if (plans[0].accountId !== plans[1].accountId) refuse();
  for (const [index, pair] of pairs.entries()) {
    work.assertPrivatePairResources(pair); work.assertPublicReleasePairDatabase(firestore, pair);
    if (pair.environment !== 'development' || !matchesInstalledPublisherIntent(plans[index], pair)) refuse();
  }
  workers = workers.map((value, index) => {
    protocol.exact(value, ['role', 'attemptId', 'attemptPlanDigest', 'workerName', 'workerPlanDigest', 'versionId']);
    if (value.role !== roles[index] || !/^[A-Za-z0-9_-]{1,128}$/.test(value.attemptId ?? '') ||
        ![value.attemptPlanDigest, value.workerPlanDigest].every(protocol.digest) || !uuid(value.versionId) ||
        !(index === 3 ? /^njpbs-private-operator-[a-z0-9-]{1,40}$/ :
          /^(?:njpbs-pair-slot-[a-f0-9-]{36}|njpbs-private-ingress-[a-z0-9-]{1,30})$/).test(value.workerName ?? '') ||
        index < 2 && (value.workerName !== pairs[index].publicWorker.service || value.versionId !== pairs[index].publicWorker.versionId)) refuse();
    return { ...value };
  });
  if (new Set(workers.map(row => row.workerName)).size !== 4) refuse();
  if (gateways !== undefined && (!Array.isArray(gateways) || gateways.length !== 2)) refuse();
  const gatewayPackets = (gateways ?? []).map((raw, index) => {
    const value = parsePrivateBridgePacket(raw);
    if (value.role !== ['old-reader', 'new-reader'][index] || value.enabled !== true || !same(value.pairs, pairs) ||
        value.credentialIdentity.projectId !== 'njpbs-site-dev' || value.accessPacket.environment !== 'development' ||
        value.accessPacket.accountId !== plans[0].accountId) refuse();
    return value;
  });
  if (gatewayPackets.length && (gatewayPackets[0].workerName === gatewayPackets[1].workerName ||
      !same(gatewayPackets[0].accessPacket, gatewayPackets[1].accessPacket))) refuse();
  const context = { firestore, packet: protocol.freeze(structuredClone(packet)), sourceSha, pairs, plans, workers, gatewayPackets };
  environment(context);
  return context;
}

function recordPaths(context) {
  const paths = context.plans.flatMap(plan => {
    const pair = work.publicReleasePairPath(plan.pairTemplate.pairId), upload = rollout.publicReleasePairUploadPath(plan.pairTemplate.pairId);
    return [pair, `${pair}/controls/runtime`, upload, ...publisherActions.map(action => `${upload}/operations/${action}`),
      ...plan.schemaVersion === 3 ? [rollout.publicReleasePairUploadCompletionPath(plan.pairTemplate.pairId)] : []];
  });
  for (const target of context.workers) {
    const base = 'system/publicReleasePrivateInstalls', key = protocol.publicReleaseDigest({ worker: target.workerName });
    paths.push(`${base}/plans/${target.attemptId}`, `${base}/workers/${key}`,
      ...privateActions.flatMap(action => [`${base}/attempts/${target.attemptId}/steps/${key}-${action}`,
        `${base}/attempts/${target.attemptId}/readbacks/${key}-${action}`]));
  }
  for (const { seal, actions } of gatewayOwners(context)) {
    const base = 'system/publicReleasePrivateInstalls', key = protocol.publicReleaseDigest({ worker: seal.worker });
    paths.push(`${base}/plans/${seal.attemptId}`, `${base}/workers/${key}`,
      ...actions.flatMap(action => [`${base}/attempts/${seal.attemptId}/steps/${key}-${action}`,
        `${base}/attempts/${seal.attemptId}/readbacks/${key}-${action}`]));
  }
  return [...new Set(paths)].sort();
}

// These are the actual owners' original ledger identities, not a new gateway
// installer. Native readback:true additionally verifies live provider/Access.
function gatewayOwners(context) {
  const owners = context.gatewayPackets.map(packet => {
    const { config } = privateBridgeConfiguration(packet), portable = { ...config }; delete portable.main;
    return { seal: { schemaVersion: 1, attemptId: packet.operationId, worker: packet.workerName,
      planDigest: protocol.publicReleaseDigest({ config: portable, sourceDigest: packet.sourceDigest }) },
    attemptDigest: protocol.publicReleaseDigest(packet), actions: [...privateActions, 'domain'] };
  });
  if (context.gatewayPackets.length) {
    const packet = context.gatewayPackets[0].accessPacket;
    for (const target of packet.targets) owners.push({ seal: { schemaVersion: 1, attemptId: packet.operationId,
      worker: `access:${new URL(target.origin).hostname}`, planDigest: protocol.publicReleaseDigest({ packet, target }) },
    attemptDigest: protocol.publicReleaseDigest(packet), actions: ['access-app', 'access-policy'] });
  }
  return owners;
}

async function observe(context, transaction) {
  environment(context);
  const rows = await transaction.getAll(...context.paths.map(path => context.firestore.doc(path)));
  if (rows.some(row => !row.exists)) refuse();
  const byPath = new Map(rows.map(row => [row.ref.path, row]));
  for (const { seal, attemptDigest, actions } of gatewayOwners(context)) {
    const base = 'system/publicReleasePrivateInstalls', key = protocol.publicReleaseDigest({ worker: seal.worker });
    if (!same(byPath.get(`${base}/plans/${seal.attemptId}`).data(), { schemaVersion: 1, attemptId: seal.attemptId, planDigest: attemptDigest }) ||
        !same(byPath.get(`${base}/workers/${key}`).data(), seal)) refuse();
    for (const action of actions) {
      const claim = byPath.get(`${base}/attempts/${seal.attemptId}/steps/${key}-${action}`);
      const receipt = byPath.get(`${base}/attempts/${seal.attemptId}/readbacks/${key}-${action}`);
      protocol.exact(receipt.data(), [...Object.keys(seal), 'action', 'result']);
      if (!same(claim.data(), { ...seal, action }) ||
          !same(receipt.data(), { ...seal, action, result: receipt.data().result }) || !receipt.createTime.isEqual(receipt.updateTime)) refuse();
    }
  }
  for (const [index, plan] of context.plans.entries()) {
    const pair = context.pairs[index], base = work.publicReleasePairPath(pair.pairId), upload = rollout.publicReleasePairUploadPath(pair.pairId);
    const lifecycle = byPath.get(`${base}/controls/runtime`).data();
    protocol.exact(lifecycle, ['schemaVersion', 'pairId', 'status']);
    if (!same(byPath.get(base).data(), pair) || lifecycle.schemaVersion !== 2 || lifecycle.pairId !== pair.pairId ||
        !['candidate', 'retained'].includes(lifecycle.status)) refuse();
    const installed = byPath.get(upload).data(), planDigest = protocol.publicReleaseDigest(plan);
    protocol.exact(installed, ['schemaVersion', 'pairId', 'planDigest', 'state', 'workerVersionId', 'readbackDigest']);
    if (installed.schemaVersion !== 2 || installed.pairId !== pair.pairId || installed.planDigest !== planDigest ||
        installed.state !== 'uploaded' || installed.workerVersionId !== pair.publisher.workerVersionId || !protocol.digest(installed.readbackDigest)) refuse();
    if (plan.schemaVersion === 3) {
      const completion = assertInstalledPublisherCompletion(plan, pair, byPath.get(rollout.publicReleasePairUploadCompletionPath(pair.pairId)));
      for (const [member, target] of [[completion.installation.slot, context.workers[index]],
        [completion.installation.ingress, context.workers[2]]]) {
        if (completion.installation.operationId !== target.attemptId || completion.installation.installPlanDigest !== target.attemptPlanDigest ||
            member.name !== target.workerName || member.planDigest !== target.workerPlanDigest || member.versionId !== target.versionId) refuse();
        const base = 'system/publicReleasePrivateInstalls', key = protocol.publicReleaseDigest({ worker: target.workerName });
        const create = byPath.get(`${base}/attempts/${target.attemptId}/readbacks/${key}-create`).data().result;
        const deploy = byPath.get(`${base}/attempts/${target.attemptId}/readbacks/${key}-deploy`).data().result;
        if (member.workerId !== create.workerId || member.tag !== create.tag || member.deploymentId !== deploy.deploymentId) refuse();
      }
    }
    for (const operation of publisherActions) {
      const receipt = byPath.get(`${upload}/operations/${operation}`).data();
      protocol.exact(receipt, ['schemaVersion', 'pairId', 'planDigest', 'operation', 'requestDigest', 'state', 'readbackDigest']);
      if (receipt.schemaVersion !== 2 || receipt.pairId !== pair.pairId || receipt.planDigest !== planDigest || receipt.operation !== operation ||
          receipt.state !== 'verified' || ![receipt.requestDigest, receipt.readbackDigest].every(protocol.digest)) refuse();
    }
  }
  for (const target of context.workers) {
    const base = 'system/publicReleasePrivateInstalls', key = protocol.publicReleaseDigest({ worker: target.workerName });
    const seal = { schemaVersion: 1, attemptId: target.attemptId, worker: target.workerName, planDigest: target.workerPlanDigest };
    if (!same(byPath.get(`${base}/plans/${target.attemptId}`).data(), { schemaVersion: 1, attemptId: target.attemptId, planDigest: target.attemptPlanDigest }) ||
        !same(byPath.get(`${base}/workers/${key}`).data(), seal)) refuse();
    for (const action of privateActions) {
      const claim = byPath.get(`${base}/attempts/${target.attemptId}/steps/${key}-${action}`), receipt = byPath.get(`${base}/attempts/${target.attemptId}/readbacks/${key}-${action}`);
      const data = receipt.data(); protocol.exact(data, [...Object.keys(seal), 'action', 'result']);
      if (!same(claim.data(), { ...seal, action }) || !same(data, { ...seal, action, result: data.result }) ||
          !receipt.createTime.isEqual(receipt.updateTime)) refuse();
      if (['upload', 'deploy'].includes(action) && data.result?.versionId !== target.versionId) refuse();
    }
  }
  // Retention legitimately advances at the native switch. Validate it fresh,
  // but freeze only original install facts, not this mutable workflow state.
  return rows.filter(row => !row.ref.path.endsWith('/controls/runtime'))
    .map(row => ({ path: row.ref.path, digest: protocol.publicReleaseDigest(row.data()), version: version(row) }));
}

/** Native SDK snapshot only: provider bytes/privacy must additionally pass
 * the existing installed-target readers. This grants no runtime readiness.
 * The complete fixed roster includes both publishers and all four workers.
 */
export async function captureRehearsalInstalledCensus(options) {
  const context = inputs(options); context.paths = recordPaths(context);
  const records = await context.firestore.runTransaction(transaction => observe(context, transaction), { readOnly: true });
  const value = protocol.freeze({ schemaVersion: 1, kind: 'preinstalled-rehearsal-census', projectId: context.packet.projectId,
    runId: context.packet.runId, sourceSha: context.sourceSha, providerAttempts: 0,
    pairDigests: context.pairs.map(protocol.publicReleaseDigest), plans: context.plans.map(protocol.publicReleaseDigest),
    workers: context.workers, ...(context.gatewayPackets.length ? { gateways: context.gatewayPackets.map(protocol.publicReleaseDigest) } : {}), records });
  const handle = Object.freeze({ receiptDigest: protocol.publicReleaseDigest(value) });
  captures.set(handle, { ...context, value }); return handle;
}

async function current(handle, transaction, expectedDigest, bind) {
  const context = captures.get(handle);
  if (!context || expectedDigest !== handle.receiptDigest) refuse();
  const ref = context.firestore.doc(`publicReleaseRehearsalInstalls/${context.packet.runId}`);
  const row = await transaction.get(ref), records = await observe(context, transaction);
  if (!same(records, context.value.records)) refuse();
  const receipt = { ...context.value, censusDigest: handle.receiptDigest };
  if (row.exists) {
    if (!row.createTime.isEqual(row.updateTime) || !same(row.data(), receipt)) refuse();
  } else if (bind) transaction.create(ref, receipt);
  else refuse();
  return Object.freeze({ receiptDigest: handle.receiptDigest, providerAttempts: 0 });
}

export async function bindRehearsalInstalledCensus(handle, expectedDigest) {
  const context = captures.get(handle); if (!context) refuse();
  return context.firestore.runTransaction(transaction => current(handle, transaction, expectedDigest, true));
}
export async function readRehearsalInstalledCensus(handle, expectedDigest) {
  const context = captures.get(handle); if (!context) refuse();
  return context.firestore.runTransaction(transaction => current(handle, transaction, expectedDigest, false), { readOnly: true });
}
