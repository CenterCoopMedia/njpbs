import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import admission from '../../functions/lib/public-release-admission.js';
import family from '../../functions/lib/public-release-family-admission.js';
import runtime from '../../functions/lib/cms-publication-runtime-control.js';
import preview from '../../functions/lib/cms-preview-pair.js';
import { parseRehearsalPacket } from './public-release-rehearsal.mjs';
import { assertDemoRehearsalEnvironment, assertDevelopmentRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { readOnlyBootstrapFirestore } from './public-release-bootstrap-preflight.mjs';

const refuse = () => { throw new Error('Installed rehearsal authority refused'); };
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const STABLE_CONTROLS = ['system/billing', 'system/noBuildPostAdmission',
  'system/publicDeployment/noBuildRecordFamilies/current', `${admission.ADMISSIONS}/controls/adoption`];

/** Observe native controls and run the real admission preparation without
 * calling its write closure. The readonly facade also refuses an accidental
 * write. A preexisting probe operation cannot turn this into an idempotent
 * bypass of the current admission gates.
 *
 * Provider inspection and installed bridge proof remain separate owners;
 * this observation never claims either from SDK control flags alone.
 */
export async function readRehearsalInstalledState(options) {
  return (await readRehearsalInstalledControl(options)).state;
}

/** The observation time comes from the native SDK's consistent transaction
 * snapshot, not a caller clock or a packet-supplied readiness assertion. */
export async function readRehearsalInstalledControl({ firestore, packet: raw, probeDocumentId, authorized = false, signal }) {
  const packet = parseRehearsalPacket(raw);
  if (authorized !== true || firestore?.projectId !== packet.projectId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(probeDocumentId ?? '')) refuse();
  if (packet.schemaVersion === 1) assertDemoRehearsalEnvironment(packet);
  else {
    assertDevelopmentRehearsalEnvironment();
    if (packet.setupMode !== 'preinstalled') refuse();
  }
  if (![undefined, 'development'].includes(process.env.CMS_DEPLOYMENT_ENVIRONMENT)) refuse();
  const readonly = readOnlyBootstrapFirestore(firestore);
  return readonly.runTransaction(async transaction => {
    signal?.throwIfAborted();
    const rows = await transaction.getAll(...['system/publicDeployment', runtime.RUNTIME_DOCUMENT_PATH, preview.SELECTOR_PATH,
      preview.RENDERER_RECEIPT_PATH, 'cmsDeploymentReceipts/adminManifest', `cmsPosts/${probeDocumentId}`,
      ...['functions', 'cmsApi'].map(component => `${preview.READER_RECEIPTS}/${component}`),
      ...STABLE_CONTROLS].map(path => readonly.doc(path)));
    const selector = protocol.parseStoredPublicReleaseSelector(rows[0].data());
    const pairs = [packet.oldPair, packet.newPair];
    if (![selector.selectedPair, selector.recoveryPair].every(ref => pairs.some(pair => same(ref, protocol.publicReleasePairReference(pair))))) refuse();
    const pairRows = await transaction.getAll(...pairs.map(pair => readonly.doc(work.publicReleasePairPath(pair.pairId))));
    pairRows.forEach((row, index) => { if (!same(protocol.parsePublicReleasePair(row.data()), pairs[index])) refuse(); });
    const pins = runtime.parseCmsPublicationRuntimeControl(rows[1].data());
    const selected = pairs.find(pair => same(selector.selectedPair, protocol.publicReleasePairReference(pair)));
    const cloud = runtime.cloudCmsPublicationRuntimeControl(pins);
    if (!selected || [pins, cloud].some(pin => pin.phase !== 'ready' || pin.commitSha !== selected.commitSha)) refuse();

    const previewSelector = preview.parseSelector(rows[2].data());
    const previewRows = await transaction.getAll(...['old', 'new'].map(side => readonly.doc(`${preview.PAIRS}/${packet.previewPairs[side].pairId}`)));
    const previewPairs = previewRows.map((row, index) => {
      const pair = preview.parsePair(row.data()), ref = packet.previewPairs[index === 0 ? 'old' : 'new'];
      if (['pairId', 'rendererSha', 'serializerId'].some(key => pair[key] !== ref[key])) refuse();
      return pair;
    });
    const previewSelected = previewPairs.find(pair => pair.pairId === previewSelector.selectedPairId);
    if (!previewSelected || !previewPairs.some(pair => pair.pairId === previewSelector.recoveryPairId)) refuse();
    preview.assertProjection(previewSelector, previewSelected);
    for (const [index, component] of ['functions', 'cmsApi'].entries()) {
      const reader = preview.currentReader(rows[index + 6].data(), component);
      preview.assertReaderSupports(reader, previewPairs);
      if (![1, 2].every(version => reader.supported.adminSession.includes(version))) refuse();
    }
    const renderer = rows[3].data(), admin = rows[4].data();
    const manifestDigest = admin?.lastComplete?.request?.manifestDigest ?? admin?.lastComplete?.manifestDigest;
    if (renderer?.schemaVersion !== 2 || renderer.state !== 'complete' || renderer.pairId !== previewSelected.pairId ||
        renderer.selectorDigest !== preview.digest(previewSelector) || renderer.lastComplete?.sourceSha !== previewSelected.rendererSha ||
        admin?.state !== 'complete' || !protocol.digest(manifestDigest)) refuse();

    const stored = rows[5].data();
    if (!stored?.published || !protocol.positive(stored.version)) refuse();
    const operationId = protocol.publicReleaseDigest({ runId: packet.runId, kind: 'readonly-admission-probe', selector }).slice(0, 20);
    if ((await transaction.get(readonly.doc(`${admission.ADMISSIONS}/operations/${operationId}`))).exists) refuse();
    const nextDocument = { ...stored, version: stored.version + 1,
      published: { ...stored.published, sourceVersion: stored.version + 1 } };
    const prepared = await family.preparePairContentPublication({ firestore: readonly, transaction, collection: 'cmsPosts',
      documentId: probeDocumentId, nextDocument, queueRef: readonly.doc(`cmsPublishQueue/${operationId}`),
      actor: { uid: 'system:isolated-rehearsal-readonly' }, kind: 'post', family: 'posts' });
    if (prepared.idempotent || !same(prepared.admission.pair, selector.selectedPair)) refuse();
    signal?.throwIfAborted();
    const state = protocol.freeze({ selector, primary: { phase: pins.phase, release: pins.commitSha },
      cloud: { phase: cloud.phase, release: cloud.commitSha }, admission: true, previewReady: true, providerAttempts: 0,
      preview: { selector: previewSelector, adminManifestDigest: manifestDigest, adminReceiptDigest: preview.digest(admin) } });
    return { state, readAt: Math.floor(rows[0].readTime.toMillis()), stableControls: STABLE_CONTROLS.map((path, index) => {
      const row = rows[index + 8];
      return { path, exists: row.exists, version: row.exists
        ? { seconds: row.updateTime.seconds, nanoseconds: row.updateTime.nanoseconds } : null };
    }) };
  });
}
