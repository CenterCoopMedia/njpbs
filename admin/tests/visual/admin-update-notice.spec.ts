import { expect, test, type Page } from "./fixtures";
import { mkdir } from "node:fs/promises";
import { freezeClock, openSpecimen } from "./capture";

const manifest = {
  schemaVersion: 2,
  status: "current",
  build: { revision: "f".repeat(40), builtAt: "2026-11-04T17:00:00.000Z" },
  milestone: null,
  milestones: null,
};

async function capture(page: Page, name: string) {
  const directory = process.env.ADMIN_UPDATE_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

for (const width of [320, 390, 1280, 1920]) {
  test(`an open tab offers an explicit reload and the existing notes at ${width}px`, async ({ page, context }) => {
    // Keep the fresh tab's real notes inside their calendar window as CI dates advance.
    await freezeClock(context, Date.parse("2026-11-05T17:00:00Z"));
    let checks = 0;
    await page.route("**/admin-status.json", route => {
      checks++;
      return route.fulfill({ json: manifest });
    });
    await openSpecimen(page, { id: "shell-home", title: "Home", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    expect(checks).toBe(0);
    await capture(page, `home-before-${width}`);
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const notice = page.locator(".admin-update-notice");
    await expect(notice).toBeVisible();
    const reload = notice.getByRole("button", { name: "Reload Boardwalk", exact: true });
    const notes = notice.getByRole("link", { name: "What's new (opens in a new tab)", exact: true });
    for (const control of [reload, notes]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await capture(page, `home-after-${width}`);
    await page.emulateMedia({ media: "print" });
    await expect(notice).not.toBeVisible();
    await page.emulateMedia({ media: "screen" });
    // The fresh app needs an authenticated shell. Use the existing local signed-in
    // Settings fixture at the HTML boundary; its real router handles the URL request.
    await context.route("**/guide?whats-new=1", route => route.fulfill({
      status: 302, headers: { Location: "/settings-workspace.html?whats-new=1" },
    }));
    await notes.focus();
    const [freshTab] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
    const dialog = freshTab.getByRole("dialog", { name: "What's new", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 4, name: "Know when Boardwalk has an update" })).toBeVisible();
    const labelledBy = await dialog.getAttribute("aria-labelledby");
    expect(await freshTab.locator(`[id="${labelledBy}"]`).count()).toBe(1);
    await freshTab.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await freshTab.close();
    await expect(notes).toBeFocused();
    expect(checks).toBe(1);
    expect(navigations).toBe(0);
    await Promise.all([page.waitForEvent("domcontentloaded"), reload.click()]);
    expect(navigations).toBe(1);
  });
}

test("an update preserves a real settings draft and Reload respects its exit guard", async ({ page }) => {
  await page.route("**/admin-status.json", route => route.fulfill({ json: manifest }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings-workspace.html");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep these unsaved words after an update");
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const reload = page.getByRole("button", { name: "Reload Boardwalk", exact: true });
  await expect(reload).toBeVisible();
  await expect(draft).toHaveValue("Keep these unsaved words after an update");
  await expect(draft).toBeFocused();
  await reload.click();
  await expect(page.getByRole("dialog", { name: /unsaved/i })).toBeVisible();
  await capture(page, "settings-unsaved-1280");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(draft).toHaveValue("Keep these unsaved words after an update");
  expect(navigations).toBe(0);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(reload).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await capture(page, "settings-unsaved-320");
});

for (const width of [390, 1280]) {
  test(`an update keeps the Live production workspace inside its full-height grid at ${width}px`, async ({ page }) => {
    await page.route("**/src/lib/live-production-access.ts", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'import.meta.env.VITE_LIVE_PRODUCTION_ENABLED === "true"', "true",
      ) });
    });
    await page.route("**/admin-status.json", route => route.fulfill({ json: manifest }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/live-production.html?host=boardwalk");
    const workspace = page.locator(".live-workspace");
    await expect(workspace).toBeVisible();
    await page.getByLabel("Production session").selectOption("rehearsal");
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const notice = page.locator(".admin-update-notice");
    await expect(notice).toBeVisible();
    const shellBounds = (await page.locator(".workspace-shell").boundingBox())!;
    const bodyBounds = (await page.locator(".workspace-body").boundingBox())!;
    const noticeBounds = (await notice.boundingBox())!;
    const workspaceBounds = (await workspace.boundingBox())!;
    const rows = await page.locator(".workspace-shell").evaluate(shell => getComputedStyle(shell).gridTemplateRows.split(" "));
    expect(rows).toHaveLength(2);
    expect(bodyBounds.height).toBeGreaterThan(200);
    expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(bodyBounds.y + 1);
    expect(bodyBounds.y + bodyBounds.height).toBeLessThanOrEqual(shellBounds.y + shellBounds.height + 1);
    expect(workspaceBounds.y + workspaceBounds.height).toBeLessThanOrEqual(shellBounds.y + shellBounds.height + 1);
  });
}
