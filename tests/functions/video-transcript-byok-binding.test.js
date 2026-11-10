import { describe, it, expect, vi } from 'vitest';
import binding from '../../functions/video-transcript-byok-runner.js';
import config from '../../functions/lib/video-transcription-config.js';
import credentials from '../../functions/lib/video-transcription-credentials.js';

const valid={enabled:true,region:'us-east-2',renditionExpectedBucketOwner:'123456789012',roleArn:'arn:aws:iam::123456789012:role/njpbs-boardwalk-transcription-byok-data',keyVersion:'1',audience:'njpbs-boardwalk-s3',renditionBucket:'njpbs-private-renditions'};
function fixture(patch={}){
 const encryption=Buffer.alloc(32,7), plaintext='synthetic-provider-key-1234';
 const expected=credentials.credentialIdentity({uid:'staff'},{scope:'personal',provider:'elevenlabs'});
 const record={...expected,schemaVersion:1,revision:1,keyVersion:'1',enabled:true};
 Object.assign(record,credentials.encryptCredential(plaintext,record,encryption),patch);
 const job={requestedBy:'staff',identity:{credentialScope:'personal',credentialRevision:1}};
 let reads=0;const deps={configFn:()=>valid,s3:{send:()=>{throw Error('No AWS calls allowed');}},firestore:{collection:()=>({doc:()=>({get:async()=>{reads++;return {data:()=>record};}})})},registryFn:()=>new Map([['video-library',{id:'video-library'}]]),keyFn:()=>encryption.toString('base64')};
 return {deps,record,job,plaintext,encryption,reads:()=>reads};
}
describe('BYOK deployment binding',()=>{
 it('disabled flag performs no service, credential, runner or storage IO',async()=>{
  const deps={configFn:()=>({enabled:false}),get firestore(){throw Error('firestore read');},get s3(){throw Error('AWS read');},keyFn:()=>{throw Error('key read');},createRunnerFn:()=>{throw Error('runner constructed');}};
  expect(await binding.createRunnerTick(deps)()).toEqual({outcome:'disabled'});
 });
 it.each([{region:'us-east-1'},{renditionExpectedBucketOwner:'111111111111'},{roleArn:'arn:aws:iam::123456789012:role/admin'},{roleArn:'arn:aws:iam::111111111111:role/njpbs-boardwalk-transcription-byok-data'},{keyVersion:''},{keyVersion:'0'},{keyVersion:'latest'},{audience:'other'},{renditionBucket:'https://bad.example'}])('fails closed before IO for config %j',async(patch)=>{
  const cfg={...valid,...patch};expect(config.isConfigured(cfg)).toBe(false);
  await expect(binding.createRunnerTick({configFn:()=>cfg,get firestore(){throw Error('unexpected IO');}})()).rejects.toThrow('byok_runner_configuration_invalid');
 });
 it('accepts the scoped Ohio configuration',()=>{
  expect(binding.isConfigured(valid)).toBe(true);expect(config.isConfigured(valid)).toBe(true);
 });
 it('decrypts only the derived owner and pinned revision and clears encryption buffer',async()=>{
  const f=fixture();let received;const cleared=[];const fill=Buffer.prototype.fill;
  const spy=vi.spyOn(Buffer.prototype,'fill').mockImplementation(function(value,...rest){if(value===0&&this.length===32)cleared.push(Buffer.from(this));return fill.call(this,value,...rest);});
  try { const tick=binding.createRunnerTick({...f.deps,createRunnerFn:args=>async()=>{received=await args.loadCredential(f.job);return {outcome:'ready'};}});expect(await tick()).toEqual({outcome:'ready'});expect(received.key.toString()).toBe(f.plaintext);expect(received).toMatchObject({revision:1,keyVersion:'1'});expect(cleared.some(x=>x.equals(f.encryption))).toBe(true); } finally {spy.mockRestore();received?.key.fill(0);}
  expect(f.reads()).toBe(1);
 });
 it.each([{ownerUid:'other'},{provider:'openai'},{revision:2},{keyVersion:'2'},{enabled:false},{authTag:Buffer.alloc(16).toString('base64')}])('rejects credential %j and clears encryption key on failure',async(patch)=>{
  const f=fixture(patch);let cleared=false;const fill=Buffer.prototype.fill;
  const spy=vi.spyOn(Buffer.prototype,'fill').mockImplementation(function(value,...rest){if(value===0&&this.length===32&&this.equals(f.encryption))cleared=true;return fill.call(this,value,...rest);});
  try {await expect(binding.createRunnerTick({...f.deps,createRunnerFn:args=>async()=>args.loadCredential(f.job)})()).rejects.toThrow();expect(cleared).toBe(true);}finally{spy.mockRestore();}
 });
 it('does not retrieve encryption key for a missing credential',async()=>{
  const f=fixture();f.deps.firestore={collection:()=>({doc:()=>({get:async()=>({data:()=>undefined})})})};const keyFn=vi.fn(()=>{throw Error('key read');});
  await expect(binding.createRunnerTick({...f.deps,keyFn,createRunnerFn:args=>async()=>args.loadCredential(f.job)})()).rejects.toThrow('byok_credential_unavailable');expect(keyFn).not.toHaveBeenCalled();
 });
});
