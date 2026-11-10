import { expect, test, type Locator } from "./fixtures";
import { openSpecimen } from "./capture";

async function expectFullyVisible(control: Locator) {
  await expect(control).toBeFocused();
  const visible = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
      // The native top layer escapes clipping by ancestors of the modal itself.
      if (parent.matches(":modal")) break;
    }
    return { visible: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.right <= right + 1
      && box.top >= top - 1 && box.bottom <= bottom + 1,
      control: element.getAttribute("aria-label") ?? element.tagName, box: box.toJSON(), limits: { left, top, right, bottom } };
  });
  expect(visible.visible, JSON.stringify(visible)).toBe(true);
}

for (const [width, height, text] of [
  [1280, 900, 100], [1920, 900, 100],
  [320, 800, 100], [390, 800, 100], [320, 800, 200], [390, 800, 200],
  [320, 440, 200], [390, 440, 200],
]) {
  test(`Gallery keeps fields and footer reachable at ${width}x${height}, ${text}% text`, async ({ page }) => {
    await openSpecimen(page, { id: "post-gallery-containment", title: "Gallery", width, presentation: "text" }, { normalizeGeneratedIds: false });
    await page.setViewportSize({ width, height });
    const trigger = page.getByRole("button", { name: "Edit image gallery 1", exact: true });
    // Establish the text-size preference before native modal focus is assigned.
    await page.addStyleTag({ content: `html { font-size: ${text}%; }` });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "image gallery 1", exact: true });
    expect((await dialog.locator(".component-editor-dialog-body").boundingBox())!.height).toBeGreaterThan(100);
    const caption = dialog.getByRole("textbox", { name: "Caption 1", exact: true });
    await caption.focus();
    await expectFullyVisible(caption);
    await caption.fill("Retained local caption");
    for (const control of [dialog.getByRole("button", { name: "Remove image 12 from gallery", exact: true }), dialog.getByRole("button", { name: "Done", exact: true })]) {
      await control.focus();
      await expectFullyVisible(control);
    }
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByRole("textbox", { name: "Caption 1", exact: true })).toHaveValue("Retained local caption");
    await dialog.getByRole("button", { name: "Close image gallery 1", exact: true }).click();
    await expect(trigger).toBeFocused();
  });
}

test("Gallery native tab order reveals every control at 320px and 200% text", async ({ page }) => {
  await openSpecimen(page, { id: "post-gallery-containment", title: "Gallery", width: 320, presentation: "text" }, { normalizeGeneratedIds: false });
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
  await page.getByRole("button", { name: "Edit image gallery 1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "image gallery 1", exact: true });
  const close = dialog.getByRole("button", { name: "Close image gallery 1", exact: true });
  await close.focus();
  await expectFullyVisible(close);
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  const names: string[] = [];
  for (let step = 0; step < 160; step++) {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expectFullyVisible(focused);
    names.push(await focused.getAttribute("aria-label") ?? await focused.textContent() ?? "");
    // Done is the last dialog control; the next Tab may enter browser chrome.
    if (await done.evaluate(element => element === document.activeElement)) break;
  }
  await expect(done).toBeFocused();
  expect(names).toContain("Remove image 12 from gallery");
  expect(names).toContain("Done");
});
