import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoMeaningSearch } from '../src/components/VideoMeaningSearch';
import { HttpError, postFunction } from '../src/lib/functions';
import { getVideoTranscript } from '../src/lib/video-production';
import { createSourceMediaRead, listSourceMedia, type SourceMediaAssetSummary } from '../src/lib/source-media';
import { invalidateVideoSearchCorpus, updateCachedVideoSearchAsset, videoSearchCacheRevision } from '../src/lib/video-search-session-cache';
import { disposeSessionMeaningSearch } from '../src/lib/meaning-search-session';
import { videoSearchShardStore } from '../src/lib/video-search-shard-cache';
import { clearMediaSessionCache } from '../src/lib/media-session-cache';

const legacyPostFunction = vi.hoisted(() => vi.fn());
const engine = vi.hoisted(() => ({ start: vi.fn(), prepare: vi.fn(), search: vi.fn(), dispose: vi.fn() }));
vi.mock('../../packages/browser-search', () => ({ createMeaningSearch: () => engine, fuseRanks: (a: string[], b: string[], limit: number) => [...new Set([...a, ...b])].slice(0, limit) }));
vi.mock('../src/lib/functions', () => ({ postFunction: vi.fn(), HttpError: class extends Error { constructor(public status: number, _message?: string, public data: Record<string, unknown> = {}) { super('Request failed'); } } }));
vi.mock('../src/lib/video-production', () => ({ getVideoTranscript: vi.fn(), videoTime: (value: number) => `${value}s` }));
vi.mock('../src/lib/source-media', () => ({ createSourceMediaRead: vi.fn(), listSourceMedia: vi.fn() }));
const asset = { id: 'video', sourceId: 'video-library', name: 'Meeting', description: 'Council', tags: ['news'], uploadedBy: { uid: 'staff' }, rightsStatus: 'complete', viewingCopy: { state: 'ready' } };
const chunk = { id: 'video/transcript/2/0', assetId: 'video', transcriptId: 'transcript', editRevision: 2, segmentIndex: 0, text: 'school funding', startSeconds: 12, endSeconds: 18 };
const coverage = { assetsScanned: 1, assetsIndexed: 1, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 };
const item = (fields = {}) => ({ asset, chunks: [chunk], revision: { reviewed: true, languageCode: 'en-US' }, coverage, ...fields });
const batch = (items: ReturnType<typeof item>[], nextCursor: string | null = null) => ({ items, nextCursor, coverage: { ...coverage, assetsScanned: items.length, assetsIndexed: items.length } });
const page = batch([item()]);
const getIdToken = vi.fn(async () => 'token');
const onOpen = vi.fn();
function mount(filters = {}, disabled = false, query = 'school', userId = 'staff') { return render(<VideoMeaningSearch userId={userId} sourceId="video-library" query={query} getIdToken={getIdToken} filters={filters} disabled={disabled} onOpen={onOpen} />); }
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  invalidateVideoSearchCorpus(); disposeSessionMeaningSearch();
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(postFunction).mockImplementation(async (...args) => {
    if ((args[2] as { action?: string }).action === 'manifest') throw new HttpError(400, 'Old Function');
    return legacyPostFunction(...args);
  });
  engine.start.mockResolvedValue(undefined); engine.prepare.mockResolvedValue({ count: 2 }); engine.search.mockResolvedValue([]);
  vi.mocked(legacyPostFunction).mockResolvedValue(page);
  vi.mocked(getVideoTranscript).mockResolvedValue({ success: true, cached: true, segments: undefined, nextCursor: undefined, transcript: { state: 'ready', editRevision: 2 } });
  vi.mocked(createSourceMediaRead).mockResolvedValue({} as never);
  vi.mocked(listSourceMedia).mockResolvedValue({ records: [asset] } as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('private video search with an older Function', () => {
  it('counts coverage only for videos reached before the browser search cap', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const unavailable = { asset: null, chunks: [], revision: null, coverage: { ...coverage, assetsIndexed: 0, assetsUnavailable: 1 } };
    const items = ['a', 'b', 'c', 'd'].map(id => item({ asset: { ...asset, id }, chunks: [{ ...chunk, id: `${id}-chunk`, text: huge }] }));
    vi.mocked(legacyPostFunction).mockResolvedValueOnce({ ...batch([items[0], unavailable as never, ...items.slice(1)]), nextCursor: 'more' });
    mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Browser search limit reached; coverage is partial.');
    expect(screen.getByRole('status')).toHaveTextContent('3 videos checked · 2 transcripts');
  });
  it('falls back to one-video pages when an older Function rejects the batch limit', async () => {
    vi.mocked(legacyPostFunction)
      .mockRejectedValueOnce(new HttpError(400, 'Video search corpus is unavailable'))
      .mockResolvedValueOnce({ asset, chunks: [chunk], revision: { reviewed: true, languageCode: 'en-US' }, coverage, nextCursor: 'next' })
      .mockResolvedValueOnce({ asset: null, chunks: [], revision: null, coverage: { ...coverage, assetsIndexed: 0, assetsUnavailable: 1 }, nextCursor: null });
    mount(); await flush(601);
    expect(vi.mocked(legacyPostFunction).mock.calls.map(call => call[2])).toEqual([
      { sourceId: 'video-library', limit: 8 },
      { sourceId: 'video-library' },
      { sourceId: 'video-library', cursor: 'next' },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Library scan finished. 2 videos checked · 1 transcript');
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
  });
  it('makes no corpus request before staff enter search text', async () => {
    mount({}, false, ''); await flush();
    expect(legacyPostFunction).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Video text search' })).not.toBeInTheDocument();
  });
  it('reuses completed corpus pages across remounts and reloads after invalidation', async () => {
    let pages = 0;
    vi.mocked(legacyPostFunction).mockImplementation(async () => {
      const call = pages++ % 5;
      const ids = Array.from({ length: call === 4 ? 7 : 8 }, (_, index) => call * 8 + index + 1);
      return batch(ids.map(id => item({ asset: { ...asset, id: `video-${id}` }, chunks: [{ ...chunk, id: `chunk-${id}` }] })),
        call === 4 ? null : `cursor-${call + 1}`);
    });
    let view = mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(5);
    expect(screen.getByRole('status')).toHaveTextContent('39 videos checked');
    view.unmount();
    view = mount(); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Library scan finished. 39 videos checked');
    expect(screen.getAllByRole('button', { name: /at 12s$/ })).toHaveLength(12);
    await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(5);
    expect(listSourceMedia).toHaveBeenCalledWith('token', { sourceId: 'video-library', limit: 1 });
    view.unmount();
    invalidateVideoSearchCorpus('video-library');
    mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(10);
  });
  it('does not reuse legacy session text when source access is revoked', async () => {
    const view = mount(); await flush(); view.unmount();
    vi.mocked(listSourceMedia).mockRejectedValueOnce(new HttpError(403, 'Revoked'));
    mount(); await flush();
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('access is unavailable');
  });
  it('keeps the legacy corpus through a hidden-tab cycle without another scan', async () => {
    mount(); await flush();
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true); fireEvent(document, new Event('visibilitychange')); await flush();
    hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange')); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
  });
  it('reuses an oldest-Function single-page corpus through the metadata authorization path', async () => {
    vi.mocked(legacyPostFunction).mockRejectedValueOnce(new HttpError(400, 'No limit support'))
      .mockResolvedValueOnce({ asset, chunks: [chunk], revision: { reviewed: true, languageCode: 'en-US' }, coverage, nextCursor: null });
    const first = mount(); await flush(); first.unmount();
    mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(2);
    expect(listSourceMedia).toHaveBeenCalledWith('token', { sourceId: 'video-library', limit: 1 });
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
  });
  it('keeps five corpus calls after a confirmed metadata save and shows the saved metadata', async () => {
    let pages = 0;
    vi.mocked(legacyPostFunction).mockImplementation(async () => {
      const call = pages++;
      const ids = Array.from({ length: call === 4 ? 7 : 8 }, (_, index) => call * 8 + index + 1);
      return batch(ids.map(id => item({ asset: { ...asset, id: `video-${id}`, name: `Meeting ${id}` },
        chunks: [{ ...chunk, id: `chunk-${id}`, assetId: `video-${id}` }] })), call === 4 ? null : `cursor-${call + 1}`);
    });
    let view = mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(5);
    const requestRevision = videoSearchCacheRevision();
    const updated: SourceMediaAssetSummary = {
      ...asset,
      id: 'video-1',
      name: 'Updated meeting',
      originalName: 'meeting.mp4',
      mimeType: 'video/mp4',
      kind: 'video',
      sizeBytes: 1_000,
      preview: 'browser',
      license: null,
      credit: null,
      rightsStatus: 'pending',
      version: 2,
      uploadedBy: { uid: 'staff', name: 'Staff' },
      viewingCopy: { state: 'ready' },
      createdAt: null,
      updatedAt: null,
    };
    expect(updateCachedVideoSearchAsset('staff', updated, requestRevision)).toBe(true);

    view.unmount();
    view = mount({ rightsStatus: 'pending' }); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(5);
    expect(screen.getByRole('button', { name: 'Open Updated meeting at the start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Meeting 2 at the start' })).not.toBeInTheDocument();
    view.unmount();
  });
  it('keeps other videos visible when the first video has more than twelve matching passages', async () => {
    vi.mocked(legacyPostFunction)
      .mockResolvedValueOnce(batch([item({ chunks: Array.from({ length: 20 }, (_, index) => ({
        ...chunk, id: `chunk-${index}`, segmentIndex: index, startSeconds: index,
      })) })], 'next'))
      .mockResolvedValueOnce(batch([item({ asset: { ...asset, id: 'other', name: 'Other video' },
        chunks: [{ ...chunk, id: 'other-chunk', assetId: 'other' }] })]));
    mount(); await flush();
    expect(screen.getByRole('button', { name: 'Open Meeting at the start' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Other video at the start' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Meeting at/ })).toHaveLength(12);
    expect(screen.getByText('12 of 20 matches')).toBeInTheDocument();
    expect(listSourceMedia).not.toHaveBeenCalled();
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(getVideoTranscript).not.toHaveBeenCalled();
  });

  it('resumes an interrupted corpus scan at its saved cursor', async () => {
    let pages = 0;
    vi.mocked(legacyPostFunction).mockImplementation(async () => {
      pages += 1;
      // The second request stays open until the first view unmounts, as an interrupted scan does.
      if (pages === 2) return new Promise(() => {});
      return batch([item({ asset: { ...asset, id: `video-${pages}` }, chunks: [{ ...chunk, id: `chunk-${pages}` }] })],
        pages < 4 ? `cursor-${pages}` : null);
    });
    let view = mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(2);
    view.unmount();
    view = mount(); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('3 videos checked');
    await flush();
    expect(vi.mocked(legacyPostFunction).mock.calls.map(call => call[2])).toEqual([
      { sourceId: 'video-library', limit: 8 },
      { sourceId: 'video-library', limit: 8, cursor: 'cursor-1' },
      { sourceId: 'video-library', limit: 8, cursor: 'cursor-1' },
      { sourceId: 'video-library', limit: 8, cursor: 'cursor-3' },
    ]);
    view.unmount();
  });
  it('does not share cached corpus text across staff accounts', async () => {
    let view = mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(1);
    view.unmount();
    mount({}, false, 'school', 'other-staff'); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(2);
  });
  it('starts automatically and keeps literal matches available while model loads', async () => {
    engine.start.mockReturnValue(new Promise(() => {}));
    mount(); await flush();
    expect(engine.start).toHaveBeenCalledOnce();
    expect(legacyPostFunction).toHaveBeenCalledWith('cmsGetVideoSearchCorpus', 'token', { sourceId: 'video-library', limit: 8 }, {}, expect.objectContaining({ appCheck: 'unless-automation', signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('button', { name: /at 12s$/ })).toHaveAccessibleDescription('school funding');
    expect(screen.queryByRole('button', { name: /enable|prepare/i })).not.toBeInTheDocument();
  });
  it('follows the whole corpus cursor independently of unfinished embedding', async () => {
    engine.prepare.mockReturnValue(new Promise(() => {}));
    vi.mocked(legacyPostFunction).mockResolvedValueOnce(batch([item()], 'next')).mockResolvedValueOnce(batch([]));
    mount(); await flush();
    expect(legacyPostFunction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(legacyPostFunction).mock.calls[1][2]).toEqual({ sourceId: 'video-library', limit: 8, cursor: 'next' });
  });
  it('preserves tag, uploader and rights filters', async () => {
    mount({ tag: 'other', createdBy: 'someone-else', rightsStatus: 'pending' }); await flush();
    expect(screen.queryByRole('button', { name: /at 12s$/ })).not.toBeInTheDocument();
  });
  it('validates current transcript and media access before opening at its timestamp', async () => {
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(getVideoTranscript).toHaveBeenCalledWith('token', { sourceId: 'video-library', assetId: 'video' }, expect.objectContaining({ transcriptId: 'transcript' }));
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(asset, 12);
  });
  it('checks transcript and asset access concurrently without a discarded signed URL', async () => {
    let finishTranscript!: (value: Awaited<ReturnType<typeof getVideoTranscript>>) => void;
    vi.mocked(getVideoTranscript).mockReturnValue(new Promise(resolve => { finishTranscript = resolve; }));
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(listSourceMedia).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    finishTranscript({ success: true, cached: true, segments: undefined, nextCursor: undefined, transcript: { state: 'ready', editRevision: 2 } }); await flush();
    expect(onOpen).toHaveBeenCalledWith(asset, 12);
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });
  it('renders one video heading with a highlighted passage and opens its heading at the start', async () => {
    mount(); await flush();
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(screen.getByText('school').tagName).toBe('MARK');
    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting at the start' })); await flush();
    expect(getVideoTranscript).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(asset, 0);
  });
  it('clears results when the current media access check denies access', async () => {
    vi.mocked(listSourceMedia).mockRejectedValue(new HttpError(403, 'Denied'));
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Open Meeting at the start' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('no longer available');
  });
  it('opens the refreshed viewing copy after processing completes', async () => {
    vi.mocked(legacyPostFunction).mockResolvedValue(batch([item({ asset: { ...asset, viewingCopy: { state: 'processing' } } })]));
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(listSourceMedia).toHaveBeenCalledWith('token', { sourceId: 'video-library', assetId: 'video' });
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(asset, 12);
  });
  it('does not open a removed asset after transcript validation', async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ records: [] } as never);
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it('removes stale revision results instead of opening them', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue({ success: true, cached: true, segments: undefined, nextCursor: undefined, transcript: { state: 'ready', editRevision: 3 } });
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /at 12s$/ })).not.toBeInTheDocument();
  });
  it('clears private results and stops the worker on revoked access', async () => {
    vi.mocked(getVideoTranscript).mockRejectedValue(new HttpError(403, 'Denied'));
    mount(); await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(onOpen).not.toHaveBeenCalled(); expect(engine.dispose).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /at 12s$/ })).not.toBeInTheDocument();
  });
  it('keeps result navigation disabled while existing work is dirty', async () => {
    mount({}, true); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeDisabled();
  });
  it('aborts pending requests and stops encoding on unmount, and drops the index on sign-out', async () => {
    const view = mount(); await flush();
    const signal = vi.mocked(legacyPostFunction).mock.calls[0][4]?.signal;
    view.unmount(); expect(signal?.aborted).toBe(true);
    expect(engine.prepare).toHaveBeenLastCalledWith([]);
    expect(engine.dispose).not.toHaveBeenCalled();
    clearMediaSessionCache();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
  it('reuses the session index after the search field is cleared and pauses only after new encoding', async () => {
    engine.prepare.mockResolvedValue({ count: 2, encoded: 0 });
    const view = mount(); await flush();
    view.rerender(<VideoMeaningSearch userId="staff" sourceId="video-library" query="" getIdToken={getIdToken} filters={{}} disabled={false} onOpen={onOpen} />); await flush();
    view.rerender(<VideoMeaningSearch userId="staff" sourceId="video-library" query="budget" getIdToken={getIdToken} filters={{}} disabled={false} onOpen={onOpen} />); await flush();
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(legacyPostFunction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('2 passages ready');
  });
});


describe('versioned private video search', () => {
  function shardProtocol() {
    vi.mocked(postFunction).mockImplementation(async (_name, _token, body) => {
      const request = body as { action: string };
      if (request.action === 'check') return { schema: 1, unchanged: true, freshnessMs: 60_000 } as never;
      return (request.action === 'manifest' ? { schema: 1, identity: 'source', usersView: false, initializing: false,
        shards: [{ id: 'video', version: 'version' }], tombstones: [], pending: 0, freshnessMs: 60_000 } :
        { schema: 1, items: [{ ...item(), id: 'video', version: 'version' }] }) as never;
    });
  }
  it('waits for a bounded Retry-After without stale results and resumes automatically', async () => {
    shardProtocol(); mount(); await flush();
    vi.mocked(postFunction).mockResolvedValueOnce({ schema: 1, unchanged: false, freshnessMs: 60_000 } as never)
      .mockRejectedValueOnce(new HttpError(429, 'Wait', { retryAfterSeconds: 120 }));
    await flush(45_000);
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('paused. Retrying in 60 seconds');
    const requests = vi.mocked(postFunction).mock.calls.length;
    await flush(59_999); expect(postFunction).toHaveBeenCalledTimes(requests);
    await flush(1);
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Library scan finished');
    await flush(1_000);
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
  });
  it('stops after two automatic rate retries and offers a manual retry', async () => {
    vi.mocked(postFunction).mockRejectedValue(new HttpError(429, 'Wait', { retryAfterSeconds: 2 }));
    mount(); await flush(4_000);
    expect(postFunction).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('status')).toHaveTextContent('paused. Select Retry');
    await flush(60_000); expect(postFunction).toHaveBeenCalledTimes(3);
    shardProtocol(); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
  it('cancels a rate wait on a new query and does not issue the old retry', async () => {
    shardProtocol();
    vi.mocked(postFunction).mockRejectedValueOnce(new HttpError(429, 'Wait', { retryAfterSeconds: 60 }));
    const view = mount(); await flush();
    const waitingSignal = vi.mocked(postFunction).mock.calls[0][4]?.signal;
    view.rerender(<VideoMeaningSearch userId="staff" sourceId="video-library" query="county" getIdToken={getIdToken} filters={{}} disabled={false} onOpen={onOpen} />);
    await flush(); expect(waitingSignal?.aborted).toBe(true);
    const manifests = () => vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'manifest');
    expect(manifests()).toHaveLength(2);
    await flush(60_000); expect(manifests()).toHaveLength(2);
  });
  it('cancels a rate wait on unmount', async () => {
    vi.mocked(postFunction).mockRejectedValue(new HttpError(429, 'Wait', { retryAfterSeconds: 60 }));
    const view = mount(); await flush(); view.unmount(); await flush(120_000);
    expect(postFunction).toHaveBeenCalledOnce();
  });
  it('cancels an unvalidated shard rate wait while hidden and resumes once visible', async () => {
    shardProtocol();
    vi.mocked(postFunction).mockRejectedValueOnce(new HttpError(429, 'Wait', { retryAfterSeconds: 60 }));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    mount(); await flush();
    const signal = vi.mocked(postFunction).mock.calls[0][4]?.signal;
    hidden.mockReturnValue(true); fireEvent(document, new Event('visibilitychange')); await flush(120_000);
    expect(signal?.aborted).toBe(true);
    expect(postFunction).toHaveBeenCalledOnce();
    expect(engine.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange')); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'manifest')).toHaveLength(2);
  });
  it('clears expired text before revalidation and keeps it hidden after revocation', async () => {
    shardProtocol(); mount(); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    vi.mocked(postFunction).mockRejectedValue(new HttpError(403, 'Revoked'));
    await flush(60_000);
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('access is unavailable');
  });
  it('keeps one legacy scan over a five-minute warmup at the actual corpus boundary', async () => {
    const { createRequire } = await import('node:module');
    const server = createRequire(import.meta.url)('../../functions/video-search-corpus.js');
    const source = { id: 'video-library', bucket: 'private', prefix: '', access: 'active_staff', writable: true };
    const catalog = new Map(Array.from({ length: 16 }, (_, index) => {
      const id = `video-${String(index).padStart(2, '0')}`;
      return [id, { sourceId: source.id, lifecycle: 'active', kind: 'video', name: 'Meeting', originalName: 'meeting.mp4',
        nameSort: 'meeting', updatedAtSort: '2026-09-16T12:00:00Z', mimeType: 'video/mp4', sizeBytes: 10,
        version: 1, preview: 'browser', rightsStatus: 'complete', objectKey: `objects/${id}.mp4`, objectVersionId: 'v1', tags: [] }];
    }));
    const jobs = new Map([...catalog.keys()].map(id => [`job-${id}`, { id: `job-${id}`, assetId: id,
      phase: 'ready', editRevision: 0, languageCode: 'en-US' }]));
    let reads = 0, gets = 0, scans = 0;
    const snapshot = (name: string, id: string, data: unknown): any => ({ id, data: () => data, ref: { get: async () => {
      reads++; return snapshot(name, id, (name === 'mediaSourceAssets' ? catalog : jobs).get(id));
    } } });
    const firestore: any = { collection(name: string) {
      let after = '', limit = Infinity;
      const filters: [string, unknown][] = [];
      const values = name === 'mediaSourceAssets' ? catalog : jobs;
      const query: any = { doc: (id: string) => snapshot(name, id, values.get(id)).ref,
        where(field: string, _operator: string, value: unknown) { filters.push([field, value]); return query; },
        orderBy() { return query; }, startAfter(value: string) { after = value; return query; },
        limit(value: number) { limit = value; return query; }, async get() {
          const rows = [...values].filter(([id, row]) => id > after && filters.every(([field, value]) => (row as any)[field] === value))
            .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit);
          reads += Math.max(1, rows.length);
          return { docs: rows.map(([id, row]) => snapshot(name, id, row)) };
        } };
      return query;
    } };
    const handler = server.createVideoSearchCorpusHandler({ firestore, configFn: () => ({ bucket: 'renditions' }),
      registryFn: () => new Map([[source.id, source]]), bootstrap: async () => ({ complete: false, epoch: '00000000-0000-4000-8000-000000000000' }),
      verifyAppCheckFn: async () => {}, requirePrincipalFn: async () => ({ uid: 'staff' }), authorizeFn: async () => {},
      processor: { read: async () => { gets++; return [{ text: 'school funding', startSeconds: 12, endSeconds: 18 }]; } },
      getJob: async ({ request }: any) => {
        await firestore.collection('mediaSourceAssets').doc(request.assetId).get();
        return (await firestore.collection('mediaSourceTranscriptJobs').doc(request.transcriptId).get()).data();
      }, shardStorage: {},
    });
    vi.mocked(postFunction).mockImplementation(async (_name, _token, body) => {
      if (!(body as { action?: string }).action) scans++;
      const response: any = { set() {}, status(code: number) { this.code = code; return this; }, json(value: unknown) { this.body = value; } };
      await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body }, response);
      expect(response.code).toBe(200); return response.body;
    });
    mount(); await flush(); await flush(5 * 60_000);
    expect(scans).toBe(2); expect(reads).toBe(145); expect(gets).toBe(16);
    expect(screen.getByRole('status')).toHaveTextContent('16 videos checked');
  });
  it('keeps stored shards after a transient result-open error', async () => {
    shardProtocol(); mount(); await flush();
    const remove = vi.spyOn(videoSearchShardStore, 'remove').mockResolvedValue();
    vi.mocked(listSourceMedia).mockRejectedValueOnce(new HttpError(503, 'Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(remove).not.toHaveBeenCalled();
  });
  it.each([404, 410])('drops only the missing result shard on %i', async status => {
    shardProtocol(); mount(); await flush();
    vi.spyOn(videoSearchShardStore, 'read').mockResolvedValue({ identity: 'source', shards: { video: { id: 'video' }, other: { id: 'other' } } } as never);
    const write = vi.spyOn(videoSearchShardStore, 'write').mockResolvedValue();
    const remove = vi.spyOn(videoSearchShardStore, 'remove').mockResolvedValue();
    vi.mocked(listSourceMedia).mockRejectedValueOnce(new HttpError(status, 'Missing'));
    fireEvent.click(screen.getByRole('button', { name: 'Meeting at 12s' })); await flush();
    expect(remove).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(JSON.stringify(['staff', 'video-library']), { identity: 'source', shards: { other: { id: 'other' } } });
  });
  it('revalidates once after a concurrent shard edit without user input', async () => {
    shardProtocol();
    vi.mocked(postFunction).mockResolvedValueOnce({ schema: 1, identity: 'source', epoch: 'epoch', usersView: false, initializing: false,
      shards: [{ id: 'video', version: 'version' }], tombstones: [], pending: 0, freshnessMs: 60_000 } as never)
      .mockRejectedValueOnce(new HttpError(409, 'Changed'));
    mount(); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'manifest')).toHaveLength(2);
  });
  it('bounds automatic retries when the source keeps changing', async () => {
    vi.mocked(postFunction).mockImplementation(async (_name, _token, body) => {
      if ((body as { action?: string }).action === 'manifest') return { schema: 1, identity: 'source', epoch: 'epoch', usersView: false,
        initializing: false, shards: [{ id: 'video', version: 'v' }], tombstones: [], pending: 0, freshnessMs: 60_000 } as never;
      throw new HttpError(409, 'Changed');
    });
    mount(); await flush(); await flush(5 * 60_000);
    expect(vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'manifest')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('could not be refreshed');
  });
  it('renews unchanged access without restarting a long-running encoder', async () => {
    shardProtocol();
    let finish!: (value: { count: number; encoded: number }) => void;
    engine.prepare.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mount(); await flush(); await flush(120_000);
    expect(engine.start).toHaveBeenCalledOnce(); expect(engine.dispose).not.toHaveBeenCalled();
    expect(vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'manifest')).toHaveLength(1);
    expect(vi.mocked(postFunction).mock.calls.filter(call => (call[2] as { action?: string }).action === 'check')).toHaveLength(2);
    finish({ count: 2, encoded: 0 }); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('2 passages ready');
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
  });
  it('clears private results while hidden and validates again on return', async () => {
    shardProtocol(); mount(); await flush();
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true); fireEvent(document, new Event('visibilitychange')); await flush();
    expect(screen.queryByRole('button', { name: 'Meeting at 12s' })).not.toBeInTheDocument();
    hidden.mockReturnValue(false); fireEvent(document, new Event('visibilitychange')); await flush();
    expect(screen.getByRole('button', { name: 'Meeting at 12s' })).toBeInTheDocument();
    hidden.mockRestore();
  });
});
