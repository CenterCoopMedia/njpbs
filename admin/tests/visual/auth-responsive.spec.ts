import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const enlargedText of [false, true]) {
  test(`Boardwalk entry keeps the brand above the form with ${enlargedText ? "200% text" : "a phone viewport"}`, async ({ page }) => {
    await openSpecimen(page, { id: "auth-loading", title: "Auth loading", width: enlargedText ? 1280 : 390, presentation: "text" });
    if (enlargedText) await page.addStyleTag({ content: "html { font-size: 200%; }" });
    const brand = page.locator(".auth-brand-column");
    const panel = page.locator(".auth-panel");
    await expect(brand).toBeVisible();
    await expect(panel).toBeVisible();
    // Enlarged text changes the auth container query after its next layout.
    // Wait for the actual stacked geometry, without weakening the reflow gate.
    await expect.poll(() => page.evaluate(() => {
      const brand = document.querySelector(".auth-brand-column")!.getBoundingClientRect();
      const panel = document.querySelector(".auth-panel")!.getBoundingClientRect();
      return panel.y >= brand.bottom - 1 && Math.abs(panel.x - brand.x) <= 1;
    })).toBe(true);
    const [brandElement, panelElement] = await Promise.all([brand.elementHandle(), panel.elementHandle()]);
    expect(brandElement).not.toBeNull();
    expect(panelElement).not.toBeNull();
    const { bounds, form } = await page.evaluate(
      ([brandNode, panelNode]) => {
        const brandRect = brandNode.getBoundingClientRect();
        const panelRect = panelNode.getBoundingClientRect();
        return {
          bounds: { height: brandRect.height, x: brandRect.x, y: brandRect.y },
          form: { x: panelRect.x, y: panelRect.y },
        };
      },
      [brandElement!, panelElement!],
    );
    expect(form.y).toBeGreaterThanOrEqual(bounds.y + bounds.height - 1);
    expect(Math.abs(form.x - bounds.x)).toBeLessThanOrEqual(1);
    // Hidden overflow can conceal a clipped brand label even when the page width fits.
    const textFits = await brand.evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll(".brand-product, .auth-brand-copy > p")].every(child => {
        const range = document.createRange();
        range.selectNodeContents(child);
        return [...range.getClientRects()].every(text => text.left >= box.left && text.right <= box.right);
      });
    });
    expect(textFits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
