import { expect, test } from "./fixtures";

for (const width of [1280, 390]) {
  test(`Favorites page controls make no media request at ${width}px`, async ({ page }) => {
    const calls: string[] = [];
    page.on("request", request => {
      if (/cms(ListMediaFavorites|ListMediaSources|CreateSourceMediaRead|SetMediaFavorites)/.test(request.url())) {
        calls.push(request.url());
      }
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=media-favorites-grid&presentation=text");
    const grid = page.getByRole("grid", { name: "Favorite media" });
    await expect(grid).toBeVisible();
    await page.getByRole("button", { name: "Filter" }).click();
    const filter = page.getByRole("dialog", { name: "Filter" });
    await filter.getByRole("button", { name: "Type" }).click();
    await filter.getByRole("checkbox", { name: "Videos" }).click();
    await expect(grid.getByRole("button", { name: /^Archive interview, video/ })).toBeVisible();
    await expect(grid.getByRole("button", { name: /^Station image, image/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit filter Type: Videos" })).toBeVisible();
    expect(calls).toEqual([]);
  });

  test(`Favorites mixed viewer keeps backend tools at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=media-favorites-grid&presentation=text");
    const grid = page.getByRole("grid", { name: "Favorite media" });
    await expect(grid).toBeVisible();
    await grid.getByRole("button", { name: /^Archive interview, video/ }).click();
    const dialog = page.getByRole("dialog", { name: "Archive interview" });
    await expect(dialog.getByRole("region", { name: "Video viewer" })).toBeVisible();
    const tools = dialog.getByRole("toolbar", { name: "Preview actions" });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });

  test(`Favorites Display and keyboard traversal work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=media-favorites-grid&presentation=text");
    const grid = page.getByRole("grid", { name: "Favorite media" });
    await expect(grid).toBeVisible();
    await page.getByRole("button", { name: "Display" }).click();
    const display = page.getByRole("dialog", { name: "Display" });
    await display.getByRole("radio", { name: "Small" }).click();
    await expect(page.locator(".favorite-media-library")).toHaveAttribute("data-thumbnail", "s");
    if (width === 390) {
      await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
    }
    await display.getByRole("radio", { name: "List" }).click();
    await page.keyboard.press("Escape");
    const videoRow = grid.getByRole("row", { name: /Archive interview/ });
    await expect(videoRow.locator('[data-column="size"]')).toHaveText("9.4 MB");
    const headings = await grid.locator('[role="columnheader"][data-column]').evaluateAll(elements => elements.map(element => element.getAttribute("data-column")));
    const videoColumns = await videoRow.locator('[role="gridcell"][data-column]').evaluateAll(elements => elements.map(element => element.getAttribute("data-column")));
    expect(videoColumns).toEqual(headings);
    const unavailable = grid.getByRole("row", { name: /Unavailable favorite/ });
    await expect(unavailable).toHaveAttribute("aria-selected", "false");
    await grid.getByRole("button", { name: /^Station image, image/ }).focus();
    await page.keyboard.press("Control+End");
    await expect(unavailable.getByRole("button", { name: "Unavailable favorite", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(unavailable).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: /Unavailable favorite/ })).toHaveCount(0);
    await grid.getByRole("button", { name: /^Station image, image/ }).focus();
    await page.keyboard.press("Control+y");
    await expect(page.getByRole("dialog", { name: "Quick Look: Station image" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "Quick Look: Brand guide" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "Quick Look: Archive interview" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(grid.getByRole("button", { name: /^Archive interview, video/ })).toBeFocused();
  });
}
