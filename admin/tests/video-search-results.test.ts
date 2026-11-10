import { describe, expect, it } from 'vitest';
import { groupVideoSearchResults, videoPassageContext, videoSearchHighlight } from '../src/lib/video-search-results';
import type { VideoSearchEntry } from '../src/lib/video-search-session-cache';

function entry(index: number, text: string, assetId = 'video'): VideoSearchEntry {
  return { id: `${assetId}/${index}`, text, asset: { id: assetId, sourceId: 'video-library', name: 'Interview', description: null, originalName: 'interview.mp4', mimeType: 'video/mp4', kind: 'video', sizeBytes: 1000, preview: 'browser', license: null, credit: null, tags: [], rightsStatus: 'complete', version: 1, createdAt: null, updatedAt: null },
    chunk: { id: `${assetId}/${index}`, assetId, transcriptId: 'transcript', editRevision: 2, segmentIndex: index, startSeconds: index * 2, endSeconds: index * 2 + 2, text } };
}

describe('grouped video search results', () => {
  it('preserves video relevance, sorts passages by time and counts each hit once', () => {
    const late = entry(4, 'wants');
    const early = entry(1, 'wants');
    const other = entry(0, 'wants', 'other');
    const metadata = { ...early, id: 'asset/video', chunk: undefined };
    const groups = groupVideoSearchResults([late, other, metadata, early, late]);
    expect(groups.map(group => group.entry.asset.id)).toEqual(['video', 'other']);
    expect(groups[0].passages).toEqual([early, late]);
    expect(groups[0].entry.chunk).toBeUndefined();
  });

  it('deduplicates split chunks by video, transcript, revision, segment and start time', () => {
    const first = entry(1, 'first half');
    const split = { ...first, id: 'split', chunk: { ...first.chunk!, id: 'split', text: 'second half' } };
    const variants = [
      { transcriptId: 'other-transcript' }, { editRevision: 3 }, { segmentIndex: 2 }, { startSeconds: 3 },
    ].map((change, index) => ({ ...first, id: `variant-${index}`, chunk: { ...first.chunk!, ...change } }));
    const other = entry(1, 'another video', 'other');
    const groups = groupVideoSearchResults([first, split, ...variants, other]);
    expect(groups[0].passages).toHaveLength(5);
    expect(groups[0].passages).not.toContain(split);
    expect(groups[1].passages).toEqual([other]);
  });

  it('caps videos and passages independently after grouping ranked results', () => {
    const crowded = Array.from({ length: 20 }, (_, index) => entry(20 - index, 'match'));
    const otherVideos = Array.from({ length: 15 }, (_, index) => entry(0, 'match', `other-${index}`));
    const groups = groupVideoSearchResults([...crowded, ...otherVideos]);
    expect(groups).toHaveLength(12);
    expect(groups[0].passages).toHaveLength(12);
    expect(groups[0].passageCount).toBe(20);
    expect(groups[0].passages.map(row => row.chunk!.segmentIndex)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(groups[1].entry.asset.id).toBe('other-0');
  });

  it('keeps name-only matches as a video without fabricated passages', () => {
    const metadata = { ...entry(0, 'Interview'), chunk: undefined };
    expect(groupVideoSearchResults([metadata])).toEqual([{ entry: metadata, passages: [], passageCount: 0 }]);
  });

  it('joins adjacent words into context without borrowing another video or revision', () => {
    const hit = entry(1, 'wants');
    const otherRevision = entry(2, 'stale');
    otherRevision.chunk!.editRevision = 1;
    expect(videoPassageContext(hit, [entry(0, 'She'), hit, entry(2, 'answers.'), entry(0, 'Other', 'other'), otherRevision], 'wants')).toBe('She wants answers.');
  });

  it('does not bridge missing segments or long pauses', () => {
    const hit = entry(1, 'wants');
    const paused = entry(2, 'later');
    paused.chunk!.startSeconds = 20;
    expect(videoPassageContext(hit, [entry(0, 'She'), hit, paused, entry(4, 'omitted')], 'wants')).toBe('She wants');
  });

  it('bounds long context around the literal match and falls back to the selected passage', () => {
    const hit = entry(0, `${'before '.repeat(90)}wants ${'after '.repeat(90)}`);
    const context = videoPassageContext(hit, [], 'wants');
    expect(context).toContain('wants');
    expect(context.length).toBeLessThanOrEqual(302);
    expect(context.startsWith('…')).toBe(true);
  });

  it('highlights case-insensitive literal text safely, including pattern characters', () => {
    expect(videoSearchHighlight('WANTS (a+b) wants', 'wants').filter(part => part.match).map(part => part.text)).toEqual(['WANTS', 'wants']);
    expect(videoSearchHighlight('Say (a+b).', '(a+b)').filter(part => part.match)).toEqual([{ text: '(a+b)', match: true }]);
    expect(videoSearchHighlight('text', '  ')).toEqual([{ text: 'text', match: false }]);
  });
});
