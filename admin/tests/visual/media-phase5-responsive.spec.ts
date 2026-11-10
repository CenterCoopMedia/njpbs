import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

const surfaces = [
  { id: "media-toolbar", search: true, display: true },
  { id: "media-video-toolbar", search: true, display: true },
  { id: "media-favorites-toolbar", search: false, display: true },
  { id: "media-collections-list", search: false, display: true },
  { id: "media-voiceovers-toolbar", search: true, display: false },
] as const;

for (const presentation of ["icons", "text"] as const) {
  test(`shared overflow preserves a useful bare search field with ${presentation} controls`, async ({ page }) => {
    await openSpecimen(page, { id: "media-toolbar", title: "Toolbar", width: 320, presentation });
    const search = page.getByRole("searchbox", { name: "Search media", exact: true });
    const minimum = await page.evaluate(() => 7 * parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(minimum);
    await search.fill("station");
    await expect(search).toHaveValue("station");
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Display", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
}

for (const width of [1280, 320]) {
  test(`phase 5 media controls fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });

    for (const surface of surfaces) {
      await page.goto(`/gallery.html?embed=${surface.id}&presentation=text`);
      const toolbar = page.getByRole("toolbar");
      const filter = page.getByRole("button", { name: /^Filter/ });
      if (await filter.count()) await expect(filter).toBeVisible();
      else {
        await toolbar.getByRole("button", { name: "More actions" }).click();
        await expect(page.getByRole("menuitem", { name: "Filter" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      if (surface.display) {
        const display = toolbar.getByRole("button", { name: /Display/ });
        if (await display.count()) await expect(display).toBeVisible();
        else {
          await toolbar.getByRole("button", { name: "More actions" }).click();
          await expect(page.getByRole("menuitem", { name: /^Display/ })).toBeVisible();
          await page.keyboard.press("Escape");
        }
      } else await expect(toolbar.getByRole("button", { name: /Display/ })).toHaveCount(0);
      if (surface.search) await expect(toolbar.getByRole("searchbox")).toBeVisible();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ), surface.id).toBe(true);
    }

    await page.goto("/gallery.html?embed=media-paging-numbered&presentation=text");
    const pager = page.getByRole("navigation", { name: "Media pages" });
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeVisible();
    const next = pager.getByRole("button", { name: "Next page" });
    await expect(next).toBeVisible();
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(pager.getByRole("status")).toContainText("Page 3 of 4");
    await expect(next).toBeFocused();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    )).toBe(true);

    await page.goto("/gallery.html?embed=media-collections-detail&presentation=text");
    const lastItem = page.getByRole("grid", { name: "Collection media" })
      .getByRole("button", { name: "Unavailable item", exact: true });
    await lastItem.scrollIntoViewIfNeeded();
    await expect(lastItem).toBeInViewport();
  });
}
