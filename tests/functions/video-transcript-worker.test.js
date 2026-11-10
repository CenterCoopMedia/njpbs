import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import nle from '../../functions/lib/video-transcript-nle.js';
import worker from '../../functions/lib/video-transcript-worker.js';
import alignment from '../../functions/lib/video-transcript-alignment-job.js';
import handlers from '../../functions/video-transcript-worker.js';
import fallbackPolicy from '../../functions/lib/video-transcript-fallback-policy.js';
const now = 1800000000000;
const id = 'a'.repeat(64);
const source = { id:'video-library', bucket:'originals', prefix:'' };
function store() {
  const input = { objectKey:'outputs/asset/web.mp4',objectVersionId:'web1',sizeBytes:50 };
  const job = { id,assetId:'asset',sourceId:source.id,sourceBucket:source.bucket,sourceObjectKey:'original.mp4',
    sourceObjectVersionId:'v1',sourceSizeBytes:100,input,durationSeconds:60,maxSpeakers:10,
    active:true,provider:'local',phase:'pending',createdAt:new Date(now).toISOString() };
  const asset = { sourceId:source.id,lifecycle:'active',objectKey:'original.mp4',objectVersionId:'v1',sizeBytes:100,
    rendition:{state:'ready',web:input} };
  const rows = new Map([[`${worker.JOBS}/${id}`,job],['mediaSourceAssets/asset',asset]]);
  let tail=Promise.resolve();
  const ref=(collection,name)=>({path:`${collection}/${name}`,id:name});
  const snapshot=r=>({id:r.id,ref:r,exists:rows.has(r.path),data:()=>structuredClone(rows.get(r.path))});
  const collection=(name,filters=[])=>({doc:key=>ref(name,key),where:(key,op,value)=>collection(name,[...filters,[key,value]]),
    orderBy:()=>collection(name,filters),limit:()=>collection(name,filters),get:async()=>({docs:[...rows].filter(([path,value])=>path.startsWith(name+'/')&&filters.every(([key,v])=>value[key]===v)).map(([path])=>snapshot({path,id:path.split('/').at(-1)}))})});
  const firestore={collection,runTransaction:fn=>{
    const run=tail.then(async()=>{const writes=[];const result=await fn({get:async r=>snapshot(r),
      update:(r,data)=>writes.push(()=>rows.set(r.path,{...rows.get(r.path),...structuredClone(data)})),
      set:(r,data)=>writes.push(()=>rows.set(r.path,structuredClone(data))),create:(r,data)=>writes.push(()=>rows.set(r.path,structuredClone(data)))});
      writes.forEach(fn=>fn());return result;});tail=run.catch(()=>{});return run;
  }};
  return { rows,firestore,source,now,ref:ref(worker.JOBS,id),get:()=>rows.get(`${worker.JOBS}/${id}`) };
}
async function claimed() {
  const s=store();const job=await worker.claimLocalJob(s);
  return {...s,job,request:{jobId:id,leaseToken:job.localLeaseToken}};
}
const segments=[{startSeconds:0,endSeconds:2,speaker:'spk_0',text:'Hello.'}];
const completeArgs=s=>({...s,request:{...s.request,engineRevision:worker.LOCAL_ENGINE,segments},clock:()=>now,
  assertBillingEnabled:vi.fn(async()=>{}),writeExports:vi.fn(async()=>({'segments.json':'v1',txt:'v2',vtt:'v3'}))});
describe('local transcript worker leases and fallback',()=>{
  it('retires a stale source before waiting for its audio input',async()=>{
    const s=store();s.rows.get('mediaSourceAssets/asset').lifecycle='deleted';
    expect(await worker.claimLocalJob({...s,audioRequired:true})).toBeNull();
    expect(s.get()).toMatchObject({active:false,phase:'stale',errorCode:'source_unavailable'});
  });
  it('claims exactly one job and recovers a lost claim response without another lease',async()=>{
    const s=store();const [one,two]=await Promise.all([worker.claimLocalJob(s),worker.claimLocalJob(s)]);
    expect(one.localLeaseToken).toBe(two.localLeaseToken);
    expect(one.localLeaseUntil).toBe(now+120000);
  });
  it('does not claim transcription while the shared GPU slot has an alignment lease',async()=>{
    const s=store();s.rows.set(`${worker.WORKERS}/node-gpu-b`,{kind:'alignment',jobId:'b'.repeat(64),leaseUntil:now+120000});
    expect(await worker.claimLocalJob(s)).toBeNull();
    expect(s.get().localLeaseToken).toBeUndefined();
  });
  it('renews a valid lease and rejects stale tokens and out-of-range progress',async()=>{
    const s=await claimed();await worker.heartbeatLocalJob({...s,now:now+30000,request:{...s.request,stage:'transcribing',processedSeconds:10}});
    expect(s.get().localLeaseUntil).toBe(now+150000);
    await expect(worker.heartbeatLocalJob({...s,request:{...s.request,leaseToken:'wrong',stage:'diarizing'}})).rejects.toMatchObject({status:409});
    await expect(worker.heartbeatLocalJob({...s,request:{...s.request,stage:'diarizing',processedSeconds:61}})).rejects.toMatchObject({status:400});
  });
  it('keeps healthy busy worker queues local but falls back once after outage',async()=>{
    const s=store();s.rows.set(`${worker.WORKERS}/node-gpu-b`,{lastSeenAt:now+150000,jobId:'other',leaseUntil:now+270000});
    expect(await worker.routeLocalFallback({...s,now:now+180000,fallbackEnabled:true})).toBe(false);
    expect(s.get().provider).toBe('local');
    await Promise.all([worker.routeLocalFallback({...s,now:now+400000,fallbackEnabled:true}),worker.routeLocalFallback({...s,now:now+400000,fallbackEnabled:true})]);
    expect(s.get()).toMatchObject({provider:'amazon-transcribe',phase:'pending',fallbackReason:'local_worker_unavailable'});
  });
  it('revokes expired lease before fallback and rejects late completion',async()=>{
    const s=await claimed();await worker.routeLocalFallback({...s,now:now+120001,fallbackEnabled:true});
    const args=completeArgs(s);await expect(worker.completeLocalJob(args)).rejects.toMatchObject({status:409});
    expect(args.writeExports).not.toHaveBeenCalled();
  });
  it('commits once and acknowledges repeated completion without another write',async()=>{
    const s=await claimed();const args=completeArgs(s);
    await worker.completeLocalJob(args);await worker.completeLocalJob(args);
    expect(args.writeExports).toHaveBeenCalledTimes(1);expect(s.get()).toMatchObject({phase:'ready',totalSegments:1,active:false});
  });
  it('does not attach output if fallback wins during the S3 write',async()=>{
    const s=await claimed();const args=completeArgs(s);
    args.writeExports=vi.fn(async()=>{await worker.routeLocalFallback({...s,now:now+120001,fallbackEnabled:true});return {txt:'orphan'};});
    await expect(worker.completeLocalJob(args)).rejects.toMatchObject({status:409});expect(s.get().outputs).toBeUndefined();
  });
  it('does not attach output if the source is deleted during storage work',async()=>{
    const s=await claimed();const args=completeArgs(s);
    args.writeExports=vi.fn(async()=>{s.rows.get('mediaSourceAssets/asset').lifecycle='deleted';return {txt:'orphan'};});
    await expect(worker.completeLocalJob(args)).rejects.toMatchObject({status:409});expect(s.get().outputs).toBeUndefined();
  });
  it('rejects replaced viewing-copy versions before writing results',async()=>{
    const s=await claimed();s.rows.get('mediaSourceAssets/asset').rendition.web={...s.job.input,objectVersionId:'replacement'};
    const args=completeArgs(s);await expect(worker.completeLocalJob(args)).rejects.toMatchObject({status:409});expect(args.writeExports).not.toHaveBeenCalled();
  });
  it('honors disabled fallback and billing stops without committing',async()=>{
    const s=await claimed();const args=completeArgs(s);args.assertBillingEnabled=async()=>{throw Error('blocked');};
    await expect(worker.completeLocalJob(args)).rejects.toThrow('blocked');expect(args.writeExports).not.toHaveBeenCalled();
    await worker.failLocalJob({...s,fallbackEnabled:false,request:{...s.request,errorCode:'local_processing_failed'}});
    expect(s.get()).toMatchObject({phase:'needs_reconciliation',active:false,provider:'local'});
    expect(s.get().cleanupWriterSettlement).toEqual({ provider: 'local', jobId: id, workerId: 'node-gpu-b', status: 'FAILED',
      attemptId: createHash('sha256').update(s.job.localLeaseToken).digest('hex'), at: new Date(now).toISOString() });
    expect(s.get().cleanupWriterSettlement).not.toHaveProperty('leaseToken');
  });
  it('never records a terminal receipt merely because a local lease expired', async () => {
    const s = await claimed();
    await worker.routeLocalFallback({ ...s, now: now + 120001, fallbackEnabled: false });
    expect(s.get()).toMatchObject({ phase: 'needs_reconciliation', active: false });
    expect(s.get().cleanupWriterSettlement).toBeUndefined();
  });
  it('bounds normalized transcript times, speaker IDs, fields and empty silence',()=>{
    const s=store();expect(worker.validateSegments([],s.get())).toEqual([]);
    for(const patch of [{endSeconds:Infinity},{endSeconds:61},{startSeconds:-1},{speaker:'spk_99'},{text:'bad\u0000'},{url:'https://evil.invalid'}]) {
      expect(()=>worker.validateSegments([{...segments[0],...patch}],s.get())).toThrow();
    }
    expect(()=>worker.validateSegments([segments[0],{...segments[0],startSeconds:-1}],s.get())).toThrow();
  });
  it('preserves bounded word timing and explicit uncertain or overlapping speech', () => {
    const s = store();
    const segment = { startSeconds: 1, endSeconds: 2, speaker: 'unknown', text: 'Hello',
      speakerUncertain: true, overlappingSpeech: true, words: [{startSeconds: 1, endSeconds: 2, text: 'Hello'}] };
    expect(worker.validateSegments([segment], s.get())).toEqual([segment]);
    for (const patch of [{speakerUncertain: false}, {overlappingSpeech: 'yes'},
      {words: [{startSeconds: 0, endSeconds: 2, text: 'Hello'}]},
      {words: [{startSeconds: 1, endSeconds: 3, text: 'Hello'}]},
      {words: [{startSeconds: 1, endSeconds: 2, text: 'Hello', confidence: 1.1}]},
      {words: [{startSeconds: 1, endSeconds: 2, text: 'Hello', url: 'private'}]}]) {
      expect(() => worker.validateSegments([{...segment, ...patch}], s.get())).toThrow();
    }
  });
  it('normalizes small EOF overruns into timings accepted by both editing exports', () => {
    const job = {...store().get(), editRevision:0};
    const segment = {startSeconds:59.8,endSeconds:60.05,speaker:'spk_0',text:'End.',
      words:[{startSeconds:59.8,endSeconds:60.05,text:'End.'}]};
    const result = worker.validateSegments([segment],job);
    expect(result[0].endSeconds).toBe(60);expect(result[0].words[0].endSeconds).toBe(60);
    expect(segment.endSeconds).toBe(60.05);expect(segment.words[0].endSeconds).toBe(60.05);
    expect(nle.avidMarkers(result,job,{frameRate:'30/1',frameOffset:0})).toContain('out 60.000s');
    expect(nle.premiereTranscript(result,job).segments[0].words[0].duration).toBeCloseTo(0.2);
    for (const invalid of [
      {...segment,startSeconds:60.01},
      {...segment,endSeconds:60.101},
      {...segment,words:[{startSeconds:60.01,endSeconds:60.05,text:'End.'}]},
    ]) expect(()=>worker.validateSegments([invalid],job)).toThrow();
  });
  it('rejects missing credentials before configuration, storage or payload parsing',async()=>{
    const configFn=vi.fn();const readAuth=vi.fn();const handler=handlers.createWorkerHandler('claim',{readAuth,configFn});
    const res={set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',headers:{},body:{url:'invalid'}},res);
    expect(res.code).toBe(401);expect(configFn).not.toHaveBeenCalled();expect(readAuth).not.toHaveBeenCalled();
  });
  it('requires enabled matching worker token digest and supports immediate revocation',async()=>{
    const token='a'.repeat(48);const tokenSha256=createHash('sha256').update(token).digest('hex');
    for(const auth of [{enabled:false,workerId:'node-gpu-b',tokenSha256},{enabled:true,workerId:'other',tokenSha256},
      {enabled:true,workerId:'node-gpu-b',tokenSha256:'0'.repeat(64)},{enabled:true,workerId:'node-gpu-b',tokenSha256}]) {
      const configFn=vi.fn(()=>({enabled:false}));const handler=handlers.createWorkerHandler('claim',{readAuth:async()=>auth,configFn});
      const res={set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
      await handler({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:{}},res);
      const valid=auth.enabled&&auth.workerId==='node-gpu-b'&&auth.tokenSha256===tokenSha256;
      expect(res.code).toBe(valid?503:401);expect(JSON.stringify(res.body)).not.toContain(token);
      expect(configFn.mock.calls.length).toBe(valid?1:0);
    }
  });

  it('holds a new-policy local failure for ElevenLabs admission before Amazon',async()=>{
    const s=await claimed();
    s.get().processingPolicy=fallbackPolicy.PAID_FALLBACK_POLICY;
    await worker.failLocalJob({...s,fallbackEnabled:true,request:{...s.request,errorCode:'local_processing_failed'}});
    expect(s.get().paidFallbackState).toBe('pending');
    expect(s.get().localLeaseToken).toBeNull();
  });
  it('holds an expired new-policy local request for ElevenLabs admission',async()=>{
    const s=store();
    s.get().processingPolicy=fallbackPolicy.PAID_FALLBACK_POLICY;
    s.get().createdAt=new Date(now-10*60*1000).toISOString();
    await worker.routeLocalFallback({...s,fallbackEnabled:true});
    expect(s.get().paidFallbackState).toBe('pending');
  });
  it('pins only the first committed output under concurrent duplicate completion',async()=>{
    const s=await claimed();const args=completeArgs(s);let writes=0;
    args.writeExports=async()=>({txt:`version${++writes}`});
    await Promise.all([worker.completeLocalJob(args),worker.completeLocalJob(args)]);
    expect(writes).toBe(2);expect(s.get().outputs).toEqual({txt:'version1'});
    s.get().editRevision=2;s.get().editedOutputs={txt:'staff-edit'};
    await worker.completeLocalJob(args);expect(writes).toBe(2);expect(s.get().editedOutputs).toEqual({txt:'staff-edit'});
  });
  it('checks billing before acquiring a local lease or signing private input',async()=>{
    const s=store();const token='a'.repeat(48);const signInput=vi.fn();
    const handler=handlers.createWorkerHandler('claim',{firestore:s.firestore,readAuth:async()=>({enabled:true,workerId:'node-gpu-b',tokenSha256:createHash('sha256').update(token).digest('hex')}),
      configFn:()=>({enabled:true,localEnabled:true,source}),processor:{signInput},assertBillingEnabledFn:async()=>{throw Error('private billing reason');}});
    const res={set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:{}},res);
    expect(res.code).toBe(503);expect(signInput).not.toHaveBeenCalled();expect(s.get().localLeaseToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('private billing reason');
  });

  it('routes an alignment heartbeat through the existing authenticated worker endpoint',async()=>{
    const token='a'.repeat(48);const heartbeat=vi.fn(async()=>({leaseUntil:now+120000}));
    const alignmentJobs={...alignment,heartbeatAlignmentJob:heartbeat};
    const handler=handlers.createWorkerHandler('heartbeat',{readAuth:async()=>({enabled:true,workerId:'node-gpu-b',tokenSha256:createHash('sha256').update(token).digest('hex')}),
      configFn:()=>({enabled:true,localEnabled:true,alignmentEnabled:true,alignmentModelRepository:alignment.MODEL_REPOSITORY,
        alignmentModelRevision:alignment.MODEL_REVISION,alignmentCacheSha256:'c'.repeat(64),source}),alignment:alignmentJobs});
    const res={set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    const body={kind:'alignment',jobId:id,leaseToken:'12345678-1234-1234-1234-123456789abc',stage:'aligning'};
    await handler({method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body},res);
    expect(res.code).toBe(200);expect(res.body).toMatchObject({success:true,leaseUntil:now+120000});
    expect(heartbeat).toHaveBeenCalledOnce();
  });

});
