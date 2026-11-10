import { expect, test } from "./fixtures";
import { assertControlDesign } from "./control-contract";

for (const width of [320, 1280]) {
  for (const presentation of ["icons"] as const) {
    test(`contextual controls at ${width}px in ${presentation} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/gallery.html?embed=contextual-controls&presentation=${presentation}`);
      await expect(page.getByRole("region", { name: "Contextual list controls" })).toBeVisible();
      const add = page.getByRole("button", { name: "Add tag", exact: true });
      await expect(add).toHaveClass(new RegExp(`action-control-${presentation === "icons" ? "icon" : "text"}`));
      const chipRemove = page.getByRole("button", { name: "Remove tag News", exact: true });
      await expect(chipRemove).toHaveClass(new RegExp(`action-control-${presentation === "icons" ? "icon" : "text"}`));
      await expect(chipRemove.locator("svg")).toBeVisible();
      const staffAdd = page.getByRole("button", { name: "Add staff byline", exact: true });
      await expect(staffAdd).toBeDisabled();
      if (presentation === "icons") {
        await page.locator(".action-control-disabled-trigger").filter({ has: staffAdd }).hover();
        await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText("Add staff byline");
        await page.getByRole("textbox", { name: "New tag", exact: true }).hover();
        await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
        const pdfAdd = page.getByRole("button", { name: "Add PDF notice", exact: true });
        await expect(pdfAdd).toBeDisabled();
        await page.locator(".action-control-disabled-trigger").filter({ has: pdfAdd }).hover();
        await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText("Add PDF notice");
        await page.getByRole("textbox", { name: "New tag", exact: true }).hover();
        await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
      }
      await assertControlDesign(page);
      await page.screenshot({ path: testInfo.outputPath(`contextual-controls-populated-${presentation}-${width}.png`), fullPage: true });

      // Real keyboard activation keeps the native button behavior and input focus.
      await page.getByRole("textbox", { name: "New tag", exact: true }).fill("Keyboard tag");
      await add.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("textbox", { name: "New tag", exact: true })).toBeFocused();
      const removeTag = page.getByRole("button", { name: "Remove tag Keyboard tag", exact: true });
      await removeTag.focus();
      await page.keyboard.press("Space");
      await expect(removeTag).toHaveCount(0);

      // Removing every structured row returns focus to the adjacent row, then Add.
      await page.getByRole("button", { name: "Remove Links 1", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Remove Links 1", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Add link", exact: true })).toBeFocused();

      const customCredit = page.getByRole("textbox", { name: "Add a custom credit", exact: true });
      await customCredit.fill("Keyboard credit");
      await page.getByRole("button", { name: "Add custom credit", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(customCredit).toBeFocused();
      await page.getByRole("button", { name: "Remove Keyboard credit from the byline", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Remove NJ PBS staff from the byline", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(customCredit).toBeFocused();

      await page.getByRole("button", { name: "Remove Meeting notice from notices", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("region", { name: "PDF notices", exact: true }).getByText("PDF notices", { exact: true })).toBeFocused();
      await expect(page.getByText("Add the first meeting notice.", { exact: true })).toBeVisible();
      await assertControlDesign(page);
      await page.screenshot({ path: testInfo.outputPath(`contextual-controls-${presentation}-${width}.png`), fullPage: true });
    });
  }
}
