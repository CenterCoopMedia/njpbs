import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMediaMeaningSession, MediaMeaningResults } from '../src/components/MediaMeaningResults';
import { DEFAULT_MEDIA_QUERY } from '../src/lib/media-query';
import { HttpError, type MediaAssetSummary, type ListMediaResponse, type MediaCorpusResponse } from '../src/lib/functions';
const engine = vi.hoisted(() => ({ start: vi.fn(), prepare: vi.fn(), search: vi.fn(), dispose: vi.fn() }));
vi.mock('../../packages/browser-search', () => ({ createMeaningSearch: () => engine }));
const asset = { id: 'asset', name: 'Original title', description: 'Council budget', altText: '', tags: [], credit: '', category: 'news', categories: ['news'], kind: 'image' } as unknown as MediaAssetSummary;
const response = (records = [asset], pageCount = 1): ListMediaResponse => ({ success: true, records, total: records.length, allCount: records.length, page: 1, pageCount, categoryCounts: {}, kindCounts: { image: records.length, document: 0 } });
const loadMedia = vi.fn();
const loadCorpus = vi.fn();
const corpus = (records = [asset], nextCursor: string | null = null): MediaCorpusResponse => ({ success: true, records, nextCursor });
const onSelect = vi.fn();
const query = { ...DEFAULT_MEDIA_QUERY, q: 'local taxes' };
const props = { identity: 'staff', query, loadMedia, loadCorpus, onSelect };
// Related results starts closed; the tests that read its matches open it as a person would.
const openRelated = () => fireEvent.click(screen.getByRole('button', { name: /^Related results/ }));
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => { clearMediaMeaningSession(); vi.useFakeTimers(); vi.clearAllMocks(); engine.start.mockResolvedValue(undefined); engine.prepare.mockResolvedValue({ count: 1 }); engine.search.mockResolvedValue([{ id: 'asset', score: 0.8 }]); loadMedia.mockResolvedValue(response()); loadCorpus.mockResolvedValue(corpus()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('media meaning result selection', () => {
  it('Related results is closed by default, its summary is the status sentence, and opening it starts no request', async () => {
    render(<MediaMeaningResults {...props} />); await flush(); await flush(181);
    const toggle = screen.getByRole('button', { name: /^Related results/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const status = screen.getByRole('status');
    expect(toggle.closest('.media-meaning-summary')).toContainElement(status);
    expect(status).toHaveTextContent('Media scan finished. 1 of 1 loaded media items indexed.');
    expect(toggle).toHaveAccessibleDescription('Media scan finished. 1 of 1 loaded media items indexed.');
    // The count tells a person there is something to open without pushing the grid down.
    expect(toggle).toHaveAccessibleName('Related results, 1 found');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(body).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Original title' })).toBeNull();
    const reads = loadCorpus.mock.calls.length;
    const searches = engine.search.mock.calls.length;

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).toBeVisible();
    expect(within(body).getByRole('heading', { name: 'Related media' })).toBeInTheDocument();
    expect(within(body).getByRole('button', { name: 'Original title' })).toBeInTheDocument();
    await flush(1000);
    fireEvent.click(toggle);
    await flush(1000);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(loadCorpus).toHaveBeenCalledTimes(reads);
    expect(engine.search).toHaveBeenCalledTimes(searches);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();
  });

  it('keeps the closed summary to one row, so a longer status never pushes the grid down, and lets it wrap once opened', async () => {
    render(<MediaMeaningResults {...props} />); await flush();
    const section = screen.getByRole('region', { name: 'Media meaning search' });
    expect(section).not.toHaveAttribute('data-open');
    fireEvent.click(screen.getByRole('button', { name: /^Related results/ }));
    expect(section).toHaveAttribute('data-open', 'true');
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.media-meaning-results:not\(\[data-open\]\) \.media-meaning-summary \{\s*flex-wrap: nowrap;/);
    expect(css).toMatch(/\.media-meaning-results:not\(\[data-open\]\) \.media-meaning-summary > p \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  });

  it('loads automatically and re-reads the exact ID under current filters before selection', async () => {
    render(<MediaMeaningResults {...props} />); openRelated(); await flush(); await flush(181);
    loadMedia.mockResolvedValueOnce(response([{ ...asset, name: 'Current title' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Original title' })); await flush();
    expect(loadMedia).toHaveBeenLastCalledWith({ ...query, q: '', page: 1, assetIds: ['asset'] });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Current title' }));
  });
  it('shows a disabled result and explanation while edits are dirty', async () => {
    render(<MediaMeaningResults {...props} disabled />); openRelated(); await flush(); await flush(181);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeDisabled();
    expect(screen.getByText('Save or discard your changes before opening another media item.')).toBeInTheDocument();
  });
  it('rejects a result removed by the current access-controlled read', async () => {
    render(<MediaMeaningResults {...props} />); openRelated(); await flush(); await flush(181);
    loadMedia.mockResolvedValueOnce(response([]));
    fireEvent.click(screen.getByRole('button', { name: 'Original title' })); await flush();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /^Related results/ });
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(body).getByRole('alert')).toHaveTextContent('This media item changed or is no longer available. Reload the library to refresh search.');
    fireEvent.click(toggle);
    expect(body).not.toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('rechecks dirty state after a pending authorization read', async () => {
    const view = render(<MediaMeaningResults {...props} />); openRelated(); await flush(); await flush(181);
    let resolve!: (value: ListMediaResponse) => void;
    loadMedia.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Original title' }));
    view.rerender(<MediaMeaningResults {...props} disabled />);
    await act(async () => resolve(response()));
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('does not apply a selection after account/filter change or unmount', async () => {
    const view = render(<MediaMeaningResults {...props} />); openRelated(); await flush(); await flush(181);
    let resolve!: (value: ListMediaResponse) => void;
    loadMedia.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Original title' }));
    view.rerender(<MediaMeaningResults {...props} identity="other" query={{ ...query, categories: ['station'] }} />);
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
    view.unmount(); await act(async () => resolve(response()));
    expect(onSelect).not.toHaveBeenCalled(); expect(engine.dispose).toHaveBeenCalled();
  });
  it('reports a model failure that arrives after the media scan', async () => {
    let reject!: (error: Error) => void;
    engine.start.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    render(<MediaMeaningResults {...props} />); openRelated(); await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Media scan finished.');
    await act(async () => reject(new Error('Model download failed')));
    expect(screen.getByRole('status')).toHaveTextContent('Meaning search is unavailable; keyword search still works.');
    expect(engine.prepare).not.toHaveBeenCalled();
  });
  it('replaces the searchable set after a successful media mutation', async () => {
    const view = render(<MediaMeaningResults {...props} refreshRevision={0} />); openRelated(); await flush(); await flush(181);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
    const added = { ...asset, id: 'new-asset', name: 'New library photo' };
    loadCorpus.mockResolvedValue(corpus([added]));
    engine.search.mockResolvedValue([{ id: added.id, score: 0.8 }]);
    view.rerender(<MediaMeaningResults {...props} refreshRevision={1} />); await flush(); await flush(181);
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New library photo' })).toBeInTheDocument();
    // The worker index is kept; the next prepare replaces its searchable set, so the old asset is gone.
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(engine.prepare).toHaveBeenLastCalledWith([expect.objectContaining({ id: added.id })]);
  });

  it('does not read the library until a search is entered', async () => {
    const view = render(<MediaMeaningResults {...props} query={{ ...query, q: ' ' }} />); openRelated();
    await flush();
    await flush(1000);
    expect(loadCorpus).not.toHaveBeenCalled();
    expect(engine.start).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Type a search to find related media.');
    view.rerender(<MediaMeaningResults {...props} />);
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
  });

  it('reuses one unfiltered scan for filter changes and remounts', async () => {
    const document = { ...asset, id: 'doc', name: 'Budget pdf', kind: 'document' } as MediaAssetSummary;
    const station = { ...asset, id: 'station-asset', name: 'Station logo', category: 'station', categories: ['station'] } as MediaAssetSummary;
    loadCorpus.mockResolvedValue(corpus([asset, document, station]));
    engine.search.mockResolvedValue([
      { id: 'asset', score: 0.9 },
      { id: 'doc', score: 0.8 },
      { id: 'station-asset', score: 0.7 },
    ]);
    const newsQuery = { ...query, categories: ['news'], kinds: ['image' as const] };
    const view = render(<MediaMeaningResults {...props} query={newsQuery} />); openRelated();
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    expect(loadCorpus).toHaveBeenCalledWith({ limit: 500 });
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Budget pdf' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Station logo' })).not.toBeInTheDocument();
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, categories: ['station'] }} />);
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Station logo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
    view.unmount();
    render(<MediaMeaningResults {...props} query={{ ...query, categories: ['station'] }} />); openRelated();
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Station logo' })).toBeInTheDocument();
  });

  it('advances through an empty authorized batch without using the grid loader', async () => {
    loadCorpus.mockResolvedValueOnce(corpus([], 'next-batch'));
    loadCorpus.mockResolvedValueOnce(corpus());
    render(<MediaMeaningResults {...props} />); openRelated();
    await flush(); await flush(600); await flush(181);
    expect(loadCorpus.mock.calls).toEqual([[{ limit: 500 }], [{ limit: 500, cursor: 'next-batch' }]]);
    expect(loadMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
  });

  it.each([400, 401, 403])('clears partial results after a %s refusal without a full-scan fallback', async status => {
    loadCorpus.mockResolvedValueOnce(corpus([asset], 'next-batch'));
    loadCorpus.mockRejectedValueOnce(new HttpError(status, 'Refused'));
    render(<MediaMeaningResults {...props} />); openRelated();
    await flush(); await flush(181);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
    await flush(600);
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Media meaning search is unavailable.');
    expect(engine.dispose).toHaveBeenCalled();
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(loadMedia).not.toHaveBeenCalled();
  });

  it('stops on a repeated cursor and clears partial results', async () => {
    loadCorpus.mockResolvedValue(corpus([asset], 'same'));
    render(<MediaMeaningResults {...props} />); await flush(); await flush(1200);
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Media meaning search is unavailable.');
  });

  it('never starts an eleventh raw-record batch', async () => {
    loadCorpus.mockImplementation(async () => corpus([], `cursor-${loadCorpus.mock.calls.length}`));
    render(<MediaMeaningResults {...props} />); await flush(); await flush(6600);
    expect(loadCorpus).toHaveBeenCalledTimes(10);
    expect(screen.getByRole('status')).toHaveTextContent('Media meaning search is unavailable.');
  });

  it('discards an in-flight corpus batch after the account changes', async () => {
    let resolve!: (value: MediaCorpusResponse) => void;
    loadCorpus.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    loadCorpus.mockResolvedValueOnce(corpus([]));
    const view = render(<MediaMeaningResults {...props} />); openRelated(); await flush();
    view.rerender(<MediaMeaningResults {...props} identity="other" />); await flush();
    await act(async () => resolve(corpus([asset], 'old-next'))); await flush(1000);
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
  });

  it('accepts a completed tenth batch', async () => {
    loadCorpus.mockImplementation(async () => corpus([], loadCorpus.mock.calls.length < 10 ? `cursor-${loadCorpus.mock.calls.length}` : null));
    render(<MediaMeaningResults {...props} />); await flush(); await flush(6000);
    expect(loadCorpus).toHaveBeenCalledTimes(10);
    expect(screen.getByRole('status')).toHaveTextContent('Media scan finished.');
    expect(screen.getByRole('status')).not.toHaveTextContent('partial');
  });

  it('reads the library again after a failed scan when the search changes', async () => {
    loadCorpus.mockRejectedValueOnce(new Error('temporary'));
    const view = render(<MediaMeaningResults {...props} />); openRelated();
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Media meaning search is unavailable.');
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    loadCorpus.mockResolvedValue(corpus());
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, q: 'park budget' }} />);
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
  });

  it('retries after a failure when the search changed while the failed read was pending', async () => {
    let fail!: (error: Error) => void;
    loadCorpus.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const view = render(<MediaMeaningResults {...props} />); openRelated();
    await flush();
    // The search changes while the first library read is still pending, then that read fails.
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, q: 'park budget' }} />);
    await flush();
    await act(async () => fail(new Error('temporary')));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Media meaning search is unavailable.');
    expect(loadCorpus).toHaveBeenCalledTimes(1);

    // Going back to the text the failed read started with is a change from what the failure saw.
    loadCorpus.mockResolvedValue(corpus());
    view.rerender(<MediaMeaningResults {...props} />);
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Original title' })).toBeInTheDocument();
  });

  it('drops a cached scan when media changes while the search field is empty', async () => {
    const view = render(<MediaMeaningResults {...props} refreshRevision={0} />); openRelated();
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, q: '' }} refreshRevision={1} />);
    await flush();
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    view.unmount();
    const added = { ...asset, id: 'new-asset', name: 'New library photo' };
    loadCorpus.mockResolvedValue(corpus([added]));
    engine.search.mockResolvedValue([{ id: added.id, score: 0.8 }]);
    render(<MediaMeaningResults {...props} refreshRevision={0} />); openRelated();
    await flush();
    await flush(181);
    expect(loadCorpus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'New library photo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Original title' })).not.toBeInTheDocument();
  });

  it('keeps the session index across a cleared search and a remount, and drops it with the session', async () => {
    const view = render(<MediaMeaningResults {...props} />); await flush();
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, q: '' }} />); await flush();
    view.rerender(<MediaMeaningResults {...props} query={{ ...query, q: 'parks' }} />); await flush();
    view.unmount();
    expect(engine.prepare).toHaveBeenLastCalledWith([]);
    render(<MediaMeaningResults {...props} />); await flush();
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(loadCorpus).toHaveBeenCalledTimes(1);
    clearMediaMeaningSession();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
