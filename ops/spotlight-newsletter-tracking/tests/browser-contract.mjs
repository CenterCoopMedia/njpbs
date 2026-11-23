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
const fixtures = Object.fromEntries(["article", "video", "noindex", "baseline"].map(name => [name, render(name)]));
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const version = browser.version().split(".").map(Number);
assert.ok(version[0] > 156 || (version[0] === 156 && (version[2] > 8078 || (version[2] === 8078 && version[3] >= 73))), "Use system Chrome at or above the approved version");

async function context({ gpc = false, blockedCookies = false, blockedWrites = false, blockedSession = false, existingGlobal = false, saved = "", javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled });
  if (saved) await ctx.addCookies([{ name: "spotlight-newsletter-consent", value: saved, domain: "news.example.org", path: "/", secure: true }]);
  await ctx.addInitScript(({ gpc, blockedCookies, blockedWrites, blockedSession, existingGlobal }) => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: gpc });
    if (blockedCookies) Object.defineProperty(document, "cookie", { get() { throw new Error("Cookie storage blocked"); }, set() {} });
    else if (blockedWrites) {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
      Object.defineProperty(document, "cookie", { get() { return descriptor.get.call(document); }, set() {} });
    }
    if (blockedSession) Object.defineProperty(window, "sessionStorage", { get() { throw new Error("Session storage blocked"); } });
    if (existingGlobal) window.vgo = () => {};
  }, { gpc, blockedCookies, blockedWrites, blockedSession, existingGlobal });
  const vendors = [];
  await ctx.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "news.example.org") {
      vendors.push(url.href);
      const body = url.hostname === "diffuser-cdn.app-us1.com"
        ? 'window.acCommands=window.vgo.q.slice();window.vgo=(...args)=>window.acCommands.push(args);'
        : 'window.wpCommands=window.wisepops.q.slice();';
      return route.fulfill({ contentType: "application/javascript", body });
    }
    if (url.pathname.endsWith("consent.js") || url.pathname.endsWith("consent.css")) {
      const name = url.pathname.endsWith(".js") ? "consent.js" : "consent.css";
      return route.fulfill({ contentType: name.endsWith(".js") ? "application/javascript" : "text/css", body: readFileSync(join(directory, name), "utf8") });
    }
    const fixture = fixtures[url.pathname.split("/")[1]] ?? fixtures.article;
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
    const deny = page.getByRole("button", { name: "Do not allow", exact: true });
    const allow = page.getByRole("button", { name: "Allow newsletter tools", exact: true });
    await deny.waitFor({ state: "visible" });
    assert.equal(vendors.length, 0, "Unknown consent never requests vendors");
    for (const button of [deny, allow]) assert.ok((await button.boundingBox()).height >= 44);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `No horizontal overflow at ${width}`);
    await deny.focus();
    await page.keyboard.press("Tab");
    assert.equal(await allow.evaluate(node => node === document.activeElement), true);
    assert.notEqual(await allow.evaluate(node => getComputedStyle(node).outlineStyle), "none");
    await page.screenshot({ path: join(evidence, `consent-${width}.png`), fullPage: true });
    await deny.click();
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.reload();
    assert.equal(vendors.length, 0, "A saved denial stays off");
    await ctx.close();
  }

  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#article-link").evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "The panel cannot obscure ordinary page focus");
    const opener = page.getByRole("button", { name: "Newsletter privacy settings", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "Do not allow", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("#spotlight-newsletter-choice").isVisible(), false, "Footer settings focus stays unobscured");
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  for (const percent of [200, 400]) {
    const { ctx, page, vendors } = await context();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("https://news.example.org/article/");
    await page.evaluate(percent => { document.documentElement.style.fontSize = `${percent}%`; }, percent);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const name of ["Do not allow", "Allow newsletter tools"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      assert.equal(await button.isVisible(), true);
    }
    await page.screenshot({ path: join(evidence, `text-${percent}.png`), fullPage: true });
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context();
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    assert.equal(vendors.length, 2);
    assert.deepEqual(await page.evaluate(() => window.acCommands), [["setAccount", "123456"], ["setTrackByDefault", false], ["process", "allowTracking"]]);
    assert.deepEqual(await page.evaluate(() => window.wpCommands), [["options", { defaultConsent: "denied" }], ["consent", "granted"]]);
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    assert.equal(vendors.length, 2, "Repeated grant does not duplicate loaders");
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Do not allow", exact: true }).click()]);
    assert.equal(vendors.length, 2, "Revocation reload does not load vendors again");
    assert.match((await ctx.cookies()).find(cookie => cookie.name === "spotlight-newsletter-consent").value, /denied/);
    await ctx.close();
  }

  for (const name of ["video", "noindex"]) {
    const { ctx, page, vendors } = await context({ saved: "v1:granted" });
    await page.goto(`https://news.example.org/${name}/`);
    assert.equal(await page.locator("#spotlight-newsletter-choice").count(), 0);
    assert.equal(vendors.length, 0, "Saved consent cannot override page exclusions");
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ javaScriptEnabled: false });
    await page.goto("https://news.example.org/article/");
    assert.equal(await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).isVisible(), false);
    await page.getByRole("link", { name: "Newsletter privacy information", exact: true }).waitFor();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  for (const saved of ["v0:granted", "%bad"]) {
    const { ctx, page, vendors } = await context({ saved });
    await page.goto("https://news.example.org/article/");
    await page.getByRole("button", { name: "Do not allow", exact: true }).waitFor();
    assert.equal(vendors.length, 0, "Obsolete or malformed saved choices do not allow tracking");
    await ctx.close();
  }
  for (const saved of ["", "v1:granted"]) {
    const { ctx, page, vendors } = await context({ gpc: true, saved });
    await page.goto("https://news.example.org/article/");
    assert.equal(vendors.length, 0);
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await page.getByText("Your browser sent a Global Privacy Control signal.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ saved: "v1:granted", blockedWrites: true });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await page.getByRole("button", { name: "Do not allow", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Your earlier permission is still active." }).waitFor();
    assert.equal(vendors.length, 2, "Failed withdrawal must not reload and repeat tracking under the old grant");
    assert.match((await ctx.cookies()).find(cookie => cookie.name === "spotlight-newsletter-consent").value, /granted/);
    await ctx.close();
  }
  for (const blockedSession of [false, true]) {
    const { ctx, page, vendors } = await context({ saved: "v1:granted", blockedSession });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    await Promise.all([page.waitForEvent("load"), page.evaluate(() => document.body.append(document.createElement("video")))]);
    assert.equal(vendors.length, 2, "A media-exclusion reload must not record another tracked visit");
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await page.getByText("Newsletter tools stay off on this page because it can display video.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).isVisible(), false);
    await page.evaluate(() => document.body.append(document.createElement("video")));
    await page.locator("video").waitFor({ state: "attached" });
    assert.equal(vendors.length, 2, "Reopening a player cannot restart tracking or a reload loop");
    if (blockedSession) assert.match(page.url(), /#spotlight-newsletter-media-off$/);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ saved: "v1:granted", existingGlobal: true });
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
    await page.getByRole("button", { name: "Allow newsletter tools", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "We could not save your choice." }).waitFor();
    assert.equal(vendors.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, vendors } = await context({ saved: "v1:granted" });
    await page.goto("https://news.example.org/article/");
    await page.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    const other = await ctx.newPage();
    await other.goto("https://news.example.org/article/");
    await other.waitForFunction(() => window.acCommands?.some(args => args[0] === "process") && window.wpCommands?.length === 2);
    assert.equal(vendors.length, 4);
    await page.getByRole("button", { name: "Newsletter privacy settings", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), other.waitForEvent("load"), page.getByRole("button", { name: "Do not allow", exact: true }).click()]);
    assert.equal(vendors.length, 4, "Both open tabs stop after withdrawal");
    await ctx.close();
  }
  console.log("Spotlight newsletter browser contracts passed");
} finally {
  await browser.close();
}
