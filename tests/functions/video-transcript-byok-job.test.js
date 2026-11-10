import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const api=require('../../functions/lib/video-transcript-byok-job');
const identity=()=>({sourceId:'video-library',assetId:'asset',originalBucket:'original',originalKey:'objects/asset.mp4',originalVersion:'o1',originalSize:100,
 renditionBucket:'rendition',renditionKey:'outputs/preview.mp4',renditionVersion:'r1',renditionSize:90,durationSeconds:20,credentialScope:'personal',credentialId:createHash('sha256').update(JSON.stringify(['credential-v1','personal','agent','elevenlabs'])).digest('hex'),credentialRevision:1,languageCode:'en-US',maxSpeakers:10});
function store(){
 const rows=new Map();let tail=Promise.resolve();
 const firestore={collection:()=>({doc:id=>({id})}),runTransaction:fn=>{
  const work=tail.then(async()=>{const next=new Map([...rows].map(([k,v])=>[k,structuredClone(v)]));
   const tx={get:async ref=>({data:()=>structuredClone(next.get(ref.id))}),set:(ref,value)=>next.set(ref.id,structuredClone(value)),create:(ref,value)=>{if(next.has(ref.id))throw Error('exists');next.set(ref.id,structuredClone(value));},update:(ref,value)=>next.set(ref.id,{...next.get(ref.id),...structuredClone(value)})};
   const result=await fn(tx);rows.clear();for(const [k,v]of next)rows.set(k,v);return result;});tail=work.catch(()=>{});return work;
 }};return {firestore,rows};
}
const allowed=async()=>true;
async function setup(){const db=store();const job=api.createJob(identity(),{uid:'agent'},1000);
 const owner=createHash('sha256').update(JSON.stringify('agent')).digest('hex');
 job.budgetReservation={day:'2026-09-15',audioSeconds:20,state:'reserved',requesterRecord:`user-${owner}-2026-09-15`,globalRecord:'global-2026-09-15',slotRecord:`slot-${owner}`};
 for(const id of [job.budgetReservation.requesterRecord,job.budgetReservation.globalRecord])db.rows.set(id,{reservedSubmissions:1,reservedAudioSeconds:20,consumedSubmissions:0,consumedAudioSeconds:0});
 db.rows.set(job.budgetReservation.slotRecord,{jobId:job.id});
 await api.requestJob({...db,job,validateCurrent:allowed});return {...db,job};}
describe('ElevenLabs durable job boundaries',()=>{
 it('keeps audio variants separate from legacy MP4 variants',()=>{
  const legacy=api.createJob(identity(),{uid:'agent'});
  const audio=api.createJob({...identity(),inputRevision:'aac-m4a-copy-v1'},{uid:'agent'});
  expect(audio.id).not.toBe(legacy.id);
  expect(audio.adapterRevision).toBe('elevenlabs-transcript-m4a-v1');
  expect(()=>api.validJob(legacy,legacy.id)).not.toThrow();
  expect(()=>api.validJob(audio,audio.id)).not.toThrow();
 });
 it('waiting for shared audio preserves the reservation and preparation failure budget',async()=>{
  const s=await setup();
  const claim=await api.claimJob({...s,id:s.job.id,validateCurrent:allowed,now:2000});
  expect(await api.waitForAudio({...s,claim,now:2001})).toBe(true);
  expect(s.rows.get(s.job.id)).toMatchObject({active:true,phase:'pending',leaseUntil:0,budgetReservation:{state:'reserved'}});
  expect(s.rows.get(s.job.id).preparationFailures).toBeUndefined();
  expect(s.rows.get(s.job.id).submissionIntentAt).toBeNull();
 });
 it('binds every media version and credential revision to a distinct variant',()=>{
  const base=identity();for(const patch of [{originalVersion:'o2'},{renditionVersion:'r2'},{credentialRevision:2},{renditionSize:91},{languageCode:'es-US'},{maxSpeakers:2}])expect(api.variantId({...base,...patch})).not.toBe(api.variantId(base));
  expect(()=>api.createJob(base,{uid:'other'})).toThrow('byok_credential_owner_invalid');expect(()=>api.variantId({...base,key:'secret'})).toThrow();
 });
 it('fixes provider and model and retains explicit settings',()=>{
  expect(api.createJob(identity(),{uid:'agent'})).toMatchObject({provider:'elevenlabs',model:'scribe_v2',languageCode:'en-US',maxSpeakers:10});
  for(const patch of [{provider:'openai'},{model:'other'},{languageCode:'en'},{languageCode:null},{maxSpeakers:1},{maxSpeakers:11},{maxSpeakers:2.5},{renditionSize:2_000_000_001},{durationSeconds:7201},{durationSeconds:0.05}])expect(()=>api.variantId({...identity(),...patch})).toThrow('byok_identity_invalid');
  expect(()=>api.variantId({...identity(),renditionSize:2_000_000_000,durationSeconds:7200,languageCode:'es-US',maxSpeakers:2})).not.toThrow();
 });
 it('accepts the exact provider duration minimum',()=>{
  expect(api.createJob({...identity(),durationSeconds:0.1},{uid:'agent'}).durationSeconds).toBe(0.1);
 });
 it('rejects provider and settings tampering before a claim',async()=>{
  for(const patch of [{provider:'openai'},{model:'other'},{languageCode:'es-US'},{maxSpeakers:2}]){
   const db=await setup();Object.assign(db.rows.get(db.job.id),patch);
   await expect(api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed})).rejects.toThrow('byok_job_identity_invalid');
  }
 });
 it('rejects a credential derived for another provider',()=>{
  const input={...identity(),credentialId:createHash('sha256').update(JSON.stringify(['credential-v1','personal','agent','openai'])).digest('hex')};
  expect(()=>api.createJob(input,{uid:'agent'})).toThrow('byok_credential_owner_invalid');
 });
 it('accepts the fixed station identity without granting station-use authority',async()=>{
  const input={...identity(),credentialScope:'organization',credentialId:createHash('sha256').update(JSON.stringify(['credential-v1','organization',null,'elevenlabs'])).digest('hex')};
  const job=api.createJob(input,{uid:'staff'});const db=store();
  await expect(api.requestJob({...db,job,validateCurrent:async()=>false})).rejects.toThrow();expect(db.rows.size).toBe(0);
 });
 it('rejects copied jobs whose input projection differs from hashed identity',async()=>{
  const db=await setup();db.rows.get(db.job.id).input.objectVersionId='other';
  await expect(api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed})).rejects.toThrow('byok_job_identity_invalid');
 });
 it('accepts Firestore map key ordering while checking every input value',async()=>{
  const db=await setup();const row=db.rows.get(db.job.id);
  row.input=Object.fromEntries(Object.entries(row.input).sort(([a],[b])=>a.localeCompare(b)));
  expect(await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed})).not.toBeNull();
 });
 it('creates only one cached job for concurrent requests',async()=>{
  const db=store(),job=api.createJob(identity(),{uid:'agent'});const results=await Promise.all([1,2].map(()=>api.requestJob({...db,job,validateCurrent:allowed})));
  expect(results.map(x=>x.cached)).toEqual([false,true]);expect(db.rows.size).toBe(1);
 });
 it('requires explicit current-state checks before creating or claiming work',async()=>{
  const db=store(),job=api.createJob(identity(),{uid:'agent'});await expect(api.requestJob({...db,job})).rejects.toThrow('byok_current_state_denied');expect(db.rows.size).toBe(0);
 });
 it('concurrent claims and intents each have one winner',async()=>{
  const db=await setup();const claims=await Promise.all([1,2].map(()=>api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed})));
  expect(claims.filter(Boolean)).toHaveLength(1);const claim=claims.find(Boolean);
  const intents=await Promise.all([1,2].map(()=>api.recordIntent({...db,claim,now:3000,validateCurrent:allowed})));expect(intents.filter(Boolean)).toHaveLength(1);
 });
 it('recovers an expired pre-intent claim but never an expired submission intent',async()=>{
  const db=await setup();const first=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  const second=await api.claimJob({...db,id:db.job.id,now:302001,validateCurrent:allowed});expect(second.attemptId).not.toBe(first.attemptId);
  expect(await api.recordIntent({...db,claim:first,now:302002,validateCurrent:allowed})).toBeNull();
  await api.recordIntent({...db,claim:second,now:302002,validateCurrent:allowed});
  expect(await api.claimJob({...db,id:db.job.id,now:1022002,validateCurrent:allowed})).toBeNull();
  expect(db.rows.get(db.job.id)).toMatchObject({phase:'needs_reconciliation',active:false});
  expect((await api.requestJob({...db,job:db.job,validateCurrent:allowed})).cached).toBe(true);
 });
 it('renews a near-expired claim at intent and permits completion after its old expiry',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:1000,validateCurrent:allowed});
  const intent=await api.recordIntent({...db,claim,now:300000,validateCurrent:allowed});
  expect(intent.leaseUntil).toBe(1020000);
  expect(await api.recordIntent({...db,claim,now:300001,validateCurrent:allowed})).toBeNull();
  expect(await api.claimJob({...db,id:db.job.id,now:302000,validateCurrent:allowed})).toBeNull();
  const result={outcome:'ready',outputs:{'segments.json':'v1',txt:'v2',vtt:'v3'},totalSegments:1};
  expect(await api.finishJob({...db,claim,result,now:302000,validateCurrent:allowed})).toBe(true);
 });
 it('holds intent through the ten-minute adapter deadline and export margin',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:1000,validateCurrent:allowed});
  const intent=await api.recordIntent({...db,claim,now:2000,validateCurrent:allowed});
  expect(intent.leaseUntil).toBe(722000);
  expect(await api.claimJob({...db,id:db.job.id,now:603000,validateCurrent:allowed})).toBeNull();
  expect(await api.finishJob({...db,claim,result:{outcome:'ready',outputs:{'segments.json':'v1',txt:'v2',vtt:'v3'},totalSegments:1},now:603000,validateCurrent:allowed})).toBe(true);
 });
 it('atomically consumes once across racing intents on the original reservation day',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  await Promise.all([1,2].map(()=>api.recordIntent({...db,claim,now:3000,validateCurrent:allowed})));
  expect(db.rows.get(db.job.budgetReservation.globalRecord)).toMatchObject({reservedSubmissions:0,reservedAudioSeconds:0,consumedSubmissions:1,consumedAudioSeconds:20});
 });
 it('releases pre-intent cancellation only once and clears its owned slot',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  expect(await api.cancelBeforeIntent({...db,claim,now:3000})).toBe(true);
  expect(await api.cancelBeforeIntent({...db,claim,now:3001})).toBe(false);
  expect(db.rows.get(db.job.budgetReservation.globalRecord)).toMatchObject({reservedSubmissions:0,consumedSubmissions:0});
  expect(db.rows.get(db.job.budgetReservation.slotRecord)).toEqual({jobId:null});
 });
 it('never refunds an uncertain submission or clears another job slot',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  await api.recordIntent({...db,claim,now:3000,validateCurrent:allowed});
  expect(await api.cancelBeforeIntent({...db,claim,now:4000})).toBe(false);
  db.rows.set(db.job.budgetReservation.slotRecord,{jobId:'another'});
  expect(await api.finishJob({...db,claim,result:{outcome:'needs_reconciliation'},now:4000})).toBe(true);
  expect(db.rows.get(db.job.budgetReservation.globalRecord).consumedSubmissions).toBe(1);
  expect(db.rows.get(db.job.budgetReservation.slotRecord).jobId).toBe('another');
 });
 it('fails paid intent closed without a reservation',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  delete db.rows.get(db.job.id).budgetReservation;
  await expect(api.recordIntent({...db,claim,now:3000,validateCurrent:allowed})).rejects.toThrow('byok_budget_invalid');
  expect(db.rows.get(db.job.id).submissionIntentAt).toBeNull();
 });
 it('credential rotation or billing denial blocks intent without a submission marker',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});
  await expect(api.recordIntent({...db,claim,now:3000,validateCurrent:async()=>false})).rejects.toThrow();expect(db.rows.get(db.job.id).submissionIntentAt).toBeNull();
 });
 it('prevents publication after source deletion and fences late completion',async()=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});await api.recordIntent({...db,claim,now:3000,validateCurrent:allowed});
  const result={outcome:'ready',outputs:{'segments.json':'v1',txt:'v2',vtt:'v3'},totalSegments:1};
  await expect(api.finishJob({...db,claim,result,now:4000,validateCurrent:async()=>false})).rejects.toThrow();expect(db.rows.get(db.job.id)).not.toHaveProperty('outputs');
  expect(await api.finishJob({...db,claim,result,now:723001,validateCurrent:allowed})).toBe(false);
 });
 it.each(['ready','rejected','needs_reconciliation'])('terminal %s cannot be claimed or replayed',async(outcome)=>{
  const db=await setup();const claim=await api.claimJob({...db,id:db.job.id,now:2000,validateCurrent:allowed});await api.recordIntent({...db,claim,now:3000,validateCurrent:allowed});
  const result={outcome,outputs:{'segments.json':'v1',txt:'v2',vtt:'v3'},totalSegments:1};
  expect(await api.finishJob({...db,claim,result,now:4000,validateCurrent:allowed})).toBe(true);
  expect(await api.claimJob({...db,id:db.job.id,now:500000,validateCurrent:allowed})).toBeNull();
  expect(await api.recordIntent({...db,claim,now:5000,validateCurrent:allowed})).toBeNull();
 });
});


describe('BYOK recorded progress', () => {
 it('records queued, preparing, processing, finalizing and ready without resetting first start', async () => {
  const db = await setup(); const row = () => db.rows.get(db.job.id); const iso = n => new Date(n).toISOString();
  expect(row()).toMatchObject({ processingStage: 'queued', updatedAt: iso(1000) }); expect(row().startedAt).toBeUndefined();
  const claim = await api.claimJob({ ...db, id: db.job.id, now: 2000, validateCurrent: allowed });
  expect(row()).toMatchObject({ processingStage: 'preparing', startedAt: iso(2000), updatedAt: iso(2000) });
  await api.recordIntent({ ...db, claim, now: 3000, validateCurrent: allowed });
  expect(row()).toMatchObject({ processingStage: 'processing', startedAt: iso(2000), updatedAt: iso(3000) });
  await api.attachSpool({ ...db, claim, now: 4000, receipt: { key: 'spool', versionId: 'v1', sha256: 'a'.repeat(64), identityHash: 'b'.repeat(64) } });
  expect(row()).toMatchObject({ processingStage: 'finalizing', updatedAt: iso(4000) });
  await api.finishJob({ ...db, claim, now: 5000, validateCurrent: allowed, result: { outcome: 'ready', outputs: { 'segments.json': 'v1', txt: 'v2', vtt: 'v3' }, totalSegments: 1 } });
  expect(row()).toMatchObject({ processingStage: 'ready', startedAt: iso(2000), completedAt: iso(5000), updatedAt: iso(5000) });
 });
 it('defers preparation as queued and records terminal preparation failure without consuming quota', async () => {
  const db = await setup(); const row = () => db.rows.get(db.job.id);
  let claim = await api.claimJob({ ...db, id: db.job.id, now: 2000, validateCurrent: allowed });
  expect(await api.deferPreparation({ ...db, claim, now: 3000 })).toBe('deferred');
  expect(row()).toMatchObject({ processingStage: 'queued', updatedAt: new Date(3000).toISOString(), startedAt: new Date(2000).toISOString() });
  row().preparationFailures = 2;
  claim = await api.claimJob({ ...db, id: db.job.id, now: 100000, validateCurrent: allowed });
  expect(await api.deferPreparation({ ...db, claim, now: 101000 })).toBe('failed');
  expect(row()).toMatchObject({ processingStage: 'failed', errorCode: 'byok_preparation_failed', completedAt: new Date(101000).toISOString(), updatedAt: new Date(101000).toISOString() });
  expect(db.rows.get(db.job.budgetReservation.globalRecord).consumedSubmissions).toBe(0);
 });
 it('records finalization-only recovery and terminal uncertainty timestamps', async () => {
  const db = await setup(); const row = () => db.rows.get(db.job.id);
  const claim = await api.claimJob({ ...db, id: db.job.id, now: 2000, validateCurrent: allowed });
  await api.recordIntent({ ...db, claim, now: 3000, validateCurrent: allowed });
  const recovery = await api.claimRecovery({ ...db, id: db.job.id, now: 724000 });
  expect(recovery).toMatchObject({ processingStage: 'finalizing', attemptId: claim.attemptId, startedAt: new Date(2000).toISOString(), updatedAt: new Date(724000).toISOString() });
  await api.finishJob({ ...db, claim: recovery, now: 725000, result: { outcome: 'needs_reconciliation' } });
  expect(row()).toMatchObject({ processingStage: 'needs_attention', errorCode: 'elevenlabs_submission_uncertain', updatedAt: new Date(725000).toISOString(), completedAt: new Date(725000).toISOString() });
 });
 it('records admission denial timestamp before any paid intent', async () => {
  const db = await setup(); const claim = await api.claimJob({ ...db, id: db.job.id, now: 2000, validateCurrent: allowed });
  await api.cancelBeforeIntent({ ...db, claim, now: 3000 });
  expect(db.rows.get(db.job.id)).toMatchObject({ phase: 'failed', processingStage: 'failed', errorCode: 'byok_admission_invalid', updatedAt: new Date(3000).toISOString(), completedAt: new Date(3000).toISOString(), submissionIntentAt: null });
 });
});

it('captures only a safe authenticated requester display name', () => {
  expect(api.createJob(identity(), { uid: 'agent', displayName: 'Sam Editor' }).requesterDisplayName).toBe('Sam Editor');
  expect(api.createJob(identity(), { uid: 'agent', displayName: 'staff@example.test' }).requesterDisplayName).toBeNull();
});
