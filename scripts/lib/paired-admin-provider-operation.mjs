import { createRequire } from 'node:module';

const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');
export const ADMIN_PROVIDER_OPERATIONS = 'cmsAdminProviderOperations';
const HEX = /^[a-f0-9]{64}$/;
const ID = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isAdminProviderId = value => typeof value === 'string' && PROVIDER_ID.test(value);
const isDigest = value => typeof value === 'string' && HEX.test(value);
export class PairedAdminProviderError extends Error {
  constructor(code) { super('Paired Admin provider refused'); this.code = code; }
}
export function refuseAdminProvider(code) { throw new PairedAdminProviderError(code); }
const same = (a, b) => api.digest(a) === api.digest(b);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuseAdminProvider('operation-invalid');
}
function identity(value) {
  if (typeof value?.operationId !== 'string' || !ID.test(value.operationId) || !isDigest(value.operationDigest) || !isDigest(value.manifestDigest)) refuseAdminProvider('operation-invalid');
  return { operationId: value.operationId, operationDigest: value.operationDigest, manifestDigest: value.manifestDigest };
}

/** This grant belongs to the existing Admin owner. A provider call cannot
 * bypass its selected-preview, compatible-reader or global writer checks. */
async function ownerPermission(firestore, tx, input) {
  const request = identity(input);
  const [ownerRow, lockRow] = await tx.getAll(firestore.doc(`cmsAdminManifestAttempts/${request.operationId}`),
    firestore.doc('cmsAdminManifestState/writer'));
  const owner = ownerRow.data(), lock = lockRow.data();
  exact(owner?.request, ['operationId', 'manifestDigest', 'expectedProviderReceiptDigest']);
  exact(owner?.evidence, ['previewSelectorDigest', 'readerDigests']);
  exact(owner.evidence.readerDigests, ['functions', 'cmsApi']);
  if (owner.schemaVersion !== 2 || !['reserved', 'uncertain'].includes(owner.state) ||
      owner.request.operationId !== request.operationId || owner.request.manifestDigest !== request.manifestDigest ||
      owner.operationDigest !== request.operationDigest || !isDigest(owner.previousAdminDigest) ||
      !isDigest(owner.evidence.previewSelectorDigest) || Object.values(owner.evidence.readerDigests).some(d => !isDigest(d)) ||
      owner.request.expectedProviderReceiptDigest !== null && !isDigest(owner.request.expectedProviderReceiptDigest) ||
      api.digest({ request: owner.request, evidence: owner.evidence, previousAdminDigest: owner.previousAdminDigest }) !== request.operationDigest ||
      lock?.schemaVersion !== 2 || lock.state !== 'reserved' || lock.operationId !== request.operationId ||
      lock.requestDigest !== api.digest(owner.request)) refuseAdminProvider('owner-permission-unavailable');
  return { ...request, expectedProviderReceiptDigest: owner.request.expectedProviderReceiptDigest,
    previewSelectorDigest: owner.evidence.previewSelectorDigest, readerDigests: owner.evidence.readerDigests };
}

function parseOperation(value, binding) {
  exact(value, ['schemaVersion', 'binding', 'state', 'deploymentId', 'providerReceiptDigest']);
  if (value.schemaVersion !== 2 || !same(value.binding, binding) ||
      !['reserved', 'issued', 'fenced', 'uploaded', 'failed'].includes(value.state) ||
      (['uploaded', 'failed'].includes(value.state) ? !isAdminProviderId(value.deploymentId) || !isDigest(value.providerReceiptDigest)
        : value.providerReceiptDigest !== null || (value.state === 'issued'
          ? value.deploymentId !== null && !isAdminProviderId(value.deploymentId) : value.deploymentId !== null))) refuseAdminProvider('operation-conflict');
  return value;
}

/** Only the provider attempt is persisted here. No method writes selection,
 * last-complete Admin, source receipts, or another operation's permission. */
export function createPairedAdminOperationJournal({ firestore, targetDigest, artifactDigest }) {
  if (!firestore || !isDigest(targetDigest) || !isDigest(artifactDigest)) refuseAdminProvider('operation-target-invalid');
  const unsent = new WeakSet();
  const refFor = request => firestore.doc(`${ADMIN_PROVIDER_OPERATIONS}/${identity(request).operationId}`);
  async function bound(tx, input) {
    const request = await ownerPermission(firestore, tx, input);
    const binding = { request, targetDigest, artifactDigest };
    const ref = refFor(request), row = await tx.get(ref);
    return { ref, binding, value: row.exists ? parseOperation(row.data(), binding) : null };
  }
  const record = (binding, state) => ({ schemaVersion: 2, binding, state, deploymentId: null, providerReceiptDigest: null });
  return Object.freeze({
    async reserve(input) {
      return firestore.runTransaction(async tx => {
        const { ref, binding, value } = await bound(tx, input);
        if (value) return { state: value.state, request: binding.request };
        tx.create(ref, record(binding, 'reserved'));
        return { state: 'reserved', request: binding.request };
      });
    },
    async issue(input) {
      const request = await firestore.runTransaction(async tx => {
        const { ref, binding, value } = await bound(tx, input);
        if (!value || value.state !== 'reserved') refuseAdminProvider('operation-already-issued-or-fenced');
        tx.set(ref, record(binding, 'issued'));
        return binding.request;
      });
      const grant = Object.freeze({ ...request });
      unsent.add(grant);
      return grant;
    },
    dispatched(grant) {
      if (!unsent.delete(grant)) refuseAdminProvider('operation-send-grant-unavailable');
    },
    async fenceUnsent(grant) {
      if (!unsent.delete(grant)) refuseAdminProvider('operation-send-grant-unavailable');
      const result = await firestore.runTransaction(async tx => {
        const { ref, binding, value } = await bound(tx, grant);
        if (!value || !['issued', 'fenced'].includes(value.state) || value.deploymentId !== null) refuseAdminProvider('operation-not-unsent');
        tx.set(ref, record(binding, 'fenced'));
        return { outcome: 'not_written', ...identity(grant), providerSettled: true };
      });
      return result;
    },
    async reconcile(input) {
      return firestore.runTransaction(async tx => {
        const { ref, binding, value } = await bound(tx, input);
        if (!value || value.state === 'reserved') {
          const fenced = record(binding, 'fenced');
          if (value) tx.set(ref, fenced); else tx.create(ref, fenced);
          return { outcome: 'not_written', ...identity(input), providerSettled: true };
        }
        if (value.state === 'fenced') return { outcome: 'not_written', ...identity(input), providerSettled: true };
        if (['uploaded', 'failed'].includes(value.state)) return { outcome: value.state, ...identity(input),
          providerSettled: true, deploymentId: value.deploymentId, providerReceiptDigest: value.providerReceiptDigest };
        return { outcome: 'uncertain', ...identity(input), providerSettled: false, deploymentId: value.deploymentId };
      });
    },
    async assigned(input, deploymentId) {
      if (!isAdminProviderId(deploymentId)) refuseAdminProvider('deployment-proof-invalid');
      return firestore.runTransaction(async tx => {
        const { ref, value } = await bound(tx, input);
        if (!value || value.state !== 'issued' || value.deploymentId !== null && value.deploymentId !== deploymentId) {
          refuseAdminProvider('operation-conflict');
        }
        tx.set(ref, { ...value, deploymentId });
      });
    },
    async terminal(input, outcome, proof) {
      exact(proof, ['deploymentId', 'providerReceiptDigest']);
      if (!['uploaded', 'failed'].includes(outcome) || !isAdminProviderId(proof.deploymentId) || !isDigest(proof.providerReceiptDigest)) refuseAdminProvider('deployment-proof-invalid');
      return firestore.runTransaction(async tx => {
        const { ref, binding, value } = await bound(tx, input);
        if (!value || !['issued', outcome].includes(value.state)) refuseAdminProvider('operation-not-issued');
        if (value.deploymentId !== null && value.deploymentId !== proof.deploymentId) refuseAdminProvider('operation-conflict');
        if (value.state === outcome && (value.deploymentId !== proof.deploymentId ||
            value.providerReceiptDigest !== proof.providerReceiptDigest)) refuseAdminProvider('operation-conflict');
        tx.set(ref, { ...record(binding, outcome), ...proof });
        return { outcome, ...identity(input), providerSettled: true, ...proof };
      });
    },
  });
}
