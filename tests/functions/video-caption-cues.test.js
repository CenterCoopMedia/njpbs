import { describe, it, expect } from 'vitest';
import captions from '../../functions/lib/video-caption-cues.js';
import contract from '../../functions/lib/video-transcript-contract.js';
import clips from '../../functions/lib/clip-transcript-export.js';

// Paragraph-shaped provider output reproduces the caption shown in Jules's report.
const paragraph = 'Yeah. I mean, if you cover immigration or criminal justice long enough, you will find that these processes are not explained by anyone. You know, the judges involved often don\'t know what the rules are. And so very often these people are, when they are released, are just sort of let out into the world. Sometimes they don\'t even have laces on their hands.';
const tokens = paragraph.split(' ');
const words = tokens.map((text, index) => ({ text, startSeconds: 10 + index * 0.4, endSeconds: 10.34 + index * 0.4 }));
const passage = { speaker: 'spk_0', text: paragraph, startSeconds: 10, endSeconds: words.at(-1).endSeconds, words };
const plainText = (cues) => cues.map(cue => cue.text).join(' ').replace(/\s+/g, ' ');

function checkCues(cues, source) {
  expect(cues.length).toBeGreaterThan(1);
  expect(plainText(cues)).toBe(source.text);
  for (const [index, cue] of cues.entries()) {
    expect(cue.text.split('\n').length).toBeLessThanOrEqual(2);
    expect(cue.text.split('\n').every(line => line.length <= 42)).toBe(true);
    expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    expect(cue.endSeconds - cue.startSeconds).toBeLessThanOrEqual(7);
    expect(cue.startSeconds).toBeGreaterThanOrEqual(source.startSeconds);
    expect(cue.endSeconds).toBeLessThanOrEqual(source.endSeconds);
    if (index) expect(cue.startSeconds).toBeGreaterThanOrEqual(cues[index - 1].endSeconds);
  }
}

describe('distribution caption cues', () => {
  it('splits a real paragraph into short cues on the supplied word times without changing the passage', () => {
    const original = structuredClone(passage);
    const cues = captions.captionCues([passage]);
    checkCues(cues, passage);
    for (const cue of cues) {
      expect(words.some(word => word.startSeconds.toFixed(3) === cue.startSeconds.toFixed(3))).toBe(true);
      expect(words.some(word => word.endSeconds.toFixed(3) === cue.endSeconds.toFixed(3))).toBe(true);
    }
    expect(passage).toEqual(original);
    expect(contract.transcriptExports([passage]).txt).toContain(paragraph);
  });

  it('uses the same cue text and line breaks in SRT and escaped WebVTT', () => {
    const cues = captions.captionCues([passage]);
    const srt = contract.transcriptSrt([passage]);
    const vtt = contract.transcriptExports([passage], { spk_0: '<Editor & guest>' }).vtt;
    expect(srt.trim().split('\n\n')).toHaveLength(cues.length);
    expect(vtt.trim().split('\n\n').slice(1)).toHaveLength(cues.length);
    for (const cue of cues) {
      expect(srt).toContain(cue.text);
      expect(vtt).toContain(`<v &lt;Editor &amp; guest&gt;>${cue.text}</v>`);
    }
    expect(srt).not.toContain('Editor');
  });

  it('keeps corrected words with estimated cue times when alignment is missing or stale', () => {
    const corrected = { ...passage, text: paragraph.replace('criminal justice', 'local government') };
    const stale = captions.captionCues([corrected]);
    const missing = captions.captionCues([{ ...corrected, words: undefined }]);
    checkCues(stale, corrected);
    expect(stale).toEqual(missing);
  });

  it('splits on pauses and speaker turns, caps long holds, and omits empty intervals', () => {
    const segments = [
      { speaker: 'spk_0', startSeconds: 0, endSeconds: 5, text: 'First second', words: [
        { text: 'First', startSeconds: 0, endSeconds: 1 }, { text: 'second', startSeconds: 4, endSeconds: 5 },
      ] },
      { speaker: 'spk_1', startSeconds: 5, endSeconds: 25, text: 'Held' },
      { speaker: 'spk_0', startSeconds: 25, endSeconds: 25, text: 'point' },
      { speaker: 'spk_0', startSeconds: 25, endSeconds: 26, text: ' \n ' },
    ];
    expect(captions.captionCues(segments)).toEqual([
      { speaker: 'spk_0', startSeconds: 0, endSeconds: 1, text: 'First' },
      { speaker: 'spk_0', startSeconds: 4, endSeconds: 5, text: 'second' },
      { speaker: 'spk_1', startSeconds: 5, endSeconds: 12, text: 'Held' },
    ]);
  });

  it('keeps an unbroken URL intact in its own cue', () => {
    const url = 'https://example.org/' + 'long'.repeat(15);
    expect(captions.captionCues([{ ...passage, text: `See ${url} today`, words: undefined }]).map(cue => cue.text))
      .toEqual(['See', url, 'today']);
  });

  it('preserves text and permits saving a provider passage that collapses to a single millisecond', () => {
    const tiny = { ...passage, startSeconds: 99.999, endSeconds: 100, words: undefined };
    const cues = captions.captionCues([tiny]);
    expect(plainText(cues)).toBe(paragraph);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue).toMatchObject({ startSeconds: 99.999, endSeconds: 100 });
      expect(cue.text.split('\n').length).toBeLessThanOrEqual(2);
      expect(cue.text.split('\n').every(line => line.length <= 42)).toBe(true);
    }
    expect(contract.transcriptExports([tiny]).txt).toContain(paragraph);
    expect(contract.transcriptExports([tiny]).vtt).toContain('00:01:39.999 --> 00:01:40.000');
    const fractional = captions.captionCues([{ ...tiny, startSeconds: 99.9991, endSeconds: 99.9992 }]);
    expect(plainText(fractional)).toBe(paragraph);
    expect(fractional.every(cue => cue.startSeconds === 99.999 && cue.endSeconds === 100)).toBe(true);
    const eof = captions.captionCues([{ ...tiny, startSeconds: 99.9996, endSeconds: 100 }]);
    expect(plainText(eof)).toBe(paragraph);
    expect(eof.every(cue => cue.startSeconds === 99.999 && cue.endSeconds === 100)).toBe(true);
  });

  it('orders overlapping speaker cues by start time without losing either speaker\'s words', () => {
    const guest = { speaker: 'spk_1', startSeconds: 13, endSeconds: 14, text: 'A second speaker.' };
    const cues = captions.captionCues([passage, guest]);
    expect(cues.map(cue => cue.startSeconds)).toEqual(cues.map(cue => cue.startSeconds).toSorted((a, b) => a - b));
    expect(plainText(cues.filter(cue => cue.speaker === passage.speaker))).toBe(paragraph);
    expect(plainText(cues.filter(cue => cue.speaker === guest.speaker))).toBe(guest.text);
    expect(cues[1].speaker).toBe('spk_1');
  });

  it('handles overlapping and zero-duration provider words without invalid cue intervals', () => {
    const overlapping = { ...passage, words: words.map((word, index) => ({ ...word, endSeconds: index < words.length - 1 ? word.endSeconds + 0.2 : word.endSeconds })) };
    checkCues(captions.captionCues([overlapping]), overlapping);
    const zero = { ...passage, words: words.map((word, index) => index === 2 ? { ...word, endSeconds: word.startSeconds } : word) };
    checkCues(captions.captionCues([zero]), zero);
  });

  it('rebases timed words before splitting a clip and preserves the source word alignment', () => {
    const clip = { inMs: 10000, outMs: 20000, output: { sourceStartSeconds: 10, sourceFrameDurationSeconds: 0.04 } };
    const selected = clips.clipTranscriptSegments([passage], clip);
    const cues = captions.captionCues(selected);
    expect(selected[0].words[0].startSeconds).toBe(0);
    expect(selected[0].words.at(-1).endSeconds).toBeLessThanOrEqual(10);
    expect(passage.words[0].startSeconds).toBe(10);
    checkCues(cues, selected[0]);
    expect(cues[0].startSeconds).toBe(0);
    for (const cue of cues) expect(selected[0].words.some(word => word.startSeconds.toFixed(3) === cue.startSeconds.toFixed(3))).toBe(true);
  });
});
