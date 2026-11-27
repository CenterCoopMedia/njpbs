import { expect, installProofFonts, test } from "./fixtures";

for (const width of [390, 1280]) {
  test(`usage analytics history, empty, failure and populated views at ${width}px`, async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    const unexpected: string[] = [];
    const target = baseURL!;
    const origins = new Set([new URL(target).origin, ...(process.env.USAGE_BASELINE_URL ? [new URL(process.env.USAGE_BASELINE_URL).origin] : [])]);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (!origins.has(url.origin)) {
        unexpected.push(`${url.origin}${url.pathname}`); return route.abort();
      }
      return route.continue();
    });
    await installProofFonts(page);
    await page.route("**/src/lib/functions.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
      export class HttpError extends Error {}
      export async function cmsListBugReports(){return {reports:[],truncated:false,sharedReportsActive:true};}
      export async function cmsGetBugReport(){throw new Error('Not selected');}
      export async function cmsGetBugReportEvidence(){throw new Error('No evidence');}
      export async function cmsListGithubIssues(){return {issues:[],truncated:false};}
      export async function cmsGetGithubIssue(){throw new Error('Not selected');}
      export async function cmsNudgeBugReport(){throw new Error('Not selected');}
      export async function cmsResolveBugReport(){throw new Error('Not selected');}
      export async function postFunction(endpoint,token,{days}){
        if(endpoint!=='cmsGetBoardwalkUsage')throw new Error('Unexpected endpoint');
        if(window.__usageFail)throw new Error('Private service detail');
        const populated=window.__usagePopulated===true;
        return {days,analyticsEnabled:false,generatedAt:'2026-11-07T15:00:00Z',firstCollectedDate:populated?'2026-11-01':null,easternFromDate:populated?'2026-11-01':null,timezone:'America/New_York',
          history:{status:'ready',start:'2026-10-09T00:00:00Z',end:'2026-11-07T15:00:00Z',actions:[
            {id:'auth.login',label:'Accepted sign-ins',count:84},
            {id:'cms.publish',label:'Publish requests (all content)',count:56},
            {id:'cms.preview.request',label:'Preview jobs requested',count:120},
            {id:'media.upload',label:'Media items added (includes approved submissions)',count:42},
            {id:'bug_report.create',label:'Problem reports filed',count:8}]},
          ...(populated?populatedReport():emptyReport())};
      }
      const groups=make=>({newsroom:make('newsroom'),product:make('product')});
      const grid=()=>Array.from({length:7},(_,day)=>Array.from({length:24},(_,hour)=>day<5&&hour>=8&&hour<=18?(hour%5+1)*240000:0));
      const friction=(scale)=>({transitions:40*scale,backForth:6*scale,pairs:scale?[{screens:['Post editor','Posts list'],count:4*scale},{screens:['Images','Post editor'],count:2*scale}]:[],
        publish:{items:12*scale,repeats:3*scale,repeatedItems:2*scale},preview:{items:20*scale,repeats:5*scale,repeatedItems:3*scale}});
      const jobs=(scale)=>({previews:40*scale,failed:2*scale,expired:scale,stuckUploads:scale});
      const screen=(id,label,views,minutes,days)=>({id,label,views,visibleMs:minutes*60000,personDays:days,
        newsroom:{views:Math.round(views*0.8),visibleMs:Math.round(minutes*0.8)*60000,personDays:Math.round(days*0.8)},
        product:{views:views-Math.round(views*0.8),visibleMs:(minutes-Math.round(minutes*0.8))*60000,personDays:days-Math.round(days*0.8)}});
      function emptyReport(){
        const zero=()=>({transitions:0,backForth:0,pairs:[],publish:{items:0,repeats:0,repeatedItems:0},preview:{items:0,repeats:0,repeatedItems:0}});
        return {daily:[],weekly:[],weekCompare:{thisWeek:groups(()=>null),lastWeek:groups(()=>null)},sessions:groups(()=>({sessions:0,visibleMs:0})),
          activePeople:{status:'unavailable'},roleActivity:{status:'unavailable',rows:[]},hourMs:groups(()=>Array.from({length:7},()=>Array(24).fill(0))),screens:[],actions:[],
          friction:{current:groups(zero),prior:groups(zero),jobs:{status:'unavailable'}},contentFlow:{status:'unavailable'},problemReports:{status:'unavailable'},excludedAccounts:null};
      }
      function populatedReport(){
        const daily=Array.from({length:14},(_,index)=>{const date=new Date(Date.UTC(2026,9,25+index)).toISOString().slice(0,10);const day=new Date(date+'T00:00:00Z').getUTCDay();
          const newsroom=day===0||day===6?2:9+(index%4);return {date,timezone:'America/New_York',activeUsers:newsroom+2,newsroom,product:2};});
        return {daily,weekly:[{week:'2026-10-26',timezone:'America/New_York',activeUsers:18,newsroom:15,product:3,byRole:[{role:'contributor',activeUsers:6},{role:'editor',activeUsers:7},{role:'owner',activeUsers:3},{role:'publisher',activeUsers:2}]},
            {week:'2026-11-02',timezone:'America/New_York',activeUsers:16,newsroom:13,product:3,byRole:[{role:'contributor',activeUsers:5},{role:'editor',activeUsers:6},{role:'owner',activeUsers:3},{role:'publisher',activeUsers:2}]}],
          weekCompare:{thisWeek:{newsroom:13,product:3},lastWeek:{newsroom:15,product:3}},sessions:{newsroom:{sessions:120,visibleMs:120*14*60000},product:{sessions:40,visibleMs:40*25*60000}},
          activePeople:{status:'ready',newsroom:17,product:3},
          roleActivity:{status:'ready',rows:[{role:'contributor',group:'newsroom',roster:9,active:7,sessions:40,visibleMs:500*60000},{role:'editor',group:'newsroom',roster:8,active:7,sessions:60,visibleMs:900*60000},
            {role:'owner',group:'product',roster:3,active:3,sessions:40,visibleMs:1000*60000},{role:'publisher',group:'newsroom',roster:2,active:2,sessions:20,visibleMs:280*60000},{role:'none',group:'newsroom',roster:1,active:0,sessions:0,visibleMs:0}]},
          hourMs:{newsroom:grid(),product:grid().map(row=>row.map(ms=>Math.round(ms/4)))},
          screens:[screen('posts','Posts',120,120,30),screen('pages','Pages',32,20,12),screen('post-templates','Post templates',0,0,0)],
          actions:[{id:'content.publish.request',label:'Content publish attempts',count:60,personDays:22,lastUsed:'2026-11-07',newsroom:{count:52,personDays:19},product:{count:8,personDays:3}},
            {id:'preview.request',label:'Saved Preview attempts',count:143,personDays:40,lastUsed:'2026-11-07',newsroom:{count:120,personDays:34},product:{count:23,personDays:6}},
            {id:'media.clip.request',label:'Clip requests',count:0,personDays:0,lastUsed:null,newsroom:{count:0,personDays:0},product:{count:0,personDays:0}}],
          friction:{current:{newsroom:friction(2),product:friction(1)},prior:{newsroom:friction(1),product:friction(0)},jobs:{status:'ready',current:{newsroom:jobs(2),product:jobs(1)},prior:{newsroom:jobs(1),product:jobs(0)}}},
          contentFlow:{status:'ready',medianHoursToFirstPublish:2.5,publishedWeeks:[{week:'2026-10-26',newsroom:21,product:2,other:4},{week:'2026-11-02',newsroom:14,product:1,other:3}],
            openDrafts:[{bucket:'day',newsroom:3,product:1,other:0},{bucket:'week',newsroom:5,product:0,other:1},{bucket:'month',newsroom:4,product:1,other:2},{bucket:'older',newsroom:11,product:2,other:6}]},
          problemReports:{status:'ready',open:6,resolved:9,medianDaysToResolve:1.5,filed:11,topPages:[{page:'/content/post',count:5},{page:'/media/videos',count:3},{page:'/reports',count:2}]},
          excludedAccounts:4};
      }
    ` }));
    await page.setViewportSize({ width, height: 900 });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true });
    };
    // Optional independent baseline server supplies origin/main's existing Reports view.
    if (process.env.USAGE_BASELINE_URL) {
      await page.goto(`${process.env.USAGE_BASELINE_URL}/report-progress-fixture.html?list=1`);
      await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible();
      await capture("before-problem-reports");
    }
    await page.goto(`${target}/report-progress-fixture.html?list=1`);
    await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible();
    await capture("after-problem-reports");
    await page.getByRole("link", { name: "Boardwalk usage analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Boardwalk usage analytics" })).toBeVisible();
    await expect(page.getByRole("row", { name: "Accepted sign-ins 84" })).toBeVisible();
    await expect(page.getByText("No new usage analytics collected", { exact: true })).toBeVisible();
    await capture("after-history");
    await page.getByLabel("Reporting period").selectOption("7");
    await expect(page.getByRole("row", { name: "Accepted sign-ins 84" })).toBeVisible();
    await page.evaluate(() => { (window as Window & { __usageFail?: boolean }).__usageFail = true; });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText(/could not be loaded/)).toBeVisible();
    await expect(page.getByText("Private service detail")).toHaveCount(0);
    await capture("after-failure");
    await page.evaluate(() => { const state = window as Window & { __usageFail?: boolean; __usagePopulated?: boolean }; state.__usageFail = false; state.__usagePopulated = true; });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("row", { name: "Posts 24 6 120 96 24 120.0 96.0 24.0" })).toBeVisible();
    await expect(page.getByRole("row", { name: "Post templates 0 0 0 0 0 0.0 0.0 0.0" })).toBeVisible();
    await expect(page.getByRole("row", { name: "Clip requests 0 0 0 0 0 None" })).toBeVisible();
    await expect(page.getByRole("img", { name: /highest day had 12/ })).toBeVisible();
    await page.getByText("Daily counts").click();
    await expect(page.getByRole("row", { name: "2026-11-07 4 2 2" })).toBeVisible();
    await capture("after-populated");
    await page.getByRole("link", { name: "Back to problem reports" }).click();
    await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible();
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });
}
