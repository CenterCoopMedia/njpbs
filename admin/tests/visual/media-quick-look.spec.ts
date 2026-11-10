import { expect, test } from "./fixtures";

for (const width of [1280, 320]) {
  test(`Quick Look steps and closes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/gallery.html?embed=media-quick-look");
    const look = page.getByRole("dialog", { name: "Quick Look: Statehouse dome at dusk" });
    await expect(look.getByRole("button", { name: "Close Quick Look" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const pdf = page.getByRole("dialog", { name: "Quick Look: NJ PBS brand guide" });
    await expect(pdf).toBeVisible();
    await pdf.getByRole("link", { name: "Open original" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: "Quick Look: Community forum: Housing and rent in Newark" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Quick Look" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(look).toBeVisible();
    await page.getByRole("button", { name: "Next item" }).click();
    await page.getByRole("button", { name: "Next item" }).click();
    await expect(page.getByRole("button", { name: "Next item" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Close Quick Look" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(look).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("status")).toHaveText("Quick Look closed.");
  });
}
