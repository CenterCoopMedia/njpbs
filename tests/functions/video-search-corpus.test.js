import { describe, it, expect, vi } from 'vitest';
import corpus from '../../functions/video-search-corpus.js';
import sources from '../../functions/lib/media-sources.js';

const source = { id: 'video-library', bucket: 'private', prefix: '', access: 'active_staff', writable: true };
function asset(id = 'asset') {
  return { sourceId: source.id, lifecycle: 'active', kind: 'video', name: 'Council meeting', originalName: 'meeting.mp4',
    nameSort: 'council meeting', updatedAtSort: '2026-09-16T12:00:00Z', mimeType: 'video/mp4', sizeBytes: 10,
    version: 1, preview: 'browser', rightsStatus: 'complete', objectKey: `objects/${id}.mp4`, objectVersionId: 'original-v1', tags: [] };
}
function setup({ users = {}, assets = [['asset', asset()]], jobs = [], read, getJob, authorizeFn } = {}) {
  const rows = new Map(assets);
  const firestore = { async getAll(...refs) { return Promise.all(refs.map(ref => ref.get())); }, collection(name) {
    if (name === 'users') return { doc: id => ({ get: async () => ({ id, exists: Boolean(users[id]), data: () => users[id] }) }) };
    let after = '', limit = Infinity, assetId;
    const query = { where(field, op, value) { if (field === 'assetId') assetId = value; return query; }, orderBy() { return query; },
      startAfter(value) { after = value; return query; }, limit(value) { limit = value; return query; }, async get() {
        const entries = name === 'mediaSourceAssets' ? [...rows] : jobs.filter(job => !assetId || job.assetId === assetId).map(job => [job.id, job]);
        return { docs: entries.filter(([id]) => id > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([id, data]) => ({ id, data: () => structuredClone(data), ref: { get: async () => ({ data: () => rows.get(id) }) } })) };
      } };
    return query;
  } };
  const processor = { read: vi.fn(read ?? (async () => [{ text: 'Funding schools', startSeconds: 12, endSeconds: 16 }])) };
  const deps = { firestore, registryFn: () => new Map([[source.id, source]]), configFn: () => ({ bucket: 'renditions' }), processor,
    verifyAppCheckFn: vi.fn(async () => {}), requirePrincipalFn: vi.fn(async () => ({ uid: 'staff' })),
    authorizeFn: authorizeFn ?? vi.fn(async () => {}), getJob: getJob ?? vi.fn(async ({ request }) => jobs.find(job => job.id === request.transcriptId)) };
  const handler = corpus.createVideoSearchCorpusHandler(deps);
  async function run(body = { sourceId: source.id }) {
    const response = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body }, response);
    return response;
  }
  return { run, rows, processor, deps };
}
const job = (id = 'saved', fields = {}) => ({ id, assetId: 'asset', phase: 'ready', editRevision: 2, createdAt: '2026-09-16T12:00:00Z', languageCode: 'en-US', ...fields });

describe('private video search corpus', () => {
  it('rejects alternate sources, unknown fields and cross-source or malformed cursors', () => {
    for (const value of [{ sourceId: 'archive-originals' }, { sourceId: source.id, q: 'private' }, { sourceId: source.id, cursor: 'bad' },
      { sourceId: source.id, cursor: Buffer.from(JSON.stringify({ v: 1, sourceId: 'archive-originals', after: 'asset' })).toString('base64url') }]) {
      expect(() => corpus.parseRequest(value)).toThrow();
    }
  });
  it('requires App Check and source access before reading private data', async () => {
    const test = setup({ jobs: [job()] });
    test.deps.verifyAppCheckFn.mockRejectedValueOnce(Object.assign(new Error('secret'), { status: 401 }));
    expect((await test.run()).statusCode).toBe(401);
    expect(test.deps.authorizeFn).not.toHaveBeenCalled();
    test.deps.authorizeFn.mockRejectedValueOnce(Object.assign(new Error('secret'), { status: 403 }));
    expect((await test.run()).statusCode).toBe(403);
    expect(test.processor.read).not.toHaveBeenCalled();
  });
  it('keeps shared-library browse for approved staff and denies revoked accounts', async () => {
    const actor = { uid: 'staff', principal: { id: 'staff', grants: [{ role: 'staff' }] } };
    await expect(sources.authorizeMediaSource({ source, actor, operation: 'browse', isApprovedActiveAccountFn: async () => true })).resolves.toBe(true);
    await expect(sources.authorizeMediaSource({ source, actor, operation: 'browse', isApprovedActiveAccountFn: async () => false })).rejects.toMatchObject({ status: 403 });
    await expect(sources.authorizeMediaSource({ source: undefined, actor, operation: 'browse', isApprovedActiveAccountFn: async () => true })).rejects.toMatchObject({ status: 404 });
    for (const principal of [undefined, { grants: [] }, { grants: [{ role: 'unknown' }] }, { grants: [{ role: 'staff', sections: [] }] }]) {
      await expect(sources.authorizeMediaSource({ source, actor: { uid: 'staff', principal }, operation: 'browse', isApprovedActiveAccountFn: async () => true })).rejects.toMatchObject({ status: 403 });
    }
  });
  it('returns corrected passages, timestamps and safe asset metadata after one object read', async () => {
    const test = setup({ jobs: [job()] });
    const response = await test.run();
    expect(response.statusCode).toBe(200);
    expect(response.headers['Cache-Control']).toBe('private, no-store');
    expect(response.body.chunks[0]).toMatchObject({ id: 'asset/saved/2/0', text: 'Funding schools', startSeconds: 12, endSeconds: 16, editRevision: 2 });
    expect(response.body.asset).not.toHaveProperty('objectKey');
    expect(response.body.asset).not.toHaveProperty('objectVersionId');
    expect(response.body.coverage.assetsIndexed).toBe(1);
    expect(response.body).not.toHaveProperty('items');
    expect(Object.keys(response.body).sort()).toEqual(['asset', 'chunks', 'coverage', 'nextCursor', 'revision', 'success']);
    expect(test.processor.read).toHaveBeenCalledTimes(1);
    expect(test.deps.authorizeFn).toHaveBeenCalledTimes(2);
  });
  it('withholds uploader ids from corpus pages without users.view', async () => {
    const test = setup({
      assets: [['asset', { ...asset(), createdBy: 'staff-2' }]],
      users: { 'staff-2': { displayName: 'Alex Rivera', email: 'private@example.org' } },
      jobs: [job()],
    });
    const response = await test.run();
    expect(response.statusCode).toBe(200);
    expect(response.body.asset.uploadedBy).toEqual({ name: 'Alex Rivera' });
    expect(JSON.stringify(response.body)).not.toMatch(/staff-2|private@example.org/);
  });
  it('prefers reviewed current revisions then corrected transcripts then newer variants', () => {
    const rows = [job('new', { createdAt: '2026-09-17', editRevision: 0 }), job('corrected'), job('reviewed', { reviewedRevision: 2 })].map(value => ({ id: value.id, data: () => value }));
    expect(corpus.preferredJobs(rows).map(value => value.id)).toEqual(['reviewed', 'corrected', 'new']);
  });
  it('advances across missing transcripts and deleted assets without exposing them', async () => {
    const test = setup({ assets: [['a', asset('a')], ['b', { ...asset('b'), lifecycle: 'deleted' }], ['c', asset('c')]] });
    const first = await test.run();
    expect(first.body.asset.id).toBe('a');
    expect(first.body.coverage.assetsWithoutTranscript).toBe(1);
    const second = await test.run({ sourceId: source.id, cursor: first.body.nextCursor });
    expect(second.body.asset).toBeNull();
    expect(second.body.coverage.assetsUnavailable).toBe(1);
    const last = await test.run({ sourceId: source.id, cursor: second.body.nextCursor });
    expect(last.body.asset.id).toBe('c');
    expect(last.body.nextCursor).toBeNull();
  });
  it('releases no text after deletion during the private read', async () => {
    const test = setup({ jobs: [job()] });
    test.processor.read.mockImplementationOnce(async () => { test.rows.delete('asset'); return [{ text: 'private', startSeconds: 0, endSeconds: 1 }]; });
    const response = await test.run();
    expect(response.body.chunks).toEqual([]);
    expect(response.body.asset).toBeNull();
    expect(response.body.coverage.assetsUnavailable).toBe(1);
  });
  it('releases no text after transcript revision change or source authorization revocation', async () => {
    const test = setup({ jobs: [job()] });
    test.deps.getJob.mockResolvedValueOnce(job()).mockResolvedValueOnce(job('saved', { editRevision: 3 }));
    expect((await test.run()).body.chunks).toEqual([]);
    test.deps.authorizeFn.mockResolvedValueOnce(true).mockRejectedValueOnce(Object.assign(new Error('private details'), { status: 403 }));
    const response = await test.run();
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'Video search corpus is unavailable' });
  });
  it('splits long passages without dropping text and retains exact source timestamps', () => {
    const text = Array.from({ length: 1399 }, (_, i) => String.fromCharCode(0x400 + i)).join('') + '\u{10400}' + Array.from({ length: 7600 }, (_, i) => String.fromCharCode(0x1000 + i)).join('');
    const result = corpus.searchChunks({ id: 'asset', name: 'Video' }, job(), [{ text, startSeconds: 10, endSeconds: 50 }]);
    expect(result.truncated).toBe(false);
    let reconstructed = result.chunks[0].text;
    for (const chunk of result.chunks.slice(1)) {
      const overlap = reconstructed.endsWith(chunk.text.slice(0, 201)) ? 201 : 200;
      reconstructed += chunk.text.slice(overlap);
    }
    expect(reconstructed).toBe(text);
    expect(new Set(result.chunks.map(chunk => chunk.id)).size).toBe(result.chunks.length);
    for (const chunk of result.chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1400);
      expect(chunk).toMatchObject({ startSeconds: 10, endSeconds: 50, segmentIndex: 0 });
    }
  });
  it('keeps a phrase that crosses a passage boundary searchable', () => {
    const phrase = 'the council approved the school funding proposal';
    const text = 'x '.repeat(690) + phrase + ' y'.repeat(900);
    const result = corpus.searchChunks({ id: 'asset', name: 'Video' }, job(), [{ text, startSeconds: 10, endSeconds: 50 }]);
    expect(result.chunks.some(chunk => chunk.text.includes(phrase))).toBe(true);
  });
  it('marks oversized text and output as truncated instead of claiming full coverage', () => {
    const result = corpus.searchChunks({ id: 'asset', name: 'Video' }, job(), Array.from({ length: 1000 }, () => ({ text: 'x'.repeat(9000), startSeconds: 1, endSeconds: 3 })));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.chunks))).toBeLessThanOrEqual(1024 * 1024 + 2);
  });
  it('reports capped variant discovery and never runs transcription', async () => {
    const test = setup({ jobs: Array.from({ length: 33 }, (_, index) => job(`j${String(index).padStart(2, '0')}`)) });
    expect((await test.run()).body.coverage.truncatedAssets).toBe(1);
    expect(test.processor.read).toHaveBeenCalledTimes(1);
  });
  it('does not return provider errors or private text on storage failure', async () => {
    const test = setup({ jobs: [job()], read: async () => { throw new Error('signed-url-and-private-text'); } });
    const response = await test.run();
    expect(response.body.coverage.assetsUnavailable).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('signed-url');
  });
  it('returns a bounded batch in order with one access check before and after the reads', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const test = setup({ assets: [...ids.map(id => [id, asset(id)]), ['e', { ...asset('e'), lifecycle: 'deleted' }]],
      jobs: ['a', 'c', 'd'].map(id => job(`t${id}`, { assetId: id })) });
    const first = await test.run({ sourceId: source.id, limit: 3 });
    expect(first.statusCode).toBe(200);
    expect(first.body.items.map(item => item.asset.id)).toEqual(['a', 'b', 'c']);
    expect(first.body.items[0].chunks[0]).toMatchObject({ id: 'a/ta/2/0', text: 'Funding schools' });
    expect(first.body.items[1].chunks).toEqual([]);
    expect(first.body.items[0].asset).not.toHaveProperty('objectKey');
    expect(first.body).not.toHaveProperty('asset');
    expect(first.body.coverage).toEqual({ assetsScanned: 3, assetsIndexed: 2, assetsWithoutTranscript: 1, assetsUnavailable: 0, truncatedAssets: 0 });
    expect(first.body.items[1].coverage).toEqual({ assetsScanned: 1, assetsIndexed: 0, assetsWithoutTranscript: 1, assetsUnavailable: 0, truncatedAssets: 0 });
    expect(test.deps.authorizeFn).toHaveBeenCalledTimes(2);
    const last = await test.run({ sourceId: source.id, limit: 3, cursor: first.body.nextCursor });
    expect(last.body.items.map(item => item.asset?.id ?? null)).toEqual(['d', null]);
    expect(last.body.items[1]).toEqual({ asset: null, chunks: [], revision: null, coverage: { assetsScanned: 1, assetsIndexed: 0, assetsWithoutTranscript: 0, assetsUnavailable: 1, truncatedAssets: 0 } });
    expect(last.body.coverage).toMatchObject({ assetsScanned: 2, assetsIndexed: 1, assetsUnavailable: 1 });
    expect(last.body.nextCursor).toBeNull();
  });
  it('stops a batch at the byte budget and resumes after the last returned video', async () => {
    const big = Array.from({ length: 700 }, (_, index) => ({ text: 'x'.repeat(1300), startSeconds: index, endSeconds: index + 1 }));
    const test = setup({ assets: ['a', 'b', 'c'].map(id => [id, asset(id)]), jobs: ['a', 'b', 'c'].map(id => job(`t${id}`, { assetId: id })), read: async () => big });
    const first = await test.run({ sourceId: source.id, limit: 3 });
    // Each video returns about 0.95 MB of passages, so the third would pass the 2 MiB budget.
    expect(first.body.items.map(item => item.asset.id)).toEqual(['a', 'b']);
    expect(first.body.coverage.assetsScanned).toBe(2);
    const second = await test.run({ sourceId: source.id, limit: 3, cursor: first.body.nextCursor });
    expect(second.body.items.map(item => item.asset.id)).toEqual(['c']);
    expect(second.body.nextCursor).toBeNull();
  });
  it('keeps at most two transcript reads in flight and stops reading once the byte budget is spent', async () => {
    let active = 0;
    let peak = 0;
    const big = Array.from({ length: 1100 }, (_, index) => ({ text: 'x'.repeat(1300), startSeconds: index, endSeconds: index + 1 }));
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const test = setup({ assets: ids.map(id => [id, asset(id)]), jobs: ids.map(id => job(`t${id}`, { assetId: id })),
      read: async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return big; } });
    const response = await test.run({ sourceId: source.id, limit: 5 });
    expect(peak).toBeLessThanOrEqual(2);
    // Each video returns just under 1 MiB of passages. The third passes the 2 MiB budget, so the
    // round that read it is the last; the fifth video is never read.
    expect(response.body.items.map(item => item.asset.id)).toEqual(['a', 'b']);
    expect(test.processor.read).toHaveBeenCalledTimes(4);
  });
  it('rechecks every video after the whole batch is read, before releasing text', async () => {
    const test = setup({ assets: ['a', 'b'].map(id => [id, asset(id)]), jobs: ['a', 'b'].map(id => job(`t${id}`, { assetId: id })) });
    test.processor.read.mockImplementation(async selected => {
      // The second read finishes after the first video was deleted.
      if (selected.assetId === 'b') test.rows.delete('a');
      return [{ text: `private ${selected.assetId}`, startSeconds: 0, endSeconds: 1 }];
    });
    const response = await test.run({ sourceId: source.id, limit: 2 });
    expect(JSON.stringify(response.body)).not.toContain('private a');
    expect(response.body.items.map(item => item.asset?.id ?? null)).toEqual([null, 'b']);
    expect(response.body.coverage).toMatchObject({ assetsScanned: 2, assetsIndexed: 1, assetsUnavailable: 1 });
  });
  it('rejects a batch limit outside 1 to 8', () => {
    for (const limit of [0, 9, 1.5, '3']) expect(() => corpus.parseRequest({ sourceId: source.id, limit })).toThrow();
    expect(corpus.parseRequest({ sourceId: source.id, limit: 8 })).toMatchObject({ limit: 8 });
  });
});
