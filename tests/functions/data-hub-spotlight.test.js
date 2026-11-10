import { describe, expect, it } from "vitest";
import provider from "../../functions/lib/data-hub-spotlight.js";
import contract from "../../functions/lib/data-hub-reporting.js";
import sources from "../../functions/lib/data-hub-reporting-sources.js";
const now = Date.parse("2026-10-22T12:00:00Z");
const mapping = (id = 25890) => ({ ...contract.emptyReportingMapping(), spotlight:{tags:[{id,slug:"minimum-wage",label:"Minimum wage"}],categories:[]} });
const row = (id = 42) => ({id,link:`https://www.njspotlightnews.org/2026/10/story-${id}/`,date_gmt:"2026-10-20T12:00:00",title:{rendered:"Wages &amp; work"},tags:[25890],categories:[]});
describe("bounded server-side Spotlight reporting", () => {
  it("coalesces taxonomy queries, sends exact IDs with OR, and batches pins once", async () => {
    const requests=[]; const config=mapping(); config.spotlight.categories=[{id:1978,slug:"housing",label:"Housing"}];
    config.hidden=[{source:"spotlight",id:"99"}];config.pins=[{source:"spotlight",id:"43"}];
    const result=await provider.refreshSpotlightReporting([config,config],undefined,{clock:()=>now,fetchImpl:async (url,options)=>{
      requests.push({url:new URL(url),options});return Response.json([row(url.searchParams.has("include") ? 43 : 42)]);
    }});
    expect(requests).toHaveLength(2);
    expect(requests[0].url.origin).toBe("https://www.njspotlightnews.org");
    expect(Object.fromEntries(requests[0].url.searchParams)).toMatchObject({status:"publish",tax_relation:"OR",tags:"25890",categories:"1978",exclude:"99",per_page:"25"});
    expect(requests[1].url.searchParams.get("include")).toBe("43");
    requests.forEach(({options})=>{expect(options).toMatchObject({method:"GET",redirect:"error"});expect(options.signal).toBeInstanceOf(AbortSignal);expect(options.headers.Authorization).toBeUndefined();});
    expect(sources.parseSpotlightReportingSnapshot(result)).toEqual(result);
    expect(sources.spotlightReportingFor(config,result).stories.map(story=>story.id)).toEqual(["42","43"]);
    expect(result.queries[sources.reportingQueryKey(config)].stories[0].title).toBe("Wages & work");
  });
  it("keeps same-query last good on failure, drops on successful empty, and never crosses mappings",async()=>{
    const config=mapping(); const good=await provider.refreshSpotlightReporting([config],undefined,{clock:()=>now,fetchImpl:async()=>Response.json([row()])});
    const unavailable=async()=>new Response("PRIVATE upstream diagnostic",{status:503});
    const failed=await provider.refreshSpotlightReporting([config],good,{clock:()=>now+3600000,fetchImpl:unavailable});
    expect(failed.queries[sources.reportingQueryKey(config)]).toMatchObject({failed:true,checkedAt:new Date(now).toISOString(),stories:[{id:"42"}]});
    const changed=await provider.refreshSpotlightReporting([mapping(77)],good,{clock:()=>now,fetchImpl:unavailable});
    expect(changed.queries[sources.reportingQueryKey(mapping(77))]).toEqual({failed:true,checkedAt:null,stories:[]});
    const empty=await provider.refreshSpotlightReporting([config],good,{clock:()=>now,fetchImpl:async()=>Response.json([])});
    expect(empty.queries[sources.reportingQueryKey(config)].stories).toEqual([]);
    expect(JSON.stringify(failed)).not.toContain("PRIVATE");
  });
  it("refuses unsafe, future and malformed story metadata and bounds streamed responses",async()=>{
    const config=mapping();
    const result=await provider.refreshSpotlightReporting([config],undefined,{clock:()=>now,fetchImpl:async()=>Response.json([
      row(),{...row(43),link:"https://evil.example/story/"},{...row(44),date_gmt:"2027-01-01T00:00:00"},{...row(45),tags:["25890"]},
    ])});
    expect(result.queries[sources.reportingQueryKey(config)].stories.map(story=>story.id)).toEqual(["42"]);
    const oversized=await provider.refreshSpotlightReporting([config],undefined,{clock:()=>now,fetchImpl:async()=>new Response("x".repeat(256*1024+1))});
    expect(oversized.queries[sources.reportingQueryKey(config)]).toEqual({failed:true,checkedAt:null,stories:[]});
    await expect(provider.refreshSpotlightReporting(Array(20).fill(config))).rejects.toThrow(/bound/);
  });
  it("cancels in-flight reads without publishing partial bytes",async()=>{
    const controller=new AbortController();
    const pending=provider.refreshSpotlightReporting([mapping()],undefined,{signal:controller.signal,clock:()=>now,fetchImpl:async(_url,{signal})=>{
      signal.throwIfAborted();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));
    }});
    controller.abort();const result=await pending;
    expect(result.queries[sources.reportingQueryKey(mapping())].failed).toBe(true);
  });
  it("uses public taxonomy IDs and a bounded fifteen-minute cache",async()=>{
    let requests=0;
    const fetchImpl=async(url)=>{requests++;expect(new URL(url).pathname).toBe("/wp-json/wp/v2/tags");return Response.json([{id:25890,slug:"minimum-wage",name:"Minimum &amp; fair wage"}]);};
    const first=await provider.readSpotlightTerms("tags","fair wage test",{clock:()=>now,fetchImpl});first[0].id=1;
    expect((await provider.readSpotlightTerms("tags","fair wage test",{clock:()=>now+1,fetchImpl}))[0].id).toBe(25890);
    expect(requests).toBe(2);
    await provider.readSpotlightTerms("tags","fair wage test",{clock:()=>now+900001,fetchImpl});expect(requests).toBe(4);
    await expect(provider.readSpotlightTerms("users","name",{fetchImpl})).rejects.toMatchObject({status:400});
  });
});

it("reports pin-only lookup failure with its original successful check",async()=>{
 const config=contract.emptyReportingMapping();config.pins=[{source:"spotlight",id:"42"}];
 const good=await provider.refreshSpotlightReporting([config],undefined,{clock:()=>now,fetchImpl:async()=>Response.json([row()])});
 const failed=await provider.refreshSpotlightReporting([config],good,{clock:()=>now+3600000,fetchImpl:async()=>new Response(null,{status:503})});
 expect(sources.spotlightReportingFor(config,failed)).toMatchObject({failed:true,checkedAt:new Date(now).toISOString(),stories:[{id:"42"}]});
});
