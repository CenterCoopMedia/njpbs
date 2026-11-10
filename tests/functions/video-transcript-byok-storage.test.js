import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createJob } = require('../../functions/lib/video-transcript-byok-job');
const { createVideoTranscriptByokStorage, spoolKey } = require('../../functions/lib/video-transcript-byok-storage');
const { createTranscriptAudioRuntime } = require('../../functions/lib/video-transcript-audio-runtime');
const config = { bucket: 'private-renditions', accountId: '123456789012' };
function fixture() {
  const identity = { sourceId: 'video-library', assetId: 'asset', originalBucket: 'originals', originalKey: 'private/source.mov', originalVersion: 'original-v1', originalSize: 200,
    renditionBucket: config.bucket, renditionKey: 'outputs/asset/web.mp4', renditionVersion: 'web-v1', renditionSize: 12, durationSeconds: 20,
    credentialScope: 'personal', credentialId: createHash('sha256').update(JSON.stringify(['credential-v1', 'personal', 'staff', 'elevenlabs'])).digest('hex'), credentialRevision: 1, languageCode: 'en-US', maxSpeakers: 3 };
  return { ...createJob(identity, { uid: 'staff' }), attemptId: '00000000-0000-4000-8000-000000000001', leaseUntil: Date.now() + 720000 };
}
const result = () => ({ model: 'scribe_v2', inputSha256: 'a'.repeat(64), transcriptionId: 'provider-result',
  segments: [{ startSeconds: 0, endSeconds: 1, speaker: 'spk_0', text: 'Hello', words: [{ startSeconds: 0, endSeconds: 1, text: 'Hello', confidence: 0.8 }] }] });
function setup(extra = {}) {
  const rows = new Map(); const calls = []; let version = 0;
  const s3 = { send: vi.fn(async (command) => {
    const request = command.input; calls.push({ type: command.constructor.name, ...request });
    expect(request.Bucket).toBe(config.bucket); expect(request.ExpectedBucketOwner).toBe(config.accountId);
    if (command.constructor.name === 'GetObjectCommand') {
      const records = rows.get(request.Key); const record = request.VersionId ? records?.find(x => x.VersionId === request.VersionId) : records?.at(-1);
      if (!record) throw Object.assign(new Error('hidden s3 detail'), { name: 'NoSuchKey' });
      return { ...record, Body: Readable.from([record.bytes]) };
    }
    expect(command.constructor.name).toBe('PutObjectCommand');
    if (request.IfNoneMatch && rows.has(request.Key)) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' });
    const bytes = Buffer.from(request.Body); const item = { VersionId: `version-${++version}`, bytes, Metadata: request.Metadata, ContentLength: bytes.length, ContentType: request.ContentType };
    rows.set(request.Key, [...(rows.get(request.Key) ?? []), item]);
    return { VersionId: item.VersionId };
  }) };
  const billing = vi.fn(async () => {}); const receipts = [];
  const store = createVideoTranscriptByokStorage(config, { s3, assertBillingEnabledFn: billing, onReceipt: async x => receipts.push(x), ...extra });
  return { store, s3, rows, calls, billing, receipts };
}

describe('BYOK private input and durable output recovery', () => {
  it('requires a fresh audio variant before a legacy pending job can use the audio runtime', async () => {
    const s = setup();
    const audio = createTranscriptAudioRuntime({ ...config, region: 'us-east-2', audioEnabled: true,
      audioFunctionArn: `arn:aws:lambda:us-east-2:${config.accountId}:function:njpbs-boardwalk-transcript-audio-worker`,
      audioArtifactSha256: 'a'.repeat(64) }, { firestore: {}, s3: s.s3, lambda: {}, assertBillingEnabled: async () => {} });
    const store = createVideoTranscriptByokStorage(config, { s3: s.s3, audio, assertBillingEnabledFn: async () => {} });
    await expect(store.prepareInput(fixture())).rejects.toThrow('byok_legacy_input_requires_readmission');
    expect(s.calls).toEqual([]);
  });
  it('requires injected storage and billing guard', () => {
    expect(() => createVideoTranscriptByokStorage(config, {})).toThrow('byok_storage_config_invalid');
  });
  it('reads only the exact trusted rendition version and exposes one owned stream', async () => {
    const { store, rows, calls, billing } = setup(); const job = fixture();
    rows.set(job.input.objectKey, [{ VersionId: 'web-v1', ContentType: 'video/mp4', ContentLength: 12, bytes: Buffer.from('hello source') }]);
    const prepared = await store.prepareInput(job);
    expect(calls).toEqual([expect.objectContaining({ type: 'GetObjectCommand', Key: job.input.objectKey, VersionId: 'web-v1' })]);
    expect(prepared.input).toMatchObject({ versionId: 'web-v1', expectedVersionId: 'web-v1', sizeBytes: 12, durationSeconds: 20, mimeType: 'video/mp4' });
    expect(prepared.input.sha256).toBeUndefined(); prepared.cleanup(); expect(prepared.input.stream.destroyed).toBe(true); expect(billing).not.toHaveBeenCalled();
  });
  it('rejects original/outside output keys, foreign buckets and changed response headers', async () => {
    const { store, s3 } = setup();
    for (const patch of [{ renditionKey: 'private/source.mov' }, { renditionKey: 'outputs/../private.mov' }, { renditionBucket: 'foreign' }]) {
      const job = fixture(); const changed = { ...createJob({ ...job.identity, ...patch }, { uid: 'staff' }), attemptId: job.attemptId };
      await expect(store.prepareInput(changed)).rejects.toThrow('byok_storage_input_invalid');
    }
    expect(s3.send).not.toHaveBeenCalled();
    for (const patch of [{ VersionId: 'wrong' }, { ContentLength: 13 }, { ContentType: 'text/plain' }]) {
      const Body = Readable.from(['hello source']);
      s3.send.mockResolvedValueOnce({ VersionId: 'web-v1', ContentLength: 12, ContentType: 'video/mp4', Body, ...patch });
      await expect(store.prepareInput(fixture())).rejects.toThrow('byok_storage_input_changed'); expect(Body.destroyed).toBe(true);
    }
  });
  it('spools with exclusive create, complete identity and SHA, then pins its version', async () => {
    const { store, calls, receipts, billing } = setup(); const job = fixture();
    const receipt = await store.persistSpool(job, job, result());
    expect(receipt).toMatchObject({ key: spoolKey(job, job), versionId: 'version-1', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), identityHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const put = calls.find(x => x.type === 'PutObjectCommand');
    expect(put).toMatchObject({ IfNoneMatch: '*', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store' });
    expect(put.ChecksumSHA256).toBe(Buffer.from(receipt.sha256, 'hex').toString('base64'));
    const recovered = await store.recoverSpool(job, job, receipt);
    expect(recovered.segments).toEqual(result().segments); expect(recovered.inputSha256).toBe(result().inputSha256);
    expect(calls.at(-1).VersionId).toBe('version-1'); expect(receipts[0]).toEqual({ kind: 'spool', ...receipt }); expect(billing).toHaveBeenCalledTimes(1);
  });
  it.each(['NoSuchKey', 'NoSuchVersion'])('recognizes definitive %s for a pinned spool without treating access denial as absence', async (name) => {
    const s = setup(); const job = fixture();
    const receipt = await s.store.persistSpool(job, job, result());
    s.s3.send.mockRejectedValueOnce(Object.assign(new Error('hidden storage detail'), { name, $metadata: { httpStatusCode: 404 } }));
    await expect(s.store.recoverSpool(job, job, receipt)).rejects.toThrow('byok_storage_spool_missing');
    s.s3.send.mockRejectedValueOnce(Object.assign(new Error('hidden storage detail'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    await expect(s.store.recoverSpool(job, job, receipt)).rejects.toThrow('byok_storage_unavailable');
    await expect(s.store.recoverSpool(job, job, receipt)).resolves.toMatchObject({ receipt });
  });

  it('persists first spool even when a missing-key GET would be denied without ListBucket', async () => {
    const { store, s3, calls, rows } = setup(); const job = fixture(); const send = s3.send.getMockImplementation();
    s3.send.mockImplementation(async command => {
      if (command.constructor.name === 'GetObjectCommand' && !rows.has(command.input.Key)) {
        throw Object.assign(Error('Access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      }
      return send(command);
    });
    const receipt = await store.persistSpool(job, job, result());
    expect(receipt.versionId).toBe('version-1');
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ type: 'PutObjectCommand', IfNoneMatch: '*' });
  });
  it('write failure plus denied missing-key recovery stays unresolved after one PUT and GET', async () => {
    const { store, s3 } = setup(); const job = fixture();
    s3.send.mockRejectedValue(Object.assign(Error('Access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    await expect(store.persistSpool(job, job, result())).rejects.toThrow('byok_storage_unavailable');
    expect(s3.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand']);
  });
  it('recovers a lost PUT receipt from the exact attempt key without a second write', async () => {
    const { store, s3, calls } = setup(); const job = fixture(); const send = s3.send.getMockImplementation(); let lost = true;
    s3.send.mockImplementation(async command => { const output = await send(command); if (command.constructor.name === 'PutObjectCommand' && lost) { lost = false; throw Error('response lost'); } return output; });
    const receipt = await store.persistSpool(job, job, result());
    expect(receipt.versionId).toBe('version-1'); expect(calls.filter(x => x.type === 'PutObjectCommand')).toHaveLength(1);
    expect(await store.recoverSpool(job, job)).toMatchObject({ receipt });
  });
  it('same attempt is idempotent across map order; different normalized result is rejected', async () => {
    const { store, calls, rows } = setup(); const job = fixture(); const first = await store.persistSpool(job, job, result());
    const reordered = Object.fromEntries(Object.entries(result()).reverse());
    expect(await store.persistSpool(job, job, reordered)).toEqual(first);
    await expect(store.persistSpool(job, job, { ...result(), inputSha256: 'b'.repeat(64) })).rejects.toThrow('byok_storage_spool_conflict');
    expect(calls.filter(x => x.type === 'PutObjectCommand')).toHaveLength(3);
    expect(rows.get(first.key)).toHaveLength(1);
    expect(calls.filter(x => x.type === 'PutObjectCommand').every(x => x.IfNoneMatch === '*')).toBe(true);
  });
  it('rejects cross-attempt receipts, tampered metadata/body and wrong pinned versions', async () => {
    const { store, rows } = setup(); const job = fixture(); const receipt = await store.persistSpool(job, job, result());
    const other = { ...job, attemptId: '00000000-0000-4000-8000-000000000002' };
    await expect(store.recoverSpool(other, other, receipt)).rejects.toThrow('byok_storage_receipt_invalid');
    await expect(store.recoverSpool(job, job, { ...receipt, versionId: 'wrong' })).rejects.toThrow('byok_storage_spool_missing');
    const row = rows.get(receipt.key)[0]; const original = structuredClone(row);
    row.Metadata = { ...row.Metadata, 'byok-identity': 'a'.repeat(64) };
    await expect(store.recoverSpool(job, job)).rejects.toThrow('byok_storage_receipt_invalid');
    Object.assign(row, original); row.bytes = Buffer.from(row.bytes); row.bytes[5] ^= 1;
    await expect(store.recoverSpool(job, job)).rejects.toThrow('byok_storage_receipt_invalid');
  });
  it('billing stop prevents every new write but allows existing spool recovery', async () => {
    const { store, billing, calls } = setup(); const job = fixture(); const receipt = await store.persistSpool(job, job, result());
    billing.mockRejectedValue(Error('private billing reason'));
    const recovered = await store.recoverSpool(job, job, receipt); expect(recovered).not.toBeNull();
    await expect(store.finalizeExports(job, recovered)).rejects.toThrow('byok_storage_billing_unavailable');
    expect(calls.filter(x => x.type === 'PutObjectCommand')).toHaveLength(1);
  });
  it('writes three existing export formats with versions and awaits each receipt', async () => {
    const { store, receipts, calls, billing } = setup(); const job = fixture(); const receipt = await store.persistSpool(job, job, result());
    const recovered = await store.recoverSpool(job, job, receipt);
    recovered.segments[0].text = 'caller altered';
    const output = await store.finalizeExports(job, recovered);
    expect(output).toEqual({ outputs: { 'segments.json': 'version-2', txt: 'version-3', vtt: 'version-4' }, totalSegments: 1 });
    expect(receipts.filter(x => x.kind === 'export').map(x => x.format)).toEqual(['segments.json', 'txt', 'vtt']);
    expect(calls.find(x => x.Key === `transcripts/results/${job.id}.txt` && x.type === 'PutObjectCommand').Body).toContain('Hello');
    expect(billing).toHaveBeenCalledTimes(4);
  });
  it('failed receipt persistence stops finalization; durable spool enables output-only recovery', async () => {
    const { store, receipts, calls } = setup({ onReceipt: async receipt => { if (receipt.kind === 'export') throw Error('CAS lost'); } });
    const job = fixture(); const receipt = await store.persistSpool(job, job, result()); const recovered = await store.recoverSpool(job, job, receipt);
    await expect(store.finalizeExports(job, recovered)).rejects.toThrow('byok_storage_receipt_unavailable');
    expect(calls.filter(x => x.type === 'PutObjectCommand')).toHaveLength(2);
    expect(await store.recoverSpool(job, job, receipt)).toMatchObject({ inputSha256: result().inputSha256 }); expect(receipts).toHaveLength(0);
  });
  it('false receipt CAS cannot report success or continue writes', async () => {
    const { store, calls } = setup({ onReceipt: async () => false }); const job = fixture();
    await expect(store.persistSpool(job, job, result())).rejects.toThrow('byok_storage_receipt_unavailable');
    expect(calls.filter(x => x.type === 'PutObjectCommand')).toHaveLength(1);
    expect(await store.recoverSpool(job, job)).not.toBeNull();
  });
  it('matching object hash cannot disguise a different envelope identity', async () => {
    const { store, rows } = setup(); const job = fixture(); const receipt = await store.persistSpool(job, job, result());
    const row = rows.get(receipt.key)[0]; const envelope = JSON.parse(row.bytes.toString()); envelope.jobId = 'f'.repeat(64);
    row.bytes = Buffer.from(JSON.stringify(envelope)); row.ContentLength = row.bytes.length;
    row.Metadata.sha256 = createHash('sha256').update(row.bytes).digest('hex');
    await expect(store.recoverSpool(job, job)).rejects.toThrow('byok_storage_identity_invalid');
  });
  it('rejects invalid result before writes and requires the entire exact-length spool', async () => {
    const { store, s3, calls } = setup(); const job = fixture();
    await expect(store.persistSpool(job, job, { ...result(), model: 'other' })).rejects.toThrow('byok_storage_result_invalid');
    expect(calls).toHaveLength(0);
    const Body = Readable.from([Buffer.from('{}')]); s3.send.mockResolvedValueOnce({ Body, ContentLength: 3, VersionId: 'v1' });
    await expect(store.recoverSpool(job, job)).rejects.toThrow('byok_storage_result_invalid'); expect(Body.destroyed).toBe(true);
  });
});

async function localS3(handler, run, options={}) {
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  const {S3Client}=require('@aws-sdk/client-s3');
  const client=new S3Client({region:'us-east-2',endpoint:`http://127.0.0.1:${server.address().port}`,forcePathStyle:true,
    credentials:{accessKeyId:'synthetic-local-test',secretAccessKey:'synthetic-local-test'},maxAttempts:2,
    requestHandler:{connectionTimeout:50,requestTimeout:1000,throwOnRequestTimeout:true},...options});
  try{return await run(client);}finally{client.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
describe('actual Smithy HTTP and body deadlines',()=>{
 it('throws for stalled headers when requestTimeout is configured to throw',async()=>{
  await localS3(()=>{},async client=>{const {GetObjectCommand}=require('@aws-sdk/client-s3');
   await expect(client.send(new GetObjectCommand({Bucket:config.bucket,Key:'outputs/test'}))).rejects.toMatchObject({name:'TimeoutError'});
  },{maxAttempts:1,requestHandler:{connectionTimeout:50,requestTimeout:35,throwOnRequestTimeout:true}});
 });
 it('bounds request and retries with one storage abort deadline',async()=>{
  let requests=0;await localS3(()=>{requests++;},async client=>{
   const store=createVideoTranscriptByokStorage(config,{s3:client,assertBillingEnabledFn:async()=>{},ioTimeoutMs:70});
   const start=Date.now();await expect(store.prepareInput(fixture())).rejects.toThrow('byok_storage_unavailable');expect(Date.now()-start).toBeLessThan(500);
  });expect(requests).toBeGreaterThan(0);expect(requests).toBeLessThanOrEqual(2);
 });
 it('destroys a stalled MP4 body after headers before provider input can hang',async()=>{
  await localS3((req,res)=>{res.writeHead(200,{'content-type':'video/mp4','content-length':'12','x-amz-version-id':'web-v1'});res.write('hello');},async client=>{
   const store=createVideoTranscriptByokStorage(config,{s3:client,assertBillingEnabledFn:async()=>{},ioTimeoutMs:200,inputBodyTimeoutMs:45});
   const prepared=await store.prepareInput(fixture());const consume=async()=>{for await(const chunk of prepared.input.stream){void chunk;}};
   await expect(consume()).rejects.toThrow('byok_storage_deadline');expect(prepared.input.stream.destroyed).toBe(true);
  });
 });
 it('keeps a deadline on spool JSON body after Smithy resolves headers',async()=>{
  await localS3((req,res)=>{res.writeHead(200,{'content-type':'application/json','content-length':'200','x-amz-version-id':'v1'});res.write('{');},async client=>{
   const store=createVideoTranscriptByokStorage(config,{s3:client,assertBillingEnabledFn:async()=>{},ioTimeoutMs:60});const job=fixture();
   await expect(store.recoverSpool(job,job)).rejects.toThrow('byok_storage_deadline');
  });
 });
 it('caps work by remaining lease and refuses an expired lease before HTTP',async()=>{
  const send=vi.fn();const clock=()=>10000;const store=createVideoTranscriptByokStorage(config,{s3:{send},assertBillingEnabledFn:async()=>{},clock});
  await expect(store.prepareInput({...fixture(),leaseUntil:11000})).rejects.toThrow('byok_storage_unavailable');expect(send).not.toHaveBeenCalled();
  await localS3(()=>{},async client=>{const bounded=createVideoTranscriptByokStorage(config,{s3:client,assertBillingEnabledFn:async()=>{},ioTimeoutMs:200});const start=Date.now();
   await expect(bounded.prepareInput({...fixture(),leaseUntil:Date.now()+1040})).rejects.toThrow();expect(Date.now()-start).toBeLessThan(500);
  });
 });
});
