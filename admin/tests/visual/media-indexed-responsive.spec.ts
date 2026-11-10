import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [390, 1280]) {
  test(`indexed library keeps continuation, unknown counts and search reset usable at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "media-indexed-library", title: "Indexed media", width, presentation: "text" }, { readyRegion: "Images", normalizeGeneratedIds: false });
    await expect(page.getByText("2 results on this page")).toBeVisible();
    const pager = page.getByRole("navigation", { name: "Media pages" });
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("Station image 3", { exact: true }).first()).toBeVisible();
    await expect(pager.getByRole("button", { name: "Next page" })).toBeDisabled();
    await pager.getByRole("button", { name: "First page" }).click();
    await expect(page.getByText("2 results on this page")).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search media" });
    await search.fill("empty");
    await search.press("Enter");
    await expect(page.getByText("Search continues", { exact: true })).toBeVisible();
    await expect(pager.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("0 keyword results", { exact: true })).toBeVisible();
    await expect(pager.getByRole("button", { name: "Next page" })).toBeDisabled();
    await search.fill("tail");
    await search.press("Enter");
    await expect(page.getByText("2 keyword results on this page")).toBeVisible();
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("No matches on this page", { exact: true })).toBeVisible();
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`library-cursor-${width}.png`), fullPage: true });
  });

  test(`indexed picker preserves cursor controls and empty continuation at ${width}px`, async ({ page }) => {
    const chooseImage = page.getByRole("button", { name: "Choose image", exact: true });
    await openSpecimen(page, { id: "media-indexed-picker", title: "Indexed picker", width, presentation: "text" }, { normalizeGeneratedIds: false, readyLocator: chooseImage });
    await chooseImage.click();
    const dialog = page.getByRole("dialog", { name: "Choose an image" });
    const pager = dialog.getByRole("navigation", { name: "Image pages" });
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(dialog.getByText("Station image 3", { exact: true }).first()).toBeVisible();
    await pager.getByRole("button", { name: "First page" }).click();
    const search = dialog.getByRole("searchbox");
    await search.fill("empty");
    await search.press("Enter");
    await expect(dialog.getByText(/Search continues/)).toBeVisible();
    await expect(pager.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`picker-cursor-${width}.png`), fullPage: true });
  });
}
