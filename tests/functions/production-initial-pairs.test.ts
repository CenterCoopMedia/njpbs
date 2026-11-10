import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { isolatedFirestore } from '../helpers/emulator-firestore.js';
import { qualifiedPairFixture } from '../helpers/qualified-public-release-pair';
import { stageInitialCapture } from '../../scripts/lib/initial-pairs.mjs';
import { qualifyPublicReleasePair } from '../../site/scripts/public-release-pair-qualification';
import protocol from '../../functions/lib/public-release-pair.js';
import work from '../../functions/lib/public-release-pair-work.js';

let runtime: Miniflare;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: 'production-binding-fixture', type: 'worker', compatibilityDate: '2026-07-09',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default {fetch(){return new Response(null,{status:404})}}' } } },
    env: { OLD: { type: 'r2', name: 'old-production-binding' }, NEW: { type: 'r2', name: 'new-production-binding' } } } }] });
});
afterAll(async () => { await runtime?.dispose(); });

describe.each([['OLD', '0123456789abcdef0123456789abcdef01234567'], ['NEW', 'b'.repeat(40)]])('%s production byte boundaries', (label, pairCommitSha) => {
  let fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>, store: any, bucket: R2Bucket, captured: any;
  let reads = 0, writes = 0;
  const db = isolatedFirestore(`production-initial-${label}`);
  beforeAll(async () => {
    bucket = await runtime.getR2Bucket(label);
    // Independent provider read/write boundaries over a real local R2 store.
    store = { get: (...args: Parameters<R2Bucket['get']>) => { reads++; return bucket.get(...args); },
      put: (...args: Parameters<R2Bucket['put']>) => { writes++; return bucket.put(...args); } };
    fixture = await qualifiedPairFixture(db, store, { environment: 'production', pairCommitSha });
    captured = { receipt: (await db.doc(`${work.publicReleasePairPath(fixture.pair.pairId)}/inputs/${fixture.contentView.identity.inputManifestDigest}`).get()).data() };
  }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  it('exhausts H/G and replay and seals a fresh native qualification through loopback HTTP', async () => {
    const { pair, contentView } = fixture;
    expect(pair.environment).toBe('production'); expect(pair.commitSha).toBe(pairCommitSha);
    expect(await stageInitialCapture({ firestore: db, store, pair, captured })).toMatchObject({ status: 'staged', reference: contentView });
    const result = await qualifyPublicReleasePair({ ...fixture, firestore: db, store, qualificationId: `fresh-production-${label}` });
    expect(result.receipt.pairDigest).toBe(protocol.publicReleaseDigest(pair));
    expect(result.receipt.witnessDigest).toBe(protocol.publicReleaseDigest(fixture.witness));
    expect(fixture.received).toBeGreaterThan(0); expect(reads).toBeGreaterThan(0); expect(writes).toBeGreaterThan(0);
  });
  it('refuses corrupted G bytes without replacing original completion', async () => {
    const { pair, contentView } = fixture;
    const taskId = protocol.publicReleaseDigest(contentView.identity);
    const receipt = await db.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${taskId}`).get();
    const corrupt = { put: store.put, async get(key: string) {
      const row = await bucket.get(key); if (!row) return null;
      const bytes = new Uint8Array(await row.arrayBuffer());
      if (key.endsWith(`/views/${contentView.manifestDigest}.json`)) bytes[0] ^= 1;
      return { size: bytes.length, customMetadata: row.customMetadata, body: new Response(bytes).body! };
    } };
    await expect(stageInitialCapture({ firestore: db, store: corrupt, pair, captured })).rejects.toThrow();
    expect((await receipt.ref.get()).updateTime).toEqual(receipt.updateTime);
  });
  it('refuses a malformed response from the actual private reader', async () => {
    fixture.setTransform(async response => response.status === 200 ? new Response('{}', { headers: response.headers }) : response);
    try { await expect(qualifyPublicReleasePair({ ...fixture, firestore: db, store, qualificationId: `corrupt-production-${label}` })).rejects.toThrow(); }
    finally { fixture.setTransform(undefined); }
  });
});
