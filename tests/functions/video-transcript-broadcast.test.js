import { describe, it, expect } from 'vitest';
import contract from '../../functions/lib/video-transcript-contract.js';
import { Readable } from 'node:stream';
import processorModule from '../../functions/lib/video-transcript-processor.js';
import jobs from '../../functions/lib/video-transcript-job.js';

const identity = { sourceId: 'video-library', assetId: 'asset' };
const segment = { startSeconds: 1.25, endSeconds: 3.5, speaker: 'unknown', text: 'Original words', words: [{ startSeconds: 1.25, endSeconds: 3.5, text: 'Original words' }], speakerUncertain: true };

describe('broadcast transcript contract', () => {
  it('accepts bounded roles and unknown attribution but rejects role control characters and mixed review', () => {
    expect(contract.parseTranscriptEdit({ ...identity, revision: 0, speakerRoles: { spk_0: 'Reporter' } }).speakerRoles.spk_0).toBe('Reporter');
    for (const role of ['a'.repeat(241), 'Reporter\nEditor']) expect(() => contract.parseTranscriptEdit({ ...identity, revision: 0, speakerRoles: { spk_0: role } })).toThrow();
    expect(contract.parseTranscriptEdit({ ...identity, revision: 0, reviewed: true }).reviewed).toBe(true);
    for (const field of ['speakerNames', 'speakerRoles']) expect(() => contract.parseTranscriptEdit({ ...identity, revision: 0, [field]: { unknown: 'Person' } })).toThrow();
    for (const extra of [{ reviewed: false }, { reviewed: true, speakerNames: { spk_0: 'Name' } }, { reviewed: true, segments: [{ index: 0, text: 'Changed' }] }]) expect(() => contract.parseTranscriptEdit({ ...identity, revision: 0, ...extra })).toThrow();
  });
  it('retains original word timings but removes stale edited-word alignment and preserves uncertainty', () => {
    const request = contract.parseTranscriptEdit({ ...identity, revision: 0, segments: [{ index: 0, text: 'Correct words', speaker: 'spk_1' }], speakerRoles: { spk_1: '  Guest  ' } });
    const edited = contract.applyTranscriptEdit({}, [segment], request);
    expect(edited.segments[0].words).toBeUndefined();
    expect(edited.segments[0].speakerUncertain).toBeUndefined();
    expect(segment.words).toHaveLength(1);
    expect(edited.speakerRoles).toEqual({ spk_1: 'Guest' });
    expect(contract.applyTranscriptEdit({}, [segment], { segments: [{ index: 0, speaker: 'spk_1' }], speakerNames: {} }).segments[0].words).toHaveLength(1);
  });
  it('bounds new AWS passages and preserves words without inventing missing speaker attribution', () => {
    const items = Array.from({ length: 90 }, (_, i) => ({ type: 'pronunciation', start_time: String(i), end_time: String(i + 0.8), alternatives: [{ content: `word${i}` }] }));
    const segments = contract.normalizeTranscript({ jobName: 'job', status: 'COMPLETED', results: { items } }, 'job');
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.every((part) => part.endSeconds - part.startSeconds <= 30)).toBe(true);
    expect(segments.flatMap((part) => part.words).map((word) => word.text)).toEqual(items.map((item) => item.alternatives[0].content));
    expect(segments.every((part) => part.speaker === 'unknown' && part.speakerUncertain === undefined)).toBe(true);
  });
  it('binds review to revision and invalidates it on the next edit without replacing original outputs', async () => {
    const asset = { sourceId: 'video-library', kind: 'video', name: 'Video', originalName: 'video.mxf', nameSort: 'video', updatedAtSort: '2026-09-15T12:00:00Z', mimeType: 'video/mp4', sizeBytes: 10, version: 1, preview: 'browser', rightsStatus: 'complete', objectKey: 'objects/video.mp4', objectVersionId: 'v1', tags: [], lifecycle: 'active' };
    const source = { id: 'video-library', bucket: 'bucket', prefix: 'objects/' };
    const request = contract.parseTranscriptEdit({ ...identity, revision: 0, reviewed: true });
    let current = { id: contract.transcriptId(asset, 'bucket', request), ...identity,
      sourceBucket: source.bucket, sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
      sourceSizeBytes: asset.sizeBytes, languageCode: request.languageCode, maxSpeakers: request.maxSpeakers,
      phase: 'ready', outputs: { txt: 'original' } };
    const firestore = { collection: (collection) => ({ doc: (id = 'audit') => ({ collection, id }) }), runTransaction: async (fn) => fn({ get: async (ref) => ({ exists: true, id: ref.id, data: () => ref.collection === 'users' ? { active: true, grants: [{ role: 'staff' }] } : ref.collection === 'mediaSourceAssets' ? asset : current }), update: (_, changes) => { current = { ...current, ...changes }; }, set: () => {}, create: () => {} }) };
    const options = { firestore, source, request, job: current, actor: { uid: 'staff', displayName: 'Staff editor' }, audit: (entry) => entry };
    const reviewed = await jobs.commitTranscriptEdit(options);
    expect(reviewed).toMatchObject({ editRevision: 1, reviewedRevision: 1, reviewedBy: 'staff', reviewedByName: 'Staff editor', outputs: { txt: 'original' } });
    await expect(jobs.commitTranscriptEdit(options)).rejects.toThrow(/changed/);
    const changed = await jobs.commitTranscriptEdit({ ...options, job: current, request: contract.parseTranscriptEdit({ ...identity, revision: 1, speakerRoles: { spk_0: 'Reporter' } }), speakerNames: {}, speakerRoles: { spk_0: 'Reporter' }, editedOutputs: { txt: 'corrected' } });
    expect(changed).toMatchObject({ editRevision: 2, reviewedRevision: null, reviewedBy: null, outputs: { txt: 'original' }, speakerRoles: { spk_0: 'Reporter' } });
  });
  it('writes TSV from a pinned cached revision and signs exactly the new private version; billing stops writes', async () => {
    let disabled = false;
    const commands = [];
    const processor = processorModule.createVideoTranscriptProcessor({ bucket: 'renditions', accountId: '123456789012', region: 'us-east-2' }, {
      credentials: async () => ({}), transcribe: {},
      firestore: { doc: () => ({ get: async () => ({ exists: true, data: () => ({ disabled }) }) }) },
      s3: { send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([JSON.stringify([segment])]) };
        return { VersionId: 'new-log-version' };
      } },
      sign: async (_, command) => { commands.push(command); return 'https://private.invalid/log'; },
    });
    const job = { id: 'job', editRevision: 3, totalSegments: 1, editedOutputs: { 'segments.json': 'edited-segments-v3' } };
    await processor.downloadLog(job, { title: 'Source', assetId: 'asset', sourceVersion: 'source-v1' });
    expect(commands[0].input.VersionId).toBe('edited-segments-v3');
    expect(commands[1].input).toMatchObject({ Key: 'transcripts/results/job.r3.tsv', ExpectedBucketOwner: '123456789012', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store' });
    expect(commands[2].input.VersionId).toBe('new-log-version');
    commands.length = 0;
    await processor.downloadSrt(job);
    expect(commands[0].input.VersionId).toBe('edited-segments-v3');
    expect(commands[1].input).toMatchObject({ Key: 'transcripts/results/job.r3.srt', ContentType: 'application/x-subrip; charset=utf-8' });
    expect(commands[2].input.ResponseContentDisposition).toBe('attachment; filename="transcript.srt"');
    commands.length = 0;
    await processor.download({ ...job, editedOutputs: { ...job.editedOutputs, vtt: 'old-paragraph-cache' }, speakerNames: { unknown: 'Guest' } }, 'vtt');
    expect(commands[0].input.VersionId).toBe('edited-segments-v3');
    expect(commands[1].input).toMatchObject({ Key: 'transcripts/results/job.r3.vtt', ContentType: 'text/vtt; charset=utf-8',
      ServerSideEncryption: 'AES256', CacheControl: 'private, no-store' });
    expect(commands[1].input.Body).toContain('<v Guest>Original words</v>');
    expect(commands[2].input.VersionId).toBe('new-log-version');
    expect(commands[2].input.ResponseContentDisposition).toBe('attachment; filename="transcript.vtt"');
    disabled = true;
    const priorWrites = commands.filter((command) => command.constructor.name === 'PutObjectCommand').length;
    await expect(processor.downloadLog(job, {})).rejects.toMatchObject({ status: 503, message: 'Transcript export is temporarily unavailable' });
    await expect(processor.download(job, 'vtt')).rejects.toMatchObject({ status: 503 });
    expect(commands.filter((command) => command.constructor.name === 'PutObjectCommand')).toHaveLength(priorWrites);
  });
  it('exports source-relative timing, saved revision and safe spreadsheet cells without changing TXT/VTT', () => {
    const saved = { ...segment, text: '=SUM(1,2)\tquote\nnext' };
    const job = { id: 'job', editRevision: 2, reviewedRevision: 2, reviewedBy: 'staff', reviewedAt: '2026-09-15T20:00:00Z', speakerRoles: { unknown: 'Guest' } };
    const tsv = contract.transcriptLog([saved], job, { title: '@title', assetId: 'asset', sourceVersion: 'immutable-v1' });
    const lines = tsv.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].split('\t')).toHaveLength(lines[0].split('\t').length);
    expect(tsv).toContain("'@title");
    expect(tsv).toContain("'=SUM(1,2)\\tquote\\nnext");
    expect(tsv).toContain('viewing-copy-elapsed\t1250\t3500\t2250');
    expect(tsv).toContain('checked against audio');
    expect(contract.transcriptLog([saved], { ...job, editRevision: 3 }, {})).toContain('not reviewed');
    expect(contract.transcriptExports([segment]).txt).toContain('Unknown speaker: Original words');
    expect(contract.parseTranscriptRequest({ ...identity, format: 'tsv' }, { download: true }).format).toBe('tsv');
  });
});
