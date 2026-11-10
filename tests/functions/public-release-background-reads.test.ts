import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { backgroundStorageFixture } from './background-storage-fixture';
import { createPublicReleaseBackgroundReads } from '../../scripts/lib/public-release-background-reads.mjs';

describe.each(['development', 'production'] as const)('%s original provider storage boundary', environment => {
  const bucket = environment === 'production' ? 'njpbs-public-artifacts' : 'njpbs-dev-public-artifacts';
  let app: ReturnType<typeof initializeApp>, boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
  beforeAll(async () => {
    boundary = await backgroundStorageFixture(bucket);
    app = initializeApp({ projectId: 'demo-background-read' }, `first-install-background-${environment}`);
  });
  afterAll(async () => { await deleteApp(app); await boundary.close(); });
  it('reads exact dependency bytes through the real SDK background bucket and refuses other namespaces', async () => {
    const bytes = Buffer.from('original provider bytes'), key = 'post-background-v1/external-inputs/original/schedule.json';
    boundary.objects.set(key, bytes);
    const reads = createPublicReleaseBackgroundReads({ environment, app });
    const row = await reads.get(key);
    expect(Buffer.from(await new Response(row.body).arrayBuffer())).toEqual(bytes);
    expect(boundary.reads).toEqual([key]); expect(boundary.writes).toEqual([]);
    await expect(reads.get('release-pair-inputs/v2/arbitrary/object.json')).rejects.toThrow();
    expect(boundary.reads).toEqual([key]);
  });
});
