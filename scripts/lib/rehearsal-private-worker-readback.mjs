import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import { privateWorkerMetadata } from './public-release-private-provider.mjs';
import { assertRehearsalOperatorAccessCurrent } from './rehearsal-operator-access.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal private worker readback refused'); };
const actions = ['create', 'upload', 'private-subdomain', 'deploy'];

/** Read the original install ledger and provider configuration only. No
 * runtime health, content reader, wake or provider writer is invoked. */
export async function readRehearsalPrivateWorker({ firestore, provider, attemptId, attemptPlanDigest, versionId, config, source, signal, operatorAccess }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId ?? '') || !protocol.digest(attemptPlanDigest) || !(source instanceof Uint8Array) || source.length < 1 || source.length > 1024 * 1024 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(versionId ?? '')) refuse();
  const { main, ...portableConfig } = config;
  if (typeof main !== 'string') refuse();
  const sourceDigest = hash(source), planDigest = protocol.publicReleaseDigest({ config: portableConfig, sourceDigest });
  const tag = protocol.publicReleaseDigest({ attemptId, planDigest }), metadata = privateWorkerMetadata(config, tag);
  const namespace = 'system/publicReleasePrivateInstalls', workerKey = protocol.publicReleaseDigest({ worker: config.name });
  const seal = { schemaVersion: 1, attemptId, worker: config.name, planDigest };
  const paths = [`${namespace}/plans/${attemptId}`, `${namespace}/workers/${workerKey}`,
    ...actions.flatMap(action => [`${namespace}/attempts/${attemptId}/steps/${workerKey}-${action}`,
      `${namespace}/attempts/${attemptId}/readbacks/${workerKey}-${action}`])];
  const read = () => firestore.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const rows = await transaction.getAll(...paths.map(path => firestore.doc(path)));
    if (rows.some(row => !row.exists) || !same(rows[0].data(), { schemaVersion: 1, attemptId, planDigest: attemptPlanDigest }) || !same(rows[1].data(), seal)) refuse();
    const results = {};
    for (const [index, action] of actions.entries()) {
      const step = rows[index * 2 + 2], receipt = rows[index * 2 + 3];
      protocol.exact(receipt.data(), ['schemaVersion', 'attemptId', 'worker', 'planDigest', 'action', 'result']);
      if (!same(step.data(), { ...seal, action }) || !same(receipt.data(), { ...seal, action, result: receipt.data().result }) ||
          !receipt.createTime.isEqual(receipt.updateTime)) refuse();
      results[action] = receipt.data().result;
    }
    return { results, versions: rows.map(row => ({ path: row.ref.path, digest: protocol.publicReleaseDigest(row.data()),
      seconds: row.updateTime.seconds, nanoseconds: row.updateTime.nanoseconds })) };
  }, { readOnly: true });
  const before = await read();
  const privacy = () => assertRehearsalOperatorAccessCurrent(operatorAccess,
    { accountId: config.account_id, workerName: config.name, versionId }, signal);
  const beforePrivacy = operatorAccess === undefined ? null : await privacy();
  const worker = await provider.worker(config.name, signal);
  if (!worker || worker.name !== config.name || !/^[a-f0-9]{32}$/.test(worker.id ?? '') || !same(worker.tags, [`private-pair:${tag}`]) ||
      worker.subdomain?.enabled !== false || worker.subdomain?.previews_enabled !== false ||
      !same(before.results.create, { workerId: worker.id, name: config.name, tag })) refuse();
  const versions = await provider.versions(config.name, signal);
  if (versions.length !== 1 || versions[0].id !== versionId || versions[0].annotations?.['workers/message'] !== `private-pair:${tag}` ||
      !same(before.results.upload, { versionId })) refuse();
  const version = await provider.version(config.name, versionId, signal);
  if (!Array.isArray(version.resources?.bindings)) refuse();
  const bindings = version.resources.bindings.map(binding => {
    const value = { ...binding }; if (value.type === 'service' && value.environment === 'production') delete value.environment;
    return value;
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (version.id !== versionId || version.annotations?.['workers/message'] !== `private-pair:${tag}` || !same(bindings, metadata.bindings) ||
      version.resources.script_runtime?.compatibility_date !== metadata.compatibility_date ||
      !same(version.resources.script_runtime?.compatibility_flags, metadata.compatibility_flags)) refuse();
  const deployment = async () => {
    const value = await provider.deployment(config.name, signal);
    if (value?.annotations?.['workers/message'] !== `private-pair:${tag}` || value.versions?.length !== 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id ?? '') ||
        value.versions[0].version_id !== versionId || value.versions[0].percentage !== 100 ||
        !same(before.results.deploy, { deploymentId: value.id, versionId })) refuse();
    return { deploymentId: value.id, versionId };
  };
  const deployed = await deployment();
  if (operatorAccess === undefined) await provider.assertNoPublicRoutes(config.name, signal);
  const exposure = await provider.subdomain(config.name, signal);
  if (exposure?.enabled !== false || exposure?.previews_enabled !== false || !same(before.results['private-subdomain'], { private: true }) ||
      await provider.sourceDigest(config.name, signal) !== sourceDigest) refuse();
  if (!same(await deployment(), deployed) || !same(await read(), before)) refuse();
  const afterPrivacy = operatorAccess === undefined ? null : await privacy();
  if (!same(afterPrivacy, beforePrivacy)) refuse();
  signal?.throwIfAborted();
  return Object.freeze({ receiptDigest: protocol.publicReleaseDigest({ kind: 'rehearsal-installed-private-worker',
    planDigest, sourceDigest, workerId: worker.id, versionId, deployed, ledger: before,
    ...(afterPrivacy ? { operatorAccessDigest: afterPrivacy.receiptDigest } : {}) }) });
}
