import { expect, test } from "./fixtures";
import { waitForFonts } from "./capture";

for (const width of [1280, 390]) {
  test(`optimized photo choices and explicit refusal recovery at ${width}px`, async ({ page }) => {
    const requests: unknown[] = [];
    for (const endpoint of ["cmsGetMediaReview", "cmsListMediaComments"]) {
      await page.route(`**/${endpoint}`, route => route.fulfill({
        status: 404, json: { error: "Feedback unavailable in gallery fixture" },
      }));
    }
    await page.route("**/cmsCreateMediaDownload", async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      await route.fulfill(body.variant === "original" ? {
        status: 404, json: { error: "Media asset is unavailable" },
      } : {
        json: { success: true, fileName: "gallery-statehouse.webp",
          url: "http://127.0.0.1:5199/fixture-download.webp", expiresAt: "2026-10-06T12:05:00Z" },
      });
    });
    await page.route("**/fixture-download.webp", route => route.fulfill({
      body: "fixture web bytes", contentType: "image/webp",
      headers: { "Content-Disposition": 'attachment; filename="gallery-statehouse.webp"' },
    }));
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 800 });
    await page.goto("/gallery.html?embed=image-viewer&presentation=text&optimized&download-test");
    await waitForFonts(page);
    const viewer = page.getByRole("dialog", { name: "Statehouse dome at dusk" });
    const trigger = viewer.getByRole("button", { name: "Download", exact: true });
    await trigger.press("ArrowDown");
    const original = page.getByRole("menuitem", { name: "Original (full quality)", exact: true });
    const web = page.getByRole("menuitem", { name: /Web copy \(WebP\)/ });
    await expect(original).toBeFocused();
    const menuBox = await page.getByRole("menu", { name: "Download" }).boundingBox();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
    for (const item of [original, web]) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await original.press("ArrowDown");
    await expect(web).toBeFocused();
    await web.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(viewer).toBeVisible();
    await trigger.click();
    await original.click();
    await expect(page.getByText("The file could not be downloaded")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(requests).toEqual([{ assetId: "gallery-statehouse", variant: "original" }]);
    await expect(viewer).toBeVisible();
    await trigger.click();
    const download = page.waitForEvent("download");
    await web.click();
    expect((await download).suggestedFilename()).toBe("gallery-statehouse.webp");
    expect(requests).toEqual([
      { assetId: "gallery-statehouse", variant: "original" },
      { assetId: "gallery-statehouse", variant: "web" },
    ]);
    await expect(viewer).toBeVisible();
  });
}
