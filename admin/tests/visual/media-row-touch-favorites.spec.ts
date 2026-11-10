import { expect, test, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

async function openFavoriteRow(page: Page, width: number) {
  await openSpecimen(page, { id: "media-list-row", title: "Media rows", width, presentation: "icons" }, { normalizeGeneratedIds: false });
  const row = page.getByRole("grid", { name: "Images", exact: true })
    .locator(".media-row:not(.media-row-header)").first();
  await expect(row).toBeVisible();
  return {
    row,
    mark: row.getByRole("checkbox"),
    favorite: row.locator(".media-row-favorite"),
    more: row.getByRole("button", { name: "More actions: Statehouse dome at dusk, Trenton", exact: true }),
  };
}

// Refs #3594: touch access uses the existing More path, including wide lists.
test.describe("Favorite through More on touch screens", () => {
  test.use({ hasTouch: true });

  for (const width of [390, 1280]) {
    test(`native touch adds and removes a row Favorite at ${width}`, async ({ page }) => {
      const { row, mark, favorite, more } = await openFavoriteRow(page, width);
      await page.getByRole("heading", { name: "List rows", exact: true }).tap();
      const pointer = () => page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        anyCoarse: matchMedia("(any-pointer: coarse)").matches,
        noHover: matchMedia("(hover: none)").matches,
      }));
      await expect(pointer()).resolves.toEqual({ coarse: true, anyCoarse: true, noHover: true });
      await expect(favorite).toHaveAttribute("aria-pressed", "false");
      await expect(mark).not.toBeChecked();
      // The media guide keeps the full list action columns above 43rem.
      if (width > 390) expect((await row.boundingBox())!.width).toBeGreaterThan(43 * 16);
      await expect(more).toBeInViewport({ ratio: 1 });
      const target = (await more.boundingBox())!;
      expect(target.width).toBe(44);
      expect(target.height).toBe(44);

      await more.tap();
      await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).tap();
      await expect(favorite).toHaveAttribute("aria-pressed", "true");
      if (width === 390) {
        const marker = row.locator(".media-row-sub-favorite");
        await expect(marker).toHaveText("Favorite");
        const icon = marker.locator("svg");
        await expect(icon).toBeInViewport({ ratio: 1 });
        const box = (await icon.boundingBox())!;
        expect(box.width).toBeGreaterThan(1);
        expect(box.height).toBeGreaterThan(1);
      }
      await expect(mark).not.toBeChecked();
      await more.tap();
      await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).tap();
      await expect(favorite).toHaveAttribute("aria-pressed", "false");
      if (width === 390) await expect(row.locator(".media-row-sub-favorite")).toHaveCount(0);
      await expect(mark).not.toBeChecked();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(pointer()).resolves.toEqual({ coarse: true, anyCoarse: true, noHover: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
});

test("keyboard focus reveals the row heart and More restores focus", async ({ page }) => {
  const { mark, favorite, more } = await openFavoriteRow(page, 1280);
  await favorite.focus();
  await expect(favorite).toBeFocused();
  await expect(favorite).toHaveCSS("opacity", "1");
  await favorite.press("Space");
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  await more.focus();
  await more.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Open details", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Remove from favorites", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  await expect(more).toBeFocused();
  await expect(mark).not.toBeChecked();
});
