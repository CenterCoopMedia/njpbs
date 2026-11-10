import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [1280, 390]) {
  test(`Station editor confirms an unpublished editorial Home draft at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "home-v2-conversion", title: "Editorial Home conversion", width, presentation: "text" }, { normalizeGeneratedIds: false });
    const action = page.getByRole("button", { name: "Use the editorial layout", exact: true });
    await expect(action).toBeEnabled();
    const bounds = await action.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    const evidence = process.env.HOME_V2_EVIDENCE;
    if (evidence) await page.screenshot({ path: `${evidence}/after-control-${width}.png`, fullPage: true });
    await action.press("Enter");
    const confirmation = page.getByRole("group", { name: "Use the editorial layout?", exact: true });
    await expect(confirmation).toContainText("The live homepage does not change until you press Publish.");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    if (evidence) {
      await page.screenshot({ path: `${evidence}/after-confirmation-${width}.png`, fullPage: true });
      await confirmation.screenshot({ path: `${evidence}/after-confirmation-detail-${width}.png` });
    }
    await confirmation.press("Escape");
    await expect(action).toBeFocused();
    await expect(confirmation).toHaveCount(0);
    await action.click();
    await page.getByRole("group", { name: "Use the editorial layout?", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(action).toBeFocused();
    await expect(confirmation).toHaveCount(0);
    await action.click();
    await page.getByRole("group", { name: "Use the editorial layout?", exact: true }).getByRole("button", { name: "Use the editorial layout", exact: true }).click();
    await expect(page.locator("[data-home-conversion-state]")).toHaveAttribute("data-home-conversion-state", "converted");
    await expect(action).toHaveCount(0);
    await expect.poll(() => page.locator("#page-block-editor-home").evaluate(element => element.contains(document.activeElement))).toBe(true);
    const saved = JSON.parse((await page.locator("[data-home-conversion-saved]").getAttribute("data-home-conversion-saved"))!);
    // Product order from the approved preset; these are the only fixture sources.
    expect(saved.blocks.map((block: { section: string }) => block.section)).toEqual([
      "home-start", "home-start-action", "home-spotlight", "home-featured", "home-more", "home-newsletter", "home-passport-copy", "home-passport-action",
    ]);
    await expect(page.locator('[data-home-section="home-newsletter"] .block-preview p').filter({ hasText: /^The standard newsletter band appears until a newsletter is chosen\.$/ })).toBeVisible();
    if (evidence) await page.locator('[data-home-section="home-newsletter"]').screenshot({ path: `${evidence}/after-empty-newsletter-${width}.png` });
    expect(saved.status).toBe("draft");
    expect(saved.publicSourceVersion).toBe(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (evidence) await page.screenshot({ path: `${evidence}/after-draft-${width}.png`, fullPage: true });
  });
}
