import { expect, test } from "./fixtures";
import { join } from "node:path";

for (const width of [390, 1280]) {
  test(`lead video picker keeps complete rights warnings at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
      success: true, records: [
        { id: "pending", name: "Rights pending", rightsStatus: "pending", license: "owned", viewingCopy: { state: "ready", durationSeconds: 123 } },
        { id: "unlicensed", name: "License missing", rightsStatus: "confirmed", license: null, viewingCopy: { state: "ready", durationSeconds: 123 } },
      ], posters: [], hasMore: false, nextCursor: null,
    } }));
    await page.goto("/lead-media.html?kind=library-video&inspector=1");
    await expect(page.getByLabel("Change lead media", { exact: true })).toHaveAccessibleDescription("Library video · The New Jersey boardwalk");
    await page.locator('[data-image-role="leadMedia"] > summary').click();
    await page.getByRole("button", { name: "Choose a different video", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose a video", exact: true });
    await expect(picker.getByRole("status")).toHaveText("2 ready videos found");
    const warnings = picker.locator(".video-picker-warning");
    await expect(warnings).toHaveText([
      "Rights are not confirmed for this video. Check before you publish.",
      "This video has no license recorded. Check before you publish.",
    ]);
    if (process.env.LEAD_RIGHTS_EVIDENCE) await picker.screenshot({ path: join(process.env.LEAD_RIGHTS_EVIDENCE, `rights-${width}.png`) });
    for (const warning of await warnings.all()) {
      await expect(warning).toHaveCSS("white-space", "normal");
      expect(await warning.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
}
