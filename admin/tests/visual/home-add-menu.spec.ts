import { expect, test } from "./fixtures";
import v1 from "../../../site/tests/fixtures/home-composition-v1.json" with { type: "json" };
import { freezeClock, waitForFonts } from "./capture";

for (const [width, height] of [[1280, 800], [390, 844]]) {
  test(`Home Add menu leaves page actions reachable and scrolls to Row at ${width}px`, async ({ page }) => {
    const home = {
      blocks: v1.blocks.map(block => ({ ...block, visible: false })),
      metadata: { title: "Home", homeHero: { mode: "manual", items: [] } },
      homeCompositionVersion: 2, version: 7, status: "draft", createdBy: "sa",
    };
    // The gallery's API boundary supplies a saved Home with every restorable section hidden.
    await page.route("**/src/dev/gallery.tsx*", async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = "savePage: saveNever";
      expect(source).toContain(marker);
      await route.fulfill({ response, body: source.replace(marker, `${marker}, loadPage: async () => (${JSON.stringify(home)})`) });
    });
    await freezeClock(page);
    await page.setViewportSize({ width, height });
    await page.goto("/gallery.html?embed=shell-editor&presentation=icons");
    await waitForFonts(page);
    const trigger = page.getByRole("button", { name: "Add", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.evaluate(element => {
      const header = document.querySelector(".workspace-header")!.getBoundingClientRect();
      window.scrollBy(0, element.getBoundingClientRect().top - header.bottom - 16);
    });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Add", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Passport Restore hidden section", exact: true })).toBeVisible();
    const geometry = await menu.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
        headerBottom: document.querySelector(".workspace-header")!.getBoundingClientRect().bottom,
        heights: Array.from(element.querySelectorAll('[role="menuitem"]'), item => item.getBoundingClientRect().height),
        glyphs: Array.from(element.querySelectorAll('[role="menuitem"] svg'), icon => icon.innerHTML),
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.headerBottom);
    expect(geometry.bottom).toBeLessThanOrEqual(height - 8);
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeLessThanOrEqual(width - 8);
    expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(44);
    expect(new Set(geometry.glyphs).size).toBe(geometry.glyphs.length);
    const documentScroll = await page.evaluate(() => scrollY);
    await menu.press("End");
    const row = menu.getByRole("menuitem", { name: "Row", exact: true });
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    if (width === 390) expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => scrollY)).toBe(documentScroll);
    await menu.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    // A real pointer click must reach the page toolbar while Add is open.
    await page.getByRole("button", { name: "More document actions", exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator("#workspace-more-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Workspace preferences", exact: true })).toBeVisible();
  });
}
