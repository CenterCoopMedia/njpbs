import { expect, test, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

// The phone editor hides the rail to give the canvas the width. Staff must still reach every
// other destination from inside the editor, so the document bar's menu control opens the rail
// as a drawer above an inert workspace.

const EVIDENCE = process.env.EDITOR_PHONE_NAV_EVIDENCE;

async function capture(page: Page, name: string) {
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
}

for (const pair of [
  { id: "study-reference-post", title: "Post", family: "" },
  { id: "study-reference-page", title: "Page", family: "" },
  ...["directory", "record-list", "library", "media", "queue"].map(family => ({ id: "browsing-family-shell", title: family, family })),
] as const) {
  test(`390px ${pair.title} workspace opens and closes the primary navigation drawer`, async ({ page }) => {
    const goto = page.goto.bind(page);
    if (pair.family) page.goto = (url, options) => goto(`${url}&family=${pair.family}&guide=1`, options);
    try {
      await openSpecimen(page, { ...pair, width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
    } finally { page.goto = goto; }
    const evidenceId = pair.family ? `browsing-${pair.family}` : pair.id;
    const rail = page.locator("aside.sidebar");
    const trigger = page.getByRole("button", { name: "Open navigation", exact: true });

    await expect(rail).toBeHidden();
    await expect(trigger).toBeVisible();
    await capture(page, `${evidenceId}-390-closed`);

    await trigger.click();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    const box = await rail.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBeLessThanOrEqual(390 - 48);
    await expect(nav.getByRole("link").first()).toBeFocused();
    await expect(page.locator(".workspace-shell")).toHaveAttribute("inert", "");
    const close = page.getByRole("button", { name: "Close menu", exact: true });
    await expect(close).toBeVisible();
    await capture(page, `${evidenceId}-390-open`);

    // Tab wraps inside the drawer in both directions.
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("aside.sidebar")))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    // The close control's tooltip takes the first Escape, so leave from a destination instead.
    await nav.getByRole("link").first().focus();

    await page.keyboard.press("Escape");
    await expect(rail).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.locator(".editor-nav-scrim").dispatchEvent("click");
    await expect(rail).toBeHidden();

    // The rail's footer menus open inside the drawer, and their Escape closes only themselves.
    await trigger.click();
    const footerToggles = rail.locator(".sidebar-footer-utilities button[aria-expanded]");
    for (let index = 0; index < await footerToggles.count(); index += 1) {
      await footerToggles.nth(index).click();
      const panel = rail.locator(".sidebar-footer-utilities :is(.view-options-panel, .account-menu-panel)").first();
      await expect(panel).toBeVisible();
      const panelBox = await panel.boundingBox();
      const railBox = await rail.boundingBox();
      expect(panelBox!.x).toBeGreaterThanOrEqual(railBox!.x);
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width + 1);
      if (index === 0) await capture(page, `${evidenceId}-390-footer-menu`);
      // Tab from inside an open footer menu stays in the drawer, including the last one.
      if (index === await footerToggles.count() - 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest("aside.sidebar")))).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest("aside.sidebar")))).toBe(true);
        await expect(rail).toBeVisible();
        await footerToggles.nth(index).click();
        if (await panel.isHidden()) await footerToggles.nth(index).click();
      }
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(rail).toBeVisible();
    }
  });
}

test("1280px editor keeps the rail and shows no phone menu control", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toHaveCount(0);
});

test("resizing an open phone drawer to a wide screen closes it and restores the rail", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
  const shell = page.locator(".app-shell");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("inert", "");
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");

  await page.setViewportSize({ width: 1280, height: 900 });

  await expect(page.locator("aside.sidebar")).toHaveAttribute("data-menu-open", "false");
  await expect(page.locator(".editor-nav-scrim")).toHaveCount(0);
  // Only the drawer's own inert scope is checked: block previews are inert by design.
  await expect(page.locator(".app-shell > [inert]")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toHaveCount(0);
  // With nothing stored, the editor returns to its collapsed default after the drawer closes.
  await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
});

test("collapsed rail retains complete targets and icons at 200% text size", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "true"));
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(`${url}&family=library&guide=1`, options);
  try {
    await openSpecimen(page, { id: "browsing-family-shell", title: "Library", width: 1024, presentation: "text" }, { normalizeGeneratedIds: false });
  } finally { page.goto = goto; }
  const rail = page.locator("aside.sidebar");
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(60);
  await page.addStyleTag({ content: ":root { font-size: 200% !important; }" });
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(104);
  const outer = (await rail.boundingBox())!;
  for (const target of await rail.locator(".primary-nav .nav-item, .primary-nav .nav-item .icon, .account-menu-toggle, .account-avatar").all()) {
    if (!await target.isVisible()) continue;
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
  }
  const navigation = rail.getByRole("navigation", { name: "Primary" });
  await capture(page, "browsing-library-1024-text-200-percent");
  // Every destination, including those below the first viewport, must reveal a
  // complete target and focus ring through the real native scroll owner.
  for (const destination of await navigation.getByRole("link").all()) {
    if (!await destination.isVisible()) continue;
    await destination.focus();
    await expect(destination).toBeFocused();
    const box = (await destination.boundingBox())!;
    const viewport = (await navigation.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(viewport.y);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    expect(box.x).toBeGreaterThanOrEqual(viewport.x);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(await destination.evaluate(element => getComputedStyle(element).outlineOffset)).toBe("-2px");
    expect(await destination.evaluate(element => getComputedStyle(element).outlineColor)).toBe("rgb(173, 193, 255)");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
  await capture(page, "browsing-library-1024-text-200-percent-scrolled");
});
