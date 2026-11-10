import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { SourceMediaLibrary } from '../src/routes/SourceMediaLibrary';
import { getVideoTranscript, type TranscriptSettings } from '../src/lib/video-production';
import type { MediaSourceSummary } from '../src/lib/source-media';
const fixture = vi.hoisted(() => ({ id: 'fixture', sourceId: 'video-library', name: 'Fixture interview', mimeType: 'video/mp4', kind: 'video', preview: 'browser', tags: [], rightsStatus: 'complete', sizeBytes: 10, version: 1 }));
const searchMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/components/VideoMeaningSearch', async () => {
  const { useEffect } = await import('react');
  return { VideoMeaningSearch: ({ onOpen }: { onOpen: (asset: unknown, seconds: number) => void }) => {
    useEffect(() => { searchMounts.count += 1; }, []);
    return <button onClick={() => onOpen(fixture, 12)}>Open passage at 12 seconds</button>;
  } };
});
vi.mock('../src/components/VideoProductionTools', () => ({ useVideoProductionTools: ({ onSearchContentChanged, onTranscriptRequested, onTranscriptObserved, onTranscriptReady }: {
  onSearchContentChanged: () => void;
  onTranscriptRequested: (assetId: string, settings: TranscriptSettings, ready: boolean) => void;
  onTranscriptObserved: (assetId: string, settings: TranscriptSettings) => void;
  onTranscriptReady: (assetId: string, settings: TranscriptSettings) => void;
}) => ({
  content: <>
    <button onClick={onSearchContentChanged}>Save transcript fixture</button>
    <button onClick={() => onTranscriptRequested('fixture', { languageCode: 'en-US', maxSpeakers: 10, transcriptId: 'fixture-transcript' }, false)}>Request transcript fixture</button>
    <button onClick={() => onTranscriptRequested('fixture', { languageCode: 'es-US', maxSpeakers: 10, transcriptId: 'alternate-transcript' }, false)}>Request alternate transcript fixture</button>
    <button onClick={() => onTranscriptObserved('fixture', { languageCode: 'en-US', maxSpeakers: 10 })}>Observe queued transcript fixture</button>
    <button onClick={() => onTranscriptReady('fixture', { languageCode: 'en-US', maxSpeakers: 10, transcriptId: 'fixture-transcript' })}>Transcript ready fixture</button>
  </>, onTimeUpdate: vi.fn(),
  editorExportsItem: { key: "editor-export-settings", label: "Broadcast & editing exports…", onSelect: vi.fn() }, downloadItems: [],
}) }));
vi.mock('../src/lib/video-production', () => ({ getVideoTranscript: vi.fn() }));
vi.mock('../src/lib/source-media', () => ({
  listSourceMedia: async () => ({ records: [], total: 0, hasMore: false, nextCursor: null }),
  createSourceMediaRead: async () => ({ url: 'https://fixture.invalid/video.mp4', expiresAt: new Date(Date.now() + 300000).toISOString() }),
}));
function installMediaFeedbackFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split('/').at(-1);
    const body = name === 'cmsGetMediaReview'
      ? { success: true, review: null }
      : name === 'cmsListMediaComments'
        ? { success: true, comments: [], nextCursor: null }
        : null;
    if (!body) throw new Error(`Unexpected request: ${String(input)}`);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }));
}
const source: MediaSourceSummary = { id: 'video-library', label: 'Video library', description: '', mediaKind: 'video', canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: true };
function renderLibrary() {
  const router = createMemoryRouter([{ path: '/', element: <SourceMediaLibrary userId="fixture" source={source} getIdToken={async () => 'fixture'} /> }]);
  render(<RouterProvider router={router} />);
}
async function openPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'Open passage at 12 seconds' }));
  return screen.findByRole('dialog', { name: 'Fixture interview' });
}
function closePreview(dialog: HTMLElement) { fireEvent.click(within(dialog).getAllByRole('button', { name: /^Close$/ })[0]); }
beforeEach(() => {
  vi.mocked(getVideoTranscript).mockReset();
  searchMounts.count = 0;
  installMediaFeedbackFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('transcript hit playback', () => {
  const queued = { transcript: { id: 'fixture-transcript', state: 'queued' } };
  const ready = { transcript: { id: 'fixture-transcript', state: 'ready' } };
  it('keeps the search corpus mounted when a video preview closes', async () => {
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    const dialog = await openPreview();
    closePreview(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fixture interview' })).toBeNull());
    expect(searchMounts.count).toBe(1);
  });
  it('refreshes the search corpus after a transcript changes', async () => {
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(2));
  });
  it('waits to refresh until a requested transcript becomes ready after reopening', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue(queued as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fixture interview' })).toBeNull());
    expect(searchMounts.count).toBe(1);
    dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Transcript ready fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(2));
  });
  it('checks pending transcript status on a later close without opening the transcript section', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValueOnce(queued as never).mockResolvedValueOnce(ready as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(getVideoTranscript).toHaveBeenCalledTimes(1));
    expect(searchMounts.count).toBe(1);
    dialog = await openPreview();
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(2));
    expect(getVideoTranscript).toHaveBeenCalledTimes(2);
  });
  it('refreshes when a paid fallback returns a ready child for the requested parent', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue({ transcript: { id: 'fallback-child', state: 'ready' } } as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(2));
    expect(getVideoTranscript).toHaveBeenCalledTimes(1);
  });
  it('stops checking a transcript that needs reconciliation', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValue({ transcript: { id: 'fixture-transcript', state: 'needs_reconciliation' } } as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(getVideoTranscript).toHaveBeenCalledTimes(1));
    dialog = await openPreview();
    closePreview(dialog);
    await act(async () => { await Promise.resolve(); });
    expect(getVideoTranscript).toHaveBeenCalledTimes(1);
    expect(searchMounts.count).toBe(1);
  });
  it('checks a transcript started elsewhere after the viewer is reopened', async () => {
    vi.mocked(getVideoTranscript).mockResolvedValueOnce(queued as never).mockResolvedValueOnce(ready as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Observe queued transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(getVideoTranscript).toHaveBeenCalledTimes(1));
    expect(searchMounts.count).toBe(1);
    dialog = await openPreview();
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(2));
    expect(getVideoTranscript).toHaveBeenCalledTimes(2);
  });
  it('shares a pending status check across rapid viewer closes', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(getVideoTranscript).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(getVideoTranscript).toHaveBeenCalledTimes(1));
    dialog = await openPreview();
    closePreview(dialog);
    expect(getVideoTranscript).toHaveBeenCalledTimes(1);
    await act(async () => { finish(ready); });
    await waitFor(() => expect(searchMounts.count).toBe(2));
  });
  it('keeps a newer transcript request when an older status check completes', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(getVideoTranscript).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never)
      .mockResolvedValueOnce({ transcript: { id: 'alternate-transcript', state: 'ready' } } as never);
    renderLibrary();
    await waitFor(() => expect(searchMounts.count).toBe(1));
    let dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request transcript fixture' }));
    closePreview(dialog);
    await waitFor(() => expect(getVideoTranscript).toHaveBeenCalledTimes(1));
    dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request alternate transcript fixture' }));
    closePreview(dialog);
    await act(async () => { finish(ready); });
    await waitFor(() => expect(searchMounts.count).toBe(2));
    dialog = await openPreview();
    closePreview(dialog);
    await waitFor(() => expect(searchMounts.count).toBe(3));
    expect(getVideoTranscript).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getVideoTranscript).mock.calls[1][2]).toMatchObject({ transcriptId: 'alternate-transcript' });
  });
  it('preserves the initial timestamp across the zero timeupdate emitted while loading metadata', async () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Open passage at 12 seconds' }));
    const video = await screen.findByLabelText('Preview Fixture interview') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 180 });
    fireEvent.timeUpdate(video);
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(12);
  });
});
