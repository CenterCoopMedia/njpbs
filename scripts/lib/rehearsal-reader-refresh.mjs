import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import protocol from '../../functions/lib/public-release-pair.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import { parseRehearsalPacket, rehearsalSourceCommit } from './public-release-rehearsal.mjs';
import { assertDevelopmentRehearsalEnvironment, hasDevelopmentCredentialSource,
  writeDevelopmentCredential } from './development-rehearsal-credentials.mjs';
import { createCmsReaderReplayTransport, proveCmsReaderBridge, installCmsReaderBridge } from './cms-reader-bridge-install.mjs';
import { commitLiveReaderReceipt } from './cms-component-receipt.mjs';
import { createPairedAdminPagesHttp } from './paired-admin-pages-provider.mjs';
import { prepareRehearsalPreviewReaders } from './rehearsal-preview-readers.mjs';
import { readRehearsalBridgeState } from './rehearsal-reader-cases.mjs';
import { originalRehearsalReaderRequest } from './rehearsal-reader-refresh-intent.mjs';

const childPath = fileURLToPath(new URL('./rehearsal-reader-cases-child.mjs', import.meta.url));
const refuse = () => { throw new Error('Installed rehearsal reader refresh refused'); };

/** Real native leaf producers run after the explicit SDK app is initialized
 * in a fresh process. This avoids importing legacy Auth with an ambient app.
 * Only request templates/cases cross IPC; staff and SDK credentials stay in
 * bounded inherited/at-use channels and never enter a plan or receipt.
 */
function casesProcess({ packet, baseline, templates, developmentCredential, readStaffToken, signal }) {
  return new Promise((resolve, reject) => {
    const child = fork(childPath, [], { execArgv: [], env: { PATH: process.env.PATH, HOME: '/nonexistent',
      METADATA_SERVER_DETECTION: 'none', GCLOUD_PROJECT: packet.projectId, GOOGLE_CLOUD_PROJECT: packet.projectId,
      CMS_DEPLOYMENT_ENVIRONMENT: 'development' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe'] });
    let result, failed = false, requests = 0;
    const pending = new Set(), fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, 60_000); signal?.addEventListener('abort', fail, { once: true });
    child.on('error', fail);
    child.on('message', message => {
      if (message?.kind === 'cases') {
        if (result || Buffer.byteLength(JSON.stringify(message.result)) > 2 * 1024 * 1024) fail();
        else result = message.result;
        return;
      }
      if (message?.kind !== 'staff-token' || message.id !== ++requests || requests > 36 || pending.size) { fail(); return; }
      const request = (async () => {
        const value = await readStaffToken();
        if (typeof value !== 'string' || !value || value.length > 32768 || /[\r\n]/.test(value)) refuse();
        if (child.connected) await new Promise((accept, reject) => child.send({ id: message.id, ok: true, value },
          error => error ? reject(new Error('Reader IPC closed')) : accept()));
      })().catch(fail).finally(() => pending.delete(request));
      pending.add(request);
    });
    child.once('exit', async (code, stopped) => {
      clearTimeout(timer); signal?.removeEventListener('abort', fail); await Promise.allSettled([...pending]);
      if (failed || stopped || code !== 0 || !result) reject(new Error('Installed rehearsal reader refresh refused'));
      else resolve(result);
    });
    child.stdio[4].on('error', () => {});
    writeDevelopmentCredential(developmentCredential, child.stdio[4]).catch(fail);
    child.send({ kind: 'start-cases', packet, baseline, templates }, error => { if (error) fail(); });
  });
}

/** New explicit source proof through the existing bridge owners. Provider
 * identities/candidates stay unchanged; this never installs/deploys code.
 * A started/uncertain attempt is never replaced with a fresh operation ID.
 */
export function createRehearsalReaderRefresh({ firestore, packet: raw, baseline: inputBaseline, templates: inputTemplates,
  targets, candidates, admin, developmentCredential, readStaffToken, readEdgeSecret,
  sourceSha, signal, authorized = false }) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || packet.schemaVersion !== 2 || packet.setupMode !== 'preinstalled' ||
      firestore?.projectId !== 'njpbs-site-dev' || admin?.target?.environment !== 'development' || admin.target.projectId !== packet.projectId ||
      !hasDevelopmentCredentialSource(developmentCredential) || typeof readStaffToken !== 'function' || typeof readEdgeSecret !== 'function') refuse();
  const baseline = protocol.freeze(structuredClone(inputBaseline)), templates = protocol.freeze(structuredClone(inputTemplates));
  const configurationDigest = protocol.publicReleaseDigest({ baseline, templates, targets, candidates,
    adminTarget: admin.target, adminCandidate: admin.prepared.manifestDigest,
    adminBaseline: { deploymentId: admin.baseline.deploymentId, artifact: admin.baseline.artifact.manifestDigest } });
  const current = () => {
    assertDevelopmentRehearsalEnvironment(); signal?.throwIfAborted();
    if (!hasDevelopmentCredentialSource(developmentCredential) || rehearsalSourceCommit() !== sourceSha ||
        ![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
  };
  current();
  const http = createPairedAdminPagesHttp({ ...admin, signal });
  const transport = createCmsReaderReplayTransport({ projectId: packet.projectId, targets, readStaffToken, readEdgeSecret, signal });
  const observe = transaction => readRehearsalBridgeState({ firestore, packet, baseline, ...(transaction ? { transaction } : {}) });
  const derive = () => casesProcess({ packet, baseline, templates, developmentCredential, readStaffToken, signal });
  return Object.freeze({ async refresh() {
    current();
    const input = { firestore, packet, sourceSha, configurationDigest, authorized: true };
    let original = await originalRehearsalReaderRequest({ ...input, observed: await observe() });
    if (!original) {
      const derived = await derive();
      const operationId = `reader-rnp-${protocol.publicReleaseDigest({ runId: packet.runId, state: derived.state }).slice(0, 32)}`;
      const request = { schemaVersion: 2, operationId, expectedStateDigest: preview.digest(derived.state), readers: derived.readers, cases: derived.cases };
      original = await originalRehearsalReaderRequest({ ...input, observed: derived, request });
    }
    const { request, state } = original, operationId = request.operationId;
    const common = { firestore, request, signal, readLiveState: async () => (await observe()).state,
      readProviders: () => http.readLiveReaderIdentities(),
      assertStateInTransaction: async ({ transaction }) => preview.digest((await observe(transaction)).state) };
    await proveCmsReaderBridge({ ...common, transport, readRetainedCases: async () => (await derive()).cases });
    current();
    await installCmsReaderBridge({ ...common, candidates, commitReader: commitLiveReaderReceipt });
    current();
    return prepareRehearsalPreviewReaders({ firestore, packet, retainedState: state, bridgeOperationId: operationId, admin, signal });
  } });
}
