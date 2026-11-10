import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";
import { assertControlDesign } from "./control-contract";

for (const width of [1280, 390]) {
  test(`unsaved work keeps safe focus and clear action roles at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {
      id: "guide-unsaved-changes", title: "Unsaved work", width, presentation: "text",
    });
    const dialog = page.getByRole("dialog");
    const keep = dialog.getByRole("button", { name: "Keep editing" });
    const discard = dialog.getByRole("button", { name: "Discard and leave" });
    const save = dialog.getByRole("button", { name: "Save and leave" });

    await expect(keep).toBeFocused();
    await expect(keep).toHaveClass(/button-secondary/);
    await expect(discard).toHaveClass(/button-danger-quiet/);
    await expect(save).toHaveClass(/button-primary/);
    for (const next of [discard, save, keep]) {
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
      await expect(next).toBeInViewport();
    }
    await page.keyboard.press("Shift+Tab");
    await expect(save).toBeFocused();
    await assertControlDesign(page);

    const keepBox = await keep.boundingBox();
    const saveBox = await save.boundingBox();
    if (width === 390) expect(saveBox!.y).toBeLessThan(keepBox!.y);
    else expect(keepBox!.x).toBeLessThan(saveBox!.x);
    await test.info().attach(`unsaved-work-${width}.png`, {
      body: await page.screenshot(), contentType: "image/png",
    });
  });
}
