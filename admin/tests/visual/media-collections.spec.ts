import { expect, test, type Page } from "./fixtures";

async function openCollectionSpecimen(page: Page, id: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/gallery.html?embed=${id}&presentation=text`);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

for (const width of [1280, 390]) {
  test(`Collections list exposes Status and Scope at ${width}px`, async ({ page }) => {
    await openCollectionSpecimen(page, "media-collections-list", width);
    await expect(page.getByRole("heading", { level: 2, name: "Collections" })).toBeVisible();

    const filters = page.getByRole("group", { name: "Applied filters" });
    await expect(filters.getByRole("button", { name: "Edit filter Status: Archived" })).toBeVisible();
    await expect(filters.getByRole("button", { name: "Edit filter Scope: All staff" })).toBeVisible();
    await expect(filters).toContainText("on this page");
    await expect(page.getByRole("button", { name: /^Archived pledge drive/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Retired station IDs/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Old draft package/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Filter, 2 applied" }).click();
    const dialog = page.getByRole("dialog", { name: "Filter" });
    await expect(dialog.getByRole("button", { name: "Status" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Scope" })).toBeVisible();
    await dialog.getByRole("button", { name: "Status" }).click();
    await expect(dialog.getByRole("group", { name: "Status" })
      .getByRole("checkbox", { name: "Archived" })).toBeChecked();
    await dialog.getByRole("button", { name: "All filters" }).click();
    await dialog.getByRole("button", { name: "Scope" }).click();
    await expect(dialog.getByRole("group", { name: "Scope" })
      .getByRole("checkbox", { name: "All staff" })).toBeChecked();

    await expectNoPageOverflow(page);
  });

  test(`Collections detail keeps mixed controls and viewer bodies at ${width}px`, async ({ page }) => {
    await openCollectionSpecimen(page, "media-collections-detail", width);
    const grid = page.getByRole("grid", { name: "Collection media" });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole("button", { name: /^Statehouse newsroom still, image/ })).toBeVisible();
    await expect(grid.getByRole("button", { name: /^Archive interview excerpt, video/ })).toBeVisible();
    await expect(grid.getByRole("button", { name: /^Field production guide, PDF/ })).toBeVisible();
    await expect(grid.getByRole("button", { name: "Unavailable item", exact: true })).toBeVisible();

    await grid.getByRole("button", { name: "More actions: Statehouse newsroom still" }).click();
    const itemMenu = page.getByRole("menu", { name: "Statehouse newsroom still" });
    await expect(itemMenu.getByRole("menuitem", { name: "Remove from collection" })).toBeVisible();
    await expect(itemMenu.getByRole("menuitem", { name: "Add to collection" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await grid.getByRole("checkbox", { name: "Select Statehouse newsroom still" }).click();
    await grid.getByRole("checkbox", { name: "Select unavailable collection item" }).click();
    const selection = page.getByRole("group", { name: "Collection selection" });
    await expect(selection).toContainText("2 of 30 selected");
    await expect(selection.getByRole("button", { name: "Remove from collection" })).toBeVisible();
    await expect(selection.getByRole("button", { name: "Add to collection" })).toHaveCount(0);
    await selection.getByRole("button", { name: "Clear selection" }).click();
    await expect(selection).toHaveCount(0);

    await page.getByRole("toolbar", { name: "Library controls" })
      .getByRole("button", { name: "Display" }).click();
    const display = page.getByRole("dialog", { name: "Display" });
    await expect(display).toBeVisible();
    await display.getByRole("radio", { name: "List" }).click();
    await page.keyboard.press("Escape");
    await expect(grid).toHaveAttribute("data-layout", "list");
    const unavailableRow = grid.getByRole("row", { name: /Unavailable item/ });
    await expect(unavailableRow).toBeVisible();
    await expect(unavailableRow.getByRole("button", { name: "Unavailable item", exact: true })).toBeVisible();

    await grid.getByRole("button", { name: /^Statehouse newsroom still, image/ }).click();
    let viewer = page.getByRole("dialog", { name: "Statehouse newsroom still" });
    const nextFile = async (position: string) => {
      if (width === 390) {
        await viewer.getByRole("button", { name: "More preview actions", exact: true }).click();
        const menu = page.getByRole("menu", { name: "More preview actions" });
        await expect(menu).toContainText(`Current results · ${position}`);
        await expect(menu.getByRole("menuitem", { name: "Add to collection" })).toHaveCount(0);
        return menu.getByRole("menuitem", { name: /^Next file/ });
      }
      await expect(viewer.getByRole("group", { name: "Step through this page" })).toContainText(position);
      return viewer.getByRole("button", { name: "Next file" });
    };
    await expect(viewer.getByRole("region", { name: "Image viewer" })).toBeVisible();
    let next = await nextFile("1 of 3");
    await expect(viewer.getByRole("button", { name: "Add to collection" })).toHaveCount(0);

    await next.click();
    viewer = page.getByRole("dialog", { name: "Archive interview excerpt" });
    await expect(viewer.getByRole("region", { name: "Video viewer" })).toBeVisible();
    next = await nextFile("2 of 3");
    await expect(viewer.locator(".media-preview-header-facts")).toContainText("Archive");
    await expect(viewer.getByRole("toolbar", { name: "Preview actions" }).getByRole("button", { name: "Download", exact: true })).toBeVisible();

    await next.click();
    viewer = page.getByRole("dialog", { name: "Field production guide" });
    await expect(viewer.getByRole("region", { name: "Document viewer" })).toBeVisible();
    next = await nextFile("3 of 3");
    await expect(viewer).toContainText("A preview is not available for this PDF.");
    if (width === 390) {
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await expect(next).toContainText("Last file in these results.");
      await next.focus();
      await next.press("Enter");
      await expect(page.getByRole("menu", { name: "More preview actions" })).toBeVisible();
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(next).toBeDisabled();
    }

    await expectNoPageOverflow(page);
  });
}

test("Collections controls stay usable when the list scrolls on narrow and short screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 501 });
  await page.goto("/gallery.html?embed=media-collections-list&presentation=text");
  const filter = page.getByRole("button", { name: "Filter, 2 applied" });
  await expect(filter).toBeVisible();
  const beforeScroll = await filter.boundingBox();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // A shorter list can end before the filter leaves the viewport. At this
  // height it must move with the document rather than sticking over its rows.
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs(
    (await filter.boundingBox())!.y - (beforeScroll!.y - await page.evaluate(() => scrollY)),
  )).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: /^Retired station IDs/ })).toBeInViewport();

  await page.setViewportSize({ width: 640, height: 390 });
  const display = page.getByRole("button", { name: "Display", exact: true });
  await expect(display).toBeInViewport();
  await display.click();
  await expect(page.getByRole("dialog", { name: "Display" })).toBeVisible();
  await expectNoPageOverflow(page);
});
