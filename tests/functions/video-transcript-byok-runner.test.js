import { describe, it, expect } from "vitest";
import runner from "../../functions/lib/video-transcript-byok-runner.js";
import jobs from "../../functions/lib/video-transcript-byok-job.js";
import api from "../../functions/video-transcript-byok.js";
import credentials from "../../functions/lib/video-transcription-credentials.js";
import renditions from "../../functions/lib/source-media-rendition.js";
const source = {
  id: "video-library",
  bucket: "originals",
  prefix: "",
  writable: true,
  access: "active_staff",
};
const request = {
  sourceId: "video-library",
  assetId: "asset",
  provider: "elevenlabs",
  credentialScope: "organization",
  credentialRevision: 1,
  languageCode: "en-US",
  maxSpeakers: 10,
};
const actor = {
  uid: "staff",
  authTime: 100,
  displayName: "Staff",
  principal: { grants: [{ role: "staff" }] },
};
const settings = {
  enabled: true,
  bucket: "renditions",
  accountId: "123456789012",
};
const now = Date.parse("2026-09-15T12:00:00Z");
function asset() {
  const result = {
    id: "asset",
    sourceId: "video-library",
    objectKey: "objects/asset.mxf",
    objectVersionId: "version1",
    sizeBytes: 100,
    lifecycle: "active",
    name: "Video",
    originalName: "video.mxf",
    nameSort: "video",
    updatedAtSort: "2026-09-15T12:00:00Z",
    mimeType: "application/mxf",
    kind: "video",
    version: 1,
    preview: "download_only",
    rightsStatus: "complete",
    tags: [],
  };
  const prefix = `outputs/${renditions.sourceMediaRenditionId(result)}/attempt/`;
  result.rendition = {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: result.objectKey,
    sourceObjectVersionId: result.objectVersionId,
    sourceSizeBytes: result.sizeBytes,
    attemptId: "attempt",
    updatedAt: "2026-09-15T12:00:00Z",
    web: {
      objectKey: prefix + "preview.mp4",
      objectVersionId: "web1",
      sizeBytes: 50,
      mimeType: "video/mp4",
      durationSeconds: 60,
    },
    poster: {
      objectKey: prefix + "preview-poster.0000000.jpg",
      objectVersionId: "poster1",
      sizeBytes: 5,
      mimeType: "image/jpeg",
    },
  };
  return result;
}
function memoryStore() {
  const rows = new Map([["mediaSourceAssets/asset", asset()]]);
  let tail = Promise.resolve();
  let next = 1;
  const ref = (collection, id = `auto${next++}`) => {
    const result = { path: `${collection}/${id}`, id };
    result.get = async () => snap(result);
    return result;
  };
  const snap = (reference) => ({
    id: reference.id,
    ref: reference,
    exists: rows.has(reference.path),
    data: () => structuredClone(rows.get(reference.path)),
  });
  const query = (name, filters = [], after = null, count = Infinity) => ({
    doc: (id) => ref(name, id),
    where: (field, operator, value) =>
      query(name, [...filters, [field, operator, value]], after, count),
    orderBy: (field) => {
      expect(field).toBe("__name__");
      return query(name, filters, after, count);
    },
    startAfter: (id) => query(name, filters, id, count),
    limit: (value) => query(name, filters, after, value),
    get: async () => ({
      docs: [...rows]
        .filter(
          ([key, value]) =>
            key.startsWith(name + "/") &&
            filters.every(
              ([field, operator, expected]) =>
                operator === "==" && value[field] === expected,
            ) &&
            (!after || key.split("/").at(-1) > after),
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, count)
        .map(([key]) => snap({ path: key, id: key.split("/").at(-1) })),
    }),
  });
  const firestore = {
    doc: (path) => {
      const [name, id] = path.split("/");
      return ref(name, id);
    },
    collection: (name) => query(name),
    runTransaction: (fn) => {
      const run = tail.then(async () => {
        const writes = [];
        const result = await fn({
          get: async (reference) => snap(reference),
          create: (reference, value) =>
            writes.push(["create", reference, structuredClone(value)]),
          update: (reference, value) =>
            writes.push(["update", reference, structuredClone(value)]),
          set: (reference, value) =>
            writes.push(["set", reference, structuredClone(value)]),
        });
        for (const [mode, reference, value] of writes) {
          if (mode === "create" && rows.has(reference.path))
            throw Error("already exists");
          rows.set(
            reference.path,
            mode === "create"
              ? value
              : { ...rows.get(reference.path), ...value },
          );
        }
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  return { rows, firestore };
}
const audit = (value) => value;
async function queued(store = memoryStore()) {
  const result = await jobs.requestTranscript({
    firestore: store.firestore,
    source,
    request,
    actor,
    audit,
  });
  return { ...store, ...result };
}
function providerJob(job, status = "IN_PROGRESS") {
  return {
    TranscriptionJobName: processorModule.jobName(job),
    LanguageCode: job.languageCode,
    Media: { MediaFileUri: `s3://renditions/${processorModule.inputKey(job)}` },
    Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: job.maxSpeakers },
    TranscriptionJobStatus: status,
  };
}
const missing = () =>
  Object.assign(Error("The requested job couldn't be found."), {
    name: "BadRequestException",
  });
function processing(
  job,
  { provider = null, startError = null, s3Send, billingDisabled = false } = {},
) {
  const calls = [];
  const processor = processorModule.createVideoTranscriptProcessor(config, {
    firestore: {
      doc: () => ({
        get: async () => ({
          exists: true,
          data: () => ({
            disabled:
              typeof billingDisabled === "function"
                ? billingDisabled()
                : billingDisabled,
          }),
        }),
      }),
    },
    credentials: async () => ({}),
    transcribe: {
      send: async (command) => {
        calls.push(command);
        if (command.constructor.name === "GetTranscriptionJobCommand") {
          if (!provider) throw missing();
          return { TranscriptionJob: provider };
        }
        if (startError) throw startError;
        return {};
      },
    },
    s3: {
      send:
        s3Send ??
        (async (command) => {
          calls.push(command);
          return command.constructor.name === "HeadObjectCommand"
            ? { VersionId: "web1", ContentLength: 50 }
            : { VersionId: "output1" };
        }),
    },
  });
  const save = async (changes) => {
    Object.assign(job, changes);
    return true;
  };
  return { processor, calls, save };
}

function setup() {
  const store = memoryStore();
  store.rows.set("users/staff", { active: true });
  const key = credentials.credentialIdentity(actor, {
    scope: "organization",
    provider: "elevenlabs",
  });
  store.rows.set(`${credentials.CREDENTIAL_COLLECTION}/${key.id}`, {
    ...key,
    revision: 1,
    enabled: true,
    ciphertext: "never-return",
  });
  return { ...store, source, request, actor, settings, now, audit: (x) => x };
}

async function prepared(overrides={}){
 const args=setup();let time=now;const {job}=await api.admit(args);const counts={posts:0,exports:0};const secret=Buffer.from('test-key-value-1234');let spool=null;
 const receipt={key:`transcripts/results/${job.id}.attempt.normalized.json`,versionId:'v1',sha256:'a'.repeat(64),identityHash:'b'.repeat(64)};
 const storage={prepareInput:async()=>({input:{},cleanup:async()=>{}}),persistSpool:async()=>{spool={receipt,segments:[],inputSha256:'c'.repeat(64)};return receipt;},recoverSpool:async()=>spool,finalizeExports:async()=>{counts.exports++;return {outputs:{'segments.json':'v1',txt:'v2',vtt:'v3'},totalSegments:0};},...overrides.storage};
 const deps={firestore:args.firestore,source,renditionBucket:'renditions',clock:()=>time,storage,getAuthUser:async()=>({uid:'staff',disabled:false,tokensValidAfterTime:new Date(0).toISOString()}),loadCredential:async()=>({key:secret,revision:1,keyVersion:'1'}),transcribe:async()=>{counts.posts++;return {};},...overrides};deps.storage=storage;
 for(const [key,value]of args.rows)if(key.startsWith('mediaTranscriptionCredentials/'))value.keyVersion='1';
 return {...args,job,counts,secret,storage,deps,run:runner.createByokRunner(deps),advance:ms=>{time+=ms;},spool:()=>spool};
}
describe('injected BYOK runner',()=>{
 it('holds operator canaries from the scheduler and steps only the named job',async()=>{
  const s=await prepared();
  s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`).operatorCanaryId='a'.repeat(64);
  expect(await s.run()).toEqual({outcome:'idle'});
  expect(s.counts.posts).toBe(0);
  const only=runner.createByokRunner({...s.deps,onlyJobId:s.job.id});
  expect(await only()).toEqual({outcome:'ready'});
  expect(await only()).toEqual({outcome:'idle'});
  expect(s.counts.posts).toBe(1);
 });
 it('consumes once, writes cached result and clears slot',async()=>{const s=await prepared();expect(await s.run()).toEqual({outcome:'ready'});expect(s.counts.posts).toBe(1);expect(s.counts.exports).toBe(1);expect(s.secret.every(x=>x===0)).toBe(true);expect(await s.run()).toEqual({outcome:'idle'});const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:0,consumedSubmissions:1});});
 it('serializes concurrent global runners',async()=>{const s=await prepared();const results=await Promise.all([s.run(),s.run()]);expect(results.map(x=>x.outcome).sort()).toEqual(['busy','ready']);expect(s.counts.posts).toBe(1);});
 it.each(['revoked','source','credential','billing'])('rejects %s before provider dispatch and releases budget',async(kind)=>{const s=await prepared();if(kind==='revoked')s.deps.getAuthUser=async()=>({uid:'staff',disabled:true});if(kind==='source')s.rows.get('mediaSourceAssets/asset').lifecycle='deleted';if(kind==='credential')for(const [key,value]of s.rows)if(key.startsWith('mediaTranscriptionCredentials/'))value.revision=2;if(kind==='billing')s.rows.set('system/billing',{disabled:true});expect(await runner.createByokRunner(s.deps)()).toEqual({outcome:'rejected_before_submission'});expect(s.counts.posts).toBe(0);const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:0,consumedSubmissions:0});});
 it('does not discard paid output after credential rotation',async()=>{const s=await prepared();s.deps.transcribe=async()=>{s.counts.posts++;for(const [key,value]of s.rows)if(key.startsWith('mediaTranscriptionCredentials/'))value.revision=2;return {};};expect(await runner.createByokRunner(s.deps)()).toEqual({outcome:'ready'});});
 it('recovers exact spool after lost receipt without a second provider POST',async()=>{const s=await prepared();const persist=s.storage.persistSpool;s.storage.persistSpool=async(...args)=>{await persist(...args);throw Error('connection lost after put');};expect(await s.run()).toEqual({outcome:'recovery_pending'});s.advance(721000);expect(await s.run()).toEqual({outcome:'ready'});expect(s.counts.posts).toBe(1);});
 it('marks missing spool uncertain after expired intent without replay',async()=>{const s=await prepared({transcribe:async()=>{throw Error('timeout');}});expect(await s.run()).toEqual({outcome:'recovery_pending'});s.advance(721000);expect(await s.run()).toEqual({outcome:'needs_reconciliation'});expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({errorCode:'elevenlabs_submission_uncertain'});expect(await s.run()).toEqual({outcome:'idle'});});
 it.each(['byok_storage_receipt_invalid', 'byok_storage_result_invalid', 'byok_storage_identity_invalid', 'byok_storage_result_too_large'])('settles %s once through the original attempt without another paid submission', async(code)=>{
  const s=await prepared({storage:{recoverSpool:async()=>{throw Object.assign(Error('private storage detail'),{code});}}});
  expect(await s.run()).toEqual({outcome:'recovery_pending'});
  const row=()=>s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`); const attempt=row().attemptId;
  s.advance(721000);
  expect(await s.run()).toEqual({outcome:'needs_reconciliation'});
  expect(row()).toMatchObject({active:false,phase:'needs_reconciliation',attemptId:attempt,errorCode:'byok_spool_invalid',leaseOwner:null,leaseUntil:0});
  expect(await s.run()).toEqual({outcome:'idle'});expect(s.counts.posts).toBe(1);expect(s.counts.exports).toBe(0);
  const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:0,consumedSubmissions:1});
 });
 it('settles a definitively missing pinned result without dropping its receipt or original attempt',async()=>{
  const s=await prepared({storage:{finalizeExports:async()=>{throw Error('lost export response');}}});
  expect(await s.run()).toEqual({outcome:'recovery_pending'});
  const row=()=>s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`);const receipt=row().spoolReceipt;const attempt=row().attemptId;
  s.storage.recoverSpool=async()=>{throw Object.assign(Error('private storage detail'),{code:'byok_storage_spool_missing'});};s.advance(721000);
  expect(await s.run()).toEqual({outcome:'needs_reconciliation'});
  expect(row()).toMatchObject({active:false,phase:'needs_reconciliation',attemptId:attempt,spoolReceipt:receipt,errorCode:'byok_spool_missing'});
  expect(await s.run()).toEqual({outcome:'idle'});expect(s.counts.posts).toBe(1);
 });
 it('keeps transient spool reads recoverable and accepts the later exact result without resubmitting',async()=>{
  const s=await prepared();const recover=s.storage.recoverSpool;let unavailable=true;
  s.storage.recoverSpool=async(...args)=>{if(unavailable)throw Object.assign(Error('private storage detail'),{code:'byok_storage_unavailable'});return recover(...args);};
  expect(await s.run()).toEqual({outcome:'recovery_pending'});s.advance(721000);
  await expect(s.run()).rejects.toThrow('private storage detail');
  expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:true,phase:'running',recoveryAttempts:1});
  unavailable=false;s.advance(721000);expect(await s.run()).toEqual({outcome:'ready'});expect(s.counts.posts).toBe(1);
 });
 it('reports lease loss instead of settling an absent spool under another owner',async()=>{
  const s=await prepared({transcribe:async()=>{throw Error('uncertain submission');}});
  expect(await s.run()).toEqual({outcome:'recovery_pending'});s.advance(721000);
  s.storage.recoverSpool=async()=>{s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`).leaseOwner='another-owner';return null;};
  expect(await s.run()).toEqual({outcome:'lease_lost'});
  expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:true,phase:'running',leaseOwner:'another-owner'});
 });
 it('does not repeat settlement or submission after a lost missing-spool settlement response',async()=>{
  const s=await prepared({storage:{persistSpool:async()=>{throw Error('uncertain output');}}});
  expect(await s.run()).toEqual({outcome:'recovery_pending'});s.advance(721000);
  const transact=s.firestore.runTransaction;let lost=false;
  s.firestore.runTransaction=async fn=>{const result=await transact(fn);if(!lost&&s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`).phase==='needs_reconciliation'){lost=true;throw Error('lost settlement response');}return result;};
  await expect(s.run()).rejects.toThrow('lost settlement response');
  expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:false,phase:'needs_reconciliation',errorCode:'elevenlabs_submission_uncertain'});
  expect(await s.run()).toEqual({outcome:'idle'});expect(s.counts.posts).toBe(1);
  const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:0,consumedSubmissions:1});
 });
 it('bounds failed output recovery attempts',async()=>{const s=await prepared({storage:{finalizeExports:async()=>{throw Error('unavailable');}}});expect(await s.run()).toEqual({outcome:'recovery_pending'});for(let i=0;i<3;i++){s.advance(721000);await expect(s.run()).rejects.toThrow('unavailable');}s.advance(721000);await s.run();expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:false,phase:'needs_reconciliation'});expect(s.counts.posts).toBe(1);});
 it('retains paid spool and consumed budget if source access changes before publication',async()=>{
  const s=await prepared();s.deps.transcribe=async()=>{s.counts.posts++;s.rows.get('mediaSourceAssets/asset').lifecycle='deleted';return {};};
  expect(await runner.createByokRunner(s.deps)()).toEqual({outcome:'needs_reconciliation'});
  expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:false,phase:'needs_reconciliation',spoolReceipt:{versionId:'v1'}});
  expect(s.counts.exports).toBe(0);const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path).consumedSubmissions).toBe(1);
 });

 it('bounds transient preparation retries without consuming or duplicating reservations',async()=>{
  const s=await prepared({storage:{prepareInput:async()=>{throw Error('temporary storage failure');}}});
  expect(await s.run()).toEqual({outcome:'preparation_retry_pending'});expect(await s.run()).toEqual({outcome:'idle'});
  s.advance(61000);expect(await s.run()).toEqual({outcome:'preparation_retry_pending'});
  s.advance(121000);expect(await s.run()).toEqual({outcome:'rejected_before_submission'});
  expect(s.counts.posts).toBe(0);const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:0,consumedSubmissions:0});
 });
 it('sweeps past twenty waiting jobs without starving an eligible request',async()=>{
  const s=await prepared();for(let i=1;i<=20;i++){const id=i.toString(16).padStart(64,'0');s.rows.set(`mediaSourceTranscriptJobs/${id}`,{...s.job,id,nextAttemptAt:now+86400000});}
  expect(await s.run()).toEqual({outcome:'idle'});expect(await s.run()).toEqual({outcome:'ready'});expect(s.counts.posts).toBe(1);
 });

 it.each(['auth','firestore'])('retries an initial transient %s failure on the same cached reservation',async(kind)=>{
  const s=await prepared();let unavailable=true;
  if(kind==='auth')s.deps.getAuthUser=async()=>{if(unavailable)throw Object.assign(Error('temporary auth failure'),{code:'auth/internal-error'});return {uid:'staff',disabled:false};};
  else {const transact=s.firestore.runTransaction;s.firestore.runTransaction=fn=>transact(tx=>fn({...tx,get:async ref=>{if(unavailable&&ref.path==='users/staff')throw Object.assign(Error('temporary database failure'),{code:14});return tx.get(ref);}}));}
  const run=runner.createByokRunner(s.deps);
  expect(await run()).toEqual({outcome:'preparation_retry_pending'});
  unavailable=false;const cached=await api.admit(s);expect(cached.cached).toBe(true);expect(cached.job).toMatchObject({active:true,phase:'pending',preparationFailures:1});
  expect(s.counts.posts).toBe(0);expect(await run()).toEqual({outcome:'idle'});
  const refs=api.budgetRefs(s.firestore,'staff','2026-09-15');expect(s.rows.get(refs.global.path)).toMatchObject({reservedSubmissions:1,consumedSubmissions:0});
  unavailable=false;s.advance(61000);expect(await run()).toEqual({outcome:'ready'});expect(s.counts.posts).toBe(1);
 });
 it('treats a confirmed missing Auth user as a terminal denial',async()=>{
  const s=await prepared({getAuthUser:async()=>{throw Object.assign(Error('missing'),{code:'auth/user-not-found'});}});
  expect(await s.run()).toEqual({outcome:'rejected_before_submission'});
  expect(s.rows.get(`mediaSourceTranscriptJobs/${s.job.id}`)).toMatchObject({active:false,phase:'failed'});expect(s.counts.posts).toBe(0);
 });

});
