import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { chromium } from "playwright";

const before = process.env.LEAD_REVIEW_BEFORE_URL ?? "http://127.0.0.1:4339";
const after = process.env.LEAD_REVIEW_AFTER_URL ?? "http://127.0.0.1:4340";
const output = process.env.LEAD_REVIEW_EVIDENCE;
const image = process.env.LEAD_REVIEW_IMAGE;
const socketPath = process.env.LEAD_REVIEW_PROXY_SOCKET;
const picker = process.env.LEAD_REVIEW_PICKER === "1";

if (!output || !image || !socketPath) throw new Error("Set LEAD_REVIEW_EVIDENCE, LEAD_REVIEW_IMAGE and LEAD_REVIEW_PROXY_SOCKET");
const kinds = ["image", "library-video", "linked-video", "embed", "empty", "invalid"];
const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
const results = [], errors = [];
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce", deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  // Every request is fixture-owned. No live API, provider or video request leaves the browser.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/lead-review-index") return route.fulfill({ contentType: "text/html", body: '<title>Lead review evidence</title>' +
      ["before", "after"].flatMap(phase => kinds.flatMap(kind => [false, true].map(locked =>
        `<p><a href="${phase === "before" ? before : after}/lead-media.html?kind=${kind}&template=1${locked ? "&locked=1" : ""}">${phase} ${kind} ${locked ? "locked" : "editable"}</a></p>`))).join("") });
    if (url.pathname === "/guide/landscape.webp") return route.fulfill({ contentType: "image/jpeg", body: await readFile(image) });
    if (url.pathname.endsWith("cmsListSourceMedia")) return route.fulfill({ json: { success: true, records: [{ id: "lead-video", name: "The New Jersey boardwalk", rightsStatus: "complete", license: "owned" }] } });
    if (url.pathname.endsWith("cmsCreateSourceMediaRead")) {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, access: { assetId: body.assetId, action: body.action,
        url: `${after}/${body.action === "poster" ? "guide/landscape.webp" : "fixture-video.mp4"}`, mimeType: body.action === "poster" ? "image/jpeg" : "video/mp4" } } });
    }
    if (url.pathname === "/fixture-video.mp4") return route.fulfill({ status: 204, body: "" });
    if (![before, after].includes(url.origin)) return route.abort();
    const response = await new Promise((resolve, reject) => {
      const call = request({ socketPath, path: `/?url=${encodeURIComponent(url.href)}` }, incoming => {
        const chunks = []; incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode, contentType: incoming.headers["content-type"], body: Buffer.concat(chunks) }));
      }); call.on("error", reject); call.end();
    });
    return route.fulfill(response);
  });
  for (const width of [390, 1280, 1920]) for (const kind of kinds) for (const locked of [false, true]) for (const phase of ["before", "after"]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${after}/lead-review-index`);
    await page.getByRole("link", { name: `${phase} ${kind} ${locked ? "locked" : "editable"}`, exact: true }).click();
    await page.getByRole("textbox", { name: "Template name", exact: true }).waitFor();
    await page.getByText(phase === "before" && !picker ? "Lead image and background" : "Lead media and background", { exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => Promise.all([...document.images].map(image => image.decode())));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${phase}/${kind}/${width}: containment`);
    assert.equal(await page.getByRole("textbox", { name: "Hero background image", exact: true }).isDisabled(), locked);
    if (phase === "after" && (!picker || locked)) {
      const review = page.getByRole("group", { name: "Lead media review", exact: true });
      await review.waitFor();
      assert.equal(await review.evaluate(node => !!node.closest("[inert],fieldset[disabled]")), false);
      assert.equal(await page.getByRole("textbox", { name: "Hero image", exact: true }).count(), 0);
      if (kind === "linked-video" || kind === "embed") {
        const link = review.getByRole("link"); await link.focus();
        assert.ok(await link.evaluate(node => node === document.activeElement));
      }
      if (kind === "library-video") {
        const preview = review.getByRole("button", { name: "Preview video", exact: true });
        assert.equal(await preview.isEnabled(), true); await preview.focus();
        assert.ok(await preview.evaluate(node => node === document.activeElement));
      }
      assert.equal(await review.locator("iframe").count(), 0);
    }
    if (phase === "after" && picker && !locked) assert.equal(await page.getByRole("combobox", { name: "Lead media type", exact: true }).isEnabled(), true);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    if (!["empty", "invalid"].includes(kind) && locked === picker) await page.screenshot({ path: join(output, `${phase}-template-${picker ? "locked-" : ""}${kind}-${width}.jpg`), fullPage: true, type: "jpeg", quality: 80, animations: "disabled" });
    results.push({ phase, kind, width, locked, contained: true, inspectable: phase === "after" && (!picker || locked) });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "browser-results.json"), JSON.stringify({ browserVersion: browser.version(), checks: results.length, results, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, errors, browserVersion: browser.version() }));
} finally { await browser.close(); }
