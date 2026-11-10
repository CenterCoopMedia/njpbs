import { expect, test, type Page } from "./fixtures";

// Menus and popovers stay `visibility: hidden` until they are positioned, then move focus in.
// Under reduced motion that focus must still land inside the surface; a transition on
// visibility once left it on the trigger, so arrow keys and Escape never reached the menu.
// jsdom computes no transitions, so this runs in the browser against the gallery specimens.

async function open(page: Page, embed: string, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/gallery.html?embed=${embed}`);
  await page.waitForLoadState("networkidle");
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test.describe(`with reduced motion ${reducedMotion}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
    });

    test("a More menu takes focus, answers the arrow keys and returns focus on Escape", async ({ page }) => {
      await open(page, "media-overlays");
      const trigger = page.getByRole("button", { name: "More actions" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "More actions" });
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test("a context menu opened with Shift+F10 takes focus", async ({ page }) => {
      await open(page, "media-overlays");
      await page.getByRole("button", { name: "Right-click me" }).focus();
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("menu", { name: "Sunset over Newark" }).getByRole("menuitem").first())
        .toBeFocused();
    });

    test("a media card's More menu and right-click menu take focus", async ({ page }) => {
      await open(page, "media-grid-keyboard");
      await page.getByRole("button", { name: /^More actions/ }).first().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      await page.locator(".media-tile").first().click({ button: "right" });
      await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeFocused();
    });

    test("the toolbar's overflow More menu takes focus at a narrow width", async ({ page }) => {
      await open(page, "media-toolbar", 420);
      await page.getByRole("button", { name: "More actions" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeFocused();
    });

    test("an anchored popover moves focus to its first control", async ({ page }) => {
      await open(page, "media-overlays");
      // The specimen starts with Display open; close it first so Enter opens it again.
      const display = page.getByRole("button", { name: "Display" });
      await display.click();
      await expect(page.getByRole("dialog", { name: "Display" })).toHaveCount(0);
      await display.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Display" })).toBeVisible();
      await expect.poll(() => page.evaluate(() =>
        document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-label") ?? null))
        .toBe("Display");
    });
  });
}
