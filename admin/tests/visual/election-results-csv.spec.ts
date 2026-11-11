import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import { renderElectionResults } from "../../../packages/content-core/src/election-results-render";
import type { ElectionResultsData } from "../../../packages/content-core/src/election-results";
const hub = JSON.parse(readFileSync(new URL("../../../site/tests/fixtures/election-results-hub.json", import.meta.url), "utf8")) as { id: string; data: ElectionResultsData };

const css = ["../../../site/src/styles/design-tokens.css", "../../../packages/content-core/src/component-blocks.css",
  "../../../packages/content-core/src/election-results.css"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const script = buildSync({
  stdin: { contents: 'import { installElectionResults } from "./election-results-dom.ts"; installElectionResults(window);',
    resolveDir: fileURLToPath(new URL("../../../packages/content-core/src", import.meta.url)) },
  bundle: true, write: false, format: "iife", platform: "browser",
}).outputFiles[0].text;
const original = hub.data as ElectionResultsData;
function counted() {
  const data = structuredClone(original);
  data.races[0].status = "counting";
  data.races[0].asOf = "2026-11-04T02:15:00Z";
  data.races[0].candidates = data.races[0].candidates.map((candidate, index) => ({
    ...candidate, votes: index === 0 ? 1000 : 0, share: index === 0 ? 100 : 0,
  }));
  return data;
}
function html(data: ElectionResultsData) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main class="cms-page__blocks"><div class="cms-block cms-block--election_results">${renderElectionResults(hub.id, data, 2, undefined, true)}</div></main></body></html>`;
}
async function downloadCsv(page: Page) {
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).press("Enter");
  const download = await ready;
  expect(download.suggestedFilename()).toBe("nj-decides-results.csv");
  return readFileSync((await download.path())!, "utf8");
}

for (const width of [390, 1280]) {
  test(`public CSV follows displayed results through filters and refresh at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.install({ time: new Date("2026-11-04T02:16:00Z") });
    let data = structuredClone(original);
    let reads = 0;
    await page.route("**/results", route => { reads++; return route.fulfill({ contentType: "text/html", body: html(data) }); });
    await page.goto("/results");
    const button = page.getByRole("button", { name: "Download CSV", exact: true });
    await expect(button).toBeHidden();
    await expect(page.locator("article")).toHaveCount(13);
    await expect(page.locator("table tbody tr")).toHaveCount(39);
    await page.screenshot({ path: testInfo.outputPath("no-script.png") });
    await page.addScriptTag({ content: script });
    await expect(page.locator("[data-election-live-text]")).toHaveText("Checking for updates");
    await expect(page.locator("[data-election-live-dot]")).toBeHidden();
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleDescription("All races, including those hidden by filters. Unknown values are blank.");
    await page.getByRole("combobox", { name: "Race status" }).focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("download-ready.png") });
    const initial = await downloadCsv(page);
    expect(initial.split("\r\n")).toHaveLength(41);
    expect(initial).toContain('"Cory Booker","Democratic","",""');
    await expect(button).toBeFocused();
    await page.getByRole("searchbox", { name: "Search races" }).fill("Cory Booker");
    await expect(page.locator("article:visible")).toHaveCount(1);
    expect(await downloadCsv(page)).toBe(initial);
    expect(reads).toBe(1); // Download makes no request.
    data = counted();
    await page.clock.fastForward(60_000);
    await expect(page.locator(".election-results__votes").first()).toHaveText("1,000 votes");
    await expect(page.locator("[data-election-live-text]")).toHaveText("Live updates");
    await expect(page.locator("[data-election-live-dot]")).toBeVisible();
    await expect(button).toBeFocused();
    const updated = await downloadCsv(page);
    expect(updated).toContain('"Cory Booker","Democratic","1000","100"');
    expect(updated).toContain('"Justin Murphy","Republican","0","0"');
    expect(updated).toContain('"2026-11-04T02:15:00Z"');
    expect(updated).not.toBe(initial);
    const adoptionTime = await page.locator("[data-election-update-time]").textContent();
    await expect(page.locator("table tbody tr").first().locator("td").nth(1)).toHaveText("1,000");
    await page.getByRole("searchbox", { name: "Search races" }).fill("");
    await page.locator('[data-election-jump="us-house-12"]').focus();
    data = counted();
    data.races.pop(); // This removes the focused link: refresh must defer the entire snapshot.
    const deferredResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/results");
    await page.clock.fastForward(60_000);
    await (await deferredResponse).finished();
    // Finish the request before moving focus to the download control.
    await expect.poll(() => reads).toBe(3);
    await expect(page.locator("[data-election-live-text]")).toHaveText("Updates delayed");
    await expect(page.locator("[data-election-update-time]")).toHaveText(adoptionTime!);
    await expect(page.locator("[data-election-live-dot]")).toBeHidden();
    await expect(page.locator('[data-election-jump="us-house-12"]')).toBeFocused();
    await expect(page.locator("article")).toHaveCount(13);
    expect(await downloadCsv(page)).toBe(updated);
    await page.clock.fastForward(60_000);
    await expect(page.locator("article")).toHaveCount(12);
    const adopted = await downloadCsv(page);
    expect(adopted).not.toContain('"District 12"');
    expect(adopted).not.toBe(updated);
  });
  test(`reader pause, failure and recovery follow real requests at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.install({ time: new Date("2026-11-04T02:16:00Z") });
    let reads = 0;
    let failed = false;
    await page.route("**/results", route => { reads++; return route.fulfill({ status: failed ? 503 : 200, contentType: "text/html", body: html(counted()) }); });
    await page.goto("/results");
    await page.addScriptTag({ content: script });
    const status = page.locator("[data-election-results-update]");
    const label = page.locator("[data-election-live-text]");
    const pause = page.getByRole("button", { name: "Pause updates", exact: true });
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(pause).toHaveAccessibleDescription(/Pause applies to all results on this page/);
    await pause.press("Enter");
    const resume = page.getByRole("button", { name: "Resume updates", exact: true });
    await expect(resume).toBeFocused();
    await expect(label).toHaveText("Updates paused");
    await page.clock.fastForward(180_000);
    expect(reads).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("paused.png") });
    await resume.press("Enter");
    await expect(pause).toBeFocused();
    await expect(label).toHaveText("Checking for updates");
    await page.clock.fastForward(1_000);
    await expect(label).toHaveText("Live updates");
    expect(reads).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("active.png") });
    failed = true;
    await page.clock.fastForward(60_000);
    await expect(label).toHaveText("Updates delayed");
    await expect(page.locator("[data-election-live-dot]")).toBeHidden();
    await expect(page.locator(".election-results__votes").first()).toHaveText("1,000 votes");
    await context.setOffline(true);
    await expect(label).toHaveText("Offline; updates paused");
    await page.clock.fastForward(300_000);
    expect(reads).toBe(3);
    failed = false;
    await context.setOffline(false);
    await expect(label).toHaveText("Updates delayed");
    await page.clock.fastForward(1_000);
    await expect(label).toHaveText("Live updates");
    expect(reads).toBe(4);
    await expect(pause).toBeFocused();
    expect((await pause.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await pause.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
