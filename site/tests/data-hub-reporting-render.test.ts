// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataHubReportingHtml } from "../src/lib/data-hub-reporting-render";
import { emptyDataHubReporting, emptyReportingMapping, type ReportingStory } from "../../packages/content-core/src/data-hub-reporting";
const html=readFileSync(new URL("../src/data/njpbs-data-hub-v16.html",import.meta.url),"utf8");
const source=(value:string)=>/<script[^>]*id="source-data"[^>]*>([\s\S]*?)<\/script>/.exec(value)![1];
const editorial=(value:string)=>JSON.parse(/<script[^>]*id="editorial-data"[^>]*>([\s\S]*?)<\/script>/.exec(value)![1]);
const now=Date.parse("2026-10-22T12:00:00Z");
const story:ReportingStory={source:"posts",id:"published-post",href:"https://njpbs.org/posts/published-story/",title:"Real wages <script>alert(1)</script>",publishedAt:"2026-10-21T12:00:00.000Z",tags:["wages"],categories:[]};
describe("compiled Data Hub reporting slot",()=>{
 it("keeps the saved selection until a mapping is published and never rewrites figures",()=>{
  expect(dataHubReportingHtml(html,undefined,[],undefined,now)).toBe(html);
  const config={...emptyDataHubReporting(),figures:{minimumwage:{...emptyReportingMapping(),posts:{tags:["wages"],categories:[]}}}};
  const result=dataHubReportingHtml(html,config,[story],undefined,now);
  expect(source(result)).toBe(source(html));
  expect(editorial(result).reporting.minimumwage).toEqual([{publication:"NJ PBS",title:story.title,href:story.href,publishedDay:"2026-10-21"}]);
  expect(editorial(result).featuredReporting).toEqual(editorial(result).reporting.minimumwage);
  expect(result).not.toContain(story.title);
  expect(result).not.toContain("Story links do not refresh automatically.");
  expect(result).toContain("reporting refreshes from staff-selected topics.");
 });
 it("hides empty owned mappings and treats an independent empty Featured mapping as empty",()=>{
  const config={...emptyDataHubReporting(),featured:{inheritFigure:false as const,mapping:emptyReportingMapping()}};
  const payload=editorial(dataHubReportingHtml(html,config,[story],undefined,now));
  expect(payload.reporting.minimumwage).toEqual([]);expect(payload.featuredReporting).toEqual([]);
 });
 it("shows only a staff pin's note and isolates an invalid optional provider",()=>{
  const config={...emptyDataHubReporting(),figures:{minimumwage:{...emptyReportingMapping(),pins:[{source:"posts" as const,id:story.id,note:"Staff context"}]}}};
  const payload=editorial(dataHubReportingHtml(html,config,[story],{bad:"provider"},now));
  expect(payload.reporting.minimumwage[0].connection).toBe("Staff context");
  expect(payload.reporting.minimumwage).toHaveLength(1);
 });
});
