import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCommand } from '../../packages/content-core/src/live-production';
import { LiveProductionWorkspace } from '../src/routes/LiveProductionRoute';
import { ExitGuardProvider } from '../src/routes/ExitGuard';
import { banners, fakeClient, sessionView } from './live-production-fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function studio() {
  const client = fakeClient(), old = banners()[1];
  let view = sessionView();
  view = { ...view, observed: { ...view.observed, state: 'on_air', report: { ...view.observed.report!,
    state: 'on_air', source: 'boardwalk', inputKey: view.mapping.inputs.headline!.key, text: old.record.draft.text,
    correlation: { commandId: 'old-take', bannerId: old.record.id, bannerVersion: 1 } } } };
  client.session = vi.fn(async () => view);
  const command = client.command;
  client.command = vi.fn(async request => {
    const result = await command(request);
    return request.commandAction === 'update_text' ? { ...result, action: 'update_text', expectedLive: view.observed.report! } as LiveCommand : result;
  });
  return { client, get view() { return view; }, setView(next: typeof view) { view = next; } };
}
async function open(s: ReturnType<typeof studio>, variant: 'boardwalk' | 'studio' = 'boardwalk') {
  render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: '/', element: <LiveProductionWorkspace client={s.client} variant={variant} /> }])} /></ExitGuardProvider>);
  await screen.findByRole('option', { name: /Studio rehearsal/ });
  fireEvent.change(screen.getByLabelText('Production session'), { target: { value: 'rehearsal' } });
  fireEvent.click(await screen.findByRole('button', { name: /Headline · v1/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare' }));
}
async function saveUpdate() {
  fireEvent.change(screen.getByLabelText('Headline'), { target: { value: 'Updated saved headline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft saved. Output has not changed.');
}

describe('explicit Update live workspace', () => {
  it.each(['boardwalk', 'studio'] as const)('keeps edits and Save separate, sends the exact saved revision, and waits for observation in %s', async variant => {
    const s = studio(); await open(s, variant); await saveUpdate();
    expect(s.client.command).not.toHaveBeenCalled();
    const update = screen.getByRole('button', { name: 'Update live' });
    expect(update).toBeEnabled(); fireEvent.click(update);
    await waitFor(() => expect(s.client.command).toHaveBeenCalledTimes(1));
    expect(s.client.command).toHaveBeenCalledWith(expect.objectContaining({ commandAction: 'update_text',
      bannerId: 'headline-banner', baseVersion: 2, expectedObservationSequence: 3, expectedClearGeneration: 0 }));
    await screen.findByText(/Update live · saved version 2/);
    expect(screen.getByRole('button', { name: 'Update live' })).toBeDisabled();
    expect(screen.getByText('Awaiting observation', { selector: 'strong' })).toBeInTheDocument();
    const accepted = await vi.mocked(s.client.command).mock.results[0].value;
    s.setView({ ...s.view, observed: { ...s.view.observed, report: { ...s.view.observed.report!, sequence: 4,
      text: { templateId: 'headline', headline: 'Updated saved headline' },
      correlation: { commandId: accepted.id, bannerId: 'headline-banner', bannerVersion: 2 } } } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh studio' }));
    await screen.findByText('Observed', { selector: 'strong' });
  });
  it('keeps Clear available during an update and preserves its newer intent after a late response', async () => {
    const s = studio(); await open(s); await saveUpdate();
    const command = s.client.command;
    let finish!: (value: LiveCommand) => void;
    s.client.command = vi.fn(request => request.commandAction === 'update_text' ? new Promise<LiveCommand>(resolve => { finish = resolve; }) : command(request));
    fireEvent.click(screen.getByRole('button', { name: 'Update live' }));
    const request = vi.mocked(s.client.command).mock.calls[0][0];
    expect(screen.getByRole('button', { name: 'Clear Overlay 1' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Overlay 1' }));
    await waitFor(() => expect(s.client.command).toHaveBeenCalledTimes(2));
    await act(async () => finish(await command(request)));
    expect(screen.getByRole('heading', { name: 'Requested action' }).closest('.live-requested')).toHaveTextContent('Clear Overlay 1');
    expect(screen.getByRole('button', { name: 'Update live' })).toBeDisabled();
  });
  it('shows an uncertain update without retrying on refresh and leaves Clear usable', async () => {
    const s = studio(); await open(s); await saveUpdate();
    s.client.command = vi.fn().mockRejectedValue(new Error('Response lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Update live' }));
    await screen.findByText(/Update live requested; receipt unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh studio' }));
    expect(s.client.command).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Update live' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear Overlay 1' })).toBeEnabled();
  });
  it('names an uncertain Update live correctly after switching sessions', async () => {
    const s = studio(); await open(s); await saveUpdate();
    s.client.command = vi.fn().mockRejectedValue(new Error('Response lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Update live' }));
    await screen.findByText(/Update live requested; receipt unavailable/);
    fireEvent.change(screen.getByLabelText('Production session'), { target: { value: '' } });
    await screen.findByText(/Unresolved Update live outcome in Studio rehearsal/);
    expect(screen.queryByText(/Unresolved Clear outcome/)).not.toBeInTheDocument();
    expect(s.client.command).toHaveBeenCalledTimes(1);
  });
  it.each(['manual', 'stale', 'different_banner'])('does not send an update for %s output', async kind => {
    const s = studio(); await open(s); await saveUpdate();
    const report = s.view.observed.report!;
    s.setView({ ...s.view, ...(kind === 'stale' ? { serverNowMs: 31000 } : {}), observed: { ...s.view.observed,
      report: kind === 'manual' ? { ...report, source: 'manual', correlation: null }
        : kind === 'different_banner' ? { ...report, correlation: { commandId: 'other', bannerId: 'other', bannerVersion: 1 } } : report } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh studio' }));
    await waitFor(() => {
      const button = screen.queryByRole('button', { name: 'Update live' });
      expect(button === null || button.hasAttribute('disabled')).toBe(true);
    });
    expect(s.client.command).not.toHaveBeenCalled();
  });
});
