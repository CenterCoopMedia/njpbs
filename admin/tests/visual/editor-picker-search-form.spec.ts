import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [1280, 1920, 390]) {
  test(`Enter in the Post image search preserves the draft at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-mobile-draft", title: "Draft Post", width, presentation: "text" }, { normalizeGeneratedIds: false });
    const headline = page.getByRole("textbox", { name: "Headline", exact: true });
    await headline.fill("Retained search draft");
    await page.getByRole("button", { name: /^Edit image / }).click();
    await page.locator("#editor-details-selection-panel").getByRole("button", { name: "Change image", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
    const search = picker.getByRole("searchbox", { name: "Search images", exact: true });
    await search.fill("no-m26-search-match");
    await search.press("Enter");
    await expect(picker.getByText("No images found", { exact: true })).toBeVisible();
    await expect(page.getByText("Draft saved.", { exact: true })).toHaveCount(0);
    // Once results settle, Enter also exercises the unchanged-query path.
    await search.press("Enter");
    await expect(page.getByText("Draft saved.", { exact: true })).toHaveCount(0);
    await search.fill("");
    await picker.getByRole("button", { name: "Search", exact: true }).click();
    await expect(picker.getByRole("list", { name: "Available images", exact: true })).toBeVisible();
    await expect(page.getByText("Draft saved.", { exact: true })).toHaveCount(0);
    await picker.getByRole("button", { name: "Close", exact: true }).click();
    await expect(headline).toHaveValue("Retained search draft");
    if (width < 780) await page.getByRole("button", { name: "Close details", exact: true }).click();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.locator(".success-notice").getByText("Draft saved.", { exact: true })).toBeVisible();
  });
}
