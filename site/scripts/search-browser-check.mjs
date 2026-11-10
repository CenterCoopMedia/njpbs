// Run against a local full build: xvfb-run -a node scripts/search-browser-check.mjs
// Serve dist with `npm run preview -- --host 127.0.0.1 --port 4322` first.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const base = process.argv[2] ?? "http://127.0.0.1:4322";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Use a local build; failure tests intercept requests.");
const browser = await chromium.launch({ channel: "chrome", headless: false, chromiumSandbox: true });
const searchbox = (page) => page.getByRole("searchbox", { name: "Search this site" });
const results = (page) => page.getByRole("list", { name: "Search results", exact: true });
const status = (page) => page.getByRole("main").getByRole("status");
const waitStatus = (page, text) => status(page).filter({ hasText: text }).waitFor();

async function axe(page) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  })).violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })));
  assert.deepEqual(violations, []);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/about/`);
  // Reach the header search using only Tab and Enter, without moving focus by script.
  for (let presses = 0; presses < 30; presses += 1) {
    await page.keyboard.press("Tab");
    if (await page.getByRole("link", { name: "Search", exact: true }).filter({ visible: true }).evaluate((el) => el === document.activeElement)) break;
  }
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Search");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${base}/search/`);
  await waitStatus(page, "Enter a word");
  await axe(page);
  // Tab through the page to the labeled input, then submit with Enter.
  for (let presses = 0; presses < 35; presses += 1) {
    await page.keyboard.press("Tab");
    if (await searchbox(page).evaluate((el) => el === document.activeElement)) break;
  }
  assert(await searchbox(page).evaluate((el) => el === document.activeElement));
  assert.notEqual(await searchbox(page).evaluate((el) => getComputedStyle(el).outlineStyle), "none");
  await page.keyboard.type("support");
  await page.keyboard.press("Enter");
  await waitStatus(page, "Showing");
  assert.equal(await results(page).getByRole("link").first().getAttribute("href"), "/support/");
  await searchbox(page).fill("NJ PBS");
  await waitStatus(page, "Showing 10.");
  assert.equal(await results(page).getByRole("listitem").count(), 10);
  await axe(page);
  await page.getByRole("button", { name: "Show more results" }).focus();
  await page.keyboard.press("Enter");
  await waitStatus(page, /Showing (1[1-9]|[2-9]\d)\./);
  assert(await results(page).getByRole("link").nth(10).evaluate((el) => el === document.activeElement));
  // The real generated index must return only existing local pages.
  for (const href of await results(page).getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    assert.equal((await page.request.get(new URL(href, base).href)).status(), 200, href);
  }
  await searchbox(page).fill("zzzznosuchnjpbspage");
  await waitStatus(page, "No results");
  assert.equal(await results(page).getByRole("listitem").count(), 0);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await waitStatus(page, "Enter a word");
  assert(await searchbox(page).evaluate((el) => el === document.activeElement));
  assert.equal(await searchbox(page).inputValue(), "");
  await searchbox(page).fill("donate");
  await waitStatus(page, "Showing");
  assert.equal(await results(page).getByRole("link").filter({ hasText: "Give to NJ PBS" }).getAttribute("href"), "/give/");
  assert.equal(await results(page).getByRole("link").evaluateAll((links) => links.some((link) => link.pathname === "/donate/")), false);
  for (const width of [320, 390, 768, 1153, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}px`);
    const button = await page.getByRole("button", { name: "Search", exact: true }).boundingBox();
    assert(button.height >= 44 && button.width >= 44);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /menu/i }).click();
  await page.getByRole("link", { name: "Search", exact: true }).filter({ visible: true }).waitFor();
  await page.keyboard.press("Escape");
  await axe(page);
  assert.deepEqual(errors, []);
  await page.close();
  console.log("PASS real index, keyboard, pagination, empty/clear states, mobile reflow, axe");

  const nojs = await browser.newPage({ javaScriptEnabled: false });
  await nojs.goto(`${base}/search/`);
  await nojs.getByText("Search needs JavaScript.", { exact: false }).waitFor();
  assert.equal(await nojs.getByRole("searchbox").count(), 0);
  for (const href of await nojs.getByRole("navigation", { name: "Browse NJ PBS" }).getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    if (href.startsWith("/")) assert.equal((await nojs.request.get(new URL(href, base).href)).status(), 200);
  }
  await nojs.close();
  console.log("PASS no-JavaScript fallback with live local browse links and no dead input");

  const failed = await browser.newPage();
  await failed.route("**/pagefind/pagefind.js", (route) => route.abort());
  await failed.goto(`${base}/search/`);
  await searchbox(failed).fill("support");
  await waitStatus(failed, "Search could not load");
  await failed.locator("[data-search-recovery]").getByRole("link", { name: "Reload search" }).waitFor();
  await failed.unroute("**/pagefind/pagefind.js");
  await failed.locator("[data-search-recovery]").getByRole("link", { name: "Reload search" }).click();
  await searchbox(failed).fill("support");
  await waitStatus(failed, "Showing");
  await failed.close();
  console.log("PASS failed index import and reload recovery");

  const filtered = await browser.newPage();
  await filtered.route("**/pagefind/pagefind.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `export async function filters() {
      return { show: { 'News NJ': 1 }, genre: { News: 1, Arts: 1 } };
    }
    export async function search(_term, { filters = {} } = {}) {
      return { results: filters.genre === 'Arts' ? [] : [{
        data: async () => ({ url: '/programs/news/', meta: { title: 'News NJ' }, excerpt: 'Local reporting' })
      }] };
    }`,
  }));
  await filtered.goto(`${base}/search/`);
  await filtered.getByRole("combobox", { name: "Program", exact: true }).selectOption("News NJ");
  await results(filtered).getByRole("link", { name: "News NJ", exact: true }).waitFor();
  assert.equal(await results(filtered).getByRole("link").count(), 1);
  await filtered.getByRole("combobox", { name: "Genre", exact: true }).selectOption("Arts");
  await waitStatus(filtered, "No results for the selected filters");
  assert.equal(await results(filtered).getByRole("link").count(), 0);
  await filtered.getByRole("button", { name: "Clear", exact: true }).click();
  assert.equal(await filtered.getByRole("combobox", { name: "Program", exact: true }).inputValue(), "");
  assert.equal(await filtered.getByRole("combobox", { name: "Genre", exact: true }).inputValue(), "");
  await filtered.close();
  console.log("PASS program filters without query words, intersections and Clear");

  const race = await browser.newPage();
  await race.route("**/pagefind/pagefind.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export async function filters() { return {}; }
    export async function search(term) {
      if (term === 'hang') return new Promise(() => {});
      return { results: [{ data: async () => {
        if (term === 'old') await new Promise(resolve => setTimeout(resolve, 700));
        return { url: '/about/', meta: { title: term }, excerpt: 'A result' };
      }}] };
    }`,
  }));
  await race.goto(`${base}/search/`);
  await searchbox(race).fill("old");
  await race.getByRole("button", { name: "Search", exact: true }).click();
  await searchbox(race).fill("new");
  await waitStatus(race, "for “new”");
  await race.waitForTimeout(850);
  assert.equal(await results(race).getByRole("link").innerText(), "new");
  await searchbox(race).fill("old");
  await race.getByRole("button", { name: "Search", exact: true }).click();
  await race.getByRole("button", { name: "Clear", exact: true }).click();
  await race.waitForTimeout(850);
  assert.equal(await results(race).getByRole("link").count(), 0);
  await waitStatus(race, "Enter a word");
  await searchbox(race).fill("hang");
  await waitStatus(race, "Searching");
  await waitStatus(race, "Search could not load");
  await race.locator("[data-search-recovery]").getByRole("link", { name: "Reload search" }).waitFor();
  await race.close();
  console.log("PASS late-result suppression, clear during fetch, bounded stalled-worker recovery");
} finally {
  await browser.close();
}
