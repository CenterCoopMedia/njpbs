// @vitest-environment node
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,it} from "vitest";
import {loadDataHubReportingSnapshot} from "../src/lib/data-hub-reporting-loader";

it("captures reporting through the existing generated Spotlight file and accepts old files",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"hub-reporting-"));
 try {
  const file=path.join(directory,"spotlight-news.json"),env={SPOTLIGHT_NEWS_DATA_PATH:file};
  const snapshot={schemaVersion:1,queries:{},pins:{key:"",checkedAt:null,failed:false,stories:[]}};
  await writeFile(file,JSON.stringify({cards:[],dataHubReporting:snapshot}));
  await expect(loadDataHubReportingSnapshot(env)).resolves.toEqual(snapshot);
  await writeFile(file,JSON.stringify({cards:[]}));
  await expect(loadDataHubReportingSnapshot(env)).resolves.toBeUndefined();
 } finally {await rm(directory,{recursive:true,force:true});}
});
it("omits invalid optional reporting without making figure content unavailable",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"hub-reporting-invalid-"));
 try {
  const file=path.join(directory,"spotlight-news.json");
  await writeFile(file,JSON.stringify({cards:[],dataHubReporting:{schemaVersion:99}}));
  await expect(loadDataHubReportingSnapshot({SPOTLIGHT_NEWS_DATA_PATH:file})).resolves.toBeUndefined();
 } finally {await rm(directory,{recursive:true,force:true});}
});
