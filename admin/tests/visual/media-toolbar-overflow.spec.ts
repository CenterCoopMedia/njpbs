import { expect, test } from "./fixtures";

const libraries = [
  { id: "media-browsing", name: "Images" },
  { id: "media-favorites", name: "Favorites" },
  { id: "audio-library", name: "Audio" },
  { id: "media-collections-list", name: "Collections" },
];

for (const width of [320, 768]) {
  for (const library of libraries) {
    test(`${library.name} toolbar stays inside its container at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/gallery.html?embed=${library.id}&presentation=text`);
      await expect(page.getByRole("toolbar", { name: "Library controls" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);

      if (width < 768) {
        const row = page.getByRole("group", { name: /^(Filter and sort|Filters)$/ });
        await expect(row).toBeVisible();
        // Padded pages can hide a shared row's negative margin from the document-level
        // check. The row must fit its own chrome as well as the viewport (#2667).
        expect(await row.evaluate(element => {
          const rowBox = element.getBoundingClientRect();
          const chromeBox = element.closest(".media-chrome")!.getBoundingClientRect();
          return rowBox.left >= chromeBox.left && rowBox.right <= chromeBox.right;
        })).toBe(true);
      }
    });
  }
}
