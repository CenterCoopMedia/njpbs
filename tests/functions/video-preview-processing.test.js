import { test } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { createVideoPreviewProcessor, executionArn } = require('../../functions/lib/video-preview-processor');
const { pendingPreview, sameOriginal } = require('../../functions/lib/video-preview-job');
const config = { source: { bucket: 'originals', expectedBucketOwner: '123456789012' }, workflowArn: 'arn:aws:states:us-east-2:123456789012:stateMachine:preview' };
const asset = { id:'asset', sourceId:'video-library', objectKey:'objects/asset.mxf', objectVersionId:'version-a', sizeBytes:123, lifecycle:'active' };

test('metadata edits preserve identity; replaced originals do not', () => {
 const job=pendingPreview(asset);
 assert.equal(pendingPreview({...asset,name:'Changed',version:9}).id,job.id);
 assert.equal(sameOriginal({...asset,name:'Changed'},job),true);
 assert.equal(sameOriginal({...asset,objectVersionId:'version-b'},job),false);
});
test('lost start response recovers same named execution without a new attempt',async()=>{
 const job=pendingPreview(asset);const calls=[];const saves=[];
 const process=createVideoPreviewProcessor(config,{s3:{send:async()=>({VersionId:asset.objectVersionId,ContentLength:asset.sizeBytes})},client:{send:async cmd=>{calls.push(cmd.input);throw Object.assign(Error(),{name:'ExecutionAlreadyExists'});}}});
 await process(job,async (...args)=>{saves.push(args);return true;});
 assert.equal(calls[0].name.length<=80,true);
 assert.equal(saves[0][0].executionArn,executionArn(config.workflowArn,job));
 assert.equal(saves[0][1].state,'processing');
});
test('running workflow does not publish a false ready record',async()=>{
 const job=pendingPreview(asset);job.phase='running';job.executionArn=executionArn(config.workflowArn,job);
 const process=createVideoPreviewProcessor(config,{s3:{send:async()=>({VersionId:asset.objectVersionId,ContentLength:asset.sizeBytes})},client:{send:async()=>({status:'RUNNING'})}});
 await process(job,()=>assert.fail('must not publish'));
});
test('finished workflow must match both original identity and attempt',async()=>{
 const job=pendingPreview(asset);job.phase='running';job.executionArn=executionArn(config.workflowArn,job);
 const process=createVideoPreviewProcessor(config,{s3:{send:async()=>({VersionId:asset.objectVersionId,ContentLength:asset.sizeBytes})},client:{send:async()=>({status:'SUCCEEDED',output:JSON.stringify({id:job.id,attemptId:'wrong'})})}});
 await assert.rejects(process(job,()=>assert.fail('must not publish')),/workflow_output_invalid/);
});
test('successful version-bound outputs become ready; wrong output prefix is rejected',async()=>{
 const job=pendingPreview(asset);job.phase='running';job.executionArn=executionArn(config.workflowArn,job);
 const prefix=`outputs/${job.id}/${job.attemptId}/`;
 const output={id:job.id,attemptId:job.attemptId,web:{objectKey:prefix+'preview.mp4',objectVersionId:'web-v',sizeBytes:50,mimeType:'video/mp4'},poster:{objectKey:prefix+'preview-poster.0000000.jpg',objectVersionId:'poster-v',sizeBytes:5,mimeType:'image/jpeg'}};
 const process=createVideoPreviewProcessor(config,{s3:{send:async()=>({VersionId:asset.objectVersionId,ContentLength:asset.sizeBytes})},client:{send:async()=>({status:'SUCCEEDED',output:JSON.stringify(output)})}});
 let saved;await process(job,(changes,rendition)=>{saved=rendition;return true;});assert.equal(saved.state,'ready');
 output.web.objectKey='outputs/other/preview.mp4';
 await assert.rejects(process(job,()=>assert.fail('must not publish')),/rendition_output_invalid/);
});
test('failed workflow keeps original untouched and reports failure',async()=>{
 const job=pendingPreview(asset);job.phase='running';job.executionArn=executionArn(config.workflowArn,job);
 const process=createVideoPreviewProcessor(config,{s3:{send:async()=>({VersionId:asset.objectVersionId,ContentLength:asset.sizeBytes})},client:{send:async()=>({status:'FAILED'})}});
 await process(job,(changes,rendition)=>{assert.equal(changes.active,false);assert.equal(rendition.state,'failed');assert.equal(rendition.sourceObjectVersionId,'version-a');});
});

const { processPreviewTick } = require('../../functions/video-previews');
function memoryStore(initialJob) {
 const rows=new Map([[`mediaSourcePreviewJobs/${initialJob.id}`,structuredClone(initialJob)],['mediaSourceAssets/asset',structuredClone(asset)]]);
 const reference=(path)=>({path,id:path.split('/').at(-1)});
 const snapshot=ref=>({id:ref.id,ref,exists:rows.has(ref.path),data:()=>structuredClone(rows.get(ref.path))});
 const db={collection:name=>({doc:id=>reference(`${name}/${id}`),where:()=>({limit:()=>({get:async()=>({docs:[...rows].filter(([key,value])=>key.startsWith(name+'/')&&value.active).map(([key])=>snapshot(reference(key)))})})})}),runTransaction:async fn=>fn({get:async ref=>snapshot(ref),set:(ref,value)=>rows.set(ref.path,structuredClone(value)),update:(ref,changes)=>rows.set(ref.path,{...rows.get(ref.path),...structuredClone(changes)})})};
 return {db,rows};
}
const tickConfig={source:{prefix:''}};
test('a successful step resets accumulated adapter failures',async()=>{
 const job={...pendingPreview(asset),failures:4};const {db,rows}=memoryStore(job);
 await processPreviewTick({firestore:db,config:tickConfig,processor:async(current,save)=>save({phase:'running'})});
 assert.equal(rows.get(`mediaSourcePreviewJobs/${job.id}`).failures,0);
 await processPreviewTick({firestore:db,config:tickConfig,processor:async()=>{throw Error('transient');}});
 assert.equal(rows.get(`mediaSourcePreviewJobs/${job.id}`).failures,1);
 assert.equal(rows.get(`mediaSourcePreviewJobs/${job.id}`).active,true);
});
test('permanent start errors stop automatic retries without creating a new attempt',async()=>{
 const job={...pendingPreview(asset),failures:4};const {db,rows}=memoryStore(job);
 await processPreviewTick({firestore:db,config:tickConfig,processor:async()=>{throw Error('permission');}});
 const saved=rows.get(`mediaSourcePreviewJobs/${job.id}`);
 assert.equal(saved.phase,'needs_reconciliation');assert.equal(saved.active,false);assert.equal(saved.attemptId,job.attemptId);
});
test('a replacement during processing cannot receive the stale output',async()=>{
 const job=pendingPreview(asset);const {db,rows}=memoryStore(job);
 await processPreviewTick({firestore:db,config:tickConfig,processor:async(current,save)=>{
  rows.set('mediaSourceAssets/asset',{...asset,objectVersionId:'replacement'});
  assert.equal(await save({phase:'ready',active:false},{state:'ready'}),false);
 }});
 assert.equal(rows.get('mediaSourceAssets/asset').rendition,undefined);
 assert.equal(rows.get(`mediaSourcePreviewJobs/${job.id}`).phase,'stale');
});
