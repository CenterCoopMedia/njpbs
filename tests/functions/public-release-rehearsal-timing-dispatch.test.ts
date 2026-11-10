import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { publicReleaseR2Fixture } from '../helpers/public-release-r2-fixture';
import { switchedPairFixture } from '../helpers/public-release-switched-pair';
import { createRehearsalTimingDispatch } from '../../scripts/lib/rehearsal-timing-dispatch.mjs';
import protocol from '../../functions/lib/public-release-pair.js';
import admission from '../../functions/lib/public-release-admission.js';
import work from '../../functions/lib/public-release-pair-work.js';

describe.sequential('fresh original timing dispatch', () => {
  const firestore = isolatedFirestore('rehearsal-timing-dispatch');
  let binding: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
  let pair: any, other: any, input: any, publication: any, index = 0;
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    binding = await publicReleaseR2Fixture('rehearsal-timing-dispatch');
    fixture = await switchedPairFixture(firestore, binding.store);
    const selector = protocol.parseStoredPublicReleaseSelector((await firestore.doc('system/publicDeployment').get()).data());
    pair = (await firestore.doc(work.publicReleasePairPath(selector.selectedPair.pairId)).get()).data();
    other = (await firestore.doc(work.publicReleasePairPath(selector.recoveryPair.pairId)).get()).data();
  }, 120_000);
  afterAll(async () => { try { await fixture?.close(); await binding?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });
  beforeEach(async () => {
    const id = `timed-${++index}`, original = (await firestore.doc('cmsPosts/story').get()).data()!;
    const before = { ...original, id, type: 'post', slug: id,
      published: { ...original.published, metadata: { ...original.published.metadata, slug: id, previousSlugs: [] } } };
    await firestore.doc(`cmsPosts/${id}`).create(before);
    const nextDocument = { ...before, version: before.version + 1, publishBuildPending: true,
      published: { ...before.published, sourceVersion: before.version + 1, metadata: { ...before.published.metadata, title: `Measured ${id}` } } };
    input = { operationId: String(index).padStart(20, '0'), sourceVersion: nextDocument.published.sourceVersion,
      snapshotDigest: protocol.publicReleaseDigest(nextDocument.published), path: `/posts/${id}/`, status: 200 };
    nextDocument.publishBuildQueueId = input.operationId;
    publication = { operationId: input.operationId, documentId: id, beforeDocumentDigest: protocol.publicReleaseDigest(before), nextDocument };
  });
  const open = (selected = pair) => createRehearsalTimingDispatch({ firestore, pair: selected,
    cases: [input], publications: [publication], authorized: true });
  const absent = async () => expect((await firestore.doc(`${admission.ADMISSIONS}/operations/${input.operationId}`).get()).exists).toBe(false);

  it('accepts exactly once through the actual owner and refuses a second sample without changing the original', async () => {
    const dispatch = open(), expected = structuredClone(publication.nextDocument);
    publication.nextDocument.published.metadata.title = 'Unreviewed later mutation';
    await dispatch(input, new AbortController().signal);
    expect((await firestore.doc(`cmsPosts/${publication.documentId}`).get()).data()).toEqual(expected);
    const queue = await firestore.doc(`cmsPublishQueue/${input.operationId}`).get();
    expect(queue.data()).toMatchObject({ transport: admission.TRANSPORT, status: 'pending', execution: null });
    await expect(dispatch(input, new AbortController().signal)).rejects.toThrow('timing dispatch refused');
    expect((await queue.ref.get()).updateTime!.isEqual(queue.updateTime!)).toBe(true);
  });
  it('refuses changed source bytes even when its version is unchanged', async () => {
    const dispatch = open();
    await firestore.doc(`cmsPosts/${publication.documentId}`).update({ title: 'Private edit without a version change' });
    await expect(dispatch(input, new AbortController().signal)).rejects.toThrow(); await absent();
    expect((await firestore.doc(`cmsPublishQueue/${input.operationId}`).get()).exists).toBe(false);
  });
  it('checks the selected pair inside the source transaction and rolls back all acceptance writes', async () => {
    await expect(open(other)(input, new AbortController().signal)).rejects.toThrow(); await absent();
    expect((await firestore.doc(`cmsPosts/${publication.documentId}`).get()).data()!.version).toBe(publication.nextDocument.version - 1);
  });
  it('refuses cancellation and a changed case before an original acceptance exists', async () => {
    const dispatch = open(), controller = new AbortController(); controller.abort();
    await expect(dispatch(input, controller.signal)).rejects.toThrow();
    await expect(dispatch({ ...input, snapshotDigest: 'f'.repeat(64) }, new AbortController().signal)).rejects.toThrow();
    await absent();
  });
});
