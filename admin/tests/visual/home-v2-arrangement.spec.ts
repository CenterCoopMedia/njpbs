import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

const original = ["home-start", "home-start-action", "home-featured", "home-passport-copy", "home-passport-action", "home-more", "home-spotlight"];
const moved = ["home-start", "home-start-action", "home-passport-copy", "home-passport-action", "home-featured", "home-more", "home-spotlight"];

for (const width of [1280, 390]) {
  test(`Home v2 retains a saved introduction above the newsletter boundary at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "home-v2-arrangement", title: "Home v2 arrangement", width, presentation: "text" }, { normalizeGeneratedIds: false });
    await expect(page.getByRole("region", { name: "Newsletter signup", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Text", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /^text \d+$/ });
    await editor.getByRole("textbox", { name: "Body", exact: true }).fill("Reviewed introduction above the newsletter.");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    const introduction = page.locator(".content-plank-placement").filter({ has: page.locator(".block-preview-content", { hasText: "Reviewed introduction above the newsletter." }) });
    await introduction.getByRole("button", { name: /^Move to…: text/ }).click();
    const move = page.getByRole("dialog", { name: "Move text", exact: true });
    await move.getByRole("combobox", { name: /^Position/ }).selectOption({ label: "Before newsletter signup" });
    await move.getByRole("button", { name: "Move content", exact: true }).click();
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await page.getByRole("button", { name: "Reopen saved Home", exact: true }).click();
    await expect(page.locator("[data-home-v2-reopen]")).toHaveAttribute("data-home-v2-reopen", "1");
    const saved = JSON.parse((await page.locator("[data-home-v2-saved]").getAttribute("data-home-v2-saved"))!) as { id: string; section?: string; type: string }[];
    expect(saved.map(block => block.section)).toEqual([undefined, ...original]);
    expect(saved[0].type).toBe("prose");
    await expect(page.locator(".block-preview-content", { hasText: "Reviewed introduction above the newsletter." })).toBeVisible();
  });

  test(`Home v2 arrangement saves and reopens the complete section at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "home-v2-arrangement", title: "Home v2 arrangement", width, presentation: "text" }, { normalizeGeneratedIds: false });
    const saved = async () => JSON.parse((await page.locator("[data-home-v2-saved]").getAttribute("data-home-v2-saved"))!) as { id: string; section: string; visible: boolean }[];
    const initialIds = (await saved()).map(block => block.id);
    const passport = page.locator('[data-home-section="home-passport-copy"]');
    await passport.getByRole("button", { name: /^Move:/ }).press("ArrowUp");
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await expect.poll(async () => (await saved()).map(block => block.section)).toEqual(moved);
    await page.getByRole("button", { name: "Reopen saved Home", exact: true }).click();
    await expect(page.locator("[data-home-v2-reopen]")).toHaveAttribute("data-home-v2-reopen", "1");
    expect(await page.locator("[data-home-section]").evaluateAll(elements => elements.map(element => element.getAttribute("data-home-section")))).toEqual(["home-start", "home-passport-copy", "home-featured", "home-more", "home-spotlight"]);

    // Native click starts with no selected content. Its focus must not move the
    // button before pointer-up, otherwise the first click misses the editor.
    await page.getByRole("button", { name: "Edit Passport", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Passport", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Remove section from page/ }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await page.getByRole("button", { name: "Reopen saved Home", exact: true }).click();
    await expect(page.locator("[data-home-v2-reopen]")).toHaveAttribute("data-home-v2-reopen", "2");
    expect((await saved()).filter(block => block.section.startsWith("home-passport")).map(block => block.visible)).toEqual([false, false]);
    expect((await saved()).map(block => block.id).sort()).toEqual([...initialIds].sort());
    await page.getByRole("button", { name: "Edit Passport", exact: true }).click();
    await dialog.getByRole("button", { name: /^Add section to page/ }).click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();

    if (width === 1280) {
      // Moving the following section to the Passport header chooses its upper boundary by
      // element reference and exercises native browser drag through both portals.
      const targetGrip = page.locator('[data-home-section="home-featured"]').getByRole("button", { name: /^Move:/ });
      // Bring both nearby grips into view before dragTo captures source coordinates.
      // Optional section controls can push the target below the viewport.
      await targetGrip.scrollIntoViewIfNeeded();
      await targetGrip.dragTo(passport.getByRole("button", { name: /^Move:/ }));
    } else {
      // The explicit placement controls remain usable when adjacent grips are
      // farther apart than a phone viewport.
      await passport.getByRole("button", { name: /^Move:/ }).press("ArrowDown");
    }
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await expect.poll(async () => (await saved()).map(block => block.section)).toEqual(original);
    expect((await saved()).filter(block => block.section.startsWith("home-passport")).map(block => block.visible)).toEqual([true, true]);
    expect((await saved()).map(block => block.id).sort()).toEqual([...initialIds].sort());
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
