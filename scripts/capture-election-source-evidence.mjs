import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [beforeOrigin = "http://127.0.0.1:5241", afterOrigin = "http://127.0.0.1:5242", output = "/tmp/lgn-feed-election-source-evidence"] = process.argv.slice(2);
for (const origin of [beforeOrigin, afterOrigin]) {
  const url = new URL(origin);
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/"); assert.equal(url.search, "");
}
const roster = JSON.parse(await readFile(new URL("../tests/fixtures/election-sources/roster.json", import.meta.url)));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const evidence = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://media.example.test/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450"><rect width="600" height="450" fill="#dce6f4"/><circle cx="300" cy="170" r="80" fill="#537094"/><path d="M130 440c0-180 340-180 340 0" fill="#537094"/></svg>' }));
    async function capture(name) {
      await page.evaluate(() => document.fonts.ready);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow at ${width}`);
      const path = resolve(output, `${name}-${width}.png`);
      await page.screenshot({ path, fullPage: true }); evidence.push(path);
    }
    async function go(source, state = "") {
      await page.goto(`${afterOrigin}/election-results-evidence.html?view=editor&source=${source}${state ? `&state=${state}` : ""}`);
      await page.getByRole("button", { name: "Refresh connection" }).waitFor();
      await page.getByText("Checking the connection…", { exact: true }).waitFor({ state: "hidden" });
    }
    await page.goto(`${beforeOrigin}/election-results-evidence.html?view=editor`);
    await page.getByRole("button", { name: "Edit election results 1" }).waitFor();
    await capture("before-manual");
    await go("connect"); await capture("after-disconnected");
    await page.getByRole("button", { name: "Connect a source" }).click();
    await page.getByRole("combobox", { name: "Results source" }).selectOption("sheet");
    await page.getByLabel("Spreadsheet ID", { exact: true }).fill("synthetic-sheet-id");
    await page.getByLabel("Sheet tab", { exact: true }).fill("Results");
    await page.getByText("Review Sheet column headers", { exact: true }).click();
    assert.equal(await page.getByLabel("candidate_id", { exact: true }).inputValue(), "candidate_id");
    await page.getByText("U.S. Senate: New Jersey", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Include New Jersey", exact: true }).check();
    await capture("after-sheet-mapping");
    await page.getByRole("combobox", { name: "Results source" }).selectOption("ap");
    await page.getByLabel("AP race ID for New Jersey", { exact: true }).fill("100");
    await page.getByText("U.S. Senate: New Jersey — selected", { exact: true }).click();
    await page.getByRole("button", { name: "Connect source", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Complete AP candidate ID for Cory Booker" }).waitFor();
    assert(await page.getByLabel("AP candidate ID for Cory Booker", { exact: true }).evaluate(element => element.closest("details").open && document.activeElement === element));
    await capture("after-mapping-validation");
    for (const [index, candidate] of roster.candidates.filter(candidate => candidate.raceId === "us-senate").entries()) {
      await page.getByLabel(`AP candidate ID for ${candidate.name}`, { exact: true }).fill(String(index + 1));
    }
    const firstCandidate = page.getByLabel("AP candidate ID for Cory Booker", { exact: true });
    const secondCandidate = page.getByLabel("AP candidate ID for Justin Murphy", { exact: true });
    await firstCandidate.fill("8639"); await secondCandidate.fill(""); await secondCandidate.pressSequentially("86390");
    assert.equal(await secondCandidate.inputValue(), "86390");
    await page.getByLabel("AP race ID for New Jersey", { exact: true }).fill("");
    assert.equal(await firstCandidate.inputValue(), "8639");
    await page.getByLabel("AP race ID for New Jersey", { exact: true }).fill("100");
    assert.equal(await secondCandidate.inputValue(), "86390");
    await firstCandidate.fill("1"); await secondCandidate.fill("2");
    assert.equal(await page.getByRole("textbox", { name: /API key/i }).count(), 0);
    await page.getByRole("combobox", { name: "Publish mode" }).selectOption("counts-auto");
    await capture("after-ap-mapping");
    await page.getByText("Optional Media photo for Cory Booker", { exact: true }).click();
    const photo = page.getByRole("button", { name: /Choose.*Media|Choose.*photo|Browse.*Media/i });
    if (await photo.count() !== 1) throw new Error(`Expected one visible Media trigger, found ${await photo.count()}`);
    await photo.click();
    const picker = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /Media|Choose/i }) });
    await picker.waitFor();
    await capture("after-media-picker");
    await picker.getByRole("button", { name: /^Jordan Ellis Category:/ }).click();
    await picker.waitFor({ state: "hidden" });
    await page.getByLabel("Photo description for Cory Booker", { exact: true }).fill("Synthetic candidate portrait");
    assert.equal(await page.getByLabel("Photo credit for Cory Booker", { exact: true }).inputValue(), "Illustrative portrait");
    await capture("after-media-selected");
    await page.getByRole("button", { name: "Discard source settings" }).click();
    await go("pending", "readonly");
    assert(await page.getByRole("button", { name: "Approve status changes" }).isEnabled());
    await capture("after-pending");
    await page.getByRole("button", { name: "Approve status changes" }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Saving the connection…", { exact: true }).waitFor();
    await page.getByText("Saving the connection…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Approve status changes" }).count(), 0);
    await page.getByRole("button", { name: "Pause updates" }).click();
    await page.getByRole("button", { name: "Resume updates" }).waitFor();
    await capture("after-paused");
    await page.getByRole("button", { name: "Resume updates" }).click();
    await page.getByRole("button", { name: "Pause updates" }).waitFor();
    await go("hold"); await page.getByText("Update held: stale", { exact: true }).waitFor(); await capture("after-hold");
    await go("ap-disabled"); await page.getByText("Update held: ap-disabled", { exact: true }).waitFor(); await capture("after-ap-disabled");
    await go("reader");
    assert.equal(await page.getByRole("button", { name: "Pause updates" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Edit connection" }).count(), 0);
    await capture("after-reader");
    assert.deepEqual(errors, [], `Browser errors at ${width}`);
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(resolve(output, "evidence.json"), JSON.stringify({ browser: "default bundled headless Chromium", sandbox: true, evidence }, null, 2) + "\n");
console.log(`Verified element-reference source flows at 1280 and 390 pixels; ${evidence.length} screenshots in ${output}`);
