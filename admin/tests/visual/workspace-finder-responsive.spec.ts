import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const viewport of [{ width: 320, height: 260 }, { width: 1280, height: 900 }]) {
  test(`workspace search fits and returns focus at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openSpecimen(page, {
      id: "shell-home", title: "Newsroom home", width: viewport.width, presentation: "icons",
    });
    await page.setViewportSize(viewport);
    if (viewport.width < 620) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Find a workspace", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Find a workspace" });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    if (!bounds) throw new Error("The workspace finder is missing");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const search = dialog.getByRole("searchbox", { name: "Search workspaces" });
    await expect(search).toBeFocused();
    await search.fill("media");
    await expect(dialog.getByRole("link")).toHaveCount(1);
    await expect(dialog.getByRole("link", { name: "Media library" })).toHaveAttribute("href", "/media");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
