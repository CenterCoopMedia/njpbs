import { expect, test } from "@playwright/test";

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
    await page.route("**/src/lib/functions.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
      export class HttpError extends Error {}
      export async function cmsListBugReports(){return {reports:[],truncated:false,sharedReportsActive:true};}
      export async function cmsGetBugReport(){throw new Error('Not selected');}
      export async function cmsGetBugReportEvidence(){throw new Error('No evidence');}
      export async function cmsListGithubIssues(){return {issues:[],truncated:false};}
      export async function cmsGetGithubIssue(){throw new Error('Not selected');}
      export async function cmsNudgeBugReport(){throw new Error('Not selected');}
      export async function postFunction(endpoint,token,{days}){
        if(endpoint!=='cmsGetBoardwalkUsage')throw new Error('Unexpected endpoint');
        if(window.__usageFail)throw new Error('Private service detail');
        const populated=window.__usagePopulated===true;
        return {days,analyticsEnabled:false,generatedAt:'2026-11-07T15:00:00Z',firstCollectedDate:populated?'2026-11-01':null,timezone:'UTC',
          history:{status:'ready',start:'2026-10-09T00:00:00Z',end:'2026-11-07T15:00:00Z',actions:[
            {id:'auth.login',label:'Accepted sign-ins',count:84},
            {id:'cms.publish',label:'Publish requests (all content)',count:56},
            {id:'cms.preview.request',label:'Preview jobs requested',count:120},
            {id:'media.upload',label:'Media items added (includes approved submissions)',count:42},
            {id:'bug_report.create',label:'Problem reports filed',count:8}]},
          daily:[{date:'2026-11-07',activeUsers:12}],weekly:[{week:'2026-11-02',activeUsers:19}],
          screens:[{id:'posts',label:'Posts',views:120,visibleMs:7200000},{id:'pages',label:'Pages',views:32,visibleMs:1200000},{id:'post-templates',label:'Post templates',views:0,visibleMs:0}],
          actions:[{id:'content.publish.request',label:'Content publish attempts',count:60},{id:'preview.request',label:'Saved Preview attempts',count:143}]};
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
    await expect(page.getByRole("row", { name: "Posts 120 120.0" })).toBeVisible();
    await expect(page.getByRole("row", { name: "Post templates 0 0.0" })).toBeVisible();
    await capture("after-populated");
    await page.getByRole("link", { name: "Back to problem reports" }).click();
    await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible();
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });
}
