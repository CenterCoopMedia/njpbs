import { expect, test } from "./fixtures";
import { join } from "node:path";

for (const [mode, kind] of [["layout", "absent"], ["content", "legacy-empty"]]) for (const width of [390, 1280]) {
  test(`locked empty ${mode} template shows no lead selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
      ? route.continue() : route.abort());
    await page.goto(`/lead-media.html?template=1&locked=1&kind=${kind}&mode=${mode}`);
    await page.getByText("Lead media and background", { exact: true }).click();
    const review = page.getByRole("group", { name: "Lead media review" });
    await expect(review).toBeVisible();
    await expect(review).toContainText("Shown at the top of Posts made from this template.");
    await expect(page.getByRole("textbox", { name: "Template name", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Hero background image", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Lead media type", exact: true })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    if (process.env.LEAD_TEMPLATE_EVIDENCE) await review.screenshot({ path: join(process.env.LEAD_TEMPLATE_EVIDENCE, `${mode}-${width}.png`) });
    await expect(review).toContainText("No lead media selected.");
    await expect(review).not.toContainText("incomplete or unavailable");
    expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
