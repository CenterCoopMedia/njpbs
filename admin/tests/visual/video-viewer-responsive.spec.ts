import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [1280, 320]) for (const presentation of ["icons", "text"] as const) {
  test(`video inspector uses the shared header and guards dirty navigation at ${width}px in ${presentation}`, async ({ page }) => {
    await openSpecimen(page, { id: "video-viewer-inspector", title: "Video details", width, presentation }, { normalizeGeneratedIds: false });
    const viewer = page.getByRole("dialog", { name: "Statehouse B-roll, spring session", exact: true });
    const header = viewer.locator(".component-editor-dialog-header");
    const details = viewer.getByRole("complementary", { name: "Video details", exact: true });
    const title = details.getByRole("textbox", { name: "Title", exact: true });
    const save = header.getByRole("button", { name: "Save details", exact: true });
    const more = header.getByRole("button", { name: "More preview actions", exact: true });
    await expect(save).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(details.getByRole("button", { name: "Save details", exact: true })).toHaveCount(0);
    await expect(save).toHaveAttribute("form", await title.evaluate(element => (element as HTMLInputElement).form!.id));
    if (width === 320) {
      await more.click();
      await expect(page.getByRole("menu")).toContainText("Current results · 3 of 24");
      await page.getByRole("menuitemcheckbox", { name: "Favorite", exact: true }).click();
      await more.click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Favorite", exact: true })).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
    } else {
      await expect(header.getByRole("group", { name: "Step through this page", exact: true })).toContainText("3 of 24");
      const favorite = header.getByRole("button", { name: /Favorite/ });
      await favorite.click();
      await expect(favorite).toHaveAttribute("aria-pressed", "true");
    }
    await title.fill("A local video draft");
    await expect(save).toBeEnabled();
    if (width === 320) {
      await more.click();
      await page.getByRole("menuitem", { name: "Next file", exact: true }).click();
    } else await header.getByRole("button", { name: "Next file", exact: true }).click();
    const keep = page.getByRole("button", { name: "Keep editing", exact: true });
    await expect(keep).toBeFocused();
    await keep.click();
    await expect(title).toHaveValue("A local video draft");
    await expect(width === 320 ? more : header.getByRole("button", { name: "Next file", exact: true })).toBeFocused();
    await header.getByRole("button", { name: "Close", exact: true }).click();
    await expect(keep).toBeFocused();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open video viewer", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("video details feedback footer follows the fields at the reported phone width", async ({ page }) => {
  await openSpecimen(page, { id: "video-viewer-inspector", title: "Video details", width: 457, presentation: "text" }, { normalizeGeneratedIds: false });
  await page.setViewportSize({ width: 457, height: 774 });
  const inspector = page.getByRole("complementary", { name: "Video details", exact: true });
  // An unfinished tag displays the real validation footer without a save request.
  await inspector.getByPlaceholder("Add tag…").fill("draft tag");
  await page.locator(".component-editor-dialog-header").getByRole("button", { name: "Save details", exact: true }).click();
  const footer = inspector.locator(".ui-inspector-footer");
  await expect(footer).toContainText("Press Enter or comma to add the tag before saving.");
  const geometry = await inspector.evaluate(element => {
    const footer = element.querySelector<HTMLElement>(".ui-inspector-footer")!;
    const lastSection = element.querySelector<HTMLElement>(".ui-inspector-section:last-child")!;
    const inspectorBox = element.getBoundingClientRect();
    const sectionBox = lastSection.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return { position: getComputedStyle(footer).position, follows: footerBox.top >= sectionBox.bottom - 1, contained: footerBox.bottom <= inspectorBox.bottom + 1 };
  });
  expect(geometry).toEqual({ position: "static", follows: true, contained: true });
});
