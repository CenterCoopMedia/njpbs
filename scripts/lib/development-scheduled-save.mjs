import protocol from '../../functions/lib/public-release-pair.js';
import { parseOperatorCredentialIdentity, operatorRefused as refuse } from './public-release-operator-io.mjs';
const hash = protocol.publicReleaseDigest;
export function parseDevelopmentScheduledSave(raw) {
  protocol.exact(raw, ['schemaVersion', 'kind', 'operatorCommitSha', 'credentialIdentity', 'oldPair', 'documentId', 'baseVersion', 'beforeDigest', 'scheduleAt']);
  const pair = protocol.parsePublicReleasePair(raw.oldPair);
  if (raw.schemaVersion !== 1 || raw.kind !== 'development-native-scheduled-save' || !/^[a-f0-9]{40}$/.test(raw.operatorCommitSha ?? '') ||
      pair.environment !== 'development' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.documentId ?? '') || !protocol.positive(raw.baseVersion) ||
      !protocol.digest(raw.beforeDigest) || typeof raw.scheduleAt !== 'string' || !Number.isFinite(Date.parse(raw.scheduleAt)) ||
      new Date(raw.scheduleAt).toISOString() !== raw.scheduleAt) refuse();
  parseOperatorCredentialIdentity(raw.credentialIdentity, 'development');
  return protocol.freeze(structuredClone(raw));
}
export async function saveDevelopmentScheduledPost({ firestore, packet: raw, readStaffToken, readEdgeSecret, request = fetch, signal, readback = false }) {
  const packet = parseDevelopmentScheduledSave(raw);
  if (firestore.projectId !== 'njpbs-site-dev') refuse();
  const read = () => firestore.runTransaction(async tx => {
    const [root, source] = await tx.getAll(firestore.doc('system/publicDeployment'), firestore.doc(`cmsPosts/${packet.documentId}`));
    const selector = protocol.parseStoredPublicReleaseSelector(root.data());
    if (!source.exists || hash(selector.selectedPair) !== hash(protocol.publicReleasePairReference(packet.oldPair))) refuse();
    return { selectorDigest: hash(selector), document: source.data() };
  }, { readOnly: true });
  const result = observed => {
    const doc = observed.document;
    if (doc.status !== 'scheduled' || doc.version !== packet.baseVersion + 1 || doc.publishAt !== packet.scheduleAt ||
        doc.scheduledPublicationTransport !== 'release-pair-publication-v2') refuse();
    return { kind: 'native-scheduled-save-readback', documentId: packet.documentId, version: doc.version, publishAt: doc.publishAt,
      documentDigest: hash(doc), selectorDigest: observed.selectorDigest };
  };
  signal?.throwIfAborted();
  const before = await read();
  if (readback) return result(before);
  if (before.document.version !== packet.baseVersion || hash(before.document) !== packet.beforeDigest) refuse();
  const body = { collection: 'cmsPosts', id: packet.documentId, document: {}, baseVersion: packet.baseVersion, scheduleAt: packet.scheduleAt };
  signal?.throwIfAborted();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${await readStaffToken()}`,
    'x-njpbs-cms-edge': await readEdgeSecret() };
  signal?.throwIfAborted();
  // One native save, never a direct source/queue/marker write. On uncertainty,
  // stop and use --readback; an unchanged source is not permission to resend.
  const response = await request('https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsSaveContent', {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 1024 * 1024) refuse(); chunks.push(chunk); }
    if (!response.ok) refuse();
    const saved = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (saved.success !== true || saved.collection !== 'cmsPosts' || saved.id !== packet.documentId ||
        saved.document?.version !== packet.baseVersion + 1 || saved.document?.publishAt !== packet.scheduleAt) refuse();
  } finally { await response.body?.cancel().catch(() => {}); }
  const after = await read();
  if (before.selectorDigest !== after.selectorDigest) refuse();
  return result(after);
}
