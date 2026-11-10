import { expect, test } from "@playwright/test";
import { openSpecimen } from "./capture";

for (const width of [390, 1280]) {
  test(`shared chrome stays bounded while workspace CSS is delayed at ${width}px`, async ({ page }, testInfo) => {
    // Hold the real lazy stylesheet without delaying React or the base shell styles.
    await page.addInitScript(() => {
      const selector = 'style[data-vite-dev-id$="/cms-workspace.css"]';
      const hold = () => document.querySelectorAll<HTMLStyleElement>(selector).forEach(style => { style.media = "not all"; });
      const observer = new MutationObserver(hold);
      observer.observe(document, { childList: true, subtree: true });
      document.addEventListener("release-workspace-css", () => {
        observer.disconnect();
        document.querySelectorAll<HTMLStyleElement>(selector).forEach(style => style.removeAttribute("media"));
      }, { once: true });
    });
    await openSpecimen(page, { id: "shell-editor", title: "Page editor", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    await expect(page.locator('style[data-vite-dev-id$="/cms-workspace.css"]')).toHaveAttribute("media", "not all");
    const chrome = page.locator(".workspace-chrome");
    const heights = await chrome.evaluate(async node => {
      const samples: number[] = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(requestAnimationFrame);
        samples.push(node.getBoundingClientRect().height);
      }
      return samples;
    });
    await page.screenshot({ path: testInfo.outputPath("delayed-workspace.png") });
    expect(Math.max(...heights) - Math.min(...heights), JSON.stringify(heights)).toBeLessThanOrEqual(1);
    expect(Math.max(...heights)).toBeLessThan(800);
    await page.evaluate(() => document.dispatchEvent(new Event("release-workspace-css")));
    await expect(page.locator(".workspace-editor-document-bar")).toHaveCSS("min-height", "0px");
    await expect.poll(() => page.locator(".workspace-shell").evaluate(node => {
      const measured = Number.parseFloat(node.style.getPropertyValue("--workspace-header-height"));
      return Math.abs(measured - node.querySelector(".workspace-chrome")!.getBoundingClientRect().height);
    })).toBeLessThanOrEqual(1);
    const documentBar = (await page.locator(".workspace-document-bar").boundingBox())!;
    const editingBar = (await page.locator(".workspace-editing-bar").boundingBox())!;
    expect((await chrome.boundingBox())!.height).toBeCloseTo(documentBar.height + editingBar.height, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: testInfo.outputPath("loaded-workspace.png") });
  });
}
