import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { qualifiedPairFixture } from '../helpers/qualified-public-release-pair';
import { initialPublicReleaseControlsFixture } from '../helpers/initial-public-release-controls';
import { initialPairsPacket } from '../helpers/development-initial-pairs';
import { readDevelopmentInitialPairsAuthority, stageDevelopmentInitialCapture, runDevelopmentInitialPairs } from '../../scripts/lib/development-initial-pairs.mjs';
import { qualifyPublicReleasePair } from '../../site/scripts/public-release-pair-qualification';
import { openPublicReleasePairInput } from '../../site/scripts/public-release-pair-input-storage';
import { PAIR_SOURCE_METADATA_FILE, preparePublicReleasePairSourceCensus } from '../../site/scripts/public-release-pair-source-census';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';
import enrollment from '../../functions/lib/public-release-change-enrollment.js';

const db = isolatedFirestore('development-initial-pairs-bytes');
let runtime: Miniflare, store: R2Bucket, fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: 'dev-initial', type: 'worker', compatibilityDate: '2026-07-09',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default {fetch(){return new Response(null,{status:404})}}' } } },
    env: { CONTENT: { type: 'r2', name: 'dev-initial' } } } }] });
  store = await runtime.getR2Bucket('CONTENT');
  fixture = await qualifiedPairFixture(db, store);
}, 60_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });

it('stages only completed native claims, exhausts G bytes again, and preserves original completion on corruption', async () => {
  const { pair, contentView } = fixture, base = work.publicReleasePairPath(pair.pairId);
  const captured = { receipt: (await db.doc(`${base}/inputs/${contentView.identity.inputManifestDigest}`).get()).data() };
  const taskId = protocol.publicReleaseDigest(contentView.identity), receipt = (await db.doc(`${base}/receipts/${taskId}`).get()).data();
  const staged = await stageDevelopmentInitialCapture({ firestore: db, store, pair, captured });
  expect(staged).toMatchObject({ status: 'staged', taskId, reference: contentView });
  let reads = 0;
  const corrupt = { put: store.put.bind(store), async get(key: string) {
    reads++; const stored = await store.get(key); if (!stored) return null;
    const bytes = new Uint8Array(await stored.arrayBuffer()); if (key.endsWith(`/views/${contentView.manifestDigest}.json`)) bytes[0] ^= 1;
    return { size: bytes.length, customMetadata: stored.customMetadata, body: new Response(bytes).body! };
  } };
  await expect(stageDevelopmentInitialCapture({ firestore: db, store: corrupt, pair, captured })).rejects.toThrow();
  expect(reads).toBeGreaterThan(0);
  expect((await db.doc(`${base}/receipts/${taskId}`).get()).data()).toEqual(receipt);
});
it('returns an attended wait for pending native work and refuses failed work before any object read', async () => {
  const { pair, contentView } = fixture, base = work.publicReleasePairPath(pair.pairId), taskId = protocol.publicReleaseDigest(contentView.identity);
  const ref = db.doc(`${base}/work/${taskId}`), original = (await ref.get()).data()!;
  const captured = { receipt: (await db.doc(`${base}/inputs/${contentView.identity.inputManifestDigest}`).get()).data() };
  const never = { get: async () => { throw new Error('Must not touch storage'); } };
  try {
    await ref.set({ ...original, status: 'pending', attempts: 0, claimDigest: null, leaseUntil: null, nextAttemptAt: 0, receiptDigest: null, lastFailure: null });
    expect(await stageDevelopmentInitialCapture({ firestore: db, store: never, pair, captured })).toEqual({ status: 'waiting', pairId: pair.pairId, taskId, taskStatus: 'pending' });
    await ref.set({ ...original, status: 'failed', attempts: 1, claimDigest: null, leaseUntil: null, nextAttemptAt: Date.now() + 1000, receiptDigest: null, lastFailure: 'storage-unavailable' });
    expect(await stageDevelopmentInitialCapture({ firestore: db, store: never, pair, captured })).toMatchObject({ status: 'waiting', taskId, taskStatus: 'failed' });
    await ref.set({ ...original, status: 'failed', attempts: 3, claimDigest: null, leaseUntil: null, nextAttemptAt: null, receiptDigest: null, lastFailure: 'byte-mismatch' });
    await expect(stageDevelopmentInitialCapture({ firestore: db, store: never, pair, captured })).rejects.toThrow();
  } finally { await ref.set(original); }
});
it('obtains the native qualification through actual loopback reader I/O', async () => {
  const result = await qualifyPublicReleasePair({ ...fixture, firestore: db, qualificationId: 'development-initial-exact' });
  expect(result.receipt.pairDigest).toBe(protocol.publicReleaseDigest(fixture.pair)); expect(fixture.received).toBeGreaterThan(0);
});
it('refuses changed remote bytes at the native qualifier HTTP boundary', async () => {
  fixture.setTransform(async response => {
    if (response.status !== 200) return response;
    const value = await response.json() as any; value.outputs[0].bodyBase64 = Buffer.from('wrong immutable bytes').toString('base64');
    return new Response(JSON.stringify(value), { headers: response.headers });
  });
  try { await expect(qualifyPublicReleasePair({ ...fixture, firestore: db, qualificationId: 'development-initial-corrupt' })).rejects.toThrow(); }
  finally { fixture.setTransform(undefined); }
});
it('refuses reusing the old H census after an initial control capability changes', async () => {
  const { pair, contentView } = fixture, base = work.publicReleasePairPath(pair.pairId);
  const captured = (await db.doc(`${base}/inputs/${contentView.identity.inputManifestDigest}`).get()).data()!;
  const frozen = await openPublicReleasePairInput({ firestore: db, store, pair, identity: contentView.identity,
    expectedSource: captured.source, expectedCursor: captured.cursor });
  const expected = JSON.parse(new TextDecoder().decode(await frozen.readFile(PAIR_SOURCE_METADATA_FILE)));
  const ref = db.doc('system/publicDeployment/noBuildPages/capability'), before = (await ref.get()).data()!;
  try {
    await ref.set({ ...before, dataHubCompositionVersion: 1 });
    await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor: fixture.witness.headCursor })).rejects.toMatchObject({ code: 'source-census-mismatch' });
  } finally { await ref.set(before); }
});
it('uses actual enrollment and closed fences, rejects cutoff drift, and reads incomplete original outcomes without writes', async () => {
  const raw = isolatedFirestore('development-initial-pairs-authority');
  const firestore = new Proxy(raw, { get(target, key) { if (key === 'projectId') return 'njpbs-site-dev';
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const f = await initialPublicReleaseControlsFixture(firestore);
  const packet = initialPairsPacket(); Object.assign(packet, { currentPair: f.pair, recoveryPair: f.recoveryPair,
    bootstrapOperationId: f.attempt.operationId,
    enrollmentRequestDigest: (await firestore.doc(enrollment.ENROLLMENT_PATH).get()).data()!.requestDigest });
  packet.artifacts.forEach((artifact, index) => { artifact.preparedArtifact.commitSha = [f.pair, f.recoveryPair][index].commitSha; });
  const authority = await readDevelopmentInitialPairsAuthority({ firestore, packet });
  expect(authority.head.sequence).toBe(0);
  const result = await runDevelopmentInitialPairs({ firestore, packet, mode: 'readback' });
  expect(result).toMatchObject({ status: 'incomplete', qualifications: [null, null] }); expect(result.tasks).toHaveLength(4);
  await firestore.doc('system/publicReleaseChanges').update({ sequence: 1, lastDigest: 'e'.repeat(64) });
  await expect(readDevelopmentInitialPairsAuthority({ firestore, packet })).rejects.toThrow();
});
