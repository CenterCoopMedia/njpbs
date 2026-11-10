import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { DEV_TARGETS } from '../assert-dev-cms-targets.mjs';
import { functionsInventoryIdentity } from './cms-component-receipt.mjs';
import { listPages } from '../deploy-cms-function-batches.mjs';
import { pairedAdminArtifactContents } from './paired-admin-pages-artifact.mjs';
import { ADMIN_PROVIDER_OPERATIONS, createPairedAdminOperationJournal, refuseAdminProvider, isAdminProviderId } from './paired-admin-provider-operation.mjs';

const api = createRequire(import.meta.url)('../../functions/lib/cms-preview-pair.js');
const HEX = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const token = value => typeof value === 'string' && /^[\x21-\x7e]{1,32768}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = request => `njpbs-paired-admin:${request.operationId}:${request.operationDigest}:${request.manifestDigest}`;

async function boundaryValue(read, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }),
      new Promise((_, reject) => { abort = () => reject(new Error('Boundary aborted')); signal.addEventListener('abort', abort, { once: true }); })]);
  } catch { refuseAdminProvider('credential-unavailable'); }
  finally { signal.removeEventListener('abort', abort); }
}

async function bounded(response, limit) {
  if (!response?.body) refuseAdminProvider('http-body-unavailable');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > limit) refuseAdminProvider('http-body-too-large');
      parts.push(part.value);
    }
    return Buffer.concat(parts, size);
  } finally { await reader.cancel(); }
}

/** Native HTTPS only. In particular, the deployment POST has no retry loop.
 * The pinned Wrangler deployment helper retries it and is not used here. */
export function createPairedAdminPagesHttp({ target, prepared, readCloudflareToken, readGoogleToken, readAccessHeaders,
  fetchImpl = fetch, authorized = false, signal }) {
  const development = target?.environment === 'development';
  const names = development ? { projectId: DEV_TARGETS.FIREBASE_PROJECT_ID, pagesProject: DEV_TARGETS.CMS_ADMIN_PAGES,
    origin: DEV_TARGETS.CMS_ADMIN_ORIGIN, cmsApi: DEV_TARGETS.CMS_API_WORKER }
    : { projectId: 'njpbs-site', pagesProject: 'njpbs-admin', origin: 'https://admin.njpbs.org', cmsApi: 'njpbs-cms-api' };
  if (!target || Object.keys(target).sort().join(',') !== 'accountId,branch,configurationDigest,environment,pagesProjectId,projectId' ||
      authorized !== true || !['development', 'production'].includes(target?.environment) ||
      typeof target.accountId !== 'string' || !/^[a-f0-9]{32}$/.test(target.accountId) || development && target.accountId !== DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID ||
      !isAdminProviderId(target.pagesProjectId) || target.branch !== 'main' || typeof target.configurationDigest !== 'string' || !HEX.test(target.configurationDigest) ||
      target.projectId !== names.projectId || prepared.environment !== target.environment ||
      [readCloudflareToken, readGoogleToken, readAccessHeaders, fetchImpl].some(fn => typeof fn !== 'function')) refuseAdminProvider('provider-target-invalid');
  pairedAdminArtifactContents(prepared);
  target = Object.freeze({ ...names, ...target });
  const targetDigest = api.digest(target);
  const base = `/accounts/${target.accountId}/pages/projects/${names.pagesProject}`;
  const requestSignal = other => AbortSignal.any([...(signal ? [signal] : []), ...(other ? [other] : []), AbortSignal.timeout(30_000)]);
  async function json(url, { method = 'GET', body, authorization, requestHeaders = {}, requestSignal: other, onDispatch } = {}) {
    try {
      const deadline = requestSignal(other);
      const credential = authorization ?? await boundaryValue(readCloudflareToken, deadline);
      if (!token(credential)) refuseAdminProvider('credential-unavailable');
      deadline.throwIfAborted();
      onDispatch?.();
      const response = await fetchImpl(url, { method, body, headers: { ...requestHeaders, authorization: `Bearer ${credential}` },
        redirect: 'error', cache: 'no-store', signal: deadline });
      if (!response.ok) { await response.body?.cancel(); refuseAdminProvider('provider-http-refused'); }
      const value = JSON.parse((await bounded(response, 8 * 1024 * 1024)).toString('utf8'));
      if (value.success === false || Array.isArray(value.errors) && value.errors.length) refuseAdminProvider('provider-http-refused');
      return value;
    } catch { refuseAdminProvider('provider-http-unavailable'); }
  }
  const pages = (path = '', options) => json(`https://api.cloudflare.com/client/v4${base}${path}`, options);
  function project(value) {
    if (value?.id !== target.pagesProjectId || value.name !== names.pagesProject || value.production_branch !== target.branch ||
        api.digest({ id: value.id, name: value.name, production_branch: value.production_branch,
          production: value.deployment_configs?.production ?? null }) !== target.configurationDigest ||
        !isAdminProviderId(value.canonical_deployment?.id)) refuseAdminProvider('provider-project-changed');
    return value.canonical_deployment.id;
  }
  function deploymentIdentity(value, expectedMarker = null) {
    const metadata = value?.deployment_trigger?.metadata;
    if (!isAdminProviderId(value?.id) || value.project_id !== target.pagesProjectId || value.project_name !== names.pagesProject ||
        value.environment !== 'production' || metadata?.branch !== target.branch || !SHA.test(metadata?.commit_hash) ||
        value.is_skipped === true ||
        expectedMarker !== null && (metadata.commit_message !== expectedMarker || metadata.commit_hash !== prepared.sourceSha)) {
      refuseAdminProvider('deployment-unproven');
    }
    return { deploymentId: value.id, sourceSha: metadata.commit_hash, message: metadata.commit_message ?? null };
  }
  function deployment(value, expectedMarker = null) {
    const row = deploymentIdentity(value, expectedMarker);
    if (value.latest_stage?.name !== 'deploy' || value.latest_stage.status !== 'success') refuseAdminProvider('deployment-unproven');
    return row;
  }
  const receipt = (row, artifact) => api.digest({ schemaVersion: 2, targetDigest,
    deploymentId: row.deploymentId, sourceSha: row.sourceSha, manifestDigest: artifact.manifestDigest });
  async function readInventory() {
    const rows = [], seen = new Set();
    let totalPages = null, totalCount = null;
    for (let page = 1; page <= 100; page++) {
      const body = await pages(`/deployments?env=production&page=${page}&per_page=100`), info = body.result_info;
      if (!Array.isArray(body.result) || !info || info.page !== page || info.per_page !== 100 ||
          !Number.isSafeInteger(info.total_pages) || info.total_pages < 1 || info.total_pages > 100 ||
          totalPages !== null && totalPages !== info.total_pages || body.result.length > 100 ||
          page < info.total_pages && body.result.length !== 100 ||
          info.count !== undefined && info.count !== body.result.length ||
          info.total_count !== undefined && (!Number.isSafeInteger(info.total_count) || info.total_count < 0 || info.total_count > 10000 ||
            totalCount !== null && totalCount !== info.total_count) ||
          body.result.some(row => !isAdminProviderId(row?.id) || seen.has(row.id))) refuseAdminProvider('deployment-inventory-incomplete');
      totalPages = info.total_pages;
      totalCount ??= info.total_count ?? null;
      for (const row of body.result) { seen.add(row.id); rows.push(row); }
      if (page === totalPages) {
        if (totalCount !== null && totalCount !== rows.length) refuseAdminProvider('deployment-inventory-incomplete');
        return rows;
      }
    }
    refuseAdminProvider('deployment-inventory-incomplete');
  }
  return Object.freeze({
    target, targetDigest,
    async activeId() { return project((await pages()).result); },
    async verifyDeployment(id, request = null, artifact = prepared) {
      if (!isAdminProviderId(id)) refuseAdminProvider('deployment-invalid');
      const row = deployment((await pages(`/deployments/${encodeURIComponent(id)}`)).result, request ? marker(request) : null);
      if (row.deploymentId !== id || row.sourceSha !== artifact.sourceSha) refuseAdminProvider('deployment-unproven');
      return { deploymentId: row.deploymentId, providerReceiptDigest: receipt(row, artifact) };
    },
    async waitForDeployment(id, request, other) {
      if (!isAdminProviderId(id)) refuseAdminProvider('deployment-invalid');
      const deadline = requestSignal(other);
      try {
        for (;;) {
          deadline.throwIfAborted();
          const value = (await pages(`/deployments/${encodeURIComponent(id)}`, { requestSignal: deadline })).result;
          deadline.throwIfAborted();
          const row = deploymentIdentity(value, marker(request)), stage = value.latest_stage;
          if (row.deploymentId !== id || !['queued', 'initialize', 'clone_repo', 'build', 'deploy'].includes(stage?.name) ||
              !['success', 'idle', 'active', 'failure', 'canceled', 'skipped'].includes(stage?.status)) refuseAdminProvider('deployment-unproven');
          if (stage.name === 'deploy' && stage.status === 'success') {
            return { outcome: 'uploaded', proof: { deploymentId: id, providerReceiptDigest: receipt(row, prepared) } };
          }
          if (stage.status === 'failure' && typeof stage.ended_on === 'string' && Number.isFinite(Date.parse(stage.ended_on))) {
            return { outcome: 'failed', proof: { deploymentId: id, providerReceiptDigest: api.digest({ targetDigest,
              deploymentId: id, sourceSha: row.sourceSha, manifestDigest: prepared.manifestDigest,
              stage: { name: stage.name, status: stage.status, endedOn: stage.ended_on } }) } };
          }
          await wait(1_000, undefined, { signal: deadline });
        }
      } catch { refuseAdminProvider('deployment-wait-uncertain'); }
    },
    async findDeployment(request) {
      const rows = await readInventory();
      const stable = value => api.digest(value.map(row => [row.id, row.deployment_trigger?.metadata,
        row.latest_stage?.name, row.latest_stage?.status, row.project_id, row.project_name, row.environment]));
      if (stable(rows) !== stable(await readInventory())) refuseAdminProvider('deployment-inventory-changed');
      const matching = rows.filter(row => row.deployment_trigger?.metadata?.commit_message === marker(request));
      if (matching.length !== 1) refuseAdminProvider(matching.length ? 'deployment-ambiguous' : 'deployment-uncertain');
      const row = deploymentIdentity(matching[0], marker(request));
      return this.waitForDeployment(row.deploymentId, request);
    },
    async uploadAssets(other) {
      const { jwt } = (await pages('/upload-token', { requestSignal: other })).result ?? {};
      if (!token(jwt)) refuseAdminProvider('asset-credential-unavailable');
      const { files } = pairedAdminArtifactContents(prepared);
      // The upload is content addressed. Only createDeployment selects Pages.
      for (const file of files) {
        await json('https://api.cloudflare.com/client/v4/pages/assets/upload', { method: 'POST', authorization: jwt,
          requestHeaders: { 'content-type': 'application/json' }, requestSignal: other,
          body: JSON.stringify([{ key: file.hash, value: file.bytes.toString('base64'),
            metadata: { contentType: file.contentType }, base64: true }]) });
      }
      await json('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', { method: 'POST', authorization: jwt,
        requestHeaders: { 'content-type': 'application/json' }, requestSignal: other,
        body: JSON.stringify({ hashes: files.map(file => file.hash) }) });
    },
    async createDeployment(request, other, onDispatch) {
      let dispatched = false;
      try {
        const { files, special, workerBundle } = pairedAdminArtifactContents(prepared);
        const body = new FormData();
        body.set('manifest', JSON.stringify(Object.fromEntries(files.map(file => [file.path, file.hash]))));
        body.set('branch', target.branch); body.set('commit_hash', prepared.sourceSha); body.set('commit_dirty', 'false');
        body.set('commit_message', marker(request));
        for (const [name, bytes] of special) body.set(name, new Blob([bytes]), name);
        if (workerBundle) body.set('_worker.bundle', new Blob([workerBundle], { type: prepared.workerBundleContentType }), '_worker.bundle');
        const result = (await pages('/deployments', { method: 'POST', body, requestSignal: other,
          onDispatch: () => { onDispatch?.(); dispatched = true; } })).result;
        if (!isAdminProviderId(result?.id)) refuseAdminProvider('deployment-uncertain');
        return result.id;
      } catch { refuseAdminProvider(dispatched ? 'deployment-uncertain' : 'deployment-not-sent'); }
    },
    async verifyActiveBytes(artifact, expectedId) {
      if (await this.activeId() !== expectedId) refuseAdminProvider('active-deployment-changed');
      for (const file of pairedAdminArtifactContents(artifact).files) {
        try {
          const path = file.path === '/404.html' ? `/_paired-admin-absent-${artifact.manifestDigest}/`
            : file.path.endsWith('/index.html') ? file.path.slice(0, -10)
              : file.path.endsWith('.html') ? file.path.slice(0, -5) : file.path;
          const deadline = requestSignal();
          const headers = new Headers(await boundaryValue(readAccessHeaders, deadline));
          headers.set('accept-encoding', 'identity');
          const response = await fetchImpl(`${names.origin}${path}`, { headers, cache: 'no-store',
            redirect: 'error', signal: deadline });
          const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          const javascript = ['text/javascript', 'application/javascript'];
          if (response.status !== (file.path === '/404.html' ? 404 : 200) || contentType !== file.contentType &&
              !(javascript.includes(contentType) && javascript.includes(file.contentType))) {
            await response.body?.cancel(); refuseAdminProvider('active-bytes-unavailable');
          }
          const bytes = await bounded(response, file.size + 1);
          if (bytes.length !== file.size || digest(bytes) !== file.sha256) refuseAdminProvider('active-bytes-mismatch');
        } catch { refuseAdminProvider('active-bytes-unavailable'); }
      }
      if (await this.activeId() !== expectedId) refuseAdminProvider('active-deployment-changed');
    },
    async readLiveReaderIdentities() {
      const googleToken = await boundaryValue(readGoogleToken, requestSignal());
      if (!token(googleToken)) refuseAdminProvider('credential-unavailable');
      const url = `https://cloudfunctions.googleapis.com/v2/projects/${names.projectId}/locations/us-central1/functions`;
      let pagesRead = 0, functionCount = 0;
      const functions = await listPages(async (next, pageToken) => {
        if (++pagesRead > 20 || pageToken && (typeof pageToken !== 'string' || pageToken.length > 2048)) refuseAdminProvider('reader-inventory-invalid');
        const body = await json(`${next}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { authorization: googleToken });
        if (!Array.isArray(body.functions) || (functionCount += body.functions.length) > 1000) refuseAdminProvider('reader-inventory-invalid');
        return body;
      }, url, 'functions');
      if (functions.length > 1000 || functions.some(fn => typeof fn?.name !== 'string' ||
          !fn.name.startsWith(`projects/${names.projectId}/locations/us-central1/functions/`))) refuseAdminProvider('reader-inventory-invalid');
      const value = (await json(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${names.cmsApi}/deployments`)).result;
      const rows = value?.deployments ?? value;
      if (!Array.isArray(rows) || !isAdminProviderId(rows[0]?.id)) refuseAdminProvider('reader-inventory-invalid');
      const versions = rows[0].versions;
      if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100 ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(versions[0].version_id ?? '')) {
        refuseAdminProvider('reader-inventory-invalid');
      }
      return { functions: functionsInventoryIdentity(functions), cmsApi: { script: names.cmsApi,
        deploymentId: rows[0].id, versionId: versions[0].version_id } };
    },
  });
}

/** Concrete adapter for publishPairedAdminManifest. Its existing owner is the
 * only source of upload permission and remains the only Admin readiness writer. */
export function createPairedAdminPagesProvider({ firestore, baseline, ...options }) {
  const http = createPairedAdminPagesHttp(options), { prepared } = options;
  const demo = http.target.environment === 'development' && /^demo-[a-z0-9-]+$/.test(firestore?.projectId ?? '') &&
    options.allowLocalEmulator === true && options.fetchImpl !== undefined && options.fetchImpl !== fetch &&
    /^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');
  if (process.env.FIRESTORE_EMULATOR_HOST !== undefined && !demo || firestore?.projectId !== http.target.projectId && !demo ||
      !isAdminProviderId(baseline?.deploymentId) ||
      baseline.artifact?.environment !== http.target.environment) refuseAdminProvider('provider-database-invalid');
  pairedAdminArtifactContents(baseline.artifact);
  const journal = createPairedAdminOperationJournal({ firestore, targetDigest: http.targetDigest, artifactDigest: prepared.artifactDigest });
  return Object.freeze({
    async readLiveReaderIdentities() { return http.readLiveReaderIdentities(); },
    async readActiveManifest() {
      const id = await http.activeId();
      if (id === baseline.deploymentId) {
        const proof = await http.verifyDeployment(id, null, baseline.artifact);
        await http.verifyActiveBytes(baseline.artifact, id);
        return { manifestDigest: baseline.artifact.manifestDigest, ...proof };
      }
      const rows = await firestore.collection(ADMIN_PROVIDER_OPERATIONS).where('deploymentId', '==', id).limit(2).get();
      if (rows.size !== 1) refuseAdminProvider('active-operation-unproven');
      const row = rows.docs[0].data();
      if (row.state !== 'uploaded' || row.binding?.targetDigest !== http.targetDigest || row.binding?.artifactDigest !== prepared.artifactDigest ||
          row.binding.request.manifestDigest !== prepared.manifestDigest) refuseAdminProvider('active-operation-unproven');
      const proof = await http.verifyDeployment(id, row.binding.request);
      if (proof.providerReceiptDigest !== row.providerReceiptDigest) refuseAdminProvider('active-operation-unproven');
      await http.verifyActiveBytes(prepared, id);
      return { ...proof, operationId: row.binding.request.operationId, operationDigest: row.binding.request.operationDigest,
        manifestDigest: prepared.manifestDigest, providerSettled: true };
    },
    async publish(request) {
      if (request.manifestDigest !== prepared.manifestDigest) refuseAdminProvider('artifact-operation-mismatch');
      request.signal?.throwIfAborted();
      const reservation = await journal.reserve(request);
      if (reservation.state !== 'reserved') refuseAdminProvider('operation-reconcile-required');
      await http.activeId();
      await http.uploadAssets(request.signal);
      request.signal?.throwIfAborted();
      const current = await this.readActiveManifest();
      if (current.providerReceiptDigest !== reservation.request.expectedProviderReceiptDigest) refuseAdminProvider('active-deployment-changed');
      const permission = await journal.issue(request);
      let id;
      try { id = await http.createDeployment(permission, request.signal, () => journal.dispatched(permission)); }
      catch (error) {
        if (error?.code === 'deployment-not-sent') await journal.fenceUnsent(permission);
        throw error;
      }
      await journal.assigned(request, id);
      const terminal = await http.waitForDeployment(id, permission, request.signal);
      await journal.terminal(request, terminal.outcome, terminal.proof);
      if (terminal.outcome === 'failed') refuseAdminProvider('deployment-failed');
    },
    async reconcileOperation(request) {
      const observed = await journal.reconcile(request);
      if (observed.providerSettled) return observed;
      const terminal = observed.deploymentId ? await http.waitForDeployment(observed.deploymentId, request) : await http.findDeployment(request);
      return journal.terminal(request, terminal.outcome, terminal.proof);
    },
  });
}
