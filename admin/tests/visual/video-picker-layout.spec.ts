import { expect, test } from "./fixtures";
import { join } from "node:path";

for (const width of [390, 1280]) {
  test(`paginated video choices keep a compact Load more control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
      ? route.continue() : route.abort());
    const cursors: unknown[] = [];
    await page.route("**/cmsListSourceMedia", route => {
      const { cursor } = route.request().postDataJSON();
      cursors.push(cursor ?? null);
      const more = cursor === "next-page";
      return route.fulfill({ json: {
        success: true,
        records: Array.from({ length: more ? 1 : 48 }, (_, index) => ({
          id: `video-${more ? 49 : index + 1}`, name: `Library video ${more ? 49 : index + 1}`,
          credit: "NJ PBS", rightsStatus: "complete", license: "owned", viewingCopy: { state: "ready", durationSeconds: 123 },
        })),
        posters: [], hasMore: !more, nextCursor: more ? null : "next-page", total: 49,
      } });
    });
    await page.goto("/lead-media.html?template=1&kind=library-video");
    await page.getByText("Lead media and background", { exact: true }).click();
    await page.getByRole("button", { name: "Choose a different video", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose a video", exact: true });
    await expect(picker.getByRole("status")).toHaveText("48 ready videos found");
    const more = picker.getByRole("button", { name: "Load more videos", exact: true });
    await more.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    const control = await more.boundingBox();
    const grid = await picker.locator(".video-picker-results").boundingBox();
    expect(control!.width).toBeLessThan(grid!.width - 16);
    expect(Math.abs(control!.x - grid!.x)).toBeLessThanOrEqual(1);
    expect(control!.height).toBeGreaterThanOrEqual(44);
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    cursors.length = 0;
    await more.click();
    await expect(picker.getByRole("status")).toHaveText("49 ready videos found");
    await expect(picker.locator(".video-picker-choice")).toHaveCount(49);
    await expect(more).toHaveCount(0);
    expect(cursors).toEqual(["next-page"]);
    await picker.getByRole("button", { name: "Library video 49", exact: true }).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Video title/ })).toHaveValue("The New Jersey boardwalk");
  });

  test(`lead video choices use the dialog width and clear search spacing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
      ? route.continue() : route.abort());
    await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
      success: true, records: [
        { id: "pending", name: "Rights pending", credit: "NJ PBS", rightsStatus: "pending", license: "owned", viewingCopy: { state: "ready", durationSeconds: 123 } },
        { id: "unlicensed", name: "License missing", rightsStatus: "confirmed", license: null, viewingCopy: { state: "ready", durationSeconds: 123 } },
      ], posters: [{ assetId: "pending", url: "/brand/auth-newsroom-art.webp" }], hasMore: false, nextCursor: null,
    } }));
    await page.goto("/lead-media.html?template=1&kind=library-video");
    await page.getByText("Lead media and background", { exact: true }).click();
    await page.getByRole("button", { name: "Choose a different video", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose a video", exact: true });
    const status = picker.getByRole("status");
    await expect(status).toHaveText("2 ready videos found");
    await picker.locator("img").evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    if (process.env.VIDEO_PICKER_EVIDENCE) await picker.screenshot({ path: join(process.env.VIDEO_PICKER_EVIDENCE, `picker-${width}.png`) });

    const description = await picker.locator(":scope > p").first().boundingBox();
    const label = await picker.getByText("Search videos", { exact: true }).boundingBox();
    const search = await picker.getByRole("search").boundingBox();
    const count = await status.boundingBox();
    expect(label!.y - (description!.y + description!.height)).toBeGreaterThanOrEqual(12);
    expect(count!.y - (search!.y + search!.height)).toBeGreaterThanOrEqual(12);
    const grid = await picker.locator(".video-picker-results").boundingBox();
    const cards = picker.locator(".video-picker-choice");
    const last = await cards.last().boundingBox();
    expect(Math.abs(last!.x + last!.width - grid!.x - grid!.width)).toBeLessThanOrEqual(1);
    await expect(cards.first()).toHaveCSS("text-align", "left");
    // Check the rendered cross-axis alignment, including the short title and
    // metadata, rather than the browser's serialization of flex alignment.
    for (const card of await cards.all()) {
      const offsets = await card.evaluate(element => {
        const style = getComputedStyle(element);
        const left = element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        return Array.from(element.children, child => Math.abs(child.getBoundingClientRect().left - left));
      });
      for (const offset of offsets) expect(offset).toBeLessThanOrEqual(1);
    }
    expect(await cards.first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    const warnings = picker.locator(".video-picker-warning");
    await expect(warnings).toHaveText([
      "Rights are not confirmed for this video. Check before you publish.",
      "This video has no license recorded. Check before you publish.",
    ]);
    for (const warning of await warnings.all()) {
      expect(await warning.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await cards.first().click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Video title/ })).toHaveValue("The New Jersey boardwalk");
  });
}
