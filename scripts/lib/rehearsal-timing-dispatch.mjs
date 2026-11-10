import { createRequire } from 'node:module';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import admission from '../../functions/lib/public-release-admission.js';
import { assertDevelopmentRehearsalEnvironment, assertDemoRehearsalEnvironment } from './development-rehearsal-credentials.mjs';
import { MAX_REHEARSAL_TIMING_CASES, isRehearsalTimingOperationId } from './rehearsal-timing-cases.mjs';

const require = createRequire(import.meta.url);
const family = require('../../functions/lib/public-release-family-admission.js');
const { publiclyVisible } = require('../../functions/lib/public-video-references.js');
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const refuse = () => { throw new Error('Rehearsal timing dispatch refused'); };

/** One planned source acceptance, inside the original family transaction.
 * An existing queue/admission is a refusal: it cannot become a fresh clock.
 * Capture/render/activation/settlement remain the installed continuation's work.
 */
export function createRehearsalTimingDispatch({ firestore, pair: rawPair, cases, publications, authorized = false }) {
  if (authorized !== true) refuse();
  const pair = protocol.parsePublicReleasePair(rawPair);
  const environment = () => {
    if (/^demo-[a-z0-9-]+$/.test(firestore?.projectId ?? '')) assertDemoRehearsalEnvironment({
      schemaVersion: 1, projectId: firestore.projectId, emulatorHost: process.env.FIRESTORE_EMULATOR_HOST });
    else { assertDevelopmentRehearsalEnvironment(); if (firestore?.projectId !== 'njpbs-site-dev') refuse(); }
    work.assertPrivatePairResources(pair); work.assertPublicReleasePairDatabase(firestore, pair);
    if (pair.environment !== 'development') refuse();
  };
  environment();
  if (!Array.isArray(cases) || !cases.length || cases.length > MAX_REHEARSAL_TIMING_CASES || !Array.isArray(publications) || publications.length !== cases.length) refuse();
  const plans = new Map();
  for (const [index, raw] of cases.entries()) {
    protocol.exact(raw, ['operationId', 'sourceVersion', 'snapshotDigest', 'path', 'status']);
    const input = protocol.freeze(structuredClone(raw)), publication = structuredClone(publications[index]);
    protocol.exact(publication, ['operationId', 'documentId', 'beforeDocumentDigest', 'nextDocument']);
    const next = publication.nextDocument, visible = publiclyVisible(next), snapshot = next?.published;
    if (!isRehearsalTimingOperationId(input.operationId) || plans.has(input.operationId) || publication.operationId !== input.operationId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(publication.documentId) || !protocol.digest(publication.beforeDocumentDigest) ||
        next?.id !== publication.documentId || next?.type !== 'post' || !protocol.positive(next.version) ||
        !protocol.positive(input.sourceVersion) || !protocol.digest(input.snapshotDigest) || ![200, 308, 410].includes(input.status)) refuse();
    const source = admission.publicationSource({ kind: 'post', family: 'posts', id: publication.documentId,
      action: visible ? 'publish' : 'withdraw', sourceVersion: snapshot?.sourceVersion, snapshot });
    if (source.sourceVersion !== input.sourceVersion || source.snapshotDigest !== input.snapshotDigest ||
        typeof snapshot?.metadata?.slug !== 'string') refuse();
    const canonical = `/posts/${snapshot.metadata.slug}/`;
    const previous = (snapshot.metadata.previousSlugs ?? []).map(slug => `/posts/${slug}/`);
    if (visible !== (input.status !== 410) || input.status === 200 && input.path !== canonical ||
        input.status === 308 && (input.path === canonical || !previous.includes(input.path)) ||
        input.status === 410 && ![canonical, ...previous].includes(input.path)) refuse();
    plans.set(input.operationId, protocol.freeze({ input, ...publication }));
  }
  return async (input, signal) => {
    environment(); signal?.throwIfAborted();
    const plan = plans.get(input?.operationId);
    if (!plan || !same(plan.input, input)) refuse();
    await firestore.runTransaction(async transaction => {
      environment(); signal?.throwIfAborted();
      const sourceRef = firestore.doc(`cmsPosts/${plan.documentId}`), queueRef = firestore.doc(`cmsPublishQueue/${input.operationId}`);
      const [before, original, queue] = await transaction.getAll(sourceRef,
        firestore.doc(`${admission.ADMISSIONS}/operations/${input.operationId}`), queueRef);
      if (!before.exists || original.exists || queue.exists ||
          protocol.publicReleaseDigest(before.data()) !== plan.beforeDocumentDigest || plan.nextDocument.version !== before.data().version + 1) refuse();
      const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: 'cmsPosts',
        documentId: plan.documentId, nextDocument: plan.nextDocument, queueRef,
        actor: { uid: 'system:isolated-rehearsal' }, kind: 'post', family: 'posts' });
      if (prepared.idempotent || prepared.admission.source.sourceVersion !== input.sourceVersion ||
          prepared.admission.source.snapshotDigest !== input.snapshotDigest ||
          !same(prepared.admission.pair, protocol.publicReleasePairReference(pair)) || prepared.admission.pairDigest !== protocol.publicReleaseDigest(pair)) refuse();
      signal?.throwIfAborted();
      prepared.write(); transaction.set(sourceRef, plan.nextDocument);
    });
  };
}
