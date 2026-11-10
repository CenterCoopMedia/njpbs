import { beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { BOOTSTRAP_PREFLIGHTS, runBootstrapPreflights, readOnlyBootstrapFirestore } from "../../scripts/lib/public-release-bootstrap-preflight.mjs";
const db = isolatedFirestore("public-release-bootstrap-preflight");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
beforeEach(async () => {
  // SETUP WRITES, outside every preflight. No provider/deployed proof is claimed.
  for (const { layer, name } of BOOTSTRAP_PREFLIGHTS) await db.doc(`bootstrapDemo/layer-${layer}`).set({ layer, name, sourceSha: "a".repeat(40) });
});
const adapters = () => Object.fromEntries(BOOTSTRAP_PREFLIGHTS.map(({ layer, name }) => [layer, async ({ firestore }) => {
  const row = await firestore.runTransaction(tx => tx.get(firestore.doc(`bootstrapDemo/layer-${layer}`)));
  expect(row.data()).toEqual({ layer, name, sourceSha: "a".repeat(40) });
  return { receiptDigest: hash(row.data()) };
}]));
it("executes all seven supplied read-only preflights against the emulator", async () => {
  const before = (await db.collection("bootstrapDemo").get()).docs.map(row => row.data());
  const emitted = [];
  const report = await runBootstrapPreflights({ firestore: db, adapters: adapters(), input: {}, emit: row => emitted.push(row) });
  expect(report.passed).toBe(true); expect(report.productionAuthority).toBe(false);
  expect(emitted.map(row => row.layer)).toEqual([1,2,3,4,5,6,7]);
  expect((await db.collection("bootstrapDemo").get()).docs.map(row => row.data())).toEqual(before);
});
it("refuses direct and transactional writes and still observes the remaining layers", async () => {
  const configured = adapters();
  configured[2] = ({ firestore }) => firestore.doc("bootstrapDemo/layer-2").set({ changed: true });
  configured[3] = async ({ firestore }) => (await firestore.doc("bootstrapDemo/layer-3").get()).ref.update({ changed: true });
  configured[5] = ({ firestore }) => firestore.runTransaction(tx => tx.update(firestore.doc("bootstrapDemo/layer-5"), { changed: true }));
  const report = await runBootstrapPreflights({ firestore: db, adapters: configured, input: {} });
  expect(report.results.filter(row => row.status === "FAIL").map(row => [row.layer,row.code]))
    .toEqual([[2,"bootstrap-write-forbidden"],[3,"bootstrap-write-forbidden"],[5,"bootstrap-write-forbidden"]]);
  expect(report.results.at(-1).status).toBe("PASS");
  expect((await db.doc("bootstrapDemo/layer-2").get()).data()).not.toHaveProperty("changed");
});
it("reports every missing adapter as failure without inventing a layer proof", async () => {
  const report = await runBootstrapPreflights({ firestore: db, adapters: {}, input: {} });
  expect(report.passed).toBe(false);
  expect(report.results).toHaveLength(7);
  expect(report.results.every(row => row.code === "bootstrap-adapter-unbound")).toBe(true);
});
it("the CLI binds clean tracked source, runs seven reads and rejects invalid packets before import", async () => {
  const { mkdtemp, writeFile, readFile, rm, stat, mkdir, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const execute = promisify(execFile);
  const root = await mkdtemp(path.join(tmpdir(), "rnp-bootstrap-cli-"));
  try {
    // Dedicated tiny source checkout: dirty-source refusal can be tested without
    // modifying the author's shared worktree or weakening the CLI's guard.
    const checkout=path.join(root,"source"), scripts=path.join(checkout,"scripts");
    await mkdir(path.join(scripts,"lib"),{recursive:true});
    await mkdir(path.join(checkout,"config"));
    for(const relative of ["scripts/preflight-release-no-pause-bootstrap.mjs","scripts/lib/public-release-bootstrap-preflight.mjs",
      "scripts/render-development-config.mjs","config/development-inputs.json"])
      await writeFile(path.join(checkout,relative),await readFile(path.resolve(relative)));
    await symlink(path.resolve("node_modules"),path.join(checkout,"node_modules"));
    await writeFile(path.join(checkout,".gitignore"),"node_modules\nignored-adapter.mjs\n");
    const marker=path.join(root,"adapter-imported"), packet=path.join(root,"packet.json"), adapter=path.join(scripts,"adapter.mjs");
    const owner=path.join(scripts,"owner.mjs");
    await writeFile(owner,"export const marker = 1;\n");
    // Only transport fixture reads: never real qualification/provider proof.
    await writeFile(adapter, `import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';import {marker} from './owner.mjs';
      writeFileSync(${JSON.stringify(marker)}, String(marker));
      export function createBootstrapPreflights(){return Object.fromEntries([1,2,3,4,5,6,7].map(layer=>[layer,async({firestore})=>{
        const row=await firestore.doc('bootstrapDemo/layer-'+layer).get(); if(!row.exists)throw Error('missing');
        return {receiptDigest:createHash('sha256').update(JSON.stringify(row.data())).digest('hex')};}]))}`);
    const git=args=>execute("git",args,{cwd:checkout});
    await git(["init","--quiet"]);await git(["add","."]);
    await git(["-c","user.name=Jules Avery","-c","user.email=fixture-d755e09637@example.org","commit","--quiet","-m","Retain isolated operator proof source"]);
    const sourceSha=(await git(["rev-parse","HEAD"])).stdout.trim();
    const adapterDigest=createHash("sha256").update(await readFile(adapter)).digest("hex");
    const invoke=()=>execute(process.execPath,["--import",path.resolve("site/node_modules/tsx/dist/loader.mjs"),path.join(scripts,"preflight-release-no-pause-bootstrap.mjs"),"dry-run",packet,adapter]);
    const save=extra=>writeFile(packet,JSON.stringify({schemaVersion:1,projectId:db.projectId,sourceSha,adapterDigest,...extra}));
    await save({});const result=await invoke();
    expect(result.stdout.match(/^PASS layer-/gm)).toHaveLength(7);
    expect(result.stdout).toContain("production-authority=false");
    const report=JSON.parse(result.stdout.split("\n").find(line=>line.startsWith("REPORT ")).slice(7));
    expect(report.context.packetDigest).toBe(createHash("sha256").update(await readFile(packet)).digest("hex"));
    expect(report.digest).toBe(hash({context:report.context,results:report.results}));
    await rm(marker);
    for(const [extra,code] of [[{projectId:"njpbs-site"},"invalid-packet"],[{sourceSha:"f".repeat(40)},"source-mismatch"]]){
      await save(extra);await expect(invoke()).rejects.toMatchObject({code:1,stderr:`FAIL bootstrap-preflight: ${code}\n`});
      await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
    }
    await save({adapterDigest:"f".repeat(64)});
    await expect(invoke()).rejects.toMatchObject({code:1,stderr:"FAIL bootstrap-preflight: adapter-mismatch\n"});
    await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
    await save({});
    const ignored=path.join(scripts,"ignored-adapter.mjs");await writeFile(ignored,await readFile(adapter));
    await expect(execute(process.execPath,[path.join(scripts,"preflight-release-no-pause-bootstrap.mjs"),"dry-run",packet,ignored]))
      .rejects.toMatchObject({code:1,stderr:"FAIL bootstrap-preflight: adapter-untracked\n"});
    await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
    await save({});await writeFile(owner,"export const marker = 2;\n");
    await expect(invoke()).rejects.toMatchObject({code:1,stderr:"FAIL bootstrap-preflight: source-dirty\n"});
    await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
    await git(["restore","scripts/owner.mjs"]);
    const malformedReceipt=path.join(checkout,".rendered-deployment-inputs.json");
    await writeFile(malformedReceipt,"{");
    await expect(invoke()).rejects.toMatchObject({code:1,stderr:"FAIL bootstrap-preflight: bootstrap-preflight-refused\n"});
    await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
    await rm(malformedReceipt);
    const external=path.join(root,"external.mjs");await writeFile(external,await readFile(adapter));
    await expect(execute(process.execPath,[path.join(scripts,"preflight-release-no-pause-bootstrap.mjs"),"dry-run",packet,external]))
      .rejects.toMatchObject({code:1,stderr:"FAIL bootstrap-preflight: adapter-outside-source\n"});
    await expect(stat(marker)).rejects.toMatchObject({code:"ENOENT"});
  } finally { await rm(root,{recursive:true,force:true}); }
});

it("keeps parent, converted, listed and query-snapshot references read-only", async () => {
  const configured=adapters();
  configured[1]=({firestore})=>firestore.doc("bootstrapDemo/layer-1").parent.doc("layer-1").set({changed:true});
  configured[2]=({firestore})=>firestore.doc("bootstrapDemo/layer-2").withConverter({toFirestore:v=>v,fromFirestore:s=>s.data()}).delete();
  configured[3]=async({firestore})=>(await firestore.collection("bootstrapDemo").listDocuments())[0].update({changed:true});
  configured[4]=async({firestore})=>(await firestore.listCollections())[0].doc("layer-4").set({changed:true});
  configured[5]=async({firestore})=>(await firestore.collectionGroup("bootstrapDemo").get()).docs[0].ref.set({changed:true});
  const report=await runBootstrapPreflights({firestore:db,adapters:configured,input:{}});
  expect(report.results.slice(0,5).map(row=>row.code)).toEqual(Array(5).fill("bootstrap-write-forbidden"));
  expect((await db.collection("bootstrapDemo").get()).docs.every(row=>!row.data().changed)).toBe(true);
});

it("preserves an owner's point-in-time transaction options while refusing writes", async () => {
  const cutoff={seconds:123,nanoseconds:456};
  const observed=[];
  const fake={projectId:"demo-bootstrap-cutoff",runTransaction:async(run,options)=>{
    observed.push(options);return run({get:async()=>({data:()=>options.readTime===cutoff?{version:1}:{version:2}})});
  }};
  const readonly=readOnlyBootstrapFirestore(fake);
  const actual=await readonly.runTransaction(async tx=>(await tx.get({})).data(),{readOnly:false,readTime:cutoff});
  expect(actual).toEqual({version:1});
  expect(observed[0]).toEqual({readOnly:true,readTime:cutoff});
  expect(observed[0].readTime).toBe(cutoff);
});
it("binds report digests to the exact packet and adapter identity", async () => {
  const run=(sourceSha,adapterDigest)=>runBootstrapPreflights({firestore:db,adapters:adapters(),input:{sourceSha},adapterDigest});
  const original=await run("a".repeat(40),"b".repeat(64));
  const changedPacket=await run("c".repeat(40),"b".repeat(64));
  const changedAdapter=await run("a".repeat(40),"d".repeat(64));
  expect(original.digest).not.toBe(changedPacket.digest);expect(original.digest).not.toBe(changedAdapter.digest);
  expect(original.context).toMatchObject({projectId:db.projectId,sourceSha:"a".repeat(40),adapterDigest:"b".repeat(64)});
});
it("freezes adapter input before observations so metadata still binds the validated packet", async () => {
  const configured=adapters(), input={sourceSha:"a".repeat(40),nested:{identity:"original"}};
  configured[2]=({input:packet})=>{packet.nested.identity="changed";return {receiptDigest:"b".repeat(64)};};
  const report=await runBootstrapPreflights({firestore:db,adapters:configured,input,packetDigest:"c".repeat(64)});
  expect(report.results[1]).toMatchObject({status:"FAIL",code:"bootstrap-preflight-refused"});
  expect(report.results.at(-1).status).toBe("PASS");
  expect(report.context).toMatchObject({sourceSha:input.sourceSha,packetDigest:"c".repeat(64)});
  expect(input.nested.identity).toBe("original");
});
