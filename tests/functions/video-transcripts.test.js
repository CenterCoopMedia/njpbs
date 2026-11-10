import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import contract from '../../functions/lib/video-transcript-contract.js';
import jobs from '../../functions/lib/video-transcript-job.js';
import localJobs from '../../functions/lib/video-transcript-worker.js';
import processorModule from '../../functions/lib/video-transcript-processor.js';
import handlers from '../../functions/video-transcripts.js';
import renditions from '../../functions/lib/source-media-rendition.js';
import sources from '../../functions/lib/media-sources.js';
import byokJobs from '../../functions/lib/video-transcript-byok-job.js';
import credentials from '../../functions/lib/video-transcription-credentials.js';
import fallbackPolicy from '../../functions/lib/video-transcript-fallback-policy.js';

const source = { id:'video-library', bucket:'originals', prefix:'', writable:true, access:'active_staff' };
const config = { enabled:true, source, bucket:'renditions', accountId:'123456789012', controlRoleArn:'role', dataRoleArn:'data-role', region:'us-east-2' };
const request = contract.parseTranscriptRequest({sourceId:'video-library',assetId:'asset'});
const actor = {uid:'staff', email:'staff@example.org', authTime:100, principal:{grants:[{role:'staff'}]}};
function asset() {
  const result = {id:'asset',sourceId:'video-library',objectKey:'objects/asset.mxf',objectVersionId:'version1',sizeBytes:100,
    lifecycle:'active',name:'Video',originalName:'video.mxf',nameSort:'video',updatedAtSort:'2026-09-15T12:00:00Z',
    mimeType:'application/mxf',kind:'video',version:1,preview:'download_only',rightsStatus:'complete',tags:[]};
  const prefix=`outputs/${renditions.sourceMediaRenditionId(result)}/attempt/`;
  result.rendition={schemaVersion:1,state:'ready',sourceObjectKey:result.objectKey,sourceObjectVersionId:result.objectVersionId,
    sourceSizeBytes:result.sizeBytes,attemptId:'attempt',updatedAt:'2026-09-15T12:00:00Z',
    web:{objectKey:prefix+'preview.mp4',objectVersionId:'web1',sizeBytes:50,mimeType:'video/mp4',durationSeconds:60},
    poster:{objectKey:prefix+'preview-poster.0000000.jpg',objectVersionId:'poster1',sizeBytes:5,mimeType:'image/jpeg'}};
  return result;
}
function memoryStore() {
  const rows = new Map([['mediaSourceAssets/asset',asset()]]);
  let tail=Promise.resolve();let next=1;
  const ref=(collection,id=`auto${next++}`)=>{const result={path:`${collection}/${id}`,id};result.get=async()=>snap(result);return result;};
  const snap=(reference)=>({id:reference.id,ref:reference,exists:rows.has(reference.path),data:()=>structuredClone(rows.get(reference.path))});
  function matches(value, field, operator, expected) {
    const actual = field.split('.').reduce((current, key) => current?.[key], value);
    if (operator === '==') return actual === expected;
    if (operator === '>=') return actual >= expected;
    if (operator === '<') return actual < expected;
    return false;
  }
  const query=(name,filters=[],after=null,count=Infinity,order="__name__",direction="asc")=>({
    doc:(id)=>ref(name,id),
    where:(field,operator,value)=>query(name,[...filters,[field,operator,value]],after,count,order,direction),
    orderBy:(field,dir="asc")=>query(name,filters,after,count,field,dir),
    startAfter:(id)=>query(name,filters,id,count,order,direction),limit:(value)=>query(name,filters,after,value,order,direction),
    get:async()=>({docs:[...rows].filter(([key,value])=>key.startsWith(name+'/')&&
      filters.every(([field,operator,expected])=>matches(value,field,operator,expected))&&
      (!after||key.split('/').at(-1)>after)).sort(([a,av],[b,bv])=>{const x=order==="__name__"?a:av[order],y=order==="__name__"?b:bv[order];return (x<y?-1:x>y?1:0)*(direction==="desc"?-1:1);}).slice(0,count)
      .map(([key])=>snap({path:key,id:key.split('/').at(-1)}))}),
  });
  const firestore={collection:(name)=>query(name),doc:(path)=>{const [name,id]=path.split('/');return ref(name,id);},
    runTransaction:(fn)=>{
      const run=tail.then(async()=>{
        const writes=[];
        const result=await fn({get:async(target)=>target.path?snap(target):target.get(),create:(reference,value)=>writes.push(['create',reference,structuredClone(value)]),update:(reference,value)=>writes.push(['update',reference,structuredClone(value)]),set:(reference,value)=>writes.push(['set',reference,structuredClone(value)])});
        for(const [mode,reference,value]of writes){if(mode==='create'&&rows.has(reference.path))throw Error('already exists');rows.set(reference.path,mode==='create'?value:{...rows.get(reference.path),...value});}
        return result;
      });tail=run.catch(()=>{});return run;
    }};
  return {rows,firestore};
}
const audit=(value)=>value;
async function queued(store=memoryStore()) {
  const result=await jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit});
  return {...store,...result};
}
async function readyPaidFallback() {
  const store=memoryStore();
  store.rows.set('users/staff',{active:true,grants:[{role:'staff'}]});
  const parentResult=await jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit,
    paidFallbackEnabled:true,localEnabled:false});
  const video=asset(),web=video.rendition.web;
  const child=byokJobs.createJob({sourceId:source.id,assetId:video.id,originalBucket:source.bucket,
    originalKey:video.objectKey,originalVersion:video.objectVersionId,originalSize:video.sizeBytes,
    renditionBucket:config.bucket,renditionKey:web.objectKey,renditionVersion:web.objectVersionId,
    renditionSize:web.sizeBytes,durationSeconds:web.durationSeconds,languageCode:request.languageCode,
    maxSpeakers:request.maxSpeakers,credentialScope:'organization',
    credentialId:credentials.credentialIdentity(actor,{scope:'organization',provider:'elevenlabs'}).id,
    credentialRevision:1},actor);
  Object.assign(child,{phase:'ready',active:false,editRevision:0,totalSegments:1,
    outputs:{'segments.json':'child-segments',txt:'child-txt',vtt:'child-vtt'}});
  const parentPath=`${jobs.TRANSCRIPT_JOBS}/${parentResult.job.id}`;
  const childPath=`${jobs.TRANSCRIPT_JOBS}/${child.id}`;
  Object.assign(store.rows.get(parentPath),{phase:'ready',active:false,paidFallbackState:'ready',
    fallbackTranscriptId:child.id,totalSegments:1});
  store.rows.set(childPath,child);
  return {...store,parent:store.rows.get(parentPath),parentPath,child,childPath};
}
function providerJob(job,status='IN_PROGRESS') {
  return {TranscriptionJobName:processorModule.jobName(job),LanguageCode:job.languageCode,
    Media:{MediaFileUri:`s3://renditions/${processorModule.inputKey(job)}`},Settings:{ShowSpeakerLabels:true,MaxSpeakerLabels:job.maxSpeakers},TranscriptionJobStatus:status};
}
const missing=()=>Object.assign(Error("The requested job couldn't be found."),{name:'BadRequestException'});
function processing(job,{provider=null,startError=null,s3Send,billingDisabled=false}={}) {
  const calls=[];
  const processor=processorModule.createVideoTranscriptProcessor(config,{firestore:{doc:()=>({get:async()=>({exists:true,data:()=>({disabled:typeof billingDisabled==='function'?billingDisabled():billingDisabled})})})},credentials:async()=>({}),
    transcribe:{send:async(command)=>{calls.push(command);if(command.constructor.name==='GetTranscriptionJobCommand'){if(!provider)throw missing();return {TranscriptionJob:provider};}if(startError)throw startError;return {}; }},
    s3:{send:s3Send??(async(command)=>{calls.push(command);return command.constructor.name==='HeadObjectCommand'?{VersionId:'web1',ContentLength:50}:{VersionId:'output1'};})}});
  const save=async(changes)=>{Object.assign(job,changes);return true;};
  return {processor,calls,save};
}
function response() {return {statusCode:0,set(){},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};}
function handlerDependencies(store,extra={}) {return {firestore:store.firestore,registryFn:()=>new Map([[source.id,source]]),configFn:()=>config,
  verifyAppCheckFn:async()=>{},requirePrincipalFn:async()=>actor,
  authorizeFn:(args)=>sources.authorizeMediaSource({...args,isApprovedActiveAccountFn:async()=>true}),audit,log:{warn(){}},...extra};}
async function call(handler,body=request) {const res=response();await handler({method:'POST',headers:{'content-type':'application/json'},body},res);return res;}

describe('transcript identity, authorization and durable claims',()=>{
  it('reuses an active Amazon canary on repeated preparation without changing limits or audits',async()=>{
    const store=memoryStore();
    const args={firestore:store.firestore,source,request,actor,audit,operatorCanaryId:'a'.repeat(64)};
    const first=await jobs.requestTranscript(args);
    const saved=structuredClone([...store.rows]);
    const second=await jobs.requestTranscript(args);
    expect(first).toMatchObject({cached:false,job:{active:true,phase:'pending',operatorCanaryId:args.operatorCanaryId}});
    expect(second).toEqual({cached:true,job:first.job});
    expect([...store.rows]).toEqual(saved);
  });
  it('holds an operator Amazon canary from normal routing and provider processing',async()=>{
    const s=await queued();
    s.rows.get(`${jobs.TRANSCRIPT_JOBS}/${s.job.id}`).operatorCanaryId='a'.repeat(64);
    let processed=false;
    await handlers.processTranscriptTick({firestore:s.firestore,config,processor:{process:async()=>{processed=true;}}});
    expect(processed).toBe(false);
    expect(s.rows.get(`${jobs.TRANSCRIPT_JOBS}/${s.job.id}`).phase).toBe('pending');
  });
  it('uses local first for new requests while preserving the existing cache identity and edited output',async()=>{
    const store=memoryStore();const args={firestore:store.firestore,source,request,actor,audit,localEnabled:true};
    const created=await jobs.requestTranscript(args);
    expect(created.job).toMatchObject({provider:'local',processingPolicy:'local-first-v1'});
    expect(created.job.id).toBe(contract.transcriptId(asset(),source.bucket,request));
    const row=store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${created.job.id}`);
    Object.assign(row,{phase:'ready',active:false,editRevision:3,editedOutputs:{txt:'edited-version'}});
    const cached=await jobs.requestTranscript(args);
    expect(cached).toMatchObject({cached:true,job:{editRevision:3,editedOutputs:{txt:'edited-version'}}});
  });
  it('migrates only untouched legacy pending intents and records a policy audit',async()=>{
    const s=await queued();const key=`${jobs.TRANSCRIPT_JOBS}/${s.job.id}`;const row=s.rows.get(key);
    delete row.provider;const createdAt=row.createdAt;
    const args={firestore:s.firestore,ref:s.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(s.job.id),source,enabled:true,audit};
    expect(await jobs.migratePendingTranscriptToLocal(args)).toBe(true);
    expect(s.rows.get(key)).toMatchObject({provider:'local',createdAt,policyMigrationReason:'local_default_enabled',leaseOwner:null});
    expect([...s.rows.values()].filter(value=>value.action==='media.transcript.policy')).toHaveLength(1);
    expect(await jobs.migratePendingTranscriptToLocal(args)).toBe(false);
    for(const state of [{phase:'starting',startIntentAt:new Date().toISOString()},{phase:'ready',active:false},{phase:'pending',leaseUntil:Date.now()+120000}]) {
      const other=await queued();const value=other.rows.get(`${jobs.TRANSCRIPT_JOBS}/${other.job.id}`);delete value.provider;Object.assign(value,state);
      expect(await jobs.migratePendingTranscriptToLocal({...args,firestore:other.firestore,ref:other.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(other.job.id)})).toBe(false);
    }
  });
  it.each(['pending','running','intent'])('never routes ElevenLabs %s through legacy processing',async(state)=>{
    const store=await queued();const ref=store.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(store.job.id);
    const row=store.rows.get(ref.path);Object.assign(row,{provider:'elevenlabs',phase:state==='intent'?'running':state,leaseOwner:'legacy-owner',leaseUntil:0,
      ...(state==='intent'?{submissionIntentAt:new Date().toISOString()}: {})});
    const before=structuredClone(row);const args={firestore:store.firestore,ref,source};
    expect(await jobs.migratePendingTranscriptToLocal({...args,enabled:true,audit})).toBe(false);
    expect(await localJobs.routeLocalFallback({...args,fallbackEnabled:true})).toBe(false);
    expect(await jobs.claimTranscript(store.firestore,ref,source)).toBeNull();
    expect(await jobs.saveTranscript(store.firestore,ref,before,{phase:'starting'})).toBe(false);
    const direct=processing(row);await direct.processor.process(row,direct.save);expect(direct.calls).toEqual([]);
    const transitions=[];await handlers.processTranscriptTick({firestore:store.firestore,config:{...config,localEnabled:true,fallbackEnabled:true},processor:{process:async()=>transitions.push('legacy')}});
    expect(transitions).toEqual([]);expect(store.rows.get(ref.path)).toEqual(before);
  });
  it.each([null,'','unknown'])('fails closed for invalid provider %j',async(provider)=>{
    const store=await queued();const ref=store.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(store.job.id);const row=store.rows.get(ref.path);row.provider=provider;
    expect(await jobs.migratePendingTranscriptToLocal({firestore:store.firestore,ref,source,enabled:true,audit})).toBe(false);
    expect(await jobs.claimTranscript(store.firestore,ref,source)).toBeNull();
    const direct=processing(row);await direct.processor.process(row,direct.save);expect(direct.calls).toEqual([]);
  });

  it('does not send healthy local work to the Amazon processor',async()=>{
    const store=memoryStore();await jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit,localEnabled:true});
    const calls=[];await handlers.processTranscriptTick({firestore:store.firestore,config:{...config,localEnabled:true,fallbackEnabled:true},processor:{process:async()=>calls.push('paid')}});
    expect(calls).toEqual([]);
  });

  it('continues the scheduler page after one paid fallback routing error',async()=>{
    const store=memoryStore();const now=Date.now();
    store.rows.set('users/staff',{active:true});
    const identity=credentials.credentialIdentity(actor,{scope:'organization',provider:'elevenlabs'});
    store.rows.set(`${credentials.CREDENTIAL_COLLECTION}/${identity.id}`,{...identity,revision:1,enabled:true});
    const created=await jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit,now,
      localEnabled:false,paidFallbackEnabled:true});
    store.rows.set(`${jobs.TRANSCRIPT_JOBS}/z-legacy`,{...created.job,id:'z-legacy',
      processingPolicy:'amazon-only-v1'});
    const calls=[];
    await handlers.processTranscriptTick({firestore:store.firestore,
      config:{...config,localEnabled:false,fallbackEnabled:true},now:()=>now,
      paidFallback:{config:()=>({enabled:true,bucket:config.bucket,accountId:config.accountId}),
        admit:async()=>{throw Object.assign(Error('private admission detail'),{status:503});}},
      processor:{process:async job=>calls.push(job.id)}});
    expect(calls).toEqual(['z-legacy']);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${created.job.id}`)).toMatchObject({
      active:true,paidFallbackState:'pending',
    });
  });

  it('processes transcripts when the export settlement query fails',async()=>{
    const store=await queued();
    const firestore={...store.firestore,collection:name=>{
      if(name==='mediaSourceOrientationExports')throw Object.assign(Error('index unavailable'),{code:9});
      return store.firestore.collection(name);
    }};
    const calls=[];
    await handlers.processTranscriptTick({firestore,config,processor:{process:async(job,save)=>{
      calls.push(job.id);await save({phase:'ready',active:false});
    }}});
    expect(calls).toEqual([store.job.id]);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`)).toMatchObject({phase:'ready',active:false});
  });

  it('reconciles an expired local lease beyond five healthy jobs and checks one paid job per tick',async()=>{
    const store=await queued();const now=Date.now();store.rows.delete(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`);
    for(let i=0;i<7;i++)store.rows.set(`${jobs.TRANSCRIPT_JOBS}/a${i}`,{...store.job,id:`a${i}`,provider:'local',localQueuedAt:new Date(now).toISOString()});
    store.rows.set(`${jobs.TRANSCRIPT_JOBS}/m-paid`,{...store.job,id:'m-paid',provider:'amazon-transcribe',phase:'running',startIntentAt:new Date(now).toISOString()});
    store.rows.set(`${jobs.TRANSCRIPT_JOBS}/z-expired`,{...store.job,id:'z-expired',provider:'local',phase:'running',localLeaseToken:'expired',localLeaseUntil:now-1});
    const calls=[];const args={firestore:store.firestore,config:{...config,localEnabled:true,fallbackEnabled:true},now:()=>now,processor:{process:async(job,save)=>{calls.push(job.id);await save({active:false,phase:'ready'});}}};
    await handlers.processTranscriptTick(args);
    expect(calls).toEqual(['m-paid']);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/z-expired`)).toMatchObject({provider:'amazon-transcribe',localLeaseToken:null,phase:'pending'});
    expect(store.rows.get('system/videoTranscriptScheduler')).toMatchObject({after:'m-paid',leaseUntil:0});
    await handlers.processTranscriptTick(args);
    expect(calls).toEqual(['m-paid','z-expired']);
  });
  it('moves past a bounded page of healthy local jobs and wraps a deleted cursor target',async()=>{
    const store=await queued();const now=Date.now();store.rows.delete(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`);
    for(let i=0;i<25;i++){const id=`a${String(i).padStart(2,'0')}`;store.rows.set(`${jobs.TRANSCRIPT_JOBS}/${id}`,{...store.job,id,provider:'local',localQueuedAt:new Date(now).toISOString()});}
    const legacy={...store.job,id:'z-legacy',phase:'starting',startIntentAt:new Date(now).toISOString()};delete legacy.provider;
    store.rows.set(`${jobs.TRANSCRIPT_JOBS}/z-legacy`,legacy);
    const calls=[];const args={firestore:store.firestore,config:{...config,localEnabled:true,fallbackEnabled:true},now:()=>now,processor:{process:async(job)=>calls.push(job.id)}};
    expect(await handlers.processTranscriptTick(args)).toMatchObject({idle:true});
    await handlers.processTranscriptTick(args);expect(calls).toEqual(['z-legacy']);
    store.rows.get('system/videoTranscriptScheduler').after='zz-deleted';
    expect(await handlers.processTranscriptTick(args)).toMatchObject({idle:true});
    await handlers.processTranscriptTick(args);expect(calls).toEqual(['z-legacy','z-legacy']);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/z-legacy`).provider).toBeUndefined();
  });
  it('fences overlapping sweep invocations and cannot release a newer cursor lease',async()=>{
    const store=await queued();let entered;const started=new Promise(resolve=>{entered=resolve;});let finish;const hold=new Promise(resolve=>{finish=resolve;});
    const args={firestore:store.firestore,config,processor:{process:async()=>{entered();await hold;}}};
    const first=handlers.processTranscriptTick(args);await started;
    expect(await handlers.processTranscriptTick(args)).toMatchObject({busy:true});
    Object.assign(store.rows.get('system/videoTranscriptScheduler'),{leaseOwner:'new-owner',after:'new-cursor',leaseUntil:Date.now()+300000});
    finish();await first;
    expect(store.rows.get('system/videoTranscriptScheduler')).toMatchObject({leaseOwner:'new-owner',after:'new-cursor'});
  });

  it('rechecks billing after input preparation and can resume without a paid retry',async()=>{
    const {job}=await queued();let reads=0;let disabled=true;
    const {processor,calls,save}=processing(job,{billingDisabled:()=>++reads>1&&disabled});
    await processor.process(job,save);
    expect(job.phase).toBe('pending');
    expect(calls.some(call=>call.constructor.name==='CopyObjectCommand')).toBe(true);
    expect(calls.some(call=>call.constructor.name==='StartTranscriptionJobCommand')).toBe(false);
    disabled=false;await processor.process(job,save);
    expect(job.phase).toBe('running');expect(job.errorCode).toBe(null);
    expect(calls.filter(call=>call.constructor.name==='StartTranscriptionJobCommand')).toHaveLength(1);
  });
  it('blocks new paid work while billing is disabled and preserves pending intent',async()=>{
    const {job}=await queued();
    const {processor,calls,save}=processing(job,{billingDisabled:true});
    await processor.process(job,save);
    expect(job.errorCode).toBe('billing_unavailable');
    expect(job.phase).toBe('pending');
    expect(calls.map(call=>call.constructor.name)).toEqual(['GetTranscriptionJobCommand']);
  });
  it('rejects arbitrary provider fields, archive, speaker and language values',()=>{
    for(const extra of [{sourceId:'archive-originals'},{maxSpeakers:31},{maxSpeakers:'4'},{languageCode:'any'},{assetId:12},{model:'custom'},{force:true}])
      expect(()=>contract.parseTranscriptRequest({...request,...extra})).toThrow();
  });
  it('caches the immutable object and settings across metadata edits',()=>{
    const original=asset();const id=contract.transcriptId(original,source.bucket,request);
    expect(contract.transcriptId({...original,name:'New',version:2},source.bucket,request)).toBe(id);
    expect(contract.transcriptId({...original,objectVersionId:'v2'},source.bucket,request)).not.toBe(id);
    expect(contract.transcriptId(original,'other-bucket',request)).not.toBe(id);
    expect(contract.transcriptId(original,source.bucket,{...request,maxSpeakers:2})).not.toBe(id);
  });
  it('concurrent requests create one paid job intent and one audit row',async()=>{
    const store=memoryStore();const args={firestore:store.firestore,source,request,actor,audit};
    const results=await Promise.all([jobs.requestTranscript(args),jobs.requestTranscript(args)]);
    expect(results.map(x=>x.cached)).toEqual([false,true]);
    expect([...store.rows.keys()].filter(x=>x.startsWith(jobs.TRANSCRIPT_JOBS+'/'))).toHaveLength(1);
    expect([...store.rows.keys()].filter(x=>x.startsWith('admin_logs/'))).toHaveLength(1);
  });
  it('enforces durable actor, daily and outstanding transcript limits',async()=>{
    const day='2026-09-16';const now=Date.parse(`${day}T12:00:00Z`);
    const actorLimitId=createHash('sha256').update(actor.uid).digest('hex');
    for(const [setup,existingJobs] of [
      [(store)=>store.rows.set(`${jobs.TRANSCRIPT_LIMITS}/${actorLimitId}`,{day,count:5}),0],
      [(store)=>store.rows.set(`${jobs.TRANSCRIPT_LIMITS}/day-${day}`,{count:20}),0],
      [(store)=>{store.rows.set(`${jobs.TRANSCRIPT_LIMITS}/${actorLimitId}`,{day,count:1,activeId:'other'});
        store.rows.set(`${jobs.TRANSCRIPT_JOBS}/other`,{active:true,phase:'pending'});},
      1],
      [(store)=>{const activeIds=Array.from({length:20},(_,index)=>`active-${index}`);
        store.rows.set(`${jobs.TRANSCRIPT_LIMITS}/outstanding`,{activeIds});
        for(const id of activeIds)store.rows.set(`${jobs.TRANSCRIPT_JOBS}/${id}`,{active:true,phase:'pending'});},
      20],
      [(store)=>{
        store.rows.set(`${jobs.TRANSCRIPT_JOBS}/other`,{active:true,phase:'pending',requestedBy:actor.uid,createdAt:`${day}T01:00:00.000Z`});
      },1],
      [(store)=>{
        for(let index=0;index<20;index++)store.rows.set(`${jobs.TRANSCRIPT_JOBS}/day-${index}`,{
          active:false,phase:'ready',requestedBy:'other',createdAt:`${day}T01:00:00.000Z`});
      },20],
      [(store)=>{
        for(let index=0;index<20;index++)store.rows.set(`${jobs.TRANSCRIPT_JOBS}/queue-${index}`,{
          active:true,phase:'pending',requestedBy:'other',createdAt:'2026-09-15T01:00:00.000Z'});
      },20],
      [(store)=>{
        for(let index=0;index<20;index++)store.rows.set(`${jobs.TRANSCRIPT_JOBS}/repair-${index}`,{
          active:false,phase:'needs_reconciliation',requestedBy:'other',createdAt:'2026-09-15T01:00:00.000Z'});
      },20],
    ]) {
      const store=memoryStore();setup(store);
      await expect(jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit,now})).rejects.toMatchObject({status:429});
      expect([...store.rows.keys()].filter(key=>key.startsWith(`${jobs.TRANSCRIPT_JOBS}/`))).toHaveLength(existingJobs);
    }
  });
  it('refuses unsupported ready copy size, duration and missing preview before any intent',async()=>{
    for(const edit of [a=>{a.rendition=null;},a=>{a.rendition.web.sizeBytes=2_000_000_001;},a=>{a.rendition.web.durationSeconds=7201;},a=>{delete a.rendition.web.durationSeconds;}]){
      const store=memoryStore();edit(store.rows.get('mediaSourceAssets/asset'));
      await expect(queued(store)).rejects.toMatchObject({status:409});expect(store.rows.size).toBe(1);
    }
  });
  it('denies an inactive staff account before creating a job',async()=>{
    const store=memoryStore();const handler=handlers.createTranscriptHandler('request',handlerDependencies(store,{
      authorizeFn:(args)=>sources.authorizeMediaSource({...args,isApprovedActiveAccountFn:async()=>false})}));
    expect((await call(handler)).statusCode).toBe(403);expect(store.rows.size).toBe(1);
  });
  it('enforces App Check before requesting work',async()=>{
    const store=memoryStore();const handler=handlers.createTranscriptHandler('request',handlerDependencies(store,{
      verifyAppCheckFn:async()=>{throw Object.assign(Error('denied'),{status:401});}}));
    expect((await call(handler)).statusCode).toBe(401);expect(store.rows.size).toBe(1);
  });
  it('unauthenticated smoke requests are denied before request validation',async()=>{
    const store=memoryStore();
    for(const operation of ['request','get','download']) {
      const handler=handlers.createTranscriptHandler(operation,handlerDependencies(store,{
        requirePrincipalFn:async()=>{throw Object.assign(Error('Authentication required'),{status:401});}}));
      expect((await call(handler,{})).statusCode).toBe(401);
    }
    expect(store.rows.size).toBe(1);
  });
  it('reports no cached result without starting a job',async()=>{
    const store=memoryStore();const res=await call(handlers.createTranscriptHandler('get',handlerDependencies(store)));
    expect(res.body).toEqual({success:true,transcript:{state:'not_requested'},cached:false,
      requestPolicy:{enabled:true,localEnabled:false,provider:'elevenlabs',fallbackEnabled:true,paidFallbackProviders:['elevenlabs','amazon-transcribe']}});expect(store.rows.size).toBe(1);
  });
  it('records the paid routing policy and authentic session time on a new request',async()=>{
    const store=memoryStore();const res=await call(handlers.createTranscriptHandler('request',handlerDependencies(store,{
      configFn:()=>({...config,localEnabled:true,fallbackEnabled:true})})));
    expect(res.statusCode).toBe(200);
    const job=[...store.rows.values()].find(value=>value?.processingPolicy===fallbackPolicy.PAID_FALLBACK_POLICY);
    expect(job).toMatchObject({provider:'local',requestedAuthTime:actor.authTime,active:true});
    expect(res.body.requestPolicy).toEqual({enabled:true,localEnabled:true,provider:'local-whisper',fallbackEnabled:true,
      paidFallbackProviders:['elevenlabs','amazon-transcribe']});
  });
  it('reports station fallback while the scheduler still fences the Amazon parent',async()=>{
    const store=memoryStore();const res=await call(handlers.createTranscriptHandler('request',handlerDependencies(store,{
      configFn:()=>({...config,localEnabled:false,fallbackEnabled:true})})));
    const job=[...store.rows.values()].find(value=>value?.processingPolicy===fallbackPolicy.PAID_FALLBACK_POLICY);
    expect(job).toMatchObject({provider:'amazon-transcribe',paidFallbackState:'pending'});
    expect(res.body.transcript.processing).toMatchObject({provider:'elevenlabs',estimatedAwsChargeUsd:null});
  });
  it.each([
    [{localEnabled:true,fallbackEnabled:true},{enabled:true,provider:'local-whisper',fallbackEnabled:true}],
    [{localEnabled:true,fallbackEnabled:false},{enabled:true,provider:'local-whisper',fallbackEnabled:false}],
    [{localEnabled:false,fallbackEnabled:true},{enabled:true,provider:'elevenlabs',fallbackEnabled:true}],
    [{localEnabled:false,fallbackEnabled:false},{enabled:true,provider:'elevenlabs',fallbackEnabled:true}],
    [{enabled:false,localEnabled:true},{enabled:false,provider:'local-whisper',fallbackEnabled:false}],
    [{controlRoleArn:''},{enabled:false,provider:'elevenlabs',fallbackEnabled:false}],
  ])('exposes the effective policy before any transcript request',async(overrides,expected)=>{
    const store=memoryStore();
    const handler=handlers.createTranscriptHandler('get',handlerDependencies(store,{configFn:()=>({...config,...overrides})}));
    const res=await call(handler);
    expect(res.statusCode).toBe(200);expect(res.body.requestPolicy).toEqual({...expected,localEnabled:Boolean(overrides.localEnabled),paidFallbackProviders:['elevenlabs','amazon-transcribe']});
    expect(res.body.transcript.state).toBe('not_requested');expect(store.rows.size).toBe(1);
  });
  it('returns a failed cached record without creating a paid retry',async()=>{
    const store=await queued();store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`).phase='failed';
    const result=await jobs.requestTranscript({firestore:store.firestore,source,request,actor,audit});
    expect(result.cached).toBe(true);expect(result.job.phase).toBe('failed');
  });
  it('claims only one worker and excludes replacement/deleted originals',async()=>{
    const store=await queued();const ref=store.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(store.job.id);
    const claims=await Promise.all([jobs.claimTranscript(store.firestore,ref,source),jobs.claimTranscript(store.firestore,ref,source)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    store.rows.get('mediaSourceAssets/asset').lifecycle='deleted';
    expect(await jobs.saveTranscript(store.firestore,ref,claims[0],{phase:'ready',active:false})).toBe(false);
    expect(store.rows.get(ref.path).phase).toBe('stale');
    await expect(jobs.getTranscriptJob({firestore:store.firestore,source,request})).rejects.toMatchObject({status:404});
  });
});

describe('provider deduplication and private cache',()=>{
  it('pins S3 copy to immutable ready version and persists intent before one paid start',async()=>{
    const {job}=await queued();const {processor,calls,save}=processing(job);
    const stages=[];
    await processor.process(job,async(changes)=>{if(changes.processingStage)stages.push(changes.processingStage);if(changes.phase==='starting')expect(calls.some(x=>x.constructor.name==='StartTranscriptionJobCommand')).toBe(false);return save(changes);});
    expect(stages).toEqual(['preparing','processing','processing']);
    const copy=calls.find(x=>x.constructor.name==='CopyObjectCommand').input;
    expect(copy.CopySource).toContain('?versionId=web1');expect(copy.ExpectedSourceBucketOwner).toBe(config.accountId);
    const start=calls.find(x=>x.constructor.name==='StartTranscriptionJobCommand').input;
    expect(start.Settings).toEqual({ShowSpeakerLabels:true,MaxSpeakerLabels:10});expect(start.OutputKey).toBe(processorModule.resultKey(job));
  });
  it('lost start response is recovered by GET with no second paid call',async()=>{
    const {job}=await queued();const first=processing(job,{startError:Error('connection lost')});
    await expect(first.processor.process(job,first.save)).rejects.toThrow('connection lost');expect(job.phase).toBe('starting');
    const second=processing(job,{provider:providerJob(job)});await second.processor.process(job,second.save);
    expect(second.calls.map(x=>x.constructor.name)).toEqual(['GetTranscriptionJobCommand']);expect(job.phase).toBe('running');
  });
  it('an unconfirmed durable start never submits a second run, even after provider retention',async()=>{
    const {job}=await queued();job.phase='starting';job.startIntentAt='2020-01-01T00:00:00Z';
    const {processor,calls,save}=processing(job);await processor.process(job,save);
    expect(job.phase).toBe('needs_reconciliation');expect(calls).toHaveLength(1);
  });
  it('a lost lease prevents starting after the native copy',async()=>{
    const {job}=await queued();const {processor,calls}=processing(job);await processor.process(job,async()=>false);
    expect(calls.some(x=>x.constructor.name==='StartTranscriptionJobCommand')).toBe(false);
  });
  it('rejects an existing provider job with another input or settings',async()=>{
    const {job}=await queued();const provider=providerJob(job);provider.Media.MediaFileUri='s3://other/private';
    const {processor,save}=processing(job,{provider});await expect(processor.process(job,save)).rejects.toThrow('transcript_job_identity_invalid');
  });
  it('stores versioned full exports and speaker segments, with no transcript body in Firestore metadata',async()=>{
    const {job}=await queued();const payload={jobName:processorModule.jobName(job),status:'COMPLETED',results:{items:[
      {type:'pronunciation',start_time:'0.1',end_time:'0.8',speaker_label:'spk_0',alternatives:[{content:'Hello'}]},
      {type:'punctuation',alternatives:[{content:'.'}]}]}};
    const writes=[];const {processor,save}=processing(job,{provider:providerJob(job,'COMPLETED'),s3Send:async(command)=>{
      if(command.constructor.name==='HeadObjectCommand'){expect(job.processingStage).toBe('finalizing');return {VersionId:'raw1',ContentLength:200};}
      if(command.constructor.name==='GetObjectCommand'){expect(command.input.VersionId).toBe('raw1');return {Body:Readable.from([JSON.stringify(payload)])};}
      writes.push(command.input);return {VersionId:'stored-version'};
    }});
    await processor.process(job,save);expect(job.phase).toBe('ready');expect(job.totalSegments).toBe(1);
    expect(JSON.stringify(job)).not.toContain('Hello');expect(writes).toHaveLength(3);
    expect(writes.find(x=>x.Key.endsWith('.txt')).Body).toContain('Speaker 1: Hello.');
  });
  it('bounds provider response memory and closes the stream',async()=>{
    const stream=Readable.from(['small']);await expect(processorModule.boundedBody({ContentLength:contract.MAX_RESULT_BYTES+1,Body:stream})).rejects.toThrow('transcript_output_too_large');expect(stream.destroyed).toBe(true);
  });
  it('stores a completed paid result even if its temporary audio delete fails',async()=>{
    const {job}=await queued();job.providerInputRevision='m4a-v1';
    job.amazonAudioInput={objectKey:`transcripts/inputs/amazon/${job.id}/attempts/00000000-0000-4000-8000-000000000001/input.m4a`,objectVersionId:'audio-copy-v1'};
    // Transcribe reports MediaFormat mp4 for a job started with m4a (live job, October 18, 2026).
    const provider={...providerJob(job,'COMPLETED'),MediaFormat:'mp4'};
    const payload={jobName:processorModule.jobName(job),status:'COMPLETED',results:{items:[]}};
    const {processor,save}=processing(job,{provider,s3Send:async(command)=>{
      if(command.constructor.name==='DeleteObjectCommand')throw Error('temporary storage failure');
      if(command.constructor.name==='HeadObjectCommand')return {VersionId:'raw1',ContentLength:200};
      if(command.constructor.name==='GetObjectCommand')return {Body:Readable.from([JSON.stringify(payload)])};
      return {VersionId:'stored-version'};
    }});
    await processor.process(job,save);
    expect(job).toMatchObject({phase:'ready',active:false,totalSegments:0,audioProviderTerminal:true});
    expect(job.amazonAudioDeleted).not.toBe(true);
  });
  it('rejects a prepared-audio provider job with another media format',async()=>{
    const {job}=await queued();job.providerInputRevision='m4a-v1';
    job.amazonAudioInput={objectKey:`transcripts/inputs/amazon/${job.id}/attempts/00000000-0000-4000-8000-000000000001/input.m4a`,objectVersionId:'audio-copy-v1'};
    const provider={...providerJob(job,'COMPLETED'),MediaFormat:'wav'};
    const {processor,save}=processing(job,{provider,s3Send:async()=>({VersionId:'raw1',ContentLength:200})});
    await expect(processor.process(job,save)).rejects.toThrow('transcript_job_identity_invalid');
  });
  it('rechecks deleted asset after cache read before returning text',async()=>{
    const store=await queued();store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`).phase='ready';
    const handler=handlers.createTranscriptHandler('get',handlerDependencies(store,{processor:{read:async()=>{
      store.rows.get('mediaSourceAssets/asset').lifecycle='deleted';return [{text:'private'}];}}}));
    const res=await call(handler);expect(res.statusCode).toBe(404);expect(JSON.stringify(res.body)).not.toContain('private');
  });
  it('signs only the cached export version for five minutes',async()=>{
    const {job}=await queued();job.outputs={txt:'txt-version'};let signed;
    const processor=processorModule.createVideoTranscriptProcessor(config,{credentials:async()=>({}),transcribe:{},s3:{},
      sign:async(client,command,options)=>{signed={input:command.input,options};return 'https://private.example/download';}});
    const result=await processor.download(job,'txt');
    expect(signed.input.Key).toBe(`transcripts/results/${job.id}.txt`);expect(signed.input.VersionId).toBe('txt-version');
    expect(signed.input.ExpectedBucketOwner).toBe(config.accountId);expect(signed.options.expiresIn).toBe(300);expect(result.url).toBe('https://private.example/download');
  });
  it('does not release a signed URL after source replacement',async()=>{
    const store=await queued();store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`).phase='ready';
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor:{download:async()=>{
      store.rows.get('mediaSourceAssets/asset').objectVersionId='replacement';return {url:'https://private.example/download'};}}}));
    const res=await call(handler,{...request,format:'txt'});expect(res.statusCode).toBe(409);expect(JSON.stringify(res.body)).not.toContain('https://');
  });
  it('a different ready-copy size prevents paid start',async()=>{
    const {job}=await queued();const {processor,calls,save}=processing(job,{s3Send:async()=>({VersionId:'web1',ContentLength:51})});
    await expect(processor.process(job,save)).rejects.toThrow('transcript_input_changed');expect(calls.some(x=>x.constructor.name==='StartTranscriptionJobCommand')).toBe(false);
  });
  it('stops repeated adapter errors at reconciliation without changing cache identity',async()=>{
    const store=await queued();const path=`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`;store.rows.get(path).failures=4;
    await handlers.processTranscriptTick({firestore:store.firestore,config,processor:{process:async()=>{throw Error('private provider detail');}}});
    expect(store.rows.get(path)).toMatchObject({id:store.job.id,phase:'needs_reconciliation',active:false,errorCode:'processing_failed'});
  });
});

describe('speaker transcript format',()=>{
  it('maps diarization timestamps, attaches punctuation and separates speaker turns',()=>{
    const items=[{type:'pronunciation',start_time:'0.1',end_time:'0.8',alternatives:[{content:'Hello'}]},
      {type:'punctuation',alternatives:[{content:','}]},{type:'pronunciation',start_time:'1',end_time:'2',alternatives:[{content:'there'}]},
      {type:'pronunciation',start_time:'3',end_time:'4',alternatives:[{content:'Yes'}]}];
    const parsed=contract.normalizeTranscript({jobName:'job',status:'COMPLETED',results:{items,speaker_labels:{segments:[
      {speaker_label:'spk_0',items:[{start_time:'0.1'},{start_time:'1'}]}, {speaker_label:'spk_1',items:[{start_time:'3'}]}]}}},'job');
    expect(parsed).toEqual([{speaker:'spk_0',startSeconds:0.1,endSeconds:2,text:'Hello, there',words:[{startSeconds:0.1,endSeconds:0.8,text:'Hello,'},{startSeconds:1,endSeconds:2,text:'there'}]},{speaker:'spk_1',startSeconds:3,endSeconds:4,text:'Yes',words:[{startSeconds:3,endSeconds:4,text:'Yes'}]}]);
  });
  it('binds pagination to cached identity and escapes WebVTT text',()=>{
    const job={id:'one',phase:'ready'};const segments=Array.from({length:101},()=>({speaker:'spk_0',startSeconds:1,endSeconds:2,text:'<b>& test'}));
    const page=contract.transcriptPage(job,segments);expect(page.segments).toHaveLength(100);
    expect(contract.transcriptPage(job,segments,page.nextCursor).segments).toHaveLength(1);
    expect(()=>contract.transcriptPage({...job,id:'other'},segments,page.nextCursor)).toThrow();
    expect(contract.transcriptExports(segments.slice(0,1)).vtt).toContain('&lt;b&gt;&amp; test');
  });
  it('builds SRT cues with comma milliseconds and one line of text',()=>{
    const segments=[{speaker:'spk_0',startSeconds:3661.5,endSeconds:3662.25,text:'First\n\nline'},{speaker:'spk_1',startSeconds:4000,endSeconds:4001,text:'<i>Second</i>'}];
    expect(contract.transcriptSrt(segments)).toBe('1\n01:01:01,500 --> 01:01:02,250\nFirst line\n\n2\n01:06:40,000 --> 01:06:41,000\n<i>Second</i>\n');
  });
});

describe('saved transcript corrections',()=>{
  const segment=(text='Original',speaker='spk_0')=>({text,speaker,startSeconds:1,endSeconds:2});
  const editRequest=(extra={})=>({...request,revision:0,segments:[{index:0,text:'Corrected',speaker:'spk_1'}],speakerNames:{spk_1:'Editor name'},...extra});
  async function ready(){
    const store=await queued();const path=`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`;
    store.rows.set('users/staff',{active:true,grants:[{role:'staff'}]});
    const job=store.rows.get(path);Object.assign(job,{phase:'ready',active:false,totalSegments:1,outputs:{'segments.json':'original-segments',txt:'original-txt',vtt:'original-vtt'}});
    return {...store,path,job};
  }
  async function readyClip() {
    const store = await ready();
    const video = store.rows.get('mediaSourceAssets/asset');
    const web = video.rendition.web;
    const clip = { id: 'c'.repeat(64), sourceId: video.sourceId, assetId: video.id,
      sourceObjectKey: video.objectKey, sourceObjectVersionId: video.objectVersionId, sourceSizeBytes: video.sizeBytes,
      inputObjectKey: web.objectKey, inputObjectVersionId: web.objectVersionId, inputSizeBytes: web.sizeBytes,
      phase: 'ready', inMs: 1000, outMs: 2000, output: { frameDurationSeconds: 0.04 }, expiresAt: '2099-01-01T00:00:00Z' };
    store.rows.set(`mediaSourceClipJobs/${clip.id}`, clip);
    return { ...store, clip };
  }
  it('exports the saved clip transcript without invoking a processing or storage-write method', async () => {
    const store = await readyClip();
    const handler = handlers.createTranscriptHandler('download', handlerDependencies(store, { processor: { read: async () => [segment('Saved correction')] } }));
    const result = await call(handler, { ...request, format: 'txt', clipId: store.clip.id });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ clipId: store.clip.id, inMs: 1000, outMs: 2000, timingBasis: 'clip-elapsed' });
    expect(result.body.body).toContain('[00:00:00.000] Speaker 1: Saved correction');
  });
  it('does not release a clip transcript after source, clip or transcript changes during the read', async () => {
    for (const change of ['source', 'clip', 'revision']) {
      const store = await readyClip();
      const handler = handlers.createTranscriptHandler('download', handlerDependencies(store, { processor: { read: async () => {
        if (change === 'source') store.rows.get('mediaSourceAssets/asset').lifecycle = 'deleted';
        if (change === 'clip') store.clip.phase = 'failed';
        if (change === 'revision') store.job.editRevision = 1;
        return [segment('Private stale text')];
      } } }));
      const result = await call(handler, { ...request, format: 'txt', clipId: store.clip.id });
      expect([404, 409]).toContain(result.statusCode);
      expect(JSON.stringify(result.body)).not.toContain('Private stale text');
    }
  });
  it('rejects denied source access and App Check before reading transcript contents', async () => {
    for (const boundary of ['authorizeFn', 'verifyAppCheckFn']) {
      const store = await readyClip(); let reads = 0;
      const handler = handlers.createTranscriptHandler('download', handlerDependencies(store, {
        [boundary]: async () => { throw Object.assign(Error('Denied'), { status: 403 }); },
        processor: { read: async () => { reads++; return [segment()]; } },
      }));
      const result = await call(handler, { ...request, format: 'txt', clipId: store.clip.id });
      expect(result.statusCode).toBe(403); expect(reads).toBe(0);
    }
  });
  function editor(store,processor={read:async()=>[segment()],edit:async()=>({'segments.json':'edit-segments',txt:'edit-txt',vtt:'edit-vtt'})},extra={}){
    return handlers.createTranscriptHandler('edit',handlerDependencies(store,{processor,assertBillingEnabledFn:async()=>{},...extra}));
  }
  it('marks the exact revision reviewed without S3 writes or the billing guard',async()=>{
    const store=await ready();let writes=0;let billing=0;
    const processor={read:async()=>{expect(store.rows.get(store.path).reviewedRevision).toBe(1);return [segment()];},edit:async()=>{writes++;}};
    const res=await call(editor(store,processor,{assertBillingEnabledFn:async()=>{billing++;throw Error('disabled');}}),{...request,revision:0,reviewed:true});
    expect(res.statusCode).toBe(200);expect(res.body.transcript.editRevision).toBe(1);
    expect(store.rows.get(store.path)).toMatchObject({reviewedRevision:1,reviewedBy:actor.uid,outputs:store.job.outputs});
    expect(writes).toBe(0);expect(billing).toBe(0);
    expect((await call(editor(store),{...request,revision:0,reviewed:true})).statusCode).toBe(409);
  });
  it('persists speaker roles and clears earlier review when text changes',async()=>{
    const store=await ready();Object.assign(store.rows.get(store.path),{reviewedRevision:0,reviewedAt:new Date().toISOString()});
    const res=await call(editor(store),editRequest({speakerRoles:{spk_1:'Reporter'}}));
    expect(res.statusCode).toBe(200);
    expect(store.rows.get(store.path)).toMatchObject({speakerRoles:{spk_1:'Reporter'},reviewedRevision:null,reviewedAt:null});
  });
  it('uses trusted asset metadata for TSV and checks deletion after writing the private log',async()=>{
    const store=await ready();let writes=0;
    const processor={downloadLog:async(job,metadata)=>{writes++;expect(metadata).toEqual({title:'Video',assetId:'asset',sourceVersion:'version1'});store.rows.get('mediaSourceAssets/asset').lifecycle='deleted';return {url:'private-url'};}};
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor}));
    const res=await call(handler,{...request,format:'tsv'});
    expect(writes).toBe(1);expect(res.statusCode).toBe(404);expect(res.body).not.toHaveProperty('url');
  });
  it('refuses a stale TSV revision before any export write',async()=>{
    const store=await ready();const collection=store.firestore.collection;let writes=0;
    store.firestore.collection=(name)=>{const result=collection(name);if(name!=='mediaSourceAssets')return result;const doc=result.doc;result.doc=(id)=>{const reference=doc(id);const get=reference.get;reference.get=async()=>{store.rows.get(store.path).editRevision=1;return get();};return reference;};return result;};
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor:{downloadLog:async()=>{writes++;}}}));
    expect((await call(handler,{...request,format:'tsv'})).statusCode).toBe(409);expect(writes).toBe(0);
  });

  it.each(['avid','premiere'])('guards %s exports against a revision change during storage work',async(format)=>{
    const store=await ready();let writes=0;
    const processor={downloadNle:async(job,parsed,metadata)=>{
      writes++;expect(parsed.format).toBe(format);expect(metadata.assetId).toBe('asset');
      store.rows.get(store.path).editRevision=1;return {url:'private-url'};
    }};
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor}));
    const res=await call(handler,{...request,format,...(format==='avid'?{frameRate:'30000/1001',frameOffset:0}:{})});
    expect(writes).toBe(1);expect(res.statusCode).toBe(409);expect(res.body).not.toHaveProperty('url');
  });

  it('rejects timing changes, unknown fields, duplicate indices, oversized text and unsafe speaker IDs',()=>{
    const invalid=[{revision:-1},{revision:1.5},{revision:Number.MAX_SAFE_INTEGER},{segments:[] ,speakerNames:{}},
      {segments:[{index:0,startSeconds:2,text:'x'}]},{segments:[{index:0}]},{segments:[{index:0,text:1}]},
      {segments:[{index:0,text:'x'.repeat(16001)}]},{segments:[{index:0,text:'a\0b'}]},
      {segments:[{index:0,speaker:'spk_100'}]},{segments:[{index:0,speaker:'spk_01'}]},
      {segments:[{index:0,text:'a'},{index:0,text:'b'}]},{segments:Array.from({length:101},(_,index)=>({index,text:'a'}))},
      {speakerNames:{spk_0:'a\nb'}},{speakerNames:{spk_0:'x'.repeat(101)}},{speakerNames:JSON.parse('{"__proto__":"bad"}')},
      {outputs:{txt:'foreign'}},{model:'other'}];
    for(const change of invalid)expect(()=>contract.parseTranscriptEdit(editRequest(change))).toThrow();
    expect(()=>contract.parseTranscriptEdit(editRequest({segments:[{index:0,speaker:'spk_99'}]}))).not.toThrow();
  });
  it('requires upload authorization and App Check before storage edits',async()=>{
    const store=await ready();let touched=false;const processor={read:async()=>{touched=true;return[];}};
    const denied=await call(editor(store,processor,{authorizeFn:async({operation})=>{expect(operation).toBe('transcript');throw Object.assign(Error('denied'),{status:403});}}),editRequest());
    expect(denied.statusCode).toBe(403);expect(touched).toBe(false);
    const noAppCheck=await call(editor(store,processor,{verifyAppCheckFn:async()=>{throw Object.assign(Error('denied'),{status:401});}}),{});
    expect(noAppCheck.statusCode).toBe(401);expect(touched).toBe(false);
  });
  it('blocks edit writes and commits when billing is disabled or unavailable',async()=>{
    for(const reason of ['disabled','unavailable']){
      const store=await ready();let writes=0;
      const processor={read:async()=>[segment()],edit:async()=>{writes++;return {};}};
      const result=await call(editor(store,processor,{assertBillingEnabledFn:async(firestore)=>{
        expect(firestore).toBe(store.firestore);throw Error('private billing reason '+reason);
      },log:{warn:()=>{}}}),editRequest());
      expect(result.statusCode).toBe(503);expect(JSON.stringify(result.body)).not.toContain('private billing reason');
      expect(writes).toBe(0);expect(store.rows.get(store.path).editRevision).toBeUndefined();
      expect(store.rows.get(store.path).editedOutputs).toBeUndefined();
      expect([...store.rows.values()].some(row=>row.action==='media.transcript.edit')).toBe(false);
    }
  });
  it('commits corrected text and names while preserving times, original outputs and audit privacy',async()=>{
    const store=await ready();let saved;
    const processor={read:async()=>[segment()],edit:async(job,segments,names)=>{saved={segments,names};return {'segments.json':'edited1',txt:'txt1',vtt:'vtt1'};}};
    const result=await call(editor(store,processor),editRequest());
    expect(result.statusCode).toBe(200);expect(saved).toEqual({segments:[segment('Corrected','spk_1')],names:{spk_1:'Editor name'}});
    expect(result.body.transcript).toMatchObject({editRevision:1,speakerNames:{spk_1:'Editor name'},speakerIds:['spk_1'],segments:[{...segment('Corrected','spk_1'),index:0}]});
    expect(store.rows.get(store.path).outputs).toEqual({'segments.json':'original-segments',txt:'original-txt',vtt:'original-vtt'});
    expect(store.rows.get(store.path).editedOutputs).toEqual({'segments.json':'edited1',txt:'txt1',vtt:'vtt1'});
    const auditRows=[...store.rows].filter(([path,row])=>path.startsWith('admin_logs/')&&row.action==='media.transcript.edit');
    expect(auditRows).toHaveLength(1);expect(JSON.stringify(auditRows)).not.toMatch(/Corrected|Editor name/);
  });
  it('allows only one simultaneous save at a revision and rejects stale saves before storage',async()=>{
    const store=await ready();let writes=0;const processor={read:async()=>[segment()],edit:async()=>({txt:`v${++writes}`})};
    const handler=editor(store,processor);const results=await Promise.all([call(handler,editRequest()),call(handler,editRequest({speakerNames:{spk_1:'Other'}}))]);
    expect(results.map(x=>x.statusCode).sort()).toEqual([200,409]);expect(store.rows.get(store.path).editRevision).toBe(1);
    const count=writes;expect((await call(handler,editRequest())).statusCode).toBe(409);expect(writes).toBe(count);
    expect([...store.rows.values()].filter(x=>x.action==='media.transcript.edit')).toHaveLength(1);
  });
  it('rejects invalid indexes before writes and does not commit partial storage failures',async()=>{
    const store=await ready();let writes=0;const processor={read:async()=>[segment()],edit:async()=>{writes++;throw Error('private text or storage failure');}};
    expect((await call(editor(store,processor),editRequest({segments:[{index:1,text:'x'}]}))).statusCode).toBe(400);expect(writes).toBe(0);
    const result=await call(editor(store,processor,{log:{warn:()=>{}}}),editRequest());expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('private text');expect(store.rows.get(store.path).editRevision).toBeUndefined();
  });
  it('rechecks source deletion and replacement after storage before committing',async()=>{
    for(const mutation of [asset=>{asset.lifecycle='deleted';},asset=>{asset.objectVersionId='new';}]){
      const store=await ready();const processor={read:async()=>[segment()],edit:async()=>{mutation(store.rows.get('mediaSourceAssets/asset'));return {txt:'orphan'};}};
      const result=await call(editor(store,processor),editRequest());expect([404,409]).toContain(result.statusCode);
      expect(store.rows.get(store.path).editedOutputs).toBeUndefined();expect([...store.rows.values()].some(x=>x.action==='media.transcript.edit')).toBe(false);
    }
  });
  it('withholds stale text and signed URLs when the edit revision changes during storage work',async()=>{
    for(const operation of ['get','download']){
      const store=await ready();const change=()=>{store.rows.get(store.path).editRevision=1;};
      const processor={read:async()=>{change();return[segment('private stale')];},download:async()=>{change();return{url:'https://private.example/stale'};}};
      const handler=handlers.createTranscriptHandler(operation,handlerDependencies(store,{processor}));
      const result=await call(handler,{...request,...(operation==='download'?{format:'txt'}:{})});
      expect(result.statusCode).toBe(409);expect(JSON.stringify(result.body)).not.toMatch(/private stale|https:/);
    }
  });
  it('binds cursor revisions and supplies stable indexes and all speakers beyond the first page',()=>{
    const list=Array.from({length:101},(_,index)=>segment('x',index===100?'spk_4':'spk_0'));
    const job={id:'job',phase:'ready',speakerNames:{spk_8:'Named'},editRevision:0};const page=contract.transcriptPage(job,list);
    expect(page.speakerIds).toEqual(['spk_0','spk_4','spk_8']);expect(page.segments[99].index).toBe(99);
    expect(contract.transcriptPage(job,list,page.nextCursor).segments[0].index).toBe(100);
    const legacy=Buffer.from(JSON.stringify({id:'job',offset:100})).toString('base64url');
    expect(contract.transcriptPage(job,list,legacy).segments[0].index).toBe(100);
    for(const cursor of [legacy,page.nextCursor])expect(()=>contract.transcriptPage({...job,editRevision:1},list,cursor)).toThrow('Transcript changed');
  });
  it('merges partial speaker names, resets default names, and escapes both VTT names and text',()=>{
    const patch=contract.parseTranscriptEdit(editRequest({segments:[],speakerNames:{spk_0:'',spk_1:'<Reporter> & guest'}}));
    const result=contract.applyTranscriptEdit({speakerNames:{spk_0:'Old',spk_4:'Retained'}},[segment('<b>text & more','spk_1')],patch);
    expect(result.speakerNames).toEqual({spk_4:'Retained',spk_1:'<Reporter> & guest'});
    const output=contract.transcriptExports(result.segments,result.speakerNames);
    expect(output.txt).toContain('<Reporter> & guest: <b>text & more');
    expect(output.vtt).toContain('<v &lt;Reporter&gt; &amp; guest>&lt;b&gt;text &amp; more</v>');
  });
  it('writes separate edit versions and pins both reads and downloads without invoking Transcribe',async()=>{
    const store=await ready();const writes=[];const reads=[];let signed;
    const processor=processorModule.createVideoTranscriptProcessor(config,{credentials:async()=>({}),transcribe:{send:async()=>{throw Error('must not start');}},
      s3:{send:async(command)=>{if(command.constructor.name==='PutObjectCommand'){writes.push(command.input);return {VersionId:`edited-${writes.length}`};}
        reads.push(command.input);return {Body:Readable.from([JSON.stringify([segment('New')])])};}},
      sign:async(client,command)=>{signed=command.input;return 'https://private.example/edited';}});
    const outputs=await processor.edit(store.job,[segment('New')],{spk_0:'Named'});
    expect(writes).toHaveLength(3);expect(writes.every(x=>x.Key.includes('.edited.'))).toBe(true);
    expect(writes.find(x=>x.Key.endsWith('.txt')).Body).toContain('Named: New');
    const edited={...store.job,editedOutputs:outputs};await processor.read(edited);await processor.download(edited,'txt');
    expect(reads[0]).toMatchObject({Key:processorModule.editedResultKey(store.job,'segments.json'),VersionId:'edited-1'});
    expect(signed).toMatchObject({Key:processorModule.editedResultKey(store.job,'txt'),VersionId:'edited-2'});
    expect(store.job.outputs.txt).toBe('original-txt');
  });
});

describe('default paid fallback resolution',()=>{
  const segment={startSeconds:0.5,endSeconds:1.5,speaker:'spk_0',text:'Station result'};
  it('shows the active Amazon parent when its newer ElevenLabs child failed',async()=>{
    const store=await readyPaidFallback();
    Object.assign(store.rows.get(store.parentPath),{phase:'pending',active:true,paidFallbackState:'amazon',createdAt:'2026-10-28T12:00:00Z'});
    Object.assign(store.rows.get(store.childPath),{phase:'failed',active:false,createdAt:'2026-10-28T12:00:01Z'});
    const handler=handlers.createTranscriptHandler('get',handlerDependencies(store));
    const res=await call(handler);
    expect(res.statusCode).toBe(200);
    expect(res.body.transcript).toMatchObject({id:store.parent.id,state:'queued',processing:{provider:'amazon-transcribe'}});
    const historical=await call(handler,{sourceId:source.id,assetId:'asset',transcriptId:store.child.id});
    expect(historical.body.transcript).toMatchObject({id:store.child.id,state:'failed'});
  });
  it('reads the validated station child for the default request',async()=>{
    const store=await readyPaidFallback();let readId;
    const handler=handlers.createTranscriptHandler('get',handlerDependencies(store,{processor:{read:async(job)=>{readId=job.id;return [segment];}}}));
    const res=await call(handler);
    expect(res.statusCode).toBe(200);expect(readId).toBe(store.child.id);
    expect(res.body.transcript).toMatchObject({id:store.child.id,processing:{provider:'elevenlabs'}});
  });
  it('edits the validated station child and leaves the parent record unchanged',async()=>{
    const store=await readyPaidFallback();const parent=structuredClone(store.parent);let editedId;
    const processor={read:async(job)=>{expect(job.id).toBe(store.child.id);return [segment];},
      edit:async(job)=>{editedId=job.id;return {'segments.json':'edited-segments',txt:'edited-txt',vtt:'edited-vtt'};}};
    const handler=handlers.createTranscriptHandler('edit',handlerDependencies(store,{processor,assertBillingEnabledFn:async()=>{}}));
    const res=await call(handler,{...request,revision:0,segments:[{index:0,text:'Corrected station result',speaker:'spk_0'}],speakerNames:{}});
    expect(res.statusCode).toBe(200);expect(editedId).toBe(store.child.id);
    expect(store.rows.get(store.childPath).editRevision).toBe(1);
    expect(store.rows.get(store.parentPath)).toEqual(parent);
  });
  it('exports a ready clip from the validated station child',async()=>{
    const store=await readyPaidFallback();const video=asset();
    const clip={id:'c'.repeat(64),sourceId:video.sourceId,assetId:video.id,
      sourceObjectKey:video.objectKey,sourceObjectVersionId:video.objectVersionId,sourceSizeBytes:video.sizeBytes,
      inputObjectKey:video.rendition.web.objectKey,inputObjectVersionId:video.rendition.web.objectVersionId,
      inputSizeBytes:video.rendition.web.sizeBytes,phase:'ready',inMs:0,outMs:2000,
      output:{frameDurationSeconds:0.04},expiresAt:'2099-01-01T00:00:00Z'};
    store.rows.set(`mediaSourceClipJobs/${clip.id}`,clip);let readId;
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor:{read:async(job)=>{readId=job.id;return [segment];}}}));
    const res=await call(handler,{...request,format:'txt',clipId:clip.id});
    expect(res.statusCode).toBe(200);expect(readId).toBe(store.child.id);
    expect(res.body).toMatchObject({clipId:clip.id,transcriptId:store.child.id});
    expect(res.body.body).toContain('Station result');
  });
});

describe('explicit transcript variant selection',()=>{
  async function variant(){
    const {default:byok}=await import('../../functions/lib/video-transcript-byok-job.js');
    const {default:credentials}=await import('../../functions/lib/video-transcription-credentials.js');
    const store=memoryStore();const video=asset(),web=video.rendition.web;
    store.rows.set('users/staff',{active:true,grants:[{role:'staff'}]});
    const job=byok.createJob({sourceId:source.id,assetId:video.id,originalBucket:source.bucket,originalKey:video.objectKey,originalVersion:video.objectVersionId,originalSize:video.sizeBytes,
      renditionBucket:config.bucket,renditionKey:web.objectKey,renditionVersion:web.objectVersionId,renditionSize:web.sizeBytes,durationSeconds:web.durationSeconds,languageCode:'en-US',maxSpeakers:10,
      credentialScope:'personal',credentialId:credentials.credentialIdentity(actor,{scope:'personal',provider:'elevenlabs'}).id,credentialRevision:1},actor);
    Object.assign(job,{phase:'ready',active:false,editRevision:0,outputs:{'segments.json':'s',txt:'t',vtt:'v'}});
    const path=`${jobs.TRANSCRIPT_JOBS}/${job.id}`;store.rows.set(path,job);
    return {...store,job,path,selected:{sourceId:source.id,assetId:video.id,transcriptId:job.id}};
  }
  it('rejects invalid IDs, mixed selectors and variant request creation',()=>{
    for(const body of [{transcriptId:'A'.repeat(64)},{transcriptId:'a'.repeat(64),maxSpeakers:10},{transcriptId:'a'.repeat(64),languageCode:'en-US'}])expect(()=>contract.parseTranscriptRequest({sourceId:source.id,assetId:'asset',...body},{read:true})).toThrow();
    expect(()=>contract.parseTranscriptRequest({sourceId:source.id,assetId:'asset',transcriptId:'a'.repeat(64)})).toThrow();
  });
  it('returns honest ElevenLabs summary and selected cached segments without credential data',async()=>{
    const store=await variant();const handler=handlers.createTranscriptHandler('get',handlerDependencies(store,{processor:{read:async()=>[{startSeconds:0,endSeconds:1,speaker:'spk_0',text:'Hello'}]}}));
    const res=await call(handler,store.selected);expect(res.statusCode).toBe(200);
    expect(res.body.transcript).toMatchObject({id:store.job.id,languageCode:'en-US',maxSpeakers:10,processing:{provider:'elevenlabs',estimatedAwsChargeUsd:null}});
    expect(JSON.stringify(res.body)).not.toContain(store.job.identity.credentialId);
  });
  it.each(['asset','original','rendition','size','bucket'])('denies mismatched %s before reading private segments',async(change)=>{
    const store=await variant();let reads=0;
    if(change==='asset'){store.rows.set('mediaSourceAssets/other',{...asset(),id:'other'});store.selected.assetId='other';}
    if(change==='original')store.rows.get('mediaSourceAssets/asset').objectVersionId='new';
    if(change==='rendition')store.rows.get('mediaSourceAssets/asset').rendition.web.objectVersionId='new';
    if(change==='size')store.rows.get('mediaSourceAssets/asset').rendition.web.sizeBytes++;
    const handler=handlers.createTranscriptHandler('get',handlerDependencies(store,{...(change==='bucket'?{configFn:()=>({...config,bucket:'other'})}:{}),processor:{read:async()=>{reads++;return [];}}}));
    expect([404,409]).toContain((await call(handler,store.selected)).statusCode);expect(reads).toBe(0);
  });
  it('uses selected variant for edit CAS and refuses stale revision',async()=>{
    const store=await variant();const processor={read:async()=>[{startSeconds:0,endSeconds:1,speaker:'spk_0',text:'Hello'}],edit:async()=>({'segments.json':'s2',txt:'t2',vtt:'v2'})};
    const handler=handlers.createTranscriptHandler('edit',handlerDependencies(store,{processor,assertBillingEnabledFn:async()=>{}}));
    const body={...store.selected,revision:0,speakerNames:{spk_0:'Voice'}};
    expect((await call(handler,body)).statusCode).toBe(200);expect(store.rows.get(store.path).editRevision).toBe(1);
    expect((await call(handler,body)).statusCode).toBe(409);
  });
  it.each(['txt','vtt','srt','tsv'])('withholds selected %s download when an alignment is approved during the read',async(format)=>{
    const store=await variant();store.rows.get(store.path).alignmentState='review_required';
    const download=async()=>{store.rows.get(store.path).alignmentState='ready';return {url:'private'};};
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor:{download,downloadLog:download,downloadSrt:download}}));
    const res=await call(handler,{...store.selected,format});expect(res.statusCode).toBe(409);expect(res.body).not.toHaveProperty('url');
  });
  it.each(['txt','vtt','srt','tsv'])('withholds selected %s download after rendition replacement',async(format)=>{
    const store=await variant();const download=async()=>{store.rows.get('mediaSourceAssets/asset').rendition.web.objectVersionId='new';return {url:'private'};};
    const handler=handlers.createTranscriptHandler('download',handlerDependencies(store,{processor:{download,downloadLog:download,downloadSrt:download}}));
    const res=await call(handler,{...store.selected,format});expect(res.statusCode).toBe(409);expect(res.body).not.toHaveProperty('url');
  });
});

describe('provider-specific attempts at the callable boundary', () => {
  async function terminalStore(phase = 'needs_reconciliation') {
    const store = await queued();
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`), { phase, active: false, startIntentAt: '2026-09-15T12:00:00Z' });
    return store;
  }
  function requestHandler(store, localEnabled = true, fallbackEnabled = true) {
    return handlers.createTranscriptHandler('request', handlerDependencies(store, { configFn: () => ({ ...config, localEnabled, fallbackEnabled }) }));
  }
  it.each(['local', 'amazon-transcribe'])('creates one %s attempt while preserving the uncertain intent and its history', async provider => {
    const store = await terminalStore();
    const oldPath = `${jobs.TRANSCRIPT_JOBS}/${store.job.id}`, before = structuredClone(store.rows.get(oldPath));
    const body = { ...request, provider, newAttemptOf: store.job.id };
    const results = await Promise.all([call(requestHandler(store), body), call(requestHandler(store), body)]);
    expect(results.map(value => value.statusCode)).toEqual([200, 200]);
    expect(results.map(value => value.body.cached)).toEqual([false, true]);
    const id = results[0].body.transcript.id;
    expect(id).not.toBe(store.job.id);
    expect(results[1].body.transcript.id).toBe(id);
    expect(store.rows.get(oldPath)).toEqual(before);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${id}`)).toMatchObject({ provider, requestedProvider: provider,
      previousTranscriptId: store.job.id, attemptGeneration: 1, active: true });
    const audits = [...store.rows].filter(([path]) => path.startsWith('admin_logs/'));
    expect(audits).toHaveLength(2);
  });
  it('honors the operator Amazon-disabled policy', async () => {
    const store = await terminalStore(), before = store.rows.size;
    const result = await call(requestHandler(store, true, false), { ...request, provider: 'amazon-transcribe', newAttemptOf: store.job.id });
    expect(result.statusCode).toBe(503); expect(store.rows.size).toBe(before);
  });
  it('uses a new action key for a fresh attempt from a retained ready default', async () => {
    const store = await terminalStore('ready');
    const body = { ...request, provider: 'local', newAttemptOf: store.job.id, attemptKey: '11111111-1111-4111-8111-111111111111' };
    const first = await call(requestHandler(store), body), firstId = first.body.transcript.id;
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${firstId}`), { phase: 'failed', active: false });
    const nextBody = { ...body, attemptKey: '22222222-2222-4222-8222-222222222222' };
    const next = await call(requestHandler(store), nextBody);
    expect(next.statusCode).toBe(200); expect(next.body.cached).toBe(false);
    expect(next.body.transcript.id).not.toBe(firstId);
    expect((await call(requestHandler(store), nextBody)).body).toMatchObject({ cached: true, transcript: { id: next.body.transcript.id } });
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${firstId}`).phase).toBe('failed');
  });
  it('keeps provider identities separate and starts a later generation only from terminal history', async () => {
    const store = await terminalStore();
    const first = await call(requestHandler(store), { ...request, provider: 'local', newAttemptOf: store.job.id });
    const id = first.body.transcript.id;
    const rejected = await call(requestHandler(store), { ...request, provider: 'amazon-transcribe', newAttemptOf: id });
    expect(rejected.statusCode).toBe(409);
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${id}`), { phase: 'failed', active: false });
    const next = await call(requestHandler(store), { ...request, provider: 'local', newAttemptOf: id });
    expect(next.statusCode).toBe(200);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${next.body.transcript.id}`)).toMatchObject({ attemptGeneration: 2, previousTranscriptId: id });
    expect(next.body.transcript.id).not.toBe(id);
  });
  it('refuses disabled local processing and a predecessor for a different original', async () => {
    const store = await terminalStore();
    expect((await call(requestHandler(store, false), { ...request, provider: 'local', newAttemptOf: store.job.id })).statusCode).toBe(503);
    store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${store.job.id}`).sourceObjectVersionId = 'other';
    expect((await call(requestHandler(store), { ...request, provider: 'local', newAttemptOf: store.job.id })).statusCode).toBe(409);
  });
  it('keeps an explicit free choice out of paid fallback', async () => {
    const store = await terminalStore();
    const result = await call(requestHandler(store), { ...request, provider: 'local', newAttemptOf: store.job.id });
    const ref = store.firestore.collection(jobs.TRANSCRIPT_JOBS).doc(result.body.transcript.id);
    await localJobs.routeLocalFallback({ firestore: store.firestore, ref, source, fallbackEnabled: true, now: Date.now() + 600000 });
    expect(store.rows.get(ref.path)).toMatchObject({ provider: 'local', phase: 'needs_reconciliation', active: false });
    expect([...store.rows.keys()].some(key => key.startsWith('mediaTranscriptionBudgets/'))).toBe(false);
  });
  it('names a retained uncertain Amazon slot and permits a direct new attempt from that history row', async () => {
    const store = await terminalStore();
    const handler = requestHandler(store);
    const oldPath = `${jobs.TRANSCRIPT_JOBS}/${store.job.id}`;
    const original = structuredClone(store.rows.get(oldPath));
    const local = await call(handler, { ...request, provider: 'local', newAttemptOf: store.job.id });
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${local.body.transcript.id}`), { phase: 'ready', active: false });
    const before = structuredClone(store.rows);
    const blocked = await call(handler, { ...request, provider: 'amazon-transcribe', newAttemptOf: local.body.transcript.id });
    expect(blocked).toMatchObject({ statusCode: 429, body: { error: 'An earlier Amazon request for this video is not confirmed yet. Choose that request in the saved transcript list to try again.' } });
    expect(store.rows).toEqual(before);
    const direct = await call(handler, { ...request, provider: 'amazon-transcribe', newAttemptOf: store.job.id });
    expect(direct.statusCode).toBe(200);
    expect(store.rows.get(oldPath)).toEqual(original);
    const actorLimitId = createHash('sha256').update(actor.uid).digest('hex');
    expect(store.rows.get(`${jobs.TRANSCRIPT_LIMITS}/${actorLimitId}`)).toMatchObject({ count: 2, activeId: direct.body.transcript.id });
    expect((await call(handler, { ...request, provider: 'amazon-transcribe', newAttemptOf: store.job.id })).body.cached).toBe(true);
    expect(store.rows.get(`${jobs.TRANSCRIPT_LIMITS}/${actorLimitId}`).count).toBe(2);
    expect(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${direct.body.transcript.id}`)).toMatchObject({ provider: 'amazon-transcribe', previousTranscriptId: store.job.id });
  });
  it('selects the newest ready attempt for reads and downloads while retaining explicit old results', async () => {
    const store = await terminalStore('failed');
    const handler = requestHandler(store);
    const first = await call(handler, { ...request, provider: 'local', newAttemptOf: store.job.id });
    const firstId = first.body.transcript.id;
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${firstId}`), { phase: 'ready', active: false,
      createdAt: '2026-10-28T12:00:00Z', outputs: { txt: 'first' } });
    const cached = await call(handler, { ...request, provider: 'local', newAttemptOf: firstId });
    expect(cached.body).toMatchObject({ cached: true, transcript: { id: firstId, state: 'ready' } });
    const next = await call(handler, { ...request, provider: 'amazon-transcribe', newAttemptOf: firstId });
    expect(next.statusCode).toBe(200);
    const nextId = next.body.transcript.id;
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${nextId}`), { phase: 'ready', active: false,
      createdAt: '2026-10-28T13:00:00Z', outputs: { txt: 'next' } });
    const processor = { read: async job => [{ startSeconds: 0, endSeconds: 1, speaker: 'spk_0', text: job.id }], download: async job => ({ url: `https://example.test/${job.id}` }) };
    const get = handlers.createTranscriptHandler('get', handlerDependencies(store, { processor }));
    expect((await call(get)).body.transcript.id).toBe(nextId);
    const download = handlers.createTranscriptHandler('download', handlerDependencies(store, { processor }));
    expect((await call(download, { ...request, format: 'txt' })).body.url).toContain(nextId);
    expect((await call(get, { sourceId: source.id, assetId: 'asset', transcriptId: firstId })).body.transcript.id).toBe(firstId);
    const pending = await call(handler, { ...request, provider: 'amazon-transcribe', newAttemptOf: nextId });
    expect(pending.body.transcript.state).toBe('queued');
    expect((await call(get)).body.transcript.id).toBe(nextId);
    Object.assign(store.rows.get(`${jobs.TRANSCRIPT_JOBS}/${pending.body.transcript.id}`), { phase: 'failed', active: false });
    expect((await call(get)).body.transcript.id).toBe(nextId);
  });
  it.each([{ provider: 'elevenlabs' }, { provider: 'unknown' }, { provider: 'local' }, { provider: 'amazon-transcribe' }, { newAttemptOf: 'a'.repeat(64) }, { provider: 'local', newAttemptOf: 'bad' }])('rejects malformed attempt settings %j before admission', async fields => {
    const store = memoryStore();
    expect((await call(requestHandler(store), { ...request, ...fields })).statusCode).toBe(400);
    expect(store.rows.size).toBe(1);
  });
});
