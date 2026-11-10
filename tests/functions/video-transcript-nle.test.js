import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import nle from '../../functions/lib/video-transcript-nle.js';
import contract from '../../functions/lib/video-transcript-contract.js';
import processorModule from '../../functions/lib/video-transcript-processor.js';
const job = { id: 'a'.repeat(64), editRevision: 2, languageCode: 'en-US', durationSeconds: 60, totalSegments: 1,
  speakerNames: { spk_0: 'Person' }, speakerRoles: { spk_0: 'Reporter' }, editedOutputs: { 'segments.json': 'cache-v2' } };
const segment = { startSeconds: 1.001, endSeconds: 2, speaker: 'spk_0', text: 'Hello world.', words: [
  { startSeconds: 1.001, endSeconds: 1.5, text: 'Hello', confidence: 0.9 }, { startSeconds: 1.5, endSeconds: 2, text: 'world.' },
] };
const uuid = '631fbbc0-9c02-47c4-bb8c-732c020fa24f';
const request = { sourceId: 'video-library', assetId: 'asset', format: 'avid', frameRate: '30000/1001', frameOffset: 100 };

describe('NLE transcript exports', () => {
  it('requires explicit rational Avid frame rate; rejects irrelevant settings and unsafe offsets', () => {
    expect(contract.parseTranscriptRequest(request, { download: true })).toMatchObject({ frameRate: '30000/1001', frameOffset: 100 });
    for (const patch of [{ frameRate: undefined }, { frameRate: 29.97 }, { frameRate: '29.97' }, { frameOffset: -1 }, { frameOffset: 0.5 }, { format: 'premiere' }, { format: 'tsv' }]) {
      expect(() => contract.parseTranscriptRequest({ ...request, ...patch }, { download: true })).toThrow();
    }
    expect(nle.parseNleSettings({ format: 'avid', frameRate: '25/1' })).toEqual({ frameRate: '25/1', frameOffset: 0 });
  });
  it('produces exactly five Avid fields with rational frame math, sanitized comments and no header', () => {
    const output = nle.avidMarkers([{ ...segment, text: 'Hello\tworld\nnext', overlappingSpeech: true }], job, request);
    const lines = output.trimEnd().split('\n'); expect(lines).toHaveLength(1);
    const cells = lines[0].split('\t'); expect(cells).toHaveLength(5);
    expect(cells.slice(0, 4)).toEqual(['Person (Reporter)', '130', 'V1', 'red']);
    expect(cells[4]).toContain('Elapsed in 1.001s; out 2.000s; duration 0.999s');
    expect(cells[4]).toContain('overlapping speech');
    expect(cells[4]).toContain('Hello world next');
    expect(() => nle.avidMarkers([segment], job, { ...request, frameOffset: Number.MAX_SAFE_INTEGER })).toThrow();
  });
  it('matches the official Premiere shape with UUID v4 references and real confidence only', () => {
    const result = nle.premiereTranscript([segment], job, () => uuid);
    expect(result).toEqual({ language: 'en-us', speakers: [{ id: uuid, name: 'Person (Reporter)' }], segments: [{
      duration: 0.9990000000000001, language: 'en-us', speaker: uuid, start: 1.001, words: [
        { confidence: 0.9, duration: 0.4990000000000001, eos: false, start: 1.001, tags: [], text: 'Hello', type: 'word' },
        { confidence: 0, duration: 0.5, eos: true, start: 1.5, tags: [], text: 'world.', type: 'word' },
      ],
    }] });
    expect(nle.premiereTranscript([segment], { ...job, languageCode: 'es-US' }).language).toBe('??-??');
    expect(() => nle.premiereTranscript([segment], job, () => 'not-uuid')).toThrow();
  });
  it('refuses missing/edited/malformed word alignment and out-of-source timing without fabricating words', () => {
    for (const patch of [{ words: undefined }, { words: [] }, { text: 'Edited text' }, { words: [{ ...segment.words[0], confidence: 2 }] }, { words: [{ startSeconds: 0, endSeconds: 2, text: 'Hello world.' }] }]) {
      expect(() => nle.premiereTranscript([{ ...segment, ...patch }], job)).toThrow(/unchanged word timings/);
    }
    expect(() => nle.premiereTranscript([segment], { ...job, durationSeconds: 1 })).toThrow();
    expect(() => nle.premiereTranscript([], job)).toThrow();
    expect(nle.avidMarkers([{ ...segment, words: undefined, text: 'Corrected quote' }], job, request)).toContain('Corrected quote');
  });
  it('binds output keys to revision, export format and editor frame settings', () => {
    const base = nle.nleExport([segment], job, request);
    expect(base.key).toMatch(/^transcripts\/results\/[a-f0-9]{64}\.r2\.avid\.[a-f0-9]{64}\.txt$/);
    for (const [changedJob, changedRequest] of [[{ ...job, editRevision: 3 }, request], [job, { ...request, frameOffset: 0 }], [job, { ...request, frameRate: '25/1' }], [job, { format: 'premiere' }]]) {
      expect(nle.nleExport([segment], changedJob, changedRequest).key).not.toBe(base.key);
    }
  });
  it('rejects provider timestamps beyond this source before writing normalized exports', async () => {
    const commands = [];
    const current = { ...job, durationSeconds: 2, maxSpeakers: 2 };
    const processor = processorModule.createVideoTranscriptProcessor({ bucket: 'renditions', accountId: '123456789012', region: 'us-east-2' }, {
      credentials: async () => ({}),
      transcribe: { send: async () => ({ TranscriptionJob: { TranscriptionJobName: processorModule.jobName(current), LanguageCode: 'en-US',
        Media: { MediaFileUri: `s3://renditions/${processorModule.inputKey(current)}` }, Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 }, TranscriptionJobStatus: 'COMPLETED' } }) },
      s3: { send: async (command) => { commands.push(command); return command.constructor.name === 'HeadObjectCommand' ? { VersionId: 'raw-v1', ContentLength: 500 } : { Body: Readable.from([JSON.stringify({ jobName: processorModule.jobName(current), status: 'COMPLETED', results: { items: [{ type: 'pronunciation', start_time: '1', end_time: '3', alternatives: [{ content: 'Impossible' }] }] } })]) }; } },
    });
    await expect(processor.process(current, async () => true)).rejects.toThrow('transcript_output_invalid');
    expect(commands.some((command) => command.constructor.name === 'PutObjectCommand')).toBe(false);
  });
  it('reads pinned cache, writes private NLE object and signs its returned version; rejects missing words before writes', async () => {
    const commands = []; let cached = segment;
    const processor = processorModule.createVideoTranscriptProcessor({ bucket: 'renditions', accountId: '123456789012', region: 'us-east-2' }, {
      credentials: async () => ({}), firestore: { doc: () => ({ get: async () => ({ exists: true, data: () => ({ disabled: false }) }) }) },
      s3: { send: async (command) => { commands.push(command); return command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([JSON.stringify([cached])]) } : { VersionId: 'nle-export-v1' }; } },
      sign: async (_, command) => { commands.push(command); return 'https://private.invalid/download'; },
    });
    await processor.downloadNle(job, { format: 'premiere' });
    expect(commands[0].input.VersionId).toBe('cache-v2');
    expect(commands[1].input).toMatchObject({ ExpectedBucketOwner: '123456789012', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store' });
    expect(commands[2].input.VersionId).toBe('nle-export-v1');
    cached = { ...segment, words: undefined };
    await expect(processor.downloadNle(job, { format: 'premiere' })).rejects.toMatchObject({ status: 409 });
    expect(commands.filter((command) => command.constructor.name === 'PutObjectCommand')).toHaveLength(1);
  });
});
