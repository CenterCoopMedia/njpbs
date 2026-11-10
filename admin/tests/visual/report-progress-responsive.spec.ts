import { expect, test } from "./fixtures";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BugReportRecord } from "../../src/lib/functions";

const id = `br_${"a".repeat(32)}`;
const at = "2026-10-08T16:00:00.000Z";
const report: BugReportRecord = {
  apiVersion: 1, id, category: "suggestion", severity: "minor", area: "media",
  tryingToDo: "Download a credited video", happened: "A confirmation would help us remember the on-screen credit.",
  expected: "Show the reminder before the download starts.", steps: null, workaround: null,
  route: { path: "/media/videos", url: null }, affectedRecord: null,
  reporter: { uid: "report-fixture-editor", role: "editor" }, evidence: { screenshot: null },
  environment: { buildRevision: "b".repeat(40), deploymentEnvironment: "production", browser: "Synthetic fixture", operatingSystem: "Test", viewport: { width: 1280, height: 900 } },
  correlationIds: [], status: "open", acknowledgedAt: null, assignedAt: null, resolvedAt: null, dismissedAt: null,
  version: 3, createdAt: at, updatedAt: at,
  actionableResolution: { immediateSafeAction: "", likelyCause: { certainty: "unknown", summary: "" }, recommendedResolution: [], verification: "", fallback: "", needsAdminInput: "", missingEvidence: [] },
  progress: { phase: "merged", label: "Merged; live verification pending", detail: "The code change is merged. The live fix has not been verified.",
    active: true, updatedAt: at, lastSyncedAt: at, syncState: "current", issues: [{ number: 2835, state: "closed" }],
    pullRequests: [{ number: 2845, state: "closed", draft: false, merged: true, reviewState: "approved", checksState: "success" }], deployment: "unverified" },
};

for (const width of [390, 1280]) {
  test(`report progress and stale recovery remain usable at ${width}px`, async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    const fixtureOrigin = new URL(baseURL!).origin;
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== fixtureOrigin || /(?:^|\/)cms[A-Z]/.test(url.pathname)) {
        unexpectedRequests.push(`${url.origin}${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    // Replacing the application API module keeps every read inside this fixture.
    // No real token, Firebase session, provider API or staff report is used.
    await page.route("**/src/lib/functions.ts*", (route) => route.fulfill({
      contentType: "text/javascript", body: `
        export class HttpError extends Error { constructor(status,message){super(message);this.status=status} }
        const report = ${JSON.stringify(report)};
        function check(){if(window.__reportFixtureFail)throw new Error('The report service could not be reached.');}
        export async function cmsListBugReports(){check();return {reports:[report],truncated:false,sharedReportsActive:true};}
        export async function cmsGetBugReport(){check();return {report,audit:[],canAdminister:false};}
        export async function cmsGetBugReportEvidence(){throw new Error('No evidence in fixture');}
        export async function cmsListGithubIssues(){return {issues:[],truncated:false};}
        export async function cmsGetGithubIssue(){throw new Error('No issue in fixture');}
        export async function cmsNudgeBugReport(){throw new Error('No nudge in this fixture');}
      `,
    }));
    await page.goto("/report-progress-fixture.html");
    await expect(page.getByRole("heading", { name: "Work progress" })).toBeVisible();
    await expect(page.getByText("Report status: Open")).toBeVisible();
    await expect(page.getByRole("status").getByText("Merged; live verification pending", { exact: true })).toBeVisible();
    await expect(page.getByText("The code change is merged. The live fix has not been verified.")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const evidence = resolve("test-results/report-progress-evidence");
    await mkdir(evidence, { recursive: true });
    const screenshot = resolve(evidence, `progress-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Report progress at ${width}px`, { path: screenshot, contentType: "image/png" });

    await page.evaluate(() => { (window as Window & { __reportFixtureFail?: boolean }).__reportFixtureFail = true; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/Last shown information may be out of date/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Download a credited video" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const stale = resolve(evidence, `stale-${width}.png`);
    await page.screenshot({ path: stale, fullPage: true });
    await testInfo.attach(`Retained report after failed refresh at ${width}px`, { path: stale, contentType: "image/png" });

    await page.evaluate(() => { (window as Window & { __reportFixtureFail?: boolean }).__reportFixtureFail = false; });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/Last shown information may be out of date/)).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
}
