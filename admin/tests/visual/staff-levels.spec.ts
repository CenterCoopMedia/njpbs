import { expect, test } from "./fixtures";

// Phone cards, the intermediate table, and the full desktop table have distinct
// layout rules. Exercise the new control at one width in each rule band.
for (const width of [320, 768, 1280]) {
  test(`staff level keyboard confirmation, focus and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=users-levels&presentation=icons");
    await page.getByRole("table", { name: "Staff access" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText("Inactive, access removed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry offboarding for Inactive staff member" })).toHaveCount(0);
    const retry = page.getByRole("button", { name: "Retry offboarding for Unfinished shutdown" });
    await expect(retry).toBeVisible();
    await retry.click();
    const shutdown = page.getByRole("group", { name: "Confirm deactivation for Unfinished shutdown" });
    await expect(shutdown).toContainText("revoke active sessions");
    await shutdown.getByRole("button", { name: "Cancel" }).click();
    await expect(retry).toBeFocused();
    const edit = page.getByRole("button", { name: "Edit access level for Existing staff member with a long name" });
    await expect(edit).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit access level for Current owner" })).toBeDisabled();
    await edit.focus();
    await edit.press("Enter");
    const level = page.getByRole("combobox", { name: "Access level for Existing staff member with a long name" });
    await expect(level).toBeFocused();
    await level.selectOption("publisher");
    await expect(page.getByRole("button", { name: "Confirm level for Existing staff member with a long name" })).toBeEnabled();
    const group = page.getByRole("group", { name: "Change access for Existing staff member with a long name" });
    await expect(group).toContainText("publish, withdraw and delete content");
    const bounds = await level.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    if (width === 320) expect(bounds!.width).toBeGreaterThan(220);
    if (width === 1280) expect(bounds!.width).toBeGreaterThan(400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await group.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(edit).toBeFocused();
  });
}
