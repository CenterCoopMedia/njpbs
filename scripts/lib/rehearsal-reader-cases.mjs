import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import bridge from '../../functions/lib/cms-reader-bridge-proof.js';
import sessions from '../../functions/lib/cms-reader-session.js';
import targets from '../../functions/lib/publication-target.js';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { readOnlyBootstrapFirestore } from './public-release-bootstrap-preflight.mjs';
import { BRIDGE_PROOFS, parseCmsReaderBridgeRequest } from './cms-reader-bridge-install.mjs';

const require = createRequire(import.meta.url);
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal native reader cases refused'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const endpoints = { publicCode: 'cmsReadPairCurrentCodeV2', postChrome: 'cmsGetPublicPage',
  settings: 'cmsGetPublishedSettings', capabilities: 'cmsGetPublicPage', previewRequest: 'cmsPreviewStatus' };
const scopes = ['publicOld', 'publicNew', 'previewOld', 'previewNew'];

/** The original installed proof supplies immutable retained requirements,
 * never current readiness. The new state changes only to the actually read
 * current selector. It still requires new native authenticated replay/install
 * before a preview owner can consume it; the old proof is not retagged.
 */
export async function readRehearsalBridgeState({ firestore, packet: raw, baseline, transaction: supplied }) {
  const packet = parseRehearsalPacket(raw);
  if (firestore?.projectId !== packet.projectId) refuse();
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet); else assertDevelopmentRehearsalEnvironment();
  protocol.exact(baseline, ['bridgeOperationId', 'retainedState']);
  if (!/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(baseline.bridgeOperationId ?? '')) refuse();
  const retained = protocol.freeze(structuredClone(baseline.retainedState));
  if (Buffer.byteLength(JSON.stringify(retained)) > 64 * 1024) refuse();
  protocol.exact(retained, ['schemaVersion', 'publicSelectorDigest', 'publicPairs', 'previewPairs']);
  if (retained.schemaVersion !== 2 || !protocol.digest(retained.publicSelectorDigest) ||
      !Array.isArray(retained.publicPairs) || retained.publicPairs.length !== 2 ||
      !Array.isArray(retained.previewPairs) || retained.previewPairs.length !== 2) refuse();
  const pairs = [packet.oldPair, packet.newPair];
  pairs.forEach((pair, index) => {
    const row = retained.publicPairs[index]; protocol.exact(row, ['pairDigest', 'requirements']);
    protocol.exact(row.requirements, preview.CONTRACT_KEYS);
    if (row.pairDigest !== protocol.publicReleaseDigest(pair) || Object.values(row.requirements).some(value => !protocol.positive(value) || value > 100)) refuse();
  });
  retained.previewPairs.forEach((value, index) => {
    const pair = preview.parsePair(value), ref = packet.previewPairs[index === 0 ? 'old' : 'new'];
    if (['pairId', 'rendererSha', 'serializerId'].some(key => pair[key] !== ref[key])) refuse();
  });
  const read = async transaction => {
    const paths = [`${BRIDGE_PROOFS}/${baseline.bridgeOperationId}`, 'system/publicDeployment',
      ...pairs.map(pair => work.publicReleasePairPath(pair.pairId)),
      ...retained.previewPairs.map(pair => `${preview.PAIRS}/${pair.pairId}`),
      ...['functions', 'cmsApi'].map(component => `${preview.READER_RECEIPTS}/${component}`)];
    const rows = await transaction.getAll(...paths.map(path => firestore.doc(path)));
    if (rows.some(row => !row.exists) || !rows[0].createTime.isEqual(rows[0].updateTime)) refuse();
    const original = bridge.parseInstalledCmsReaderProof(rows[0].data(), baseline.bridgeOperationId);
    if (original.proof.stateDigest !== preview.digest(retained)) refuse();
    const expected = { publicOld: retained.publicPairs[0].pairDigest, publicNew: retained.publicPairs[1].pairDigest,
      previewOld: preview.digest(retained.previewPairs[0]), previewNew: preview.digest(retained.previewPairs[1]) };
    if (original.proof.results.some(row => row.pairDigest !== expected[row.scope])) refuse();
    const selector = protocol.parseStoredPublicReleaseSelector(rows[1].data());
    if (![selector.selectedPair, selector.recoveryPair].every(ref => pairs.some(pair => same(ref, protocol.publicReleasePairReference(pair))))) refuse();
    pairs.forEach((pair, index) => { if (!same(protocol.parsePublicReleasePair(rows[index + 2].data()), pair)) refuse(); });
    retained.previewPairs.forEach((pair, index) => { if (!same(preview.parsePair(rows[index + 4].data()), pair)) refuse(); });
    const readers = Object.fromEntries(['functions', 'cmsApi'].map((component, index) => {
      const reader = preview.currentReader(rows[index + 6].data(), component);
      if (sessions.readerSessionDigest(reader) !== original.proof.readerIdentities[component]) refuse();
      for (const pair of [...retained.publicPairs, ...retained.previewPairs])
        if (preview.CONTRACT_KEYS.some(key => !reader.supported[key].includes(pair.requirements[key]))) refuse();
      return [component, reader];
    }));
    return protocol.freeze({ state: { ...retained, publicSelectorDigest: protocol.publicReleaseDigest(selector) },
      readers, selector, baselineDigest: protocol.publicReleaseDigest(original),
      baselineVersion: { seconds: rows[0].updateTime.seconds, nanoseconds: rows[0].updateTime.nanoseconds } });
  };
  return supplied ? read(supplied) : firestore.runTransaction(read, { readOnly: true });
}

async function invoke(handler, body, staffToken) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = { method: 'POST', body, rawBody: raw, aborted: false,
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length), authorization: `Bearer ${staffToken}` },
    is: type => type === 'application/json', get(name) { return this.headers[name.toLowerCase()]; } };
  let status = 200, bytes = null;
  const res = { headersSent: false, destroyed: false, set() { return res; }, status(value) { status = value; return res; },
    json(value) { if (bytes !== null) refuse(); bytes = Buffer.from(JSON.stringify(value)); res.headersSent = true; return res; },
    send(value) { if (bytes !== null) refuse(); bytes = Buffer.from(value); res.headersSent = true; return res; } };
  await handler(req, res);
  if (status !== 200 || bytes === null || bytes.length > 29 * 1024 * 1024) refuse();
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

/** Expected responses come from the actual native SDK/chunk/leaf readers.
 * The templates contain requests only; an expected hash supplied by a caller
 * is rejected. Actual authenticated deployed replay remains a different step.
 * Real development runs use the native Auth owner against this exact SDK app.
 */
export async function deriveRehearsalReaderCases({ firestore, packet: raw, baseline, templates,
  readStaffToken, authenticate, signal, authorized = false }) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || !Array.isArray(templates) || templates.length !== 36 ||
      Buffer.byteLength(JSON.stringify(templates)) > 2 * 1024 * 1024 || typeof readStaffToken !== 'function') refuse();
  if (authenticate !== undefined && (packet.schemaVersion !== 1 || typeof authenticate !== 'function')) refuse();
  const readonly = readOnlyBootstrapFirestore(firestore), before = await readRehearsalBridgeState({ firestore: readonly, packet, baseline });
  if (!authenticate) {
    const native = require('../../functions/lib/firebase.js');
    if (native.db !== firestore || native.db.projectId !== 'njpbs-site-dev') refuse();
    authenticate = require('../../functions/lib/auth.js').requirePrincipal;
  }
  const log = { error() {}, warn() {}, info() {} };
  const page = require('../../functions/public-content.js').createCmsGetPublicPageHandler({ firestore: readonly,
    target: targets.publicationTarget('development'), log });
  const settings = require('../../functions/settings.js').createCmsGetPublishedSettingsHandler({ firestore: readonly, requirePrincipalFn: authenticate, log });
  const status = require('../../functions/preview.js').createCmsPreviewStatusHandler({ firestore: readonly, requirePrincipalFn: authenticate, log });
  const results = [];
  for (const row of templates) {
    signal?.throwIfAborted();
    protocol.exact(row, ['scope', 'feature', 'version', 'body']);
    if (!scopes.includes(row.scope) || !Object.hasOwn(endpoints, row.feature) || ![1, 2].includes(row.version)) refuse();
    const index = row.scope.endsWith('Old') ? 0 : 1;
    const publicPair = [packet.oldPair, packet.newPair][index], previewPair = before.state.previewPairs[index];
    const pairDigest = row.scope.startsWith('public') ? protocol.publicReleaseDigest(publicPair) : preview.digest(previewPair);
    let body = structuredClone(row.body), response;
    if (row.feature === 'publicCode') {
      protocol.exact(body, []);
      body = { schemaVersion: 2, mode: 'current-code-v2', rendererSha: previewPair.rendererSha,
        selection: { pair: protocol.publicReleasePairReference(publicPair), expectedPublicSelectorDigest: before.state.publicSelectorDigest,
          previewPairId: previewPair.pairId, previewCandidateReceiptId: null } };
      const value = await require('../../functions/lib/pair-current-code-source.js').readPairCurrentCode({ firestore: readonly,
        request: body, deployedReaders: before.readers });
      response = { value, bytes: Buffer.from(JSON.stringify(value)) };
    } else {
      if (body.rendererSha === '$selected') body.rendererSha = before.selector.activeCommitSha;
      if (row.feature === 'previewRequest') {
        protocol.exact(body, ['collection', 'pageId']);
        if (!['cmsPages', 'cmsPosts'].includes(body.collection) || !/^[A-Za-z0-9_-]{1,128}$/.test(body.pageId ?? '')) refuse();
      }
      const token = await readStaffToken();
      if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) refuse();
      response = await invoke(row.feature === 'settings' ? settings : row.feature === 'previewRequest' ? status : page, body, token);
      if (row.feature === 'settings' && (response.value.success !== true || response.value.found !== true) ||
          row.feature === 'previewRequest' && (response.value.success !== true || response.value.ready?.success !== true ||
            !protocol.positive(response.value.ready?.sourceVersion)) ||
          row.feature === 'postChrome' && !['post', 'context-post', 'alias', 'gone', 'receipts'].includes(response.value.kind) ||
          row.feature === 'capabilities' && !['page', 'context-page'].includes(response.value.kind)) refuse();
    }
    results.push({ scope: row.scope, feature: row.feature, version: row.version, pairDigest, endpoint: endpoints[row.feature], body,
      expected: { status: 200, contentType: 'application/json', bodyDigest: hash(response.bytes) } });
  }
  if (!same(before, await readRehearsalBridgeState({ firestore: readonly, packet, baseline }))) refuse();
  // Native coverage/shape validation, including all36 distinct retained cases.
  parseCmsReaderBridgeRequest({ schemaVersion: 2, operationId: 'reader-rehearsal-native-cases', expectedStateDigest: preview.digest(before.state),
    readers: before.readers, cases: results });
  return protocol.freeze({ ...before, cases: results });
}
