import { expect, test } from "./fixtures";

for (const width of [1280, 390]) {
  for (const kind of ["page", "post", "program", "event"]) {
    test(`one ${kind} Preview opens automatically at ${width}px`, async ({ page, context }) => {
      await context.route("https://preview.njpbs.org/p/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Exact private preview</h1>" }));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/gallery.html?embed=single-preview-workspace&presentation=text&previewKind=${kind}&waitStatus=1`);
      const button = page.getByRole("button", { name: "Preview", exact: true });
      await expect(button).toBeEnabled();
      await expect(page.getByRole("button", { name: /refresh preview/i })).toHaveCount(0);
      expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests)).toEqual([]);
      const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(36);
      const popupPromise = context.waitForEvent("page");
      await page.locator("body").ariaSnapshot();
      await (await button.elementHandle())!.click();
      const popup = await popupPromise;
      await popup.setViewportSize({ width, height: 900 });
      await expect(popup).toHaveTitle(/(?:Preparing preview|Your preview is queued|Building your preview|Requesting your preview) \| Boardwalk/);
      expect(await popup.evaluate(() => window.opener)).toBeNull();
      await expect.poll(() => page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.reads.length)).toBe(1);
      await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.releaseStatus());
      await expect(popup.getByRole("heading", { name: "Exact private preview" })).toBeVisible();
      expect(popup.url()).toContain(kind === "page" ? "/contact/" : `/${kind}s/preview-story/`);
      expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(0);
      expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests.length)).toBe(1);
      const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(geometry.scroll).toBe(geometry.width);
      await page.screenshot({ path: test.info().outputPath(`single-preview-${kind}-${width}.png`), fullPage: true });
    });
  }
  test(`dirty Post opens its tab before saving finishes at ${width}px`, async ({ page, context }) => {
    await context.route("https://preview.njpbs.org/p/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Exact private preview</h1>" }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=single-preview-workspace&presentation=text&waitSave=1");
    await page.getByRole("textbox", { name: "Headline", exact: true }).fill("Edited before Preview");
    const popupPromise = context.waitForEvent("page");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const popup = await popupPromise;
    await popup.setViewportSize({ width, height: 900 });
    await expect(popup).toHaveTitle("Preparing preview | Boardwalk");
    expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests.length)).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(1);
    await expect(popup.getByRole("heading", { name: "Preparing preview" })).toBeVisible();
    await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.releaseSave());
    await expect(popup.getByRole("heading", { name: "Exact private preview" })).toBeVisible();
    expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests[0].sourceVersion)).toBe(8);
    expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(1);
    await expect(page.getByRole("textbox", { name: "Headline", exact: true })).toHaveValue("Edited before Preview");
  });
  test(`Event keeps publishing and lifecycle actions in the shared menus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=single-preview-workspace&presentation=text&previewKind=event");
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
    await page.locator("body").ariaSnapshot();
    const publishing = await page.getByRole("button", { name: "Publishing", exact: true }).elementHandle();
    await publishing!.click();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Schedule publish", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for review", exact: true })).toBeVisible();
    await publishing!.click();
    await page.locator("body").ariaSnapshot();
    const actions = await page.getByRole("button", { name: "Event actions", exact: true }).elementHandle();
    await actions!.click();
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(0);
  });
}

test("closing the progress tab stops dispatch after a delayed save", async ({ page, context }) => {
  await page.goto("/gallery.html?embed=single-preview-workspace&presentation=text&waitSave=1");
  await page.getByRole("textbox", { name: "Headline", exact: true }).fill("Saved without a preview");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveTitle("Preparing preview | Boardwalk");
  await popup.close();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();
  await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.releaseSave());
  await expect.poll(() => page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(1);
  expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests)).toEqual([]);
});

test.afterEach(async ({ page, context }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page.evaluate(() => ({
    fixture: window.__CMS_PREVIEW_FIXTURE__, hidden: document.hidden,
    text: document.body.innerText,
  })).catch(() => ({ closed: true }));
  await info.attach("preview-handoff-state", { body: JSON.stringify(state, null, 2), contentType: "application/json" });
  console.log("Preview handoff diagnostic", JSON.stringify(state));
  for (const [index, tab] of context.pages().entries()) {
    if (!tab.isClosed()) await tab.screenshot({ path: info.outputPath(`failure-tab-${index}.png`) }).catch(() => {});
  }
});
