import { installProofFonts, expect, test } from "./fixtures";

const route = "/settings-workspace.html";
async function noOverflow(page: import("@playwright/test").Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(0);
}

test("the existing Page brand heading link preserves field and picker focus through Back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${route}#nj-decides-settings-heading`);
  await expect(page.getByRole("heading", { name: "NJ Decides brand", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "NJ Decides brand", exact: true })).toBeFocused();
  const color = page.getByRole("textbox", { name: "Text color", exact: true });
  const savedColor = await color.inputValue();
  await color.fill("#032745");
  await color.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 4));
  await page.getByRole("button", { name: "Header newsletter", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "NJ Decides brand", exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(color).toBeFocused();
  await expect(color).toHaveValue("#032745");
  expect(await color.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 4]);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("combobox", { name: "Settings section", exact: true })).toHaveValue("nj-decides-brand");
  await noOverflow(page);
  await color.fill(savedColor);
  await page.getByRole("button", { name: "Choose custom logo", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
  const search = picker.getByRole("searchbox", { name: "Search images", exact: true });
  await search.fill("Keep this brand search");
  await page.goForward();
  await expect(picker).toBeHidden();
  await page.goBack();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Keep this brand search");
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`${route}?section=public-site-chrome#nj-decides-settings-heading`);
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "NJ Decides brand", exact: true })).toHaveCount(0);
  await noOverflow(page);
});

test("schedule and footer validation stay visible when their summaries are toggled", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(route);
  const schedule = page.getByText(/^Schedule ·/);
  await schedule.click();
  await page.getByLabel("Start date and time", { exact: true }).fill("2026-11-04T18:00");
  await page.getByLabel("End date and time", { exact: true }).fill("2026-11-03T18:00");
  const error = page.getByText("The start date and time must be before the end date and time.", { exact: true });
  await expect(error).toBeVisible();
  await schedule.click();
  await expect(schedule.locator("..")).toHaveAttribute("open");
  await schedule.press("Enter");
  await expect(error).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await page.getByLabel("End date and time", { exact: true }).fill("2026-11-05T18:00");
  await schedule.click();
  await expect(schedule.locator("..")).not.toHaveAttribute("open");
  await page.getByRole("button", { name: "Site navigation", exact: true }).click();
  const footer = page.getByText(/^Footer columns ·/);
  await footer.click();
  const heading = page.getByRole("textbox", { name: "Column heading", exact: true }).first();
  await heading.fill("");
  await footer.press("Enter");
  await expect(footer.locator("..")).toHaveAttribute("open");
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await heading.fill("Useful links");
  await footer.click();
  await expect(footer.locator("..")).not.toHaveAttribute("open");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  await noOverflow(page);
});

test("settings fills the editor inset with independent columns and form-owned actions", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(route);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Admin settings", level: 2 })).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const workspace = rect(".settings-workspace"), content = rect(".content-area");
    const inspector = rect(".settings-section-inspector"), actions = rect(".settings-section-actions");
    const fields = document.querySelector<HTMLElement>(".settings-section-fields")!;
    fields.scrollTop = fields.scrollHeight;
    return { left: workspace.left - content.left, top: workspace.top - content.top,
      right: content.right - workspace.right, bottom: innerHeight - workspace.bottom,
      inspectorWidth: inspector.width, actionRight: actions.right, inspectorLeft: inspector.left,
      fieldsScrolled: fields.scrollTop > 0, inspectorScroll: document.querySelector(".settings-section-inspector")!.scrollTop,
      documentScroll: document.scrollingElement!.scrollTop };
  });
  for (const inset of [geometry.left, geometry.top, geometry.right, geometry.bottom]) expect(inset).toBeGreaterThanOrEqual(12);
  for (const inset of [geometry.left, geometry.top, geometry.right, geometry.bottom]) expect(inset).toBeLessThanOrEqual(16);
  expect(geometry.inspectorWidth).toBe(304);
  expect(geometry.actionRight).toBeLessThanOrEqual(geometry.inspectorLeft);
  expect(geometry.fieldsScrolled).toBe(true);
  expect(geometry.inspectorScroll).toBe(0);
  expect(geometry.documentScroll).toBe(0);
  await noOverflow(page);
});

test("pending departure feedback preserves the outline and form columns", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${route}?pending-save=1`);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Save before leaving");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByRole("link", { name: "Costs", exact: true }).click();
  await expect(page.getByText(/Finishing the settings action before leaving/)).toBeVisible();
  const outline = await page.getByRole("navigation", { name: "Settings sections" }).boundingBox();
  const fields = await page.locator(".settings-section-fields").boundingBox();
  expect(outline!.x + outline!.width).toBeLessThanOrEqual(fields!.x);
  expect(fields!.width).toBeGreaterThan(500);
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await noOverflow(page);
});

test("the image picker retains its search and section owner across history and viewport changes", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(route);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "NJ Decides brand", exact: true }).click();
  await page.getByRole("button", { name: "Choose custom logo", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
  const search = picker.getByRole("searchbox", { name: "Search images", exact: true });
  await search.fill("Retain this image search");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(search).toHaveValue("Retain this image search");
  await expect(picker).toBeInViewport();
  await page.goBack();
  await expect(picker).toBeHidden();
  await page.goForward();
  await expect(search).toHaveValue("Retain this image search");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose custom logo", exact: true })).toBeFocused();
  await noOverflow(page);
});
for (const width of [1920, 1280, 768, 390, 320]) {
  test(`settings fields, inspector and actions remain reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(route);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(message).toBeVisible();
    await noOverflow(page);
    await message.fill("Unsaved across sections and widths");
    if (width < 1000) await page.getByRole("combobox", { name: "Settings section", exact: true }).selectOption("nj-decides-brand");
    else await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "NJ Decides brand", exact: true }).click();
    await expect(page.getByText("Sample text", { exact: true })).toBeVisible();
    await expect(message).toBeHidden();
    await noOverflow(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole("combobox", { name: "Settings section", exact: true }).selectOption("public-homepage-banner");
    await expect(message).toHaveValue("Unsaved across sections and widths");
    await message.scrollIntoViewIfNeeded();
    await expect(message).toBeInViewport();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "Open costs", exact: true })).toBeVisible();
    await noOverflow(page);
  });
}

test("navigation keeps selection by ID through shared keyboard and pointer reordering", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(`${route}?section=site-navigation`);
  await page.getByRole("button", { name: "Edit Live", exact: true }).click();
  const label = page.getByRole("textbox", { name: "Label", exact: true });
  await expect(label).toBeFocused();
  await label.fill("Live coverage with a long name");
  const grip = page.getByRole("button", { name: "Reorder Live coverage with a long name", exact: true });
  await grip.focus();
  await page.keyboard.press("ArrowDown");
  await expect(label).toHaveValue("Live coverage with a long name");
  await expect(page.locator(".site-nav-list").first().locator(".site-nav-item-summary strong").nth(1)).toHaveText("Live coverage with a long name");
  await grip.dragTo(page.getByRole("button", { name: "Reorder Posts", exact: true }));
  await expect(label).toHaveValue("Live coverage with a long name");
  await expect(page.locator('.site-nav-item[data-selected="true"]')).toHaveCount(1);
  await page.getByText(/^Footer columns ·/).click();
  const heading = page.getByRole("textbox", { name: "Column heading", exact: true }).first();
  await heading.fill("");
  await heading.fill("Watch more");
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("button", { name: "Remove Contact", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Add header link", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toBeFocused();
  await noOverflow(page);
});

test("responsive navigation hands focus to its visible equivalent without resetting the draft", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(route);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Resize without losing this");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: /Homepage banner/ }).focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("combobox", { name: "Settings section", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Resize without losing this");
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: /Homepage banner/ })).toBeFocused();
  const search = page.getByRole("searchbox", { name: "Find a setting" });
  await search.fill("Media");
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("combobox", { name: "Settings section", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Media");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Resize without losing this");
});

test("coarse pointer, enlarged text, forced colors and reduced motion retain usable controls", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 900 }, reducedMotion: "reduce", forcedColors: "active" });
  await installProofFonts(context);
  const page = await context.newPage();
  await page.goto(route);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("A long election message remains editable on a phone.");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.scrollIntoViewIfNeeded();
  await expect(message).toBeInViewport();
  expect((await page.getByRole("combobox", { name: "Settings section", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole("button", { name: "Save draft", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);
  await context.close();
});


test("text control presentation keeps long navigation labels and move actions usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${route}?section=site-navigation&presentation=text`);
  await expect(page.getByRole("button", { name: "Remove Live", exact: true })).toHaveText("Remove");
  await expect(page.getByRole("button", { name: "Add header link", exact: true })).toHaveText("Add header link");
  await expect(page.getByRole("button", { name: "Move down, Live", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Live", exact: true }).click();
  const label = page.getByRole("textbox", { name: "Label", exact: true });
  await expect(label).toBeFocused();
  await expect(label).toBeInViewport();
  expect((await label.boundingBox())!.y + (await label.boundingBox())!.height).toBeLessThanOrEqual((await page.locator(".settings-section-actions").boundingBox())!.y);
  await label.fill("A very long navigation label for election coverage across New Jersey");
  await noOverflow(page);
});
