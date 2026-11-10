import { expect, test } from "./fixtures";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const width of [390, 1280]) {
  for (const pins of [1, 3]) {
    test(`public hero orders ${pins} pins before auto fill at ${width}px`, async ({ page }) => {
      await page.route(/^https:\/\/(?:dev\.)?njpbs\.org\/brand\//, route => route.fulfill({
        path: fileURLToPath(new URL(`../../../site/public${new URL(route.request().url()).pathname}`, import.meta.url)),
        headers: { "access-control-allow-origin": "*" },
      }));
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/home-hero-pins.html?view=public&pins=${pins}`);
      const frame = page.frameLocator('iframe[title="Public Home hero"]');
      await expect(frame.getByRole("heading", { level: 1 })).toHaveText("Connect with NJ PBS");
      await frame.locator("body").evaluate(async body => {
        await body.ownerDocument.fonts.ready;
        await Promise.all([...body.querySelectorAll("img")].map(image => image.decode()));
      });
      expect(await frame.locator(".home-editorial a").evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual(pins === 1
        ? ["/contact/", "/posts/newest/", "/posts/older/"]
        : ["/contact/", "/posts/outside/", "/posts/older/", "/posts/newest/"]);
      expect(await frame.locator("body").evaluate(body => body.ownerDocument.documentElement.scrollWidth > body.ownerDocument.defaultView!.innerWidth)).toBe(false);
      if (process.env.HEROPIN_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.HEROPIN_EVIDENCE_DIR, `hero-${pins}-pins-after-${width}.png`), fullPage: true });
    });
  }
  test(`Home dialog keeps pin controls and focus usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/home-hero-pins.html?pins=3");
    await page.getByRole("button", { name: "Edit Home hero", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Home hero", exact: true });
    const group = dialog.getByRole("group", { name: "Pinned", exact: true });
    await expect(group.locator("[data-hero-pin]").first()).toContainText("Connect with NJ PBS");
    await group.getByRole("button", { name: "Move pin 3 up", exact: true }).click();
    await expect(group.locator("[data-hero-pin]").nth(1)).toContainText("Explore the places");
    await expect(group.locator("[data-hero-pin]").nth(1)).toBeFocused();
    await group.getByLabel("Pin 1 end time (Eastern)", { exact: true }).fill("2026-11-04T20:30");
    await group.getByRole("button", { name: "Remove pin 3", exact: true }).click();
    await expect(group.locator("[data-hero-pin]")).toHaveCount(2);
    await expect(group.locator("[data-hero-pin]").nth(1)).toBeFocused();
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    if (process.env.HEROPIN_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.HEROPIN_EVIDENCE_DIR, `dialog-after-${width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit Home hero", exact: true }).click();
    await expect(group.getByLabel("Pin 1 end time (Eastern)", { exact: true })).toHaveValue("2026-11-04T20:30");
  });
}
