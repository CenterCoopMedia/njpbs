import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const origin = process.env.LEAD_MEDIA_URL ?? "http://127.0.0.1:4338";
const root = process.env.LEAD_MEDIA_FILES;
const output = process.env.LEAD_MEDIA_EVIDENCE;
if (!root || !output) throw new Error("Set LEAD_MEDIA_FILES and LEAD_MEDIA_EVIDENCE");
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const layouts = ["standard", "special-report", "multimedia", "interactive"];
const kinds = ["image", "library-video", "linked-video", "embed"];
const results = [];
const providerResults = [];
const images = new Map();
const imageComparisons = [];
const phoneGutters = [];
const require = createRequire(import.meta.url);
const { PNG } = require(join(dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"));
await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce", deviceScaleFactor: 1 });
  const page = await context.newPage();
  async function assertPhoneGutters(label) {
    const bounds = await page.locator(".multimedia-feature__lead-media").evaluate(lead => {
      const introduction = document.querySelector(".multimedia-feature__introduction");
      const inset = introduction.getBoundingClientRect().left + parseFloat(getComputedStyle(introduction).paddingLeft);
      const annotations = [...lead.querySelectorAll(".post-lead-player__caption, .cms-video__caption, .embed__heading")].map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) };
      });
      return { inset, annotations };
    });
    assert.ok(bounds.annotations.length > 0, `${label}: a lead annotation is present`);
    for (const annotation of bounds.annotations) {
      assert.ok(annotation.left >= bounds.inset - 1, `${label}: annotation has the page's left gutter`);
      assert.ok(annotation.right <= 390 - bounds.inset + 1, `${label}: annotation has the page's right gutter`);
    }
    phoneGutters.push({ label, ...bounds });
  }
  page.setDefaultTimeout(10000);
  let phase = "after";
  const errors = [];
  let providerRequests = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.resourceType() === "document" && /youtube|tiktok|instagram|facebook/.test(new URL(request.url()).hostname)) providerRequests++; });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      const file = join(root, url.pathname === "/" ? "index.html" : url.pathname);
      const mime = { ".html": "text/html", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2" }[extname(file)] ?? "application/octet-stream";
      try { return await route.fulfill({ body: await readFile(file), contentType: mime }); }
      catch { return route.fulfill({ status: 404, body: "Fixture file not found" }); }
    }
    if (url.pathname.startsWith("/posts/_shadow-assets/_astro/")) {
      const file = join(root, phase, "client/_astro", url.pathname.split("/_astro/")[1]);
      return route.fulfill({ body: await readFile(file), contentType: extname(file) === ".css" ? "text/css" : "text/javascript" });
    }
    if (route.request().resourceType() === "document") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture player</title><button>Play fixture video</button>" });
    if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/webp", body: await readFile(join(root, "poster.webp")) });
    return route.abort();
  });
  for (const width of [390, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const layout of (process.argv.includes("--providers-only") ? [] : layouts)) for (const kind of kinds) for (phase of ["before", "after"]) {
      await page.goto(origin);
      const previousRequests = providerRequests;
      await page.getByRole("link", { name: `${phase} ${layout} ${kind}`, exact: true }).click();
      await page.getByRole("heading", { name: "Coastal voices: a New Jersey story", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.locator("article").waitFor();
      await page.evaluate(async () => {
        for (const image of document.images) image.loading = "eager";
        await Promise.all([...document.images].map(image => image.decode()));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${phase} ${layout} ${kind} ${width}: overflow`);
      assert.equal(providerRequests, previousRequests, "Provider iframe must stay unloaded before Play");
      if (kind === "image") {
        const pixels = PNG.sync.read(await page.screenshot({ fullPage: true, animations: "disabled" }));
        const key = `${layout}-${width}`;
        if (phase === "before") images.set(key, pixels);
        else {
          const before = images.get(key);
          assert.equal(pixels.width, before.width);
          assert.equal(pixels.height, before.height);
          let changed = 0;
          for (let i = 0; i < pixels.data.length; i += 4) if (!pixels.data.subarray(i, i + 4).equals(before.data.subarray(i, i + 4))) changed++;
          imageComparisons.push({ layout, width, changedPixels: changed, totalPixels: pixels.width * pixels.height });
          assert.ok(changed / (pixels.width * pixels.height) < 0.001, `${key}: legacy image changed beyond raster edge noise`);
        }
      }
      await page.screenshot({ path: join(output, `${phase}-${layout}-${kind}-${width}.jpg`), fullPage: true, type: "jpeg", quality: 80, animations: "disabled" });
      if (phase === "after" && kind === "embed") {
        await page.getByRole("button", { name: "Play Coastal voices", exact: true }).click();
        await page.locator("[data-post-lead-player] iframe").waitFor();
        const attrs = await page.locator("[data-post-lead-player] iframe").evaluate(frame => ({
          title: frame.title, src: frame.src, focused: document.activeElement === frame,
        }));
        assert.ok(attrs.title.includes("Coastal voices"));
        assert.ok(!/[?&]autoplay=1/.test(attrs.src));
        assert.equal(attrs.focused, true, "Play activation moves focus to the named player");
      }
      if (phase === "after" && kind === "library-video") {
        assert.equal(await page.locator("[data-post-lead-player] video").getAttribute("preload"), "none");
        assert.equal(await page.locator("[data-post-lead-player] video").getAttribute("autoplay"), null);
      }
      if (phase === "after" && layout === "multimedia" && kind !== "image" && width === 390) await assertPhoneGutters(kind);
      results.push({ phase, layout, kind, width, overflow: false });
    }
    for (const provider of ["tiktok", "instagram", "facebook", "pasted", "long"]) {
      phase = "after";
      await page.goto(origin);
      await page.getByRole("link", { name: `provider ${provider}`, exact: true }).click();
      await page.getByRole("button", { name: provider === "long" ? `Play ${"W".repeat(190)}` : "Play Coastal voices", exact: true }).click();
      const frame = page.locator("[data-post-lead-player] iframe");
      await frame.waitFor();
      const box = await frame.boundingBox();
      assert.ok(box && box.width <= width, `${provider} frame fits viewport`);
      if (!["pasted", "long"].includes(provider)) assert.ok(box.width <= 361, `${provider} preserves vertical player width limit`);
      assert.ok(!/[?&]autoplay=1/.test(await frame.getAttribute("src")));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${provider} annotations fit viewport`);
      if (width === 390) await assertPhoneGutters(provider);
      await page.screenshot({ path: join(output, `after-provider-${provider}-${width}.jpg`), fullPage: true, type: "jpeg", quality: 80, animations: "disabled" });
      providerResults.push({ provider, width, frameWidth: box.width, frameHeight: box.height, overflow: false, autoplay: false });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "browser-results.json"), JSON.stringify({ browserVersion: browser.version(), checks: results.length, results, providerChecks: providerResults.length, providerResults, imageComparisons, phoneGutters, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, providerChecks: providerResults.length, errors, output, browserVersion: browser.version() }));
} finally { await browser.close(); }
