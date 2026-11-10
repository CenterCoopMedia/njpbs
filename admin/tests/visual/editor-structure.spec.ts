import { expect, test, type Locator, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

async function openEditor(
  page: Page,
  id: string,
  width: number,
  presentation: "text" | "icons" = "text",
): Promise<void> {
  // Interaction checks retain React's IDs so dialog labels and field descriptions
  // continue to resolve after edits. Screenshot baselines use the normal registry.
  await openSpecimen(page, { id, title: id, width, presentation }, { normalizeGeneratedIds: false });
  await expect(page.locator(".content-row-canvas")).toBeVisible();
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
}

async function expectReachable(control: Locator, viewportWidth: number): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  const box = await control.boundingBox();
  if (!box) throw new Error("The control has no visible target");
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
  const minimum = await control.evaluate(element =>
    matchMedia("(any-pointer: coarse)").matches ? 44 : element.classList.contains("button-size-compact") ? 32 : element.classList.contains("button-size-standard") ? 36 : 44,
  );
  expect(box.height).toBeGreaterThanOrEqual(minimum - 0.5);
  expect(box.width).toBeGreaterThanOrEqual(minimum - 0.5);
}

for (const presentation of ["text", "icons"] as const) {
  test(`unequal post columns preserve their proportions and selected text is legible with ${presentation} controls`, async ({ page }) => {
    await openEditor(page, "editor-structure-post", 1280, presentation);
    const left = page.getByRole("group", { name: "Row 1, column 1", exact: true });
    const right = page.getByRole("group", { name: "Row 1, column 2", exact: true });
    const leftBox = await left.boundingBox();
    const rightBox = await right.boundingBox();
    if (!leftBox || !rightBox) throw new Error("The post's two columns did not render");

    expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(2);
    expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(rightBox.x + 1);
    // Borders and fractional grid rounding may add a few pixels, but not erase
    // the authored 8/4 split or turn it into two equal-width containers.
    expect(Math.abs(leftBox.width - rightBox.width * 2)).toBeLessThanOrEqual(4);

    const selected = right.locator("#block-card-editor-structure-post-copy");
    await expect(selected).toHaveAttribute("data-selected", "true");
    const title = selected.locator(".block-card-kind");
    await expect(title).toBeVisible();
    await expect(selected.getByRole("button", { name: /^Edit text \d+$/ })).toBeEnabled();
    const contrast = await title.evaluate(element => {
      const luminance = (color: string): number => {
        const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      let surface: Element | null = element;
      let background = "rgb(255, 255, 255)";
      while (surface) {
        const color = getComputedStyle(surface).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
          background = color;
          break;
        }
        surface = surface.parentElement;
      }
      const foreground = luminance(getComputedStyle(element).color);
      const behind = luminance(background);
      return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await expect(right.locator("#block-card-editor-structure-post-related")
      .getByText("Hidden from page", { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test(`a narrow page keeps its column insertion and editing controls reachable with ${presentation} controls`, async ({ page }) => {
    await openEditor(page, "editor-structure-page", 320, presentation);
    await expectNoPageOverflow(page);
    const emptyColumn = page.getByRole("group", { name: "Row 3, column 3", exact: true });
    const add = emptyColumn.getByRole("button", { name: "Add plank to column 3", exact: true });
    await expectReachable(add, 320);
    await add.focus();
    await page.keyboard.press("Enter");

    const picker = page.getByRole("dialog", { name: "Add content", exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByPlaceholder("Search content types")).toBeFocused();
    await expect(picker).toContainText("Row 3 › Column 3");
    await expectReachable(picker.getByRole("button", { name: "Close content picker", exact: true }), 320);
    await expectReachable(picker.getByRole("button", { name: "Insert block", exact: true }), 320);
    await expectNoPageOverflow(page);
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(add).toBeFocused();

    const edit = page.locator("#block-card-editor-structure-page-copy")
      .getByRole("button", { name: /^Edit text \d+$/ });
    await expectReachable(edit, 320);
    await edit.click();
    const dialog = page.getByRole("dialog", { name: /^text \d+$/ });
    await expect(dialog.getByRole("textbox", { name: "Body", exact: true })).toBeVisible();
    await expectReachable(dialog.getByRole("button", { name: "Done", exact: true }), 320);
    await expectNoPageOverflow(page);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(edit).toBeFocused();
  });
}

test("inserting into a specific column preserves both text edits and placement through save and reopening", async ({ page }) => {
  await openEditor(page, "editor-structure-post", 1280);
  const updated = "Local reporting starts with the people who know their communities.";
  const added = "Follow the continuing coverage from across New Jersey.";
  const original = page.locator("#block-card-editor-structure-post-copy");
  await original.getByRole("button", { name: /^Edit text \d+$/ }).click();
  const dialog = page.getByRole("dialog", { name: /^text \d+$/ });
  await dialog.getByRole("textbox", { name: "Body", exact: true }).fill(updated);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(original.locator(".block-preview-content")).toContainText(updated);

  const right = page.getByRole("group", { name: "Row 1, column 2", exact: true });
  const left = page.getByRole("group", { name: "Row 1, column 1", exact: true });
  await right.getByRole("button", { name: "Add plank to column 2", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add content", exact: true });
  await expect(picker).toContainText("Row 1 › Column 2");
  await picker.getByRole("radio", { name: "text", exact: true }).check();
  await picker.getByRole("button", { name: "Insert block", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Body", exact: true }).fill(added);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();

  await expect(right.locator(".block-preview-content").filter({ hasText: added })).toHaveCount(1);
  await expect(left.locator(".block-preview-content").filter({ hasText: added })).toHaveCount(0);
  await expect(original.locator(".block-preview-content")).toContainText(updated);
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reopen saved post", exact: true }).click();

  await expect(right.locator(".block-preview-content").filter({ hasText: added })).toHaveCount(1);
  await expect(left.locator(".block-preview-content").filter({ hasText: added })).toHaveCount(0);
  await expect(original.locator(".block-preview-content")).toContainText(updated);
  await expect(right.locator("#block-card-editor-structure-post-related")
    .getByText("Hidden from page", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test("the validation state identifies the incomplete field and permits a corrected draft to be saved", async ({ page }) => {
  await openEditor(page, "editor-structure-validation", 390);
  const dialog = page.getByRole("dialog", { name: /^text \d+$/ });
  await expect(dialog).toBeVisible();
  const body = dialog.getByRole("textbox", { name: "Body", exact: true });
  await expect(body).toHaveAttribute("aria-invalid", "true");
  await expect(body).toHaveAccessibleDescription(/Body is required\./);
  await expect(dialog.getByRole("alert")).toContainText("Body is required.");

  const correction = "Reporting from New Jersey, with the context behind the headlines.";
  await body.fill(correction);
  await expect(body).not.toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save page", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reopen saved post", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#block-card-editor-structure-post-copy .block-preview-content")).toContainText(correction);
  await expectNoPageOverflow(page);
});

test("the read-only page exposes no usable editing, insertion or save actions", async ({ page }) => {
  await openEditor(page, "editor-structure-readonly", 320, "icons");
  await expect(page.getByText("Select Edit before changing reviewed content.", { exact: true })).toBeVisible();
  // Inert descendants have no computed accessible name. Inspect the retained
  // native controls directly, then verify keyboard exclusion below.
  const boundary = page.locator(".block-editor > fieldset.editor-readonly-boundary");
  await expect(boundary).toHaveJSProperty("disabled", true);
  await expect(boundary).toHaveJSProperty("inert", true);
  const save = boundary.locator(".block-editor-command-bar button.async-action-button");
  await expect(save.locator(".button-compact-label")).toHaveText("Save page");
  await expect(save).toBeDisabled();
  await expect(boundary.locator('#block-card-editor-structure-page-lead .content-row-toolbar button[data-action="settings"]')).toBeDisabled();
  await expect(boundary.locator('#block-card-editor-structure-page-copy .block-card-head button[data-action="settings"]')).toBeDisabled();
  await expect(boundary.locator('.content-row-column[aria-label="Row 3, column 3"] button[data-action="add-block"]')).toBeDisabled();

  const controlledTargets = await boundary.locator("[aria-controls]").evaluateAll(controls => controls.flatMap(control =>
    (control.getAttribute("aria-controls") ?? "").trim().split(/\s+/).map(id => ({
      id,
      count: id ? control.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`).length : 0,
    })),
  ));
  expect(controlledTargets.length).toBeGreaterThan(0);
  expect(controlledTargets.filter(target => target.count !== 1)).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Native keyboard navigation must skip the frozen canvas, including disclosure
  // summaries; the first available target is the fixture's local reopen control.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Reopen saved page", exact: true })).toBeFocused();
  await expectNoPageOverflow(page);
});
