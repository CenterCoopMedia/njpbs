import { expect, test, type Page } from "./fixtures";
import { freezeClock, waitForFonts } from "./capture";

async function openContextualEditor(page: Page, width: 320 | 390): Promise<void> {
  await freezeClock(page);
  await page.setViewportSize({ width, height: 640 });
  await page.goto("/gallery.html?embed=rich-text-context-menu&presentation=text");
  await page.waitForLoadState("networkidle");
  await waitForFonts(page);
}

async function selectParagraphText(page: Page, paragraphIndex: number): Promise<void> {
  const surface = page.getByRole("textbox", { name: "Long body" });
  await surface.locator("p").nth(paragraphIndex).evaluate((paragraph) => {
    paragraph.scrollIntoView({ block: "center" });
    const text = paragraph.firstChild;
    if (!text) throw new Error("The paragraph has no text node");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(12, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (paragraph.parentElement as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

async function expectMenuReachable(page: Page): Promise<void> {
  const menu = page
    .getByRole("toolbar", { name: "Formatting for Long body" })
    .locator("..");
  const readGeometry = () => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      left: rect.left,
      right: rect.right,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  // Reflow and Popper update asynchronously. Require all edges in the same read;
  // separate successful polls can describe different layouts during one resize.
  let geometry = await readGeometry();
  await expect.poll(async () => {
    geometry = await readGeometry();
    return {
      left: geometry.left >= 0,
      right: geometry.right <= geometry.viewportWidth,
      top: geometry.top >= 0,
      bottom: geometry.bottom <= geometry.viewportHeight,
    };
  }).toEqual({ left: true, right: true, top: true, bottom: true });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.clientHeight);
}

test("the contextual rich-text controls follow a long document at narrow and reflowed widths", async ({
  page,
}) => {
  await openContextualEditor(page, 390);
  await selectParagraphText(page, 40);

  const toolbar = page.getByRole("toolbar", { name: "Formatting for Long body" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator("..")).not.toHaveCSS("box-shadow", "none");
  await expect(toolbar.locator("xpath=ancestor::*[contains(@class, 'card-grid__card')]"))
    .toHaveCount(0);
  await expectMenuReachable(page);
  const activeLine = page.getByRole("textbox", { name: "Long body" }).locator("p").nth(40);
  const lineTop = await activeLine.evaluate((line) => line.getBoundingClientRect().top);
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await expect(activeLine.locator("strong")).toContainText("Paragraph 41");
  expect(await activeLine.evaluate((line) => line.getBoundingClientRect().top)).toBeCloseTo(lineTop, 0);

  const body = page.getByRole("textbox", { name: "Long body" });
  await body.press("Alt+F10");
  await expect(toolbar.getByRole("button", { name: "Bold" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(body).toBeFocused();

  await page.setViewportSize({ width: 320, height: 640 });
  await activeLine.evaluate(line => line.scrollIntoView({ block: "center" }));
  await expectMenuReachable(page);
  // A 160 CSS-pixel viewport is the reflow target for a 320-pixel viewport at 200% zoom.
  await page.setViewportSize({ width: 160, height: 640 });
  await activeLine.evaluate(line => line.scrollIntoView({ block: "center" }));
  await expectMenuReachable(page);

  await page.getByRole("textbox", { name: "Caption" }).focus();
  await expect(page.getByRole("toolbar", { name: "Formatting for Caption" })).toBeVisible();
  await expect(toolbar).toHaveCount(0);
  await expect(page.getByRole("toolbar")).toHaveCount(1);
});


test("floating toolbar move handle retains all four arrow keys alongside roving commands", async ({ page }) => {
  await freezeClock(page); await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/gallery.html?embed=rich-text-context-menu&presentation=text");
  await page.waitForLoadState("networkidle"); await waitForFonts(page);
  await selectParagraphText(page, 40);
  const toolbar = page.getByRole("toolbar", { name: "Formatting for Long body" });
  const menu = toolbar.locator('..');
  const mover = toolbar.getByRole("button", { name: "Move toolbar", exact: true });
  // Popper positions asynchronously after selection. Measure its settled
  // viewport position before switching to the manual arrow-key owner.
  await expect(menu).toHaveAttribute("data-popper-placement", /./);
  await expectMenuReachable(page);
  await mover.focus();
  // Placement metadata can precede rendered geometry. Wait for Popper's
  // viewport inset before the manual owner applies its own 8px boundary.
  await expect(menu).toHaveCSS("transform", /^matrix\(/);
  await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(8);
  const initial = await menu.boundingBox();
  await page.keyboard.press("ArrowRight");
  await expect(menu).toHaveCSS("transform", "none");
  await expect.poll(async () => (await menu.boundingBox())!.x).toBeCloseTo(initial!.x + 16, 0);
  await expect(mover).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await menu.boundingBox())!.x).toBeCloseTo(Math.max(8, initial!.x), 0);
  const beforeVertical = await menu.boundingBox();
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeCloseTo(beforeVertical!.y - 16, 0);
  // Return through free space; moving below the initial position would cover
  // the selection and correctly meet the existing protected-text boundary.
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeCloseTo(beforeVertical!.y, 0);
  await expect(mover).toBeFocused();
  await page.keyboard.press("Home"); await expect(toolbar.getByRole("button", { name: "Bold", exact: true })).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`automatic formatting leaves offscreen text clear and restores its selection at ${width}px`, async ({ page }) => {
    await freezeClock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=rich-text-context-menu&presentation=icons");
    await waitForFonts(page);
    await selectParagraphText(page, 40);
    const toolbar = page.getByRole("toolbar", { name: "Formatting for Long body", includeHidden: true });
    const menu = toolbar.locator("..");
    await expect(toolbar).toBeVisible();
    await expectMenuReachable(page);
    const selected = await page.evaluate(() => window.getSelection()?.toString());

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => menu.evaluate(element => element.checkVisibility({ opacityProperty: true }))).toBe(false);
    expect(await menu.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(false);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);

    await page.getByRole("textbox", { name: "Long body" }).press("Alt+F10");
    await expect(toolbar.getByRole("button", { name: "Bold", exact: true })).toBeFocused();
    await expect.poll(() => menu.evaluate(element => element.checkVisibility({ opacityProperty: true }))).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "Long body" }).locator("p").nth(40)
      .evaluate(paragraph => paragraph.scrollIntoView({ block: "center" }));
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Long body" }).locator("p").nth(40).locator("strong"))
      .toHaveText(selected!);
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const address = page.getByRole("textbox", { name: "Link address", exact: true });
    await address.fill("https://example.org/");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(address).toBeVisible();
    await expect(address).toBeFocused();
    await expect(address).toHaveValue("https://example.org/");
  });

  test(`long Page link removal and Review & publish accept normal pointer clicks at ${width}px`, async ({ page }) => {
    await freezeClock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=shell-editor-saved&guide=1&presentation=icons");
    await waitForFonts(page);
    if (width === 390) await page.getByRole("button", { name: "Edit Public file introduction", exact: true }).click();
    const body = page.getByRole("textbox", { name: "Body", exact: true });
    await body.fill(Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}. New Jersey newsroom copy.`).join("\n"));
    await body.press("Home");
    await body.press("Shift+End");
    const toolbar = page.getByRole("toolbar", { name: "Formatting for Body" });
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByRole("textbox", { name: "Link address", exact: true }).fill("https://example.org/");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(body.locator("a")).toHaveCount(1);
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(body.locator("a")).toHaveCount(0);
    if (width === 390) await page.getByRole("button", { name: "Close details", exact: true }).click();
    const review = page.getByRole("button", { name: "Review & publish", exact: true });
    await review.click();
    await expect(review).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("group", { name: "Review & publish", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
  });
}
