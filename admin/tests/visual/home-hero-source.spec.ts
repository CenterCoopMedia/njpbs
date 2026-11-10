import { expect, test } from "./fixtures";
for (const width of [1280, 390]) {
  test(`Home hero follows source only after per-field reset at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=home-hero-source");
    await page.getByRole("button", { name: "Edit Home hero", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Home hero", exact: true });
    const preview = dialog.getByRole("complementary", { name: "Hero preview" });
    await expect(preview.getByText("Home-only headline", { exact: true })).toBeVisible();
    await expect(preview.getByText("Local gallery fixture", { exact: true })).toBeVisible();
    await expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", "https://njpbs.org/support/");
    await expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("target", "_blank");
    await expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("rel", "noopener noreferrer");
    await dialog.getByRole("button", { name: "Use story’s current title", exact: true }).click();
    await dialog.getByRole("button", { name: "Use story’s current destination", exact: true }).click();
    await expect(preview.getByText("Explore the Garden State", { exact: true })).toBeVisible();
    await expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", "https://njpbs.org/posts/explore-the-garden-state/");
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("");
    await dialog.getByLabel("Title", { exact: true }).fill("New Home override");
    await expect(preview.getByText("New Home override", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Edit Home hero", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Title", { exact: true })).toHaveValue("New Home override");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
