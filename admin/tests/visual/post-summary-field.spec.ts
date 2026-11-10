import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [390]) test.describe(`Post summary at ${width}`, () => {
  test.use({ hasTouch: width === 390 });

  test("keeps the named summary separate from the headline", async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-mobile-draft", title: "Draft Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    const headline = page.getByRole("textbox", { name: "Headline", exact: true });
    const summary = page.getByRole("textbox", { name: "Summary", exact: true });
    const label = page.locator('label[for="record-post-summary"]');
    await expect(label).toBeVisible();
    await expect(summary).toHaveAccessibleDescription(/Optional text below the title/);
    await summary.fill("");
    await expect(summary).toHaveAttribute("placeholder", "Add a summary…");
    await expect(label).toBeVisible();
    if (width === 390) await label.tap();
    else await label.click();
    await expect(summary).toBeFocused();
    await summary.pressSequentially("The summary belongs in its own field.");
    await expect(headline).toHaveValue("Station update");
    await headline.fill("A distinct headline");
    await expect(summary).toHaveValue("The summary belongs in its own field.");
    await summary.focus();
    await summary.press("ArrowRight");
    await expect(summary).toBeFocused();
    const field = (await summary.boundingBox())!;
    const title = (await headline.boundingBox())!;
    const name = (await label.boundingBox())!;
    expect(field.height).toBeGreaterThanOrEqual(44);
    expect(name.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(name.y + name.height).toBeLessThanOrEqual(field.y);
    expect(field.x).toBeGreaterThanOrEqual(6);
    expect(field.x + field.width + 6).toBeLessThanOrEqual(width);
    expect(await summary.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(2);
    expect(await summary.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
});

test("an approved Post keeps its summary visible and read only", async ({ page }) => {
  await openSpecimen(page, { id: "shell-post-saved", title: "Saved Post", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  await expect(page.locator('label[for="record-post-summary"]')).toBeVisible();
  const summary = page.getByRole("textbox", { name: "Summary", exact: true });
  await expect(summary).toBeDisabled();
  await expect(summary).toHaveValue("A newsroom update prepared for review.");
  await expect(page.getByRole("textbox", { name: "Headline", exact: true })).toBeDisabled();
});
