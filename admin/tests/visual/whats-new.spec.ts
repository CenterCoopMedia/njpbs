import { expect, test } from "./fixtures";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openSpecimen } from "./capture";

const notesRequest = "**/src/data/whats-new.ts*";
const unreadName = "What's new, unread updates";

for (const width of [1280, 1920, 390]) {
  test(`recent notes stay inside the dialog at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-home", title: "Home", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    const launcher = page.getByRole("button", { name: unreadName, exact: true });
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "What's new", exact: true });
    await expect(dialog.getByRole("heading", { level: 4 }).first()).toBeVisible();
    const dates = await dialog.locator("time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")!));
    // openSpecimen freezes August 20 in station time: July 31 is date 21.
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every(date => date >= "2026-07-31" && date <= "2026-08-20")).toBe(true);
    expect(dates).toEqual([...dates].sort().reverse());
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const close = dialog.getByRole("button", { name: "Close what's new" });
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (process.env.WHATS_NEW_EVIDENCE_DIR) {
      await mkdir(process.env.WHATS_NEW_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WHATS_NEW_EVIDENCE_DIR, `after-${width}.png`) });
    }
    await close.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "What's new", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("unavailable notes keep their unread notification after a reload", async ({ page }) => {
  await openSpecimen(page, { id: "shell-home", title: "Home", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.route(notesRequest, route => route.abort("failed"));
  await page.locator("body").ariaSnapshot();
  await page.getByRole("button", { name: unreadName, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "What's new", exact: true })).toContainText("The notes could not load");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: unreadName, exact: true })).toHaveAttribute("data-unread", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: unreadName, exact: true })).toBeVisible();
});

test("notes that finish loading after dismissal stay unread until opened again", async ({ page }) => {
  await openSpecimen(page, { id: "shell-home", title: "Home", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  let releaseNotes!: () => void;
  const held = new Promise<void>(resolve => { releaseNotes = resolve; });
  await page.route(notesRequest, async route => { await held; await route.continue(); });
  await page.locator("body").ariaSnapshot();
  const request = page.waitForRequest(notesRequest);
  await page.getByRole("button", { name: unreadName, exact: true }).click();
  await request;
  await expect(page.getByRole("dialog", { name: "What's new", exact: true })).toContainText("Loading what's new");
  await page.keyboard.press("Escape");
  const response = page.waitForResponse(notesRequest);
  releaseNotes();
  await response;
  // Hidden notes prove that the response was rendered after the native dialog closed.
  await expect(page.locator(".whats-new-notes h4").first()).toBeAttached();
  const launcher = page.getByRole("button", { name: unreadName, exact: true });
  await expect(launcher).toHaveAttribute("data-unread", "true");
  await launcher.click();
  await expect(page.getByRole("dialog", { name: "What's new", exact: true }).getByRole("heading", { level: 4 }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "What's new", exact: true })).not.toHaveAttribute("data-unread");
});

test("record More menus show the What's new label and return focus at every width", async ({ page }) => {
  await openSpecimen(page, { id: "shell-record-saved", title: "Stored record", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
  for (const width of [390, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("body").ariaSnapshot();
    await page.getByRole("button", { name: "More", exact: true }).click();
    const launcher = page.getByRole("button", { name: /What's new/, exact: false });
    await expect(launcher.getByText("What's new", { exact: true })).toBeVisible();
    expect((await launcher.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await launcher.click();
    await expect(page.getByRole("dialog", { name: "What's new", exact: true }).getByRole("heading", { level: 4 }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});
