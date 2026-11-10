import { expect, test } from "./fixtures";

const postIds = ["57298ff3b0d0917f9e653f80bada063d", "1208e81a5470be941e3fb392eac674ae"];
for (const width of [1280, 390]) {
  test(`Home keeps saved source IDs and current withdrawn gaps at ${width}px`, async ({ page }) => {
    page.setDefaultTimeout(10_000);
    // The fixture carries immutable dates and IDs. Keep the browser clock real
    // for native drag auto-scroll and actionability deadlines.
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
    await page.goto("/gallery.html?embed=home-v2-selections");
    await page.getByRole("button", { name: "Reopen saved Home", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const saved = async () => JSON.parse((await page.locator("[data-home-v2-saved]").getAttribute("data-home-v2-saved"))!) as { id: string; section: string; data: { selectedIds?: string[]; selectionReceipt?: { generation: number } } }[];
    const initialIds = (await saved()).map(block => block.id);
    const section = page.locator('[data-home-section="home-posts"]');
    await section.getByRole("button", { name: /^Edit / }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/1 selected card is withdrawn/)).toBeVisible();
    const selected = dialog.getByRole("list", { name: "Selected source cards" });
    const search = dialog.getByRole("textbox", { name: "Find published cards" });
    await selected.getByRole("button", { name: "Remove card 2", exact: true }).focus();
    await selected.getByRole("button", { name: "Remove card 2", exact: true }).press("Enter");
    await expect(search).toBeFocused();
    await dialog.getByRole("button", { name: "Add Corrected published headline", exact: true }).focus();
    await dialog.getByRole("button", { name: "Add Corrected published headline", exact: true }).press("Enter");
    await expect(search).toBeFocused();
    await expect(selected.locator("li")).toHaveCount(2);
    await selected.getByRole("button", { name: /^Move selected card:/ }).first().press("ArrowDown");
    await expect(selected.locator("li").first()).toContainText("Corrected published headline");
    await selected.getByRole("button", { name: "Move card 1 down", exact: true }).click();
    await expect(selected.locator("li").first()).toContainText(`Unavailable card: ${postIds[0]}`);
    if (width === 1280) {
      await test.step("Drag a selected card before its neighbor", async () => {
        await selected.scrollIntoViewIfNeeded();
        const grips = selected.getByRole("button", { name: /^Move selected card:/ });
        await grips.nth(1).dragTo(grips.first(), { timeout: 10_000 });
        await expect(selected.locator("li").first()).toContainText("Corrected published headline");
      });
      await test.step("Restore the saved order with pointer controls", async () => {
        await selected.getByRole("button", { name: "Move card 1 down", exact: true }).click();
        await expect(selected.locator("li").first()).toContainText(`Unavailable card: ${postIds[0]}`);
      });
    }
    if (width === 390) await dialog.getByRole("button", { name: "Expand component preview", exact: true }).click();
    const preview = dialog.locator("iframe.home-preview-frame");
    await expect(preview.contentFrame().locator('[data-home-card-id]')).toHaveCount(1);
    await expect(preview.contentFrame().getByText("Corrected published headline", { exact: true })).toBeVisible();
    await expect(preview.contentFrame().locator(`[data-home-card-id="${postIds[0]}"]`)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await expect.poll(async () => (await saved()).find(block => block.section === "home-posts")!.data.selectionReceipt?.generation).toBe(22);
    expect((await saved()).find(block => block.section === "home-posts")!.data.selectedIds).toEqual(postIds);
    expect((await saved()).map(block => block.id)).toEqual(initialIds);
    await page.getByRole("button", { name: "Reopen saved Home", exact: true }).click();
    await expect(page.locator("[data-home-v2-reopen]")).toHaveAttribute("data-home-v2-reopen", "1");
    await page.locator('[data-home-section="home-posts"]').getByRole("button", { name: /^Edit / }).click();
    await expect(page.getByRole("dialog").getByText(/1 selected card is withdrawn/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
