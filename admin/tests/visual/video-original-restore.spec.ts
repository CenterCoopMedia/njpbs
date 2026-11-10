import { expect, test } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";

for (const width of [1280, 390]) {
  test(`archived original restore stays reachable in both video panes at ${width}px`, async ({ page }) => {
    const requests = await openMediaRefinement(page, width, "icons", { originalState: "archived" });
    const restore = page.getByRole("button", { name: "Restore original", exact: true });
    await expect(restore).toBeVisible();
    await expect(page.locator(".media-dialog-notices")).toContainText("up to 12 hours");
    const transcript = page.getByRole("tab", { name: "Transcript", exact: true });
    if (await transcript.isVisible()) await expect(transcript).toHaveAttribute("aria-selected", "true");
    const check = page.getByRole("button", { name: "Check original status", exact: true });
    await restore.focus();
    await restore.press("Enter");
    await expect(page.locator(".media-dialog-notices")).toContainText("Original restoring");
    await expect(restore).toHaveCount(0);
    await expect(check).toBeFocused();
    expect(requests.filter(endpoint => endpoint === "cmsSourceMediaOriginal")).toHaveLength(2);
    await expect(page.getByRole("button", { name: "Save details", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.route("**/cmsSourceMediaOriginal", route => route.fulfill({ json: { success: true,
      original: { state: "restored", archiveTier: null, checkedAt: "2026-10-17T18:00:00Z" } } }));
    await check.click();
    await expect(page.locator(".media-dialog-notices")).toContainText("Original restored");
    await expect(check).toBeFocused();
    if (await transcript.isVisible()) await expect(transcript).toHaveAttribute("aria-selected", "true");
  });
}

test("original status retry keeps its control in the phone transcript pane", async ({ page }) => {
  await openMediaRefinement(page, 390, "icons");
  await page.getByRole("tab", { name: "Watch & details", exact: true }).click();
  const check = page.getByRole("button", { name: "Check original status", exact: true });
  await expect(check).toBeEnabled();
  await page.route("**/cmsSourceMediaOriginal", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await check.click();
  const notice = page.locator(".media-dialog-notices");
  await expect(notice).toContainText("Original status could not be checked");
  const transcript = page.getByRole("tab", { name: "Transcript", exact: true });
  await transcript.click();
  await page.route("**/cmsSourceMediaOriginal", route => route.fulfill({ json: { success: true,
    original: { state: "available", archiveTier: null, checkedAt: "2026-10-17T18:00:00Z" } } }));
  await notice.getByRole("button", { name: "Check original status", exact: true }).click();
  await expect(notice).toContainText("Original available");
  await expect(check).toBeFocused();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
});
