/* global Document, document, window, navigator, innerWidth, location, getComputedStyle */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const require = createRequire(new URL("../../../site/package.json", import.meta.url));
const { chromium } = require("playwright");
const directory = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.argv[2];
assert.ok(evidence, "Supply an evidence directory outside the checkout");
mkdirSync(evidence, { recursive: true });
const render = name => execFileSync("php", [join(directory, "tests/wordpress-contract.php"), "render", name], { encoding: "utf8" });
const fixtures = Object.fromEntries(["article", "video", "noindex", "baseline", "media-blocked"].map(name => [name, render(name)]));
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const version = browser.version().split(".").map(Number);
assert.ok(version[0] > 156 || (version[0] === 156 && (version[2] > 8078 || (version[2] === 8078 && version[3] >= 73))), "Use system Chrome at or above the approved version");

async function context({ analytics = "", gpc = false, blockedCookies = false, blockedWrites = false, blockedWrite = "", blockedSession = false, existingGlobal = false, saved = "", javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled });
  if (saved) await ctx.addCookies([{ name: "spotlight-newsletter-consent", value: saved, domain: "news.example.org", path: "/", secure: true }]);
  if (analytics) await ctx.addCookies([{ name: "spotlight-analytics-consent", value: analytics, domain: "news.example.org", path: "/", secure: true }]);
  await ctx.addInitScript(({ gpc, blockedCookies, blockedWrites, blockedWrite, blockedSession, existingGlobal }) => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: gpc });
    if (blockedCookies) Object.defineProperty(document, "cookie", { get() { throw new Error("Cookie storage blocked"); }, set() {} });
    else if (blockedWrites) {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
      Object.defineProperty(document, "cookie", { get() { return descriptor.get.call(document); }, set() {} });
    } else if (blockedWrite) {
      // The browser accepts one choice and refuses the other.
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
      Object.defineProperty(document, "cookie", {
        get() { return descriptor.get.call(document); },
        set(value) { if (!value.startsWith(`${blockedWrite}=`)) descriptor.set.call(document, value); },
      });
    }
    if (blockedSession) Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Session storage blocked"); } });
    if (existingGlobal) window.vgo = () => {};
  }, { gpc, blockedCookies, blockedWrites, blockedWrite, blockedSession, existingGlobal });
  const vendors = [];
  await ctx.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "player.pbs.org" && url.pathname === "/viralplayer/123456/") {
      return route.fulfill({ contentType: "text/html", body: "<p>Synthetic video player</p>" });
    }
    if (url.hostname !== "news.example.org") {
      vendors.push(url.href);
      const body = url.hostname === "www.googletagmanager.com"
        ? 'window.gaCommands=window.dataLayer.map(args=>Array.from(args));'
        : url.hostname === "diffuser-cdn.app-us1.com"
          ? 'window.acCommands=window.vgo.q.slice();window.vgo=(...args)=>window.acCommands.push(args);'
          : 'window.wpCommands=window.wisepops.q.slice();';
      return route.fulfill({ contentType: "application/javascript", body });
    }
    if (url.pathname.endsWith("consent.js") || url.pathname.endsWith("consent.css")) {
      const name = url.pathname.endsWith(".js") ? "consent.js" : "consent.css";
      return route.fulfill({ contentType: name.endsWith(".js") ? "application/javascript" : "text/css", body: readFileSync(join(directory, name), "utf8") });
    }
    const fixture = url.searchParams.has("spotlight_newsletter_media") ? fixtures["media-blocked"]
      : fixtures[url.pathname.split("/")[1]] ?? fixtures.article;
    return route.fulfill({ contentType: "text/html", body: fixture });
  });
  return { ctx, page: await ctx.newPage(), vendors };
}

try {
  for (const width of [1280, 390, 320]) {
    const { ctx, page, vendors } = await context();
    await page.setViewportSize({ width, height: 900 });
    await page.goto("https://news.example.org/baseline/");
    await page.screenshot({ path: join(evidence, `before-${width}.png`), fullPage: true });
    await page.goto("https://news.example.org/article/");
    const bar = page.getByRole("region", { name: "Privacy choices", exact: true });
    const all = bar.getByRole("button", { name: "Allow all", exact: true });
    const none = bar.getByRole("button", { name: "Allow none", exact: true });
    const choices = bar.getByRole("button", { name: "Choices", exact: true });
    await all.waitFor({ state: "visible" });
    await bar.getByText("We use analytics and newsletter tools only if you allow them.", { exact: true }).waitFor();
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "First visit shows the bar, not the panel");
    assert.equal(vendors.length, 0, "Unknown consent never requests vendors");
    const weight = node => { const style = getComputedStyle(node); return [style.color, style.backgroundColor, style.borderColor, style.fontWeight, style.fontSize]; };
    assert.deepEqual(await all.evaluate(weight), await none.evaluate(weight), "Allow all and Allow none have equal visual weight");
    const [allBox, noneBox] = [await all.boundingBox(), await none.boundingBox()];
    assert.ok(allBox.height >= 44 && Math.abs(allBox.width - noneBox.width) < 1 && Math.abs(allBox.height - noneBox.height) < 1);
    assert.ok((await bar.boundingBox()).height < 900 / 3, `The bar stays short at ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}`);
    await all.focus();
    await page.keyboard.press("Tab");
    assert.equal(await none.evaluate(node => node === document.activeElement), true);
    assert.notEqual(await none.evaluate(node => getComputedStyle(node).outlineStyle), "none");
    await page.screenshot({ path: join(evidence, `bar-${width}.png`), fullPage: false });
    await choices.click();
    assert.equal(await bar.isVisible(), false);
    const denyAnalytics = page.getByRole("button", { name: "Do not allow analytics", exact: true });
    assert.equal(await denyAnalytics.evaluate(node => node === document.activeElement), true, "Choices focuses the first choice");
    for (const name of ["Do not allow analytics", "Allow analytics", "Do not allow newsletter tools", "Allow newsletter tools"]) {
      assert.ok((await page.getByRole("button", { name, exact: true }).boundingBox()).height >= 44);
    }
    await page.screenshot({ path: join(evidence, `consent-${width}.png`), fullPage: true });
    await denyAnalytics.click();
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), true, "One choice leaves the other open");
    await page.getByRole("button", { name: "Do not allow newsletter tools", exact: true }).click();
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Privacy settings", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.reload();
    assert.equal(await bar.isVisible(), false, "A complete choice hides the bar");
    assert.equal(vendors.length, 0, "A saved denial stays off");
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Allow none", exact: true }).click();
    assert.equal(await page.getByRole("region", { name: "Privacy choices", exact: true }).isVisible(), false);
    const cookies = Object.fromEntries((await ctx.cookies()).map(cookie => [cookie.name, cookie.value]));
    assert.deepEqual([cookies["spotlight-analytics-consent"], cookies["spotlight-newsletter-consent"]], ["v1%3Adenied", "v1%3Adenied"]);
    await page.reload();
    assert.equal(vendors.length, 0, "Allow none keeps every tool off");
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Allow all", exact: true }).click();
    await page.waitForFunction(() => window.gaCommands && window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    assert.deepEqual(vendors.map(href => new URL(href).hostname).sort(), ["diffuser-cdn.app-us1.com", "wisepops.net", "www.googletagmanager.com"], "Allow all grants both choices");
    assert.equal(await page.getByRole("region", { name: "Privacy choices", exact: true }).isVisible(), false);
    await ctx.close();
  }

  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#article-link").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "The panel cannot obscure ordinary page focus");
    const bar = page.getByRole("region", { name: "Privacy choices", exact: true });
    assert.equal(await bar.isVisible(), true, "Keyboard focus keeps the first-visit bar");
    const [link, barBox] = [await page.locator("#article-link").boundingBox(), await bar.boundingBox()];
    assert.ok(link.y + link.height <= barBox.y, "The bar does not cover focused page content");
    await page.evaluate(() => { document.querySelector("main").style.minHeight = "3000px"; });
    const footerButton = page.getByRole("button", { name: "Privacy settings", exact: true });
    await footerButton.focus();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const [footerBox, barAtEnd] = [await footerButton.boundingBox(), await bar.boundingBox()];
    assert.ok(footerBox.y + footerBox.height <= barAtEnd.y, "At maximum scroll the bar does not cover the footer button");
    await page.locator("#article-link").focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    for (let step = 0; step < 6 && !(await page.getByRole("button", { name: "Allow all", exact: true }).evaluate(node => node === document.activeElement)); step += 1) {
      await page.keyboard.press("Tab");
    }
    assert.equal(await page.getByRole("button", { name: "Allow all", exact: true }).evaluate(node => node === document.activeElement), true, "Forward Tab reaches the bar");
    const opener = page.getByRole("button", { name: "Privacy settings", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "Do not allow analytics", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "Footer settings focus stays unobscured");
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    // Layout rule: the reserved page space equals the bar height, also after the bar grows.
    const { ctx, page, vendors } = await context();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("https://news.example.org/article/");
    const bar = page.getByRole("region", { name: "Privacy choices", exact: true });
    await bar.waitFor();
    const reserved = () => page.evaluate(() => {
      const node = document.querySelector("[data-privacy-bar]");
      return [parseFloat(document.documentElement.style.paddingBottom), node.offsetHeight];
    });
    const shown = await reserved();
    assert.equal(shown[0], shown[1], "Shown bar reserves its height");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForFunction(height => document.querySelector("[data-privacy-bar]").offsetHeight > height, shown[1]);
    await page.waitForFunction(() => parseFloat(document.documentElement.style.paddingBottom) === document.querySelector("[data-privacy-bar]").offsetHeight);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForFunction(() => parseFloat(document.documentElement.style.paddingBottom) === document.querySelector("[data-privacy-bar]").offsetHeight);
    const [space, height] = await reserved();
    assert.ok(height > shown[1] && space === height, "Reserved space follows a taller bar");
    await page.evaluate(() => { document.querySelector("main").style.minHeight = "3000px"; });
    const footerButton = page.getByRole("button", { name: "Privacy settings", exact: true });
    await footerButton.focus();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const [footerBox, barBox] = [await footerButton.boundingBox(), await bar.boundingBox()];
    assert.ok(footerBox.y + footerBox.height <= barBox.y, "After the bar grows it still does not cover the footer button");
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  for (const percent of [200, 400]) {
    // Layout rule: at a narrow viewport with enlarged text the bar fits the viewport and each control scrolls into it.
    // At 200% each button fits whole (1px allows subpixel layout); at 400% a button can be taller than the bar's scroll area, so its center must be reachable.
    const { ctx, page, vendors } = await context();
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto("https://news.example.org/article/");
    await page.evaluate(percent => { document.documentElement.style.fontSize = `${percent}%`; }, percent);
    const bar = page.getByRole("region", { name: "Privacy choices", exact: true });
    const box = await bar.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 480, `The bar fits inside the viewport at ${percent}%`);
    for (const name of ["Allow all", "Allow none", "Choices"]) {
      const button = bar.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const target = await button.boundingBox();
      const inside = percent === 200
        ? target.y >= box.y - 1 && target.y + target.height <= box.y + box.height + 1
        : target.y + target.height / 2 > box.y && target.y + target.height / 2 < box.y + box.height;
      assert.ok(inside, `${name} scrolls into view inside the bar at ${percent}%`);
    }
    await page.screenshot({ path: join(evidence, `bar-narrow-text-${percent}.png`) });
    await bar.getByRole("button", { name: "Allow none", exact: true }).click();
    assert.equal(await bar.isVisible(), false);
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    // Another tab completes both choices while this tab shows the bar.
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    const bar = page.getByRole("region", { name: "Privacy choices", exact: true });
    await bar.waitFor();
    const other = await ctx.newPage();
    await other.goto("https://news.example.org/article/");
    await other.getByRole("button", { name: "Allow all", exact: true }).click();
    await page.waitForFunction(() => window.gaCommands && window.wpCommands?.length === 2);
    await bar.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.documentElement.style.paddingBottom), "", "A hidden bar reserves no space");
    assert.equal(vendors.length, 6);
    await ctx.close();
  }
  {
    // Allow none saves the analytics withdrawal, the browser refuses the newsletter write, and the reload keeps the error.
    const { ctx, page, vendors } = await context({ analytics: "v1:granted", blockedWrite: "spotlight-newsletter-consent" });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.gaCommands);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Allow none", exact: true }).click()]);
    await page.getByRole("status").filter({ hasText: "We could not save your choice. These tools remain off." }).waitFor();
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), true, "The panel shows the error after the reload");
    assert.equal(vendors.length, 1, "The withdrawn tag does not load again");
    const cookies = Object.fromEntries((await ctx.cookies()).map(cookie => [cookie.name, cookie.value]));
    assert.deepEqual([cookies["spotlight-analytics-consent"], cookies["spotlight-newsletter-consent"]], ["v1%3Adenied", undefined]);
    await page.reload();
    assert.equal(await page.getByRole("status").filter({ hasText: "We could not save your choice." }).count(), 0, "The notice shows once");
    await ctx.close();
  }
  for (const percent of [200, 400]) {
    const { ctx, page, vendors } = await context();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("https://news.example.org/article/");
    await page.evaluate(percent => { document.documentElement.style.fontSize = `${percent}%`; }, percent);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const name of ["Allow all", "Allow none", "Choices"]) assert.equal(await page.getByRole("button", { name, exact: true }).isVisible(), true);
    await page.screenshot({ path: join(evidence, `bar-text-${percent}.png`) });
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    for (const name of ["Do not allow analytics", "Allow analytics", "Do not allow newsletter tools", "Allow newsletter tools"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      assert.equal(await button.isVisible(), true);
    }
    await page.screenshot({ path: join(evidence, `text-${percent}.png`), fullPage: true });
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied" });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    assert.equal(vendors.length, 2);
    assert.deepEqual(await page.evaluate(() => window.acCommands), [["setAccount", "123456"], ["setTrackByDefault", false], ["process", "allowTracking"]]);
    assert.deepEqual(await page.evaluate(() => window.wpCommands), [["options", { defaultConsent: "denied" }], ["consent", "granted"]]);
    await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    assert.equal(vendors.length, 2, "Repeated grant does not duplicate loaders");
    await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Do not allow newsletter tools", exact: true }).click()]);
    assert.equal(vendors.length, 2, "Revocation reload does not load vendors again");
    assert.match((await ctx.cookies()).find(cookie => cookie.name === "spotlight-newsletter-consent").value, /denied/);
    await ctx.close();
  }

  for (const name of ["video", "noindex"]) {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied", saved: "v1:granted" });
    await page.goto(`https://news.example.org/${name}/`);
    assert.equal(await page.locator("#spotlight-newsletter-choice").count(), 0);
    assert.equal(vendors.length, 0, "Saved consent cannot override page exclusions");
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ javaScriptEnabled: false });
    await page.goto("https://news.example.org/article/");
    assert.equal(await page.getByRole("button", { name: "Privacy settings", exact: true }).isVisible(), false);
    await page.getByRole("link", { name: "Privacy information", exact: true }).waitFor();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  for (const saved of ["v0:granted", "%bad"]) {
    const { ctx, page, vendors } = await context({ saved });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Allow all", exact: true }).waitFor();
    assert.equal(vendors.length, 0, "Obsolete or malformed saved choices do not allow tracking");
    await ctx.close();
  }
  for (const saved of ["", "v1:granted"]) {
    const { ctx, page, vendors } = await context({ gpc: true, saved });
    await page.goto("https://news.example.org/article/");
    assert.equal(vendors.length, 0);
    await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
    await page.getByText("Your browser sent a Global Privacy Control signal.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied", saved: "v1:granted", blockedWrites: true });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
    await page.getByRole("button", { name: "Do not allow newsletter tools", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Your earlier permission is still active." }).waitFor();
    assert.equal(vendors.length, 2, "Failed withdrawal must not reload and repeat tracking under the old grant");
    assert.match((await ctx.cookies()).find(cookie => cookie.name === "spotlight-newsletter-consent").value, /granted/);
    await ctx.close();
  }
  for (const blockedSession of [false, true]) {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied", saved: "v1:granted", blockedSession });
    await page.goto("https://news.example.org/article/#comments");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    await Promise.all([page.waitForEvent("load"), page.evaluate(() => document.body.append(document.createElement("video")))]);
    assert.equal(vendors.length, 2, "A media-exclusion reload must not record another tracked visit");
    if (!blockedSession) {
      await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
      await page.getByText("Analytics and newsletter tools stay off on this page because it can display video.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).isVisible(), false);
    } else {
      assert.equal(new URL(page.url()).hash, "#comments");
      assert.equal(new URL(page.url()).searchParams.get("spotlight_newsletter_media"), "off");
      await page.evaluate(() => { location.hash = "article-link"; });
      await page.reload();
      assert.equal(vendors.length, 2, "An in-page anchor cannot erase the media exclusion");
    }
    await page.evaluate(() => document.body.append(document.createElement("video")));
    await page.locator("video").waitFor({ state: "attached" });
    assert.equal(vendors.length, 2, "Reopening a player cannot restart tracking or a reload loop");
    await ctx.close();
  }
  for (const options of [{}, { saved: "v1:denied" }, { blockedCookies: true }, { gpc: true }]) {
    const { ctx, page, vendors } = await context({ ...options, blockedSession: true });
    await page.goto("https://news.example.org/article/");
    let loads = 0;
    page.on("load", () => { loads += 1; });
    if (!options.gpc) {
      // The open first-visit panel covers the footer button; a keyboard user reaches it.
      await page.getByRole("button", { name: "Privacy settings", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).focus();
    }
    await page.evaluate(() => document.body.append(document.createElement("video")));
    await page.locator("video").waitFor({ state: "attached" });
    assert.equal(loads, 0, "A reader who never loaded newsletter tools keeps the video document");
    assert.equal(vendors.length, 0);
    if (!options.gpc) assert.equal(await page.getByRole("button", { name: "Close", exact: true }).evaluate(node => node === document.activeElement), true);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied", saved: "v1:granted", existingGlobal: true });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("status").filter({ hasText: "Newsletter tools are unavailable." }).waitFor();
    await page.locator("#article-link").focus();
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "An existing vendor notice is shown only once per document");
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ blockedCookies: true });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "We could not save your choice." }).waitFor();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied", saved: "v1:granted" });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    const other = await ctx.newPage();
    await other.goto("https://news.example.org/article/");
    await other.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    assert.equal(vendors.length, 4);
    await page.getByRole("button", { name: "Privacy settings", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), other.waitForEvent("load"), page.getByRole("button", { name: "Do not allow newsletter tools", exact: true }).click()]);
    assert.equal(vendors.length, 4, "Both open tabs stop after withdrawal");
    await ctx.close();
  }
  const google = vendors => vendors.filter(href => /google/.test(new URL(href).hostname));
  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
    await page.waitForFunction(() => window.gaCommands);
    assert.deepEqual(vendors, ["https://www.googletagmanager.com/gtag/js?id=G-TEST123456"], "Analytics grant loads only the Google tag");
    const commands = await page.evaluate(() => window.gaCommands.map(args => args[0] === "js" ? ["js"] : args));
    assert.deepEqual(commands, [
      ["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
      ["consent", "update", { analytics_storage: "granted" }],
      ["js"],
      ["config", "G-TEST123456", { allow_google_signals: false, allow_ad_personalization_signals: false, send_page_view: true }],
    ], "Consent defaults precede one page view");
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), true, "The newsletter choice stays open");
    await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
    assert.equal(vendors.length, 1, "Repeated grant does not load the tag again");
    await page.reload();
    await page.waitForFunction(() => window.gaCommands);
    assert.equal(vendors.length, 2, "One tag load per document");
    assert.equal((await page.evaluate(() => window.gaCommands)).filter(args => args[0] === "config").length, 1);
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Do not allow analytics", exact: true }).click()]);
    assert.equal(vendors.length, 2, "Withdrawal reloads without the tag");
    assert.equal(await page.evaluate(() => window.gtag), undefined);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:denied" });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Choices", exact: true }).click();
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    await page.waitForFunction(() => window.wpCommands?.length === 2);
    assert.equal(google(vendors).length, 0, "A newsletter grant never loads analytics");
    await page.reload();
    assert.equal(google(vendors).length, 0, "A saved analytics denial stays off");
    await ctx.close();
  }
  for (const options of [{ analytics: "v1:granted", gpc: true }, { analytics: "v0:granted" }, { analytics: "%bad" }]) {
    const { ctx, page, vendors } = await context(options);
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Privacy settings", exact: true }).waitFor();
    assert.equal(vendors.length, 0, "GPC and unknown analytics records never load the tag");
    await ctx.close();
  }
  for (const name of ["video", "noindex"]) {
    const { ctx, page, vendors } = await context({ analytics: "v1:granted" });
    await page.goto(`https://news.example.org/${name}/`);
    assert.equal(vendors.length, 0, "Saved analytics consent cannot override page exclusions");
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ analytics: "v1:granted", blockedSession: true });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.gaCommands);
    await Promise.all([page.waitForEvent("load"), page.evaluate(() => document.body.append(document.createElement("video")))]);
    assert.equal(vendors.length, 1, "A player that appears later stops analytics without another page view");
    assert.equal(new URL(page.url()).searchParams.get("spotlight_newsletter_media"), "off");
    await ctx.close();
  }
  console.log("Spotlight privacy browser contracts passed");
} finally {
  await browser.close();
}
