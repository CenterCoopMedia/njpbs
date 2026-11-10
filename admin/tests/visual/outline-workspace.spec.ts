import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [320, 1280]) {
  test(`outline, picker and editor state at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "outline-workspace", title: "Page outline hierarchy", width, presentation: "text" }, { normalizeGeneratedIds: false });
    const outline = page.getByRole("button", { name: "Outline", exact: true });
    await expect(outline).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".block-editor-command-bar button").first()).toHaveText(/Outline/);
    const toolbarBox = await page.locator(".block-editor-command-bar").boundingBox();
    const outlineBox = await outline.boundingBox();
    expect(outlineBox!.x - toolbarBox!.x).toBeGreaterThanOrEqual(0);
    expect(outlineBox!.x - toolbarBox!.x).toBeLessThanOrEqual(16);
    const editors = await page.locator('[contenteditable="true"]').elementHandles();
    expect(editors).toHaveLength(3);
    await outline.click();
    await expect(page.getByText("2 rows · 3 blocks", { exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Content outline", exact: true });
    const headingContrast = await page.getByRole("heading", { name: "Content outline", exact: true }).evaluate(heading => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
          const srgb = channel / 255;
          return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const text = luminance(getComputedStyle(heading).color);
      const background = luminance(getComputedStyle(heading.parentElement!).backgroundColor);
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    });
    expect(headingContrast).toBeGreaterThanOrEqual(4.5);
    await expect(nav.locator(":scope > ol > li")).toHaveCount(2);
    await test.info().attach(`outline-${width}.png`, { body: await page.screenshot({ path: test.info().outputPath(`capture-${test.info().attachments.length}.png`), fullPage: true }), contentType: "image/png" });
    if (width <= 1100) {
      const drawer = page.getByRole("dialog", { name: "Content outline", exact: true });
      await expect(drawer).toBeVisible();
      const navBox = await nav.boundingBox();
      const drawerBox = await drawer.boundingBox();
      expect(navBox!.height).toBeGreaterThan(drawerBox!.height * 0.65);
      for (let tab = 0; tab < 6; tab++) await page.keyboard.press("Tab");
      expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
      const lastColumn = nav.getByRole("button", { name: "Go to Row 2, column 3: 1 block", exact: true });
      // Test drawer dismissal from a navigation target. A focused move button's
      // tooltip correctly consumes its first Escape before the parent dialog.
      await lastColumn.focus();
      await lastColumn.scrollIntoViewIfNeeded();
      await expect(lastColumn).toBeInViewport();
      await expect(drawer.getByRole("button", { name: "Close content outline", exact: true })).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(outline).toBeFocused();
    } else {
      await nav.getByRole("button", { name: "Collapse Row 2", exact: true }).click();
      await expect(nav.getByRole("button", { name: /^Go to text/ })).toHaveCount(0);
      await outline.click();
    }
    await outline.click();
    await nav.getByRole("button", { name: "Go to Row 1, column 2: Empty", exact: true }).click();
    const rowEditor = page.getByRole("dialog", { name: "Row 1", exact: true });
    await expect(rowEditor).toBeVisible();
    await expect(rowEditor.getByRole("button", { name: "Close Row 1", exact: true })).toBeFocused();
    await rowEditor.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".content-row-breadcrumb")).toBeVisible();
    await expect(page.locator(".content-row-breadcrumb")).toHaveText("Content › Row 1 › Column 2");
    if (width <= 1100) await expect(outline).toHaveAttribute("aria-expanded", "false");
    else await outline.click();
    for (const editor of editors) expect(await editor.evaluate(element => element.isConnected)).toBe(true);
    const column = page.getByRole("group", { name: "Row 1, column 1", exact: true });
    await column.getByRole("button", { name: "Add plank to column 1", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add content", exact: true });
    const search = picker.getByPlaceholder("Search content types");
    const commit = picker.getByRole("button", { name: "Insert block", exact: true });
    await expect(search).toBeFocused();
    await expect(commit).toBeDisabled();
    const image = picker.getByRole("radio", { name: "image", exact: true });
    await image.click();
    await expect(image).toBeChecked();
    await expect(commit).toBeEnabled();
    await expect(page.locator(".block-card-image")).toHaveCount(0);
    await search.fill("no matching content type");
    await expect(picker.getByRole("status")).toHaveText("0 types match");
    await expect(picker).toContainText("No content types match your search.");
    await expect(commit).toBeDisabled();
    await search.fill("");
    await expect(image).not.toBeChecked();
    const divider = picker.getByRole("radio", { name: "divider", exact: true });
    await expect(divider).toBeDisabled();
    await expect(page.locator(".block-card-divider")).toHaveCount(0);
    await search.fill("divider");
    await expect(picker.getByRole("radiogroup", { name: "Content types" }).getByRole("radio")).toHaveCount(1);
    await expect(picker).toContainText("Dividers are only available outside rows or inside a one-column row.");
    await test.info().attach(`picker-${width}.png`, { body: await page.screenshot({ path: test.info().outputPath(`capture-${test.info().attachments.length}.png`), fullPage: true }), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(column.getByRole("button", { name: "Add plank to column 1", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await column.getByRole("button", { name: "Add plank to column 1", exact: true }).click();
    const reopenedImage = picker.getByRole("radio", { name: "image", exact: true });
    await reopenedImage.focus();
    await page.keyboard.press("Space");
    await expect(reopenedImage).toBeChecked();
    await commit.focus();
    await page.keyboard.press("Enter");
    const imageEditor = page.getByRole("dialog", { name: /^image \d+$/ });
    await expect(imageEditor).toBeVisible();
    await expect(imageEditor.getByRole("button", { name: /^Close image \d+$/ })).toBeFocused();
    await imageEditor.getByRole("button", { name: "Done", exact: true }).click();
    await expect(outline).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Save page", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    for (const editor of editors) expect(await editor.evaluate(element => element.isConnected)).toBe(true);
    await page.getByRole("button", { name: "Reopen saved content", exact: true }).click();
    await expect(page.locator(".block-card-image")).toHaveCount(1);
    const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  });
}

test("short landscape and enlarged text keep outline dismissal reachable", async ({ page }) => {
  await openSpecimen(page, { id: "outline-workspace", title: "Page outline hierarchy", width: 768, presentation: "text" }, { normalizeGeneratedIds: false });
  await page.setViewportSize({ width: 768, height: 390 });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  const close = page.getByRole("button", { name: "Close content outline", exact: true });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(page.getByRole("button", { name: "Outline", exact: true })).toBeFocused();
  const column = page.getByRole("group", { name: "Row 1, column 1", exact: true });
  const trigger = column.getByRole("button", { name: "Add plank to column 1", exact: true });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Add content", exact: true });
  await expect(picker.getByRole("button", { name: "Close content picker", exact: true })).toBeInViewport();
  await expect(picker.getByPlaceholder("Search content types")).toBeInViewport();
  await expect(picker.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect(picker.getByRole("button", { name: "Insert block", exact: true })).toBeInViewport();
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
});

test("keeps Outline on the left in a routed editor's separate toolbar", async ({ page }) => {
  await openSpecimen(page, { id: "shell-editor-saved", title: "Saved editor", width: 1280, presentation: "text" }, { normalizeGeneratedIds: false });
  const toolbar = page.locator(".workspace-editing-start");
  const outline = toolbar.getByRole("button", { name: "Outline", exact: true });
  await expect(outline).toHaveText(/Outline/);
  const toolbarBox = await toolbar.boundingBox();
  const outlineBox = await outline.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(outlineBox).not.toBeNull();
  expect(outlineBox!.x - toolbarBox!.x).toBeGreaterThanOrEqual(0);
  expect(outlineBox!.x - toolbarBox!.x).toBeLessThanOrEqual(16);
  const contentBounds = await outline.evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(button);
    return { button: { left: bounds.left, right: bounds.right }, content: Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right })) };
  });
  for (const rect of contentBounds.content) {
    expect(rect.left).toBeGreaterThanOrEqual(contentBounds.button.left);
    expect(rect.right).toBeLessThanOrEqual(contentBounds.button.right);
  }
  await test.info().attach("routed-outline-position.png", { body: await page.screenshot({ path: test.info().outputPath(`capture-${test.info().attachments.length}.png`), fullPage: true }), contentType: "image/png" });
});
