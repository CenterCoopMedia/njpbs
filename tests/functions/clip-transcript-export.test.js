import { describe, it, expect } from 'vitest';
import exports from '../../functions/lib/clip-transcript-export.js';
import contract from '../../functions/lib/video-transcript-contract.js';

const clip = { id: 'c'.repeat(64), inMs: 1000, outMs: 3000, output: { frameDurationSeconds: 0.04 } };
const job = { id: 't'.repeat(64), durationSeconds: 5, editRevision: 2, speakerNames: { spk_0: 'Editor' } };
const asset = { id: 'asset', name: 'Interview', version: 1, objectVersionId: 'original-v1', originalName: 'original.mxf', objectKey: 'media/original.mxf' };
const segment = { startSeconds: 0, endSeconds: 4, speaker: 'spk_0', text: 'Before selected words after', words: [
  { startSeconds: 0, endSeconds: 1, text: 'Before' },
  { startSeconds: 1, endSeconds: 2, text: 'selected' },
  { startSeconds: 2, endSeconds: 3, text: 'words' },
  { startSeconds: 3, endSeconds: 4, text: 'after' },
] };

describe('saved clip transcript sidecars', () => {
  it('selects overlapping timed words and rebases captions to the saved clip', () => {
    const result = exports.clipTranscriptExport([segment], job, clip, asset, 'vtt');
    expect(result.body).toContain('00:00:00.000 --> 00:00:02.000');
    expect(result.body).toContain('<v Editor>selected words</v>');
    expect(result.body).not.toContain('Before');
    expect(result.body).not.toContain('after');
    expect(result).toMatchObject({ clipId: clip.id, inMs: 1000, outMs: 3000, revision: 2, timingBasis: 'clip-elapsed' });
    expect(segment.startSeconds).toBe(0);
  });
  it('rebases SRT clip captions without speaker names', () => {
    const result = exports.clipTranscriptExport([segment], job, clip, asset, 'srt');
    expect(result.body).toBe('1\n00:00:00,000 --> 00:00:02,000\nselected words\n');
    expect(result).toMatchObject({ filename: `clip-${clip.id}.srt`, contentType: 'application/x-subrip; charset=utf-8' });
  });
  it('preserves corrected text when the full passage is inside the range', () => {
    const corrected = { ...segment, startSeconds: 1, endSeconds: 3, text: 'Corrected name', words: undefined };
    expect(exports.clipTranscriptExport([corrected], job, clip, asset, 'txt').body).toContain('Corrected name');
  });
  it('refuses a partial corrected passage whose words are not aligned', () => {
    expect(() => exports.clipTranscriptExport([{ ...segment, text: 'Corrected name' }], job, clip, asset, 'txt')).toThrow(/Align the edited transcript/);
  });
  it('accounts for outward frame rounding and refuses missing timing evidence', () => {
    const result = exports.clipTranscriptExport([segment], job, { ...clip, inMs: 1010 }, asset, 'vtt');
    expect(result.body).toContain('00:00:00.010 --> 00:00:02.000');
    expect(() => exports.clipTranscriptExport([segment], job, { ...clip, output: undefined }, asset, 'vtt')).toThrow(/Re-export/);
  });
  it('excludes passages that only touch the boundaries and supports silent ranges', () => {
    const selected = [{ ...segment, endSeconds: 1 }, { ...segment, startSeconds: 3 }];
    expect(exports.clipTranscriptExport(selected, job, clip, asset, 'vtt').body).toBe('WEBVTT\n\n');
  });
  it('omits zero-duration passages inside or outside the selection without blocking valid words', () => {
    const points = [0, 2, 5].map(time => ({ startSeconds: time, endSeconds: time, text: 'point', speaker: 'spk_0' }));
    const result = exports.clipTranscriptExport([...points, segment], job, clip, asset, 'vtt');
    expect(result.body).toContain('selected words');
    expect(result.body).not.toContain('point');
  });
  it('labels the log with clip-relative timing and escapes cell formulas', () => {
    const result = exports.clipTranscriptExport([segment], job, clip, { ...asset, name: '=formula' }, 'tsv');
    expect(result.body).toContain("'=formula\tasset\toriginal-v1\t");
    expect(result.body).toContain('\tclip-elapsed\t0\t2000\t2000\t');
    expect(exports.clipTranscriptExport([segment], job, clip, { ...asset, name: '' }, 'tsv').body).toContain('original.mxf\tasset\toriginal-v1\t');
  });
  it('rejects invalid timing and a range beyond the transcript audio', () => {
    for (const bounds of [{ inMs: -1 }, { outMs: 1000 }, { outMs: 9000 }, { inMs: 1.5 }]) {
      expect(() => exports.clipTranscriptExport([segment], job, { ...clip, ...bounds }, asset, 'txt')).toThrow();
    }
  });
  it('accepts the matching full-source millisecond ceiling', () => {
    const full = { ...clip, inMs: 0, outMs: 3001 };
    const fractional = { ...job, durationSeconds: 3.0005 };
    expect(() => exports.clipTranscriptExport([segment], fractional, full, asset, 'txt')).not.toThrow();
    expect(() => exports.clipTranscriptExport([segment], fractional, { ...full, outMs: 3002 }, asset, 'txt'))
      .toThrow(/exceeds transcript audio duration/);
  });
  it('admits clip ids only on supported download requests', () => {
    const request = { sourceId: 'video-library', assetId: 'asset', clipId: clip.id, format: 'txt' };
    expect(contract.parseTranscriptRequest(request, { download: true }).clipId).toBe(clip.id);
    expect(() => contract.parseTranscriptRequest(request)).toThrow();
    expect(() => contract.parseTranscriptRequest({ ...request, clipId: 'bad' }, { download: true })).toThrow();
    expect(() => contract.parseTranscriptRequest({ ...request, format: 'premiere' }, { download: true })).toThrow();
  });
});
