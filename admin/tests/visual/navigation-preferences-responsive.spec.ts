import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";
import { assertControlDesign } from "./control-contract";

// Issue #2556: a destination and every control share one 44px row, including at
// 320 CSS pixels. Short-height cases below also cover the 200px zoom viewport.
for (const [width, presentation] of [[320, "text"], [1280, "icons"]] as const) {
  test(`navigation keeps a single accessible row at ${width}px in ${presentation} mode`, async ({ page }) => {
    await openSpecimen(page, { id: "navigation-preferences", title: "Your rail", width, presentation });
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    const list = page.getByRole("list", { name: "Your rail order" });
    await assertControlDesign(page);
    const layout = await list.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.children).map((row) => {
        const box = row.getBoundingClientRect();
        const identity = row.querySelector(".nav-preference-identity")!.getBoundingClientRect();
        const controls = row.querySelector(".nav-preference-controls")!.getBoundingClientRect();
        const buttons = Array.from(row.querySelectorAll("button")).map((button) => button.getBoundingClientRect());
        return {
          height: box.height,
          namesFit: Array.from(row.querySelectorAll<HTMLElement>(".nav-preference-name, .nav-preference-required"))
            .every((name) => name.scrollWidth <= name.clientWidth + 1 && name.scrollHeight <= name.clientHeight + 1),
          inside: box.left >= bounds.left && box.right <= bounds.right,
          separate: identity.right <= controls.left,
          oneLine: buttons.every((button) => Math.abs(button.top - box.top) < 1 && button.bottom <= box.bottom + 1),
        };
      });
    });
    for (const row of layout) {
      expect(row.height).toBeCloseTo(44, 0);
      expect(row.inside).toBe(true);
      expect(row.namesFit).toBe(true);
      expect(row.separate).toBe(true);
      expect(row.oneLine).toBe(true);
    }
    const save = page.getByRole("button", { name: "Save rail" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    if (width === 1280) {
      const sizes = await list.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
    }

    // Operate real buttons from the keyboard and keep focus on the moved row.
    const up = page.getByRole("button", { name: "Move: Pages", exact: true });
    await up.focus();
    await page.keyboard.press("ArrowUp");
    await expect(list.getByRole("listitem").first()).toContainText("Pages");
    await expect(page.getByRole("button", { name: "Move: Pages", exact: true })).toBeFocused();
    await expect(page.getByRole("status")).toContainText("Pages moved to position 1");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    // A row edit produces one specific announcement, without a competing dirty-state region.
    await expect(page.locator('.nav-preferences [aria-live="polite"], .nav-preferences [role="status"]')).toHaveCount(1);

    const hide = page.getByRole("button", { name: "Hide: Activity", exact: true });
    await hide.focus();
    await page.keyboard.press("Space");
    const show = page.getByRole("button", { name: "Show: Activity", exact: true });
    await expect(show).toBeFocused();
    await expect(page.getByRole("status")).toContainText("Activity hidden");
    await page.keyboard.press("Space");
    await expect(hide).toBeFocused();
    await expect(page.getByRole("status")).toContainText("Activity shown");

    const last = list.getByRole("listitem").last().getByRole("button").first();
    await last.focus();
    await expect(last).toBeInViewport();
    const lastBox = await last.boundingBox();
    const footerBox = await page.locator(".nav-preferences-footer").boundingBox();
    // Routine actions follow the full-width list and cannot cover a focused row.
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(footerBox!.y);
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await assertControlDesign(page);
  });
}

for (const custom of [false, true]) {
  test(`phone menu stays above the scrolled settings footer ${custom ? "with" : "without"} custom items`, async ({ page }) => {
    await openSpecimen(page, {
      id: custom ? "navigation-preferences-account-custom" : "navigation-preferences-account",
      title: "Account settings", width: 390, presentation: "text",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Reset to default", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const sidebar = page.locator('.sidebar[data-menu-open="true"]');
    await expect(sidebar).toBeVisible();
    const utilities = sidebar.getByRole("group", { name: "View and account controls", exact: true });
    await expect(utilities).toBeInViewport();
    expect(await utilities.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    if (custom) {
      await sidebar.getByRole("button", { name: "My desk", exact: true }).click();
      const child = sidebar.getByRole("link", { name: "Page directory", exact: true });
      await child.focus();
      await expect(child).toBeInViewport();
      expect(await child.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
    }
    await sidebar.getByRole("button", { name: "Close menu", exact: true }).click();
    await page.getByRole("button", { name: "Reset to default", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Reset to default", exact: true })).toBeInViewport();
  });
}

for (const state of ["error", "pending"] as const) {
  test(`navigation footer remains usable during a ${state} save on a phone`, async ({ page }) => {
    await openSpecimen(page, { id: `navigation-preferences-${state}`, title: "Your rail", width: 320, presentation: "icons" });
    const hide = page.getByRole("button", { name: "Hide: Activity", exact: true });
    await hide.focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Save rail", exact: true }).click();
    if (state === "error") {
      await expect(page.getByText("Your rail could not be saved. Try again.", { exact: true })).toBeVisible();
      const last = page.getByRole("button", { name: "Hide: Around NJ", exact: true });
      await last.focus();
      const button = await last.boundingBox();
      const footer = await page.locator(".nav-preferences-footer").boundingBox();
      expect(button!.y + button!.height + 6).toBeLessThanOrEqual(footer!.y);
      await page.getByRole("button", { name: "Save rail", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Save rail", exact: true })).toBeInViewport();
    } else {
      await expect(page.getByRole("button", { name: /^.+: Saving…$/, exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Show: Activity", exact: true })).toBeDisabled();
    }
    await assertControlDesign(page);
  });
}

test("account settings shows the full navigation list at desktop width", async ({ page }) => {
  await openSpecimen(page, { id: "navigation-preferences-account", title: "Account settings", width: 1280, presentation: "icons" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("heading", { name: "Your rail", exact: true }).scrollIntoViewIfNeeded();
  const sizes = await page.getByRole("list", { name: "Your rail order" }).evaluate((list) => ({
    client: list.clientHeight,
    scroll: list.scrollHeight,
    namesFit: Array.from(list.querySelectorAll<HTMLElement>(".nav-preference-name"))
      .every((name) => name.scrollWidth <= name.clientWidth + 1),
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  expect(sizes.namesFit).toBe(true);
  await assertControlDesign(page);
});

for (const [width, height] of [[320, 200], [1280, 400]]) {
  test(`short navigation viewport ${width}x${height} uses page scrolling`, async ({ page }) => {
    await openSpecimen(page, { id: "navigation-preferences", title: "Your rail", width, presentation: "text" });
    await page.setViewportSize({ width, height });
    const geometry = await page.locator(".nav-preferences").evaluate((panel) => {
      const list = panel.querySelector("ol")!;
      const footer = panel.querySelector(".nav-preferences-footer")!;
      return {
        client: list.clientHeight, scroll: list.scrollHeight,
        footerInside: footer.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom,
        namesFit: Array.from(list.querySelectorAll<HTMLElement>(".nav-preference-name, .nav-preference-required"))
          .every((name) => name.scrollWidth <= name.clientWidth + 1 && name.scrollHeight <= name.clientHeight + 1),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    expect(geometry.footerInside).toBe(true);
    expect(geometry.namesFit).toBe(true);
    expect(geometry.overflow).toBe(false);
    const last = page.getByRole("button", { name: "Hide: Around NJ", exact: true });
    await last.focus();
    await expect(last).toBeInViewport();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Show: Around NJ", exact: true })).toBeFocused();
    const save = page.getByRole("button", { name: "Save rail", exact: true });
    await save.focus();
    await expect(save).toBeInViewport();
    await expect(save).toBeFocused();
    // Enabling Save can start its token-based background transition. Check the settled role.
    await expect.poll(() => save.evaluate((button) => button.getAnimations()
      .filter((animation) => animation.playState === "running").length)).toBe(0);
    await assertControlDesign(page);
  });
}

test("real account shell keeps complete names in one row at 320px", async ({ page }) => {
  await openSpecimen(page, { id: "navigation-preferences-account", title: "Account settings", width: 320, presentation: "text" });
  const rows = await page.getByRole("list", { name: "Your rail order" }).evaluate((list) => Array.from(list.children).map((row) => ({
    height: row.getBoundingClientRect().height,
    namesFit: Array.from(row.querySelectorAll<HTMLElement>(".nav-preference-name, .nav-preference-required"))
      .every((name) => name.scrollWidth <= name.clientWidth + 1 && name.scrollHeight <= name.clientHeight + 1),
  })));
  for (const row of rows) {
    expect(row.height).toBeCloseTo(44, 0);
    expect(row.namesFit).toBe(true);
  }
  await assertControlDesign(page);
});

for (const width of [320, 1280]) {
  test(`compact settings keep custom item and section controls usable at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "navigation-preferences-custom", title: "Your custom navigation", width, presentation: "text" });
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    const list = page.getByRole("list", { name: "Your rail order" });
    const customRows = list.locator('[data-custom="true"]');
    await expect(customRows).toHaveCount(3);
    const contained = await customRows.evaluateAll((rows) => rows.every((row) => {
      const bounds = row.getBoundingClientRect();
      return Array.from(row.querySelectorAll("button")).every((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
      });
    }));
    expect(contained).toBe(true);

    await page.getByRole("button", { name: "Edit My desk", exact: true }).click();
    const editor = page.locator(".custom-nav-editor");
    await expect(editor.getByLabel("Label (required)", { exact: true })).toBeFocused();
    const childList = editor.getByRole("list", { name: "Span plank order" });
    await expect(childList.getByRole("listitem")).toHaveCount(2);
    const placement = await childList.evaluate((element) => {
      const listBox = element.getBoundingClientRect();
      const sectionBox = element.closest(".custom-nav-section")!.getBoundingClientRect();
      const headingBox = element.closest(".custom-nav-section")!.querySelector("h3")!.getBoundingClientRect();
      return { listLeft: listBox.left, listRight: listBox.right, sectionLeft: sectionBox.left, sectionRight: sectionBox.right, listTop: listBox.top, headingBottom: headingBox.bottom };
    });
    expect(placement.listLeft).toBeCloseTo(placement.sectionLeft, 0);
    expect(placement.listRight).toBeCloseTo(placement.sectionRight, 0);
    expect(placement.listTop).toBeGreaterThanOrEqual(placement.headingBottom);
    const childLayout = await childList.evaluate((element) => Array.from(element.children).every((row) => {
      const bounds = row.getBoundingClientRect();
      const parts = row.querySelectorAll(".nav-preference-identity, .nav-preference-state, .nav-preference-controls");
      return Array.from(parts).every((part) => {
        const box = part.getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.bottom <= bounds.bottom + 1;
      });
    }));
    expect(childLayout).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const apply = editor.getByRole("button", { name: "Apply span", exact: true });
    await apply.focus();
    await expect(apply).toBeInViewport();
    await apply.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit My desk", exact: true })).toBeFocused();

    await page.getByRole("button", { name: "Reset to default", exact: true }).click();
    const cancel = page.getByRole("button", { name: "Cancel reset", exact: true });
    await expect(cancel).toBeFocused();
    await expect(cancel).toBeInViewport();
    const confirmation = await page.getByRole("group", { name: "Confirm rail reset" }).boundingBox();
    expect(confirmation).not.toBeNull();
    for (const name of ["Save rail", "Cancel changes"]) {
      const routine = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(routine).not.toBeNull();
      expect(confirmation!.x + confirmation!.width <= routine!.x
        || routine!.x + routine!.width <= confirmation!.x
        || confirmation!.y + confirmation!.height <= routine!.y
        || routine!.y + routine!.height <= confirmation!.y).toBe(true);
    }
    await cancel.press("Enter");
    const reset = page.getByRole("button", { name: "Reset to default", exact: true });
    await expect(reset).toBeFocused();
    // Removing the confirmation can put Reset under the pointer. Let Chromium
    // apply hover on the next frame, then wait for its resulting transition.
    await reset.evaluate(async (button) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await Promise.all(button.getAnimations().map((animation) => animation.finished));
    });
    await assertControlDesign(page);
  });
}
