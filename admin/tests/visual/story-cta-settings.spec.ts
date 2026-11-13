import { expect, test } from "./fixtures";

const route = "/settings-workspace.html?section=story-ctas";

test("story CTA rules and sample order remain usable at phone and desktop widths", async ({ page }) => {
  for (const width of [390, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1000 });
    await page.goto(route);

    await expect(page.getByRole("heading", { name: "Story CTAs", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Mid-story newsletter Enabled$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("checkbox", { name: "Enabled on stories" })).toBeChecked();
    await expect(page.getByText("Stories (posts)", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Position" })).toHaveValue("after-paragraph");
    await expect(page.getByRole("spinbutton", { name: "Paragraph number" })).toHaveValue("2");
    await expect(page.getByText(/Approved projection shown/)).toBeVisible();

    const previewMode = width === 390 ? "Mobile" : "Desktop";
    await page.getByRole("button", { name: `${previewMode} preview`, exact: true }).click();
    const frame = page.frameLocator(`iframe[title="Story CTA ${previewMode.toLowerCase()} sample preview"]`);
    await expect(frame.getByRole("heading", { name: "Garden State Weekly", exact: true })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Sign up for Garden State Weekly", exact: true })).toHaveAttribute("tabindex", "-1");
    await expect(frame.locator(".support-appeal")).toBeVisible();
    expect(await frame.locator("[data-sample-block-type]").evaluateAll(elements =>
      elements.map(element => element.getAttribute("data-sample-block-type")))).toEqual([
      "prose",
      "newsletter_signup",
      "divider",
      "prose",
      "support_appeal",
    ]);
    expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".settings-section-workspace").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeInViewport();
    if (width === 1920) {
      await page.getByRole("button", { name: "Open full-size sample", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Full-size sample story preview", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close full-size sample preview", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open full-size sample", exact: true })).toBeFocused();
    }
  }
});

test("rule selection, ordering, and enabled state update the same sample preview", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(route);

  const supportRule = page.getByRole("button", { name: /End-of-story support appeal Enabled$/ });
  await supportRule.click();
  await expect(supportRule).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("checkbox", { name: "Enabled on stories" }).uncheck();
  const disabledSupportRule = page.getByRole("button", { name: /End-of-story support appeal Disabled$/ });
  const frame = page.frameLocator('iframe[title="Story CTA desktop sample preview"]');
  await expect(frame.locator(".support-appeal")).toHaveCount(0);

  await page.getByRole("button", { name: "Move up, End-of-story support appeal" }).click();
  const ruleNames = await page.locator(".story-cta-settings__list > li > button:first-child > span").allTextContents();
  expect(ruleNames).toEqual(["End-of-story support appeal", "Mid-story newsletter"]);
  await expect(disabledSupportRule).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
});
