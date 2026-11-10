import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const kind of ["page", "post"] as const) {
  test(`${kind} reset keeps the default preference while the workspace limits its width`, async ({ page }) => {
    await openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width: 1920, presentation: "icons" }, { normalizeGeneratedIds: false });
    const details = page.getByRole("separator", { name: "Resize details", exact: true });
    const outline = page.getByRole("separator", { name: "Resize outline", exact: true });
    await details.press("End");
    await outline.press("End");
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect(details).toHaveAttribute("aria-valuemax", "18");
    await page.getByRole("button", { name: "Details width", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset width", exact: true }).click();
    expect(await page.evaluate(key => localStorage.getItem(key), `cms.inspector.editor-${kind}.details.width`)).toBe("19");
    await expect(details).toHaveAttribute("aria-valuenow", "18");
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(details).toHaveAttribute("aria-valuenow", "19");

    await outline.press("Home");
    await details.press("End");
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect(outline).toHaveAttribute("aria-valuemax", "12");
    await page.getByRole("button", { name: "Outline width", exact: true }).click();
    await page.getByRole("menuitem", { name: "Reset width", exact: true }).click();
    const outlineDefault = kind === "post" ? "12.25" : "13";
    expect(await page.evaluate(key => localStorage.getItem(key), `cms.inspector.editor-${kind}.outline.width`)).toBe(outlineDefault);
    await expect(outline).toHaveAttribute("aria-valuenow", outlineDefault);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(outline).toHaveAttribute("aria-valuenow", outlineDefault);
    await page.reload();
    await expect(outline).toHaveAttribute("aria-valuenow", outlineDefault);
    await expect(details).toHaveAttribute("aria-valuenow", "28");
  });

  test(`${kind} panes share pointer, keyboard, menu and stored width behavior`, async ({ page }) => {
    await openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width: 1920, presentation: "icons" }, { normalizeGeneratedIds: false });
    const details = page.getByRole("separator", { name: "Resize details", exact: true });
    const outline = page.getByRole("separator", { name: "Resize outline", exact: true });
    await expect(details).toHaveAttribute("aria-valuenow", "19");
    await expect(outline).toHaveAttribute("aria-valuenow", kind === "post" ? "12.25" : "13");
    const prose = page.locator(kind === 'post' ? '[contenteditable="true"]' : '.block-card').first();
    await prose.evaluate(element => { (window as unknown as { retainedProse: Element }).retainedProse = element; });
    // A resize edge must not take pointer hits meant for native scrollbars.
    for (const selector of [".content-area", ".editor-workspace-pane-outline .editor-workspace-pane-content"]) {
      const target = await page.locator(selector).evaluate(element => {
        const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.right - 2, box.top + box.height / 2)?.closest('[role="separator"]')?.getAttribute("aria-label") ?? null;
      });
      expect(target).toBeNull();
    }
    const save = page.getByRole("button", { name: "Save draft", exact: true });
    const disabledBefore = await save.isDisabled();
    await details.press("ArrowLeft");
    await expect(details).toHaveAttribute("aria-valuenow", "20");
    await details.press("Home");
    await expect(details).toHaveAttribute("aria-valuenow", "18");
    await details.press("ArrowRight");
    await expect(details).toHaveAttribute("aria-valuenow", "18");
    await details.press("End");
    await expect(details).toHaveAttribute("aria-valuenow", "28");
    await details.press("ArrowLeft");
    await expect(details).toHaveAttribute("aria-valuenow", "28");
    // Locate the accessible splitter first. Pointer movement exercises native capture,
    // including a release over the writing canvas rather than over the handle.
    await details.hover();
    const box = (await details.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 1000, box.y + box.height / 2);
    await page.mouse.up();
    await expect(details).toHaveAttribute("aria-valuenow", "18");
    await expect(details).toBeFocused();
    await outline.press("ArrowRight");
    await expect(outline).toHaveAttribute("aria-valuenow", kind === "post" ? "13.25" : "14");
    await outline.press("Home");
    await expect(outline).toHaveAttribute("aria-valuenow", "12");
    await outline.hover();
    const start = (await outline.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 64, start.y + start.height / 2);
    await page.mouse.up();
    await expect(outline).toHaveAttribute("aria-valuenow", "16");
    await page.getByRole("button", { name: "Details width", exact: true }).click();
    await page.getByRole("menuitem", { name: "Wider", exact: true }).click();
    await expect(details).toHaveAttribute("aria-valuenow", "19");
    expect(await prose.evaluate(element => (window as unknown as { retainedProse: Element }).retainedProse === element)).toBe(true);
    expect(await save.isDisabled()).toBe(disabledBefore);
    await page.reload();
    await expect(details).toHaveAttribute("aria-valuenow", "19");
    await expect(outline).toHaveAttribute("aria-valuenow", "16");
    // Scrolling the contents does not move the splitter out of reach.
    const before = await details.boundingBox();
    await page.locator(".editor-workspace-pane-details .editor-workspace-pane-content").evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await details.boundingBox()).toEqual(before);
    await details.press("ArrowLeft");
    await expect(details).toHaveAttribute("aria-valuenow", "20");
  });

  test(`${kind} panes clamp to the canvas budget and remain phone sheets`, async ({ page }) => {
    await openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width: 1920, presentation: "icons" }, { normalizeGeneratedIds: false });
    const details = page.getByRole("separator", { name: "Resize details", exact: true });
    const outline = page.getByRole("separator", { name: "Resize outline", exact: true });
    await details.press("End");
    await outline.press("End");
    const widthKey = `cms.inspector.editor-${kind}.details.width`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(details).not.toHaveAttribute("aria-valuenow", "28");
    expect(await page.evaluate(key => localStorage.getItem(key), widthKey)).toBe("28");
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(details).toHaveAttribute("aria-valuenow", "28");
    // At 1440px, the 60px rail, 22rem outline and 640px canvas leave 24.25rem.
    for (const [width, max] of [[1280, kind === "post" ? 18 : 28], [1440, 24.25], [1920, 28]]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(details).toBeVisible();
      // End must use this viewport's budget, not the previous viewport's maximum.
      await expect(details).toHaveAttribute("aria-valuemax", String(max));
      await details.press("End");
      // Read both values together while waiting for the keyboard update.
      await expect.poll(() => details.evaluate(element => {
        const now = element.getAttribute("aria-valuenow");
        return now !== null && now === element.getAttribute("aria-valuemax");
      })).toBe(true);
      await expect.poll(() => page.locator(".content-area").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(640);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Expand primary navigation", exact: true }).click();
    await expect.poll(() => page.locator(".content-area").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
    const stored = await page.evaluate(() => ({ ...localStorage }));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(details).toHaveCount(0);
    await expect(outline).toHaveCount(0);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Details", exact: true });
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(element => element.matches(":modal"))).toBe(true);
    await expect(sheet.getByRole("heading", { name: "Details", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toBeFocused();
    expect((await page.evaluate(() => ({ ...localStorage })))[`cms.inspector.editor-${kind}.details.width`]).toBe(stored[`cms.inspector.editor-${kind}.details.width`]);
  });
}
