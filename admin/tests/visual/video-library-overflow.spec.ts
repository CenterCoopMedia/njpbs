import { expect, test, type Page } from "./fixtures";

const VIDEO_LIBRARY_RECORD = {
  id: "asset-1",
  sourceId: "video-library",
  name: "County interview",
  description: "Synthetic video fixture.",
  originalName: "county-interview.mp4",
  mimeType: "video/mp4",
  kind: "video",
  sizeBytes: 10_485_760,
  preview: "download_only",
  license: "NJ PBS owned",
  credit: "Sample newsroom",
  tags: ["County"],
  rightsStatus: "pending",
  version: 1,
  uploadedBy: { name: "Sample editor" },
  createdAt: "2026-09-15T12:00:00.000Z",
  updatedAt: "2026-09-15T12:00:00.000Z",
};

for (const width of [320]) {
  test(`portaled media controls retain narrow reflow at ${width}px with 200% text`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
      success: true, records: [VIDEO_LIBRARY_RECORD], nextCursor: null, hasMore: false, total: 1, posters: [],
    } }));
    await page.route("**/cmsListMediaFavorites", route => route.fulfill({ json: { success: true, states: [] } }));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/gallery.html?embed=shell-video-library&presentation=text");
    try {
      await page.getByRole("grid", { name: "Videos" }).waitFor({ state: "visible" });
    } finally {
      await testInfo.attach("page-errors", { body: JSON.stringify(pageErrors), contentType: "application/json" });
    }
    await page.addStyleTag({ content: "html { font-size:200%; }" });
    await page.evaluate(async () => { await document.fonts.ready; });
    const chrome = page.locator(".workspace-browse-main > .media-chrome");
    const trailing = chrome.locator(".ui-overflow-toolbar-trailing");
    await expect(trailing).toHaveCSS("flex-wrap", "wrap");
    const bounds = (await chrome.boundingBox())!;
    const targets = await chrome.locator(".media-library-toolbar button, .media-library-toolbar input").evaluateAll(elements => elements
      .map(element => ({ name: element.getAttribute("aria-label") ?? element.textContent, box: element.getBoundingClientRect().toJSON() }))
      .filter(({ box }) => box.width > 0 && box.height > 0));
    expect(targets.length).toBeGreaterThan(0);
    for (const { name, box } of targets) {
      expect(box.x, name ?? "Control").toBeGreaterThanOrEqual(bounds.x - 1);
      expect(box.x + box.width, name ?? "Control").toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    }
    // The secondary Filter/Sort strip deliberately scrolls horizontally. Its
    // native focus owner must reveal Sort without widening the document.
    const sort = chrome.getByRole("button", { name: "Sort: Recently updated, newest first", exact: true });
    await sort.focus();
    await expect(sort).toBeFocused();
    await expect.poll(() => sort.evaluate(element => {
      const strip = element.closest<HTMLElement>('.media-toolbar-secondary')!;
      const frame = strip.getBoundingClientRect(), box = element.getBoundingClientRect();
      const left = frame.left + strip.clientLeft;
      return Math.max(left - box.left, box.right - left - strip.clientWidth);
    })).toBeLessThanOrEqual(0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("video controls pin directly below the shared identity bar after scrolling", async ({ page }) => {
  await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
    success: true, records: Array.from({ length: 24 }, (_, index) => ({
      ...VIDEO_LIBRARY_RECORD, id: `video-${index + 1}`, name: `County interview ${index + 1}`,
    })), nextCursor: null, hasMore: false, total: 24, posters: [],
  } }));
  await page.route("**/cmsListMediaFavorites", route => route.fulfill({ json: { success: true, states: [] } }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/gallery.html?embed=shell-video-library&presentation=text");
  await page.getByRole("button", { name: /^County interview 12, video/ }).scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const header = await page.locator('.workspace-editor-document-bar').boundingBox();
    const chrome = await page.locator('.media-chrome').boundingBox();
    return Math.abs(chrome!.y - (header!.y + header!.height));
  }).toBeLessThanOrEqual(1);
});

for (const width of [320, 1280]) {
  test(`video library has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.route("**/cmsListSourceMedia", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        records: [VIDEO_LIBRARY_RECORD],
        nextCursor: null,
        hasMore: false,
        total: 1,
        posters: [],
      }),
    }));
    await page.route("**/cmsListMediaFavorites", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, states: [] }),
    }));

    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=video-library&presentation=text");
    await page.getByRole("grid", { name: "Videos" }).waitFor({ state: "visible" });

    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )).toBe(true);
  });
}

for (const width of [390, 1280]) {
  test(`video library starts a loaded page at its result summary at ${width}px`, async ({ page }) => {
    await page.route("**/cmsListSourceMedia", route => {
      const request = route.request().postDataJSON() as { cursor?: string };
      const secondPage = request.cursor === "page-2";
      const pageName = secondPage ? "Second page" : "First page";
      const records = Array.from({ length: 24 }, (_, index) => ({
        ...VIDEO_LIBRARY_RECORD,
        id: `${secondPage ? "second" : "first"}-${index + 1}`,
        name: `${pageName} video ${index + 1}`,
        originalName: `${secondPage ? "second" : "first"}-${index + 1}.mp4`,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          records,
          nextCursor: secondPage ? null : "page-2",
          hasMore: !secondPage,
          total: 48,
          posters: [],
        }),
      });
    });
    await page.route("**/cmsListMediaFavorites", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, states: [] }),
    }));

    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/gallery.html?embed=video-library&presentation=text");
    await page.getByRole("button", { name: /^First page video 1, video/ }).waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Next page" }).click();
    await page.getByRole("button", { name: /^Second page video 1, video/ }).waitFor({ state: "visible" });

    const summary = page.getByText("48 videos", { exact: true });
    await expect(summary).toBeFocused();
    await expect.poll(async () => {
      const summaryTop = await summary.evaluate(element => element.getBoundingClientRect().top);
      const toolbarBottom = await page.locator(".media-chrome").evaluate(element => element.getBoundingClientRect().bottom);
      const gap = Math.round(summaryTop - toolbarBottom);
      return { belowToolbar: gap >= 0, withinTopSpacing: gap <= 16 };
    }).toEqual({ belowToolbar: true, withinTopSpacing: true });
  });
}

// Refs #3593: both navigation modes retain Sort and document reflow.
async function expectSortRestored(page: Page) {
  await page.getByRole("button", { name: "Sort: Recently updated, newest first", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Sort", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sort", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const [width, height] of [[320, 844], [1280, 844], [390, 320]]) {
  test(`video controls remain usable with navigation at ${width}x${height}`, async ({ page }) => {
    await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
      success: true,
      records: Array.from({ length: 24 }, (_, index) => ({
        ...VIDEO_LIBRARY_RECORD,
        id: `video-${index + 1}`,
        name: `County interview ${index + 1}`,
      })),
      nextCursor: null, hasMore: false, total: 24, posters: [],
    } }));
    await page.route("**/cmsListMediaFavorites", route => route.fulfill({ json: {
      success: true, states: [],
    } }));
    await page.setViewportSize({ width, height });
    await page.goto("/gallery.html?embed=shell-video-library&presentation=text");
    await page.getByRole("checkbox", { name: "Select County interview 1", exact: true }).check();
    await page.getByRole("button", { name: /^County interview 12, video/ }).scrollIntoViewIfNeeded();

    const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
    const controls = page.locator(".media-chrome button, .media-chrome input, .media-selection-bar button");
    // The shared frame uses a persistent rail above 619px and a drawer on phones.
    if (width > 619) {
      await expect(navigation).toBeVisible();
      await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeHidden();
      const railRight = (await page.locator(".sidebar").boundingBox())!.x + (await page.locator(".sidebar").boundingBox())!.width;
      const visible = await controls.evaluateAll(elements => elements.map(element => element.getBoundingClientRect())
        .filter(rect => rect.width && rect.height && rect.y >= 0 && rect.y < innerHeight && rect.x < innerWidth)
        .map(rect => rect.x));
      expect(visible.length).toBeGreaterThan(0);
      for (const left of visible) expect(left).toBeGreaterThanOrEqual(railRight);
      await expectSortRestored(page);
      return;
    }
    const expectCoveredControls = async () => {
      const hits = await controls.evaluateAll(elements => {
        const sidebar = document.querySelector(".sidebar")!;
        const bounds = sidebar.getBoundingClientRect();
        return elements.flatMap(element => {
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          if (!rect.width || !rect.height || x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || y >= bounds.bottom) return [];
          const hit = document.elementFromPoint(x, y);
          return [sidebar.contains(hit) || Boolean(hit?.closest(".editor-nav-scrim"))];
        });
      });
      // Browser hit-testing proves covered controls cannot receive pointer/touch input.
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(Boolean)).toBe(true);
    };

    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("inert", "");
    await expectCoveredControls();
    await navigation.getByRole("link", { name: "Admin settings", exact: true }).scrollIntoViewIfNeeded();
    await expectCoveredControls();
    await page.getByRole("button", { name: "Close menu", exact: true }).click();
    await expect(page.locator(".workspace-shell")).not.toHaveAttribute("inert", "");
    if (height < 500) {
      const dock = (await page.locator(".media-selection-dock").boundingBox())!;
      const chrome = (await page.locator(".workspace-chrome").boundingBox())!;
      expect(dock.y).toBeGreaterThanOrEqual(chrome.y + chrome.height);
      // Native focus reveals every promoted action and the page checkbox inside
      // the bar's actual scrolling port, including its border and scrollbar.
      const bar = page.locator(".media-selection-bar");
      const targets = bar.locator(".media-selection-bar-action, input[type=checkbox]");
      expect(await targets.count()).toBeGreaterThan(2);
      for (const target of await targets.all()) {
        await expect(target).toBeEnabled();
        await target.focus();
        await expect(target).toBeFocused();
        await expect(target).toBeInViewport({ ratio: 1 });
        await expect.poll(() => target.evaluate(element => {
          const port = element.closest<HTMLElement>(".media-selection-bar")!;
          const frame = port.getBoundingClientRect(), box = element.getBoundingClientRect();
          const left = frame.left + port.clientLeft, top = frame.top + port.clientTop;
          return Math.max(left - box.left, box.right - left - port.clientWidth,
            top - box.top, box.bottom - top - port.clientHeight);
        })).toBeLessThanOrEqual(0.5);
      }
    }
    // Closing the rail restores the same toolbar; its sheet still opens normally.
    await expectSortRestored(page);
  });
}
