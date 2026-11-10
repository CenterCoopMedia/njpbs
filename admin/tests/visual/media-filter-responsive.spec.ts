import { expect, test, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

// Geometry checks for the images page's chip row, Filter popover and phone grid, on the
// uncaptured media-filtered specimen (/media?kind=image&category=news). They assert layout,
// not pixels: the composed toolbar pixels are captured by the media-filter-popover baselines.

const FILTERED = { id: "media-filtered", title: "Media library — filtered with chips" } as const;

async function openFiltered(page: Page, width: number) {
  await openSpecimen(page, { ...FILTERED, width, presentation: "text" }, { readyRegion: "Images" });
  await page.locator(".media-result-bar [role=status]").waitFor({ state: "visible" });
}

async function pageOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// Filter sits in the toolbar's leading zone at desktop widths and in the Filter and sort row
// under 48rem, where the popover becomes a bottom sheet.
async function openCategoryPicker(page: Page, width: number) {
  const scope = width < 768
    ? page.getByRole("group", { name: "Filter and sort" })
    : page.getByRole("toolbar", { name: "Library controls" });
  await scope.getByRole("button", { name: /^Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Category" }).click();
  await dialog.getByRole("group", { name: "Category" }).waitFor({ state: "visible" });
  return dialog;
}

for (const width of [320, 1280]) {
  test(`filter chips stay on one line and never widen the page at ${width}px`, async ({ page }) => {
    await openFiltered(page, width);
    const row = page.getByRole("group", { name: "Applied filters" });
    await expect(row).toBeVisible();
    const tops = await row.locator(".ui-chip").evaluateAll((chips) => chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
    expect(tops.length).toBe(2);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    expect(await pageOverflow(page)).toBe(0);
  });
}

for (const width of [390, 1280]) {
  test(`Category options keep names clear of counts at ${width}px`, async ({ page }) => {
    await openFiltered(page, width);
    const dialog = await openCategoryPicker(page, width);
    const option = dialog.locator(".media-filter-option").first();
    await option.locator(".ui-checkbox-label").evaluate((element) => {
      element.textContent = "Entertainment";
    });
    const geometry = await option.evaluate((element) => {
      const name = element.querySelector(".ui-checkbox-label");
      const count = element.querySelector(".media-filter-count");
      if (!name || !count) throw new Error("Missing media category option geometry");
      const range = document.createRange();
      range.selectNodeContents(name);
      const countBox = count.getBoundingClientRect();
      const lines = [...range.getClientRects()];
      return {
        lineCount: new Set(lines.map((line) => Math.round(line.top))).size,
        overlapsCount: lines.some((line) =>
          line.left < countBox.right && line.right > countBox.left && line.top < countBox.bottom && line.bottom > countBox.top),
      };
    });
    expect(geometry.lineCount).toBe(1);
    expect(geometry.overlapsCount).toBe(false);
    expect(await pageOverflow(page)).toBe(0);
  });
}

test("thumbnail sizes set the phone column count without page overflow at 390px", async ({ page }) => {
  await openFiltered(page, 390);
  await page.getByRole("toolbar", { name: "Library controls" }).getByRole("button", { name: "Display" }).click();
  const display = page.getByRole("dialog", { name: "Display" });
  await display.waitFor({ state: "visible" });
  // The shared tile grid; its rows are display: contents, so the grid's own tracks are the columns.
  const columns = () => page.getByRole("grid", { name: "Images" }).evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  for (const [size, expected] of [["Small", 3], ["Large", 1], ["Medium", 2]] as const) {
    await display.getByRole("radio", { name: size }).click();
    await expect.poll(columns).toBe(expected);
    expect(await pageOverflow(page)).toBe(0);
  }
});

test("list actions stay inside each row with Category shown across container widths", async ({ page }) => {
  await openFiltered(page, 1280);
  await page.getByRole("toolbar", { name: "Library controls" }).getByRole("button", { name: "Display" }).click();
  const display = page.getByRole("dialog", { name: "Display" });
  await display.getByRole("radio", { name: "List" }).click();
  await display.getByRole("checkbox", { name: "Category" }).check();
  await page.keyboard.press("Escape");

  const row = page.getByRole("grid", { name: "Images" }).locator(".media-row:not(.media-row-header)").first();
  await expect(row).toBeVisible();
  for (const width of [1280, 1160, 1150, 1120, 1000, 730, 720, 680, 640, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await row.evaluate((element) => {
      const track = element.querySelector<HTMLElement>(".media-row-track");
      const actions = element.querySelector<HTMLElement>(".media-row-actions");
      if (!track || !actions) throw new Error("Missing list row geometry");
      return {
        rowRight: element.getBoundingClientRect().right,
        actionsRight: actions.getBoundingClientRect().right,
        trackOverflow: track.scrollWidth - track.clientWidth,
      };
    });
    expect(geometry.actionsRight, `Actions at ${width}px`).toBeLessThanOrEqual(geometry.rowRight + 1);
    expect(geometry.trackOverflow, `Track overflow at ${width}px`).toBeLessThanOrEqual(1);
    expect(await pageOverflow(page)).toBe(0);
  }
});
