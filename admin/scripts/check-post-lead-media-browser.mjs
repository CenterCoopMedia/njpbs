import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { request } from "node:http";

const before = process.env.LEAD_PICKER_BEFORE_URL ?? "http://127.0.0.1:4339";
const after = process.env.LEAD_PICKER_AFTER_URL ?? "http://127.0.0.1:4340";
const output = process.env.LEAD_PICKER_EVIDENCE;
const image = process.env.LEAD_PICKER_IMAGE;
const proxy = process.env.LEAD_PICKER_PROXY_SOCKET;
if (!output || !image) throw new Error("Set LEAD_PICKER_EVIDENCE and LEAD_PICKER_IMAGE");
const emptyOnly = process.env.LEAD_PICKER_EMPTY_ONLY === "1";
const kinds = emptyOnly ? ["empty"] : ["image", "library-video", "linked-video", "embed"];
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const results = [], geometry = [], errors = [];
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce", deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/lead-evidence-index", route => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><title>Lead picker evidence</title>' + ["before", "after"].flatMap(phase => kinds.map(kind =>
      `<p><a href="${phase === "before" ? before : after}/lead-media.html?kind=${kind}">${phase} ${kind}</a></p>`)).join("") }));
  await page.route("**/guide/landscape.webp", async route => route.fulfill({ contentType: "image/webp", body: await readFile(image) }));
  if (proxy) await page.route(url => [before, after].includes(url.origin) && url.pathname !== "/lead-evidence-index" && url.pathname !== "/guide/landscape.webp", async route => {
    const response = await new Promise((resolve, reject) => {
      const call = request({ socketPath: proxy, path: `/?url=${encodeURIComponent(route.request().url())}` }, incoming => {
        const chunks = []; incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode, contentType: incoming.headers["content-type"], body: Buffer.concat(chunks) }));
      });
      call.on("error", reject); call.end();
    });
    await route.fulfill(response);
  });
  for (const width of [390, 1280, 1920]) for (const kind of kinds) for (const phase of (emptyOnly ? ["after"] : ["before", "after"])) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${after}/lead-evidence-index`);
    await page.getByRole("link", { name: `${phase} ${kind}`, exact: true }).click();
    await page.getByRole("group", { name: "Hero image", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode())); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${phase}/${kind}/${width}: viewport containment`);
    if (phase === "after") {
      assert.equal(await page.getByLabel("Lead media type", { exact: true }).inputValue(), kind === "empty" ? "image" : kind);
      if (kind === "empty") {
        assert.equal(await page.getByRole("button", { name: "Choose lead image", exact: true }).count(), 1);
        assert.equal(await page.locator("html").getAttribute("data-lead-dirty"), "false", "offering an image does not dirty the empty lead");
      }
      if (kind === "library-video") {
        const action = page.getByRole("button", { name: "Choose a different video", exact: true });
        assert.equal(await action.isDisabled(), true);
        assert.ok(await page.getByText("Sign in to choose a library video.", { exact: true }).isVisible());
        assert.ok(await action.getAttribute("aria-describedby"));
        const panel = await page.getByRole("region", { name: "Video editor", exact: true }).evaluate(element => {
          const rect = element.getBoundingClientRect(), field = element.closest(".post-lead-media-editor"), style = getComputedStyle(field);
          const outer = field.getBoundingClientRect();
          return { background: getComputedStyle(element).backgroundColor, left: rect.left, right: rect.right,
            expectedLeft: outer.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
            expectedRight: outer.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) };
        });
        assert.equal(panel.background, "rgba(0, 0, 0, 0)", "library editor shares the lead fieldset surface");
        assert.ok(Math.abs(panel.left - panel.expectedLeft) < 2 && Math.abs(panel.right - panel.expectedRight) < 2, "library editor fills the fieldset content width");
        geometry.push({ kind, width, panel, disabledReasonVisible: true });
      }
      if (kind !== "image" && kind !== "empty") {
        const field = await page.getByRole("textbox", { name: "Video poster", exact: true }).evaluate(input => {
          const style = getComputedStyle(input), rect = input.getBoundingClientRect();
          const preview = input.closest(".asset-field").querySelector(".asset-field-preview").getBoundingClientRect();
          const canvas = document.createElement("canvas"), context = canvas.getContext("2d"); context.font = style.font;
          return { textWidth: context.measureText(input.value).width, available: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            top: rect.top, previewBottom: preview.bottom };
        });
        assert.ok(field.top >= field.previewBottom - 1, "poster field stacks below its thumbnail");
        assert.ok(field.textWidth <= field.available + 1, "poster selected-state text fits without clipping");
        geometry.push({ kind, width, poster: field });
      }
    }
    await page.screenshot({ path: join(output, `${phase}-picker-${kind}-${width}.jpg`), fullPage: true, type: "jpeg", quality: 80, animations: "disabled" });
    results.push({ phase, kind, width, overflow: false });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, emptyOnly ? "browser-empty-results.json" : "browser-results.json"), JSON.stringify({ browserVersion: browser.version(), checks: results.length, results, geometry, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, geometryChecks: geometry.length, errors, browserVersion: browser.version() }));
} finally { await browser.close(); }
