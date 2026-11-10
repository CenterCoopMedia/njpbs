import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { processingStatus, processingChanges, requesterName } = require('../../functions/lib/video-processing-status');
const { transcriptSummary } = require('../../functions/lib/video-transcript-contract');
const { clipSummary } = require('../../functions/lib/video-clip-contract');

describe('video processing status', () => {
  it('reports legacy queued records without invented work, identity or percentage', () => {
    const result = transcriptSummary({ id: 'job', phase: 'pending', createdAt: '2026-09-15T12:00:00Z' });
    expect(result.state).toBe('queued');
    expect(result.processing).toEqual({ stage: 'queued', provider: 'amazon-transcribe', requestedBy: null,
      requestedAt: '2026-09-15T12:00:00.000Z', startedAt: null, updatedAt: null, completedAt: null,
      percentComplete: null, statusCode: null, localStage: null, fallbackReason: null, estimatedAwsChargeUsd: null });
  });
  it('returns the authenticated requester id and not an unverified display name', () => {
    const result = processingStatus({ phase: 'pending', requestedBy: 'staff-123', requestedByName: 'Forged administrator' }, 'amazon-transcribe');
    expect(result.requestedBy).toBe('staff-123');
    expect(result).not.toHaveProperty('requestedByName');
  });
  it('projects only sanitized server-captured requester names', () => {
    expect(processingStatus({ phase: 'pending', requesterDisplayName: '  Sam Editor  ' }, 'local-whisper'))
      .toHaveProperty('requestedByName', 'Sam Editor');
    for (const name of ['staff@example.test', 'Name\nInjected', 'a'.repeat(101), null]) {
      expect(processingStatus({ phase: 'pending', requesterDisplayName: name }, 'local-whisper')).not.toHaveProperty('requestedByName');
    }
  });
  it('exposes only saved processing checkpoints and safe status codes', () => {
    expect(processingStatus({ phase: 'pending', processingStage: 'preparing', errorCode: 'billing_unavailable' }, 'amazon-transcribe'))
      .toMatchObject({ stage: 'preparing', statusCode: 'billing_unavailable' });
    expect(processingStatus({ phase: 'running', processingStage: 'finalizing', errorCode: 'https://private-output' }, 'amazon-transcribe'))
      .toMatchObject({ stage: 'finalizing', statusCode: null });
  });
  it.each(['input_changed', 'audio_track_missing', 'audio_codec_unsupported', 'audio_timeline_unsupported',
    'audio_duration_unsupported', 'audio_output_invalid', 'attempts_exhausted'])
  ('exposes existing administrator help for terminal audio failure %s', (errorCode) => {
    expect(transcriptSummary({ phase: 'failed', errorCode }).processing)
      .toMatchObject({ stage: 'failed', statusCode: 'processing_failed' });
  });
  it.each(['stale', 'cancelled', 'needs_reconciliation'])('makes %s terminal despite an older active checkpoint', (phase) => {
    expect(processingStatus({ phase, processingStage: 'processing' }, 'amazon-transcribe').stage).toBe('needs_attention');
  });
  it('keeps clip expiration and legacy polling state consistent', () => {
    expect(clipSummary({ phase: 'ready', processingStage: 'processing', expiresAt: '2020-01-01T00:00:00Z' }))
      .toMatchObject({ state: 'expired', processing: { stage: 'expired', provider: 'aws-mediaconvert' } });
  });
  it('rejects email-like, unbounded and control-character requester names', () => {
    for (const value of ['staff@example.org', 'a'.repeat(101), 'Name\nInjected', undefined]) expect(requesterName(value)).toBeNull();
    expect(requesterName('  Sam Editor  ')).toBe('Sam Editor');
  });
  it('timestamps real start and terminal transitions once, without starting on a lease refresh', () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    expect(processingChanges({}, { leaseUntil: 0 }, now)).not.toHaveProperty('startedAt');
    const first = processingChanges({}, { processingStage: 'preparing' }, now);
    expect(first.startedAt).toBe(new Date(now).toISOString());
    expect(processingChanges(first, { phase: 'running' }, now + 1000)).not.toHaveProperty('startedAt');
    const ready = processingChanges(first, { phase: 'ready' }, now + 2000);
    expect(ready.completedAt).toBe(new Date(now + 2000).toISOString());
    expect(processingChanges(ready, { phase: 'ready' }, now + 3000)).not.toHaveProperty('completedAt');
  });
});


describe('BYOK public status boundary', () => {
  it.each(['byok_admission_invalid', 'byok_preparation_failed', 'byok_spool_missing', 'byok_spool_invalid', 'elevenlabs_request_rejected', 'elevenlabs_submission_uncertain'])('exposes fixed code %s without a percentage or AWS estimate', (errorCode) => {
    const result = transcriptSummary({ provider: 'elevenlabs', phase: 'needs_reconciliation', errorCode });
    expect(result.errorCode).toBe(errorCode);
    expect(result.processing).toMatchObject({ statusCode: errorCode, percentComplete: null, estimatedAwsChargeUsd: null });
  });
  it('does not expose raw credential or provider errors', () => {
    const result = transcriptSummary({ provider: 'elevenlabs', phase: 'failed', errorCode: 'private credential error detail' });
    expect(result).not.toHaveProperty('errorCode'); expect(result.processing.statusCode).toBeNull();
  });
});
