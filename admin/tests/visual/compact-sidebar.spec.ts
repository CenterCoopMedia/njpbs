import { expect, test, type Page } from "./fixtures";
import { freezeClock, waitForFonts } from "./capture";

const routes = [
  { name: "Home", specimen: "shell-home" },
  { name: "Editorial queue", specimen: "browsing-family-shell", family: "queue" },
  { name: "Activity", specimen: "shell-home" },
  { name: "Pages", specimen: "browsing-family-shell", family: "directory" },
  { name: "editor", specimen: "shell-editor" },
];

async function openRoute(page: Page, route: typeof routes[number], width: number) {
  await freezeClock(page);
  await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "false"));
  await page.route("https://njpbs.org/**", request => request.fulfill({ json: {} }));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/gallery.html?embed=${route.specimen}&guide=1&presentation=icons${route.family ? `&family=${route.family}` : ""}`);
  await page.waitForLoadState("networkidle");
  await waitForFonts(page);
  if (route.name === "Activity") {
    if (width < 620) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  }
}

for (const route of routes) {
  for (const width of [1920, 1280, 390]) {
    test(`${route.name} uses the compact rail and keyboard behavior at ${width}px`, async ({ page }) => {
      await openRoute(page, route, width);
      const rail = page.locator("aside.sidebar");
      const workspace = page.locator(".workspace-shell");
      // Rail adoption must leave the original workspace header owner in place.
      await expect(page.locator(".workspace-header")).toHaveClass(route.name === "Home" || route.name === "Activity"
        ? "workspace-header workspace-header-context" : "workspace-header workspace-editor-document-bar");
      if (width === 390) {
        await expect(rail).toBeHidden();
        const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
        await trigger.click();
        await expect(rail).toHaveCSS("width", "320px");
        await expect(workspace).toHaveAttribute("inert", "");
        const nav = rail.getByRole("navigation", { name: "Primary", exact: true });
        await expect(nav.getByRole("link").first()).toBeFocused();
        const close = rail.getByRole("button", { name: "Close menu", exact: true });
        await close.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(rail.getByRole("button", { name: /Account menu for/ })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        const view = rail.getByRole("button", { name: "View options", exact: true });
        await view.click();
        const panel = page.locator("#workspace-view-options");
        await expect(panel).toBeVisible();
        const bounds = (await panel.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(rail).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(rail).toBeHidden();
        await expect(workspace).not.toHaveAttribute("inert");
        await expect(trigger).toBeFocused();
      } else {
        await expect(rail).toHaveCSS("width", "208px");
        await expect(rail).toHaveCSS("padding", "10px 8px 9px");
        await expect(rail.locator(".nav-item").first()).toHaveCSS("height", "40px");
        const current = rail.locator('.nav-destination-group[data-active="true"] > .nav-destination-main, .primary-nav-list > li > .nav-item.active').first();
        await expect(current).toHaveCSS("box-shadow", "rgb(120, 140, 255) 2px 0px 0px 0px inset");
        const activeSectionLink = rail.locator('.nav-destination-group[data-active="true"] .nav-item').first();
        if (await activeSectionLink.count()) {
          await activeSectionLink.hover();
          await expect(activeSectionLink).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect(current).toHaveCSS("box-shadow", "rgb(120, 140, 255) 2px 0px 0px 0px inset");
        }
        await page.getByRole("button", { name: "Collapse primary navigation", exact: true }).click();
        await expect(rail).toHaveCSS("width", "60px");
        const nav = rail.getByRole("navigation", { name: "Primary", exact: true });
        await page.keyboard.press("Tab");
        for (const link of await nav.getByRole("link").all()) {
          await link.focus();
          await expect(link).toBeFocused();
          const box = (await link.boundingBox())!;
          const viewport = (await nav.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(viewport.x);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.x + viewport.width);
          expect(box.y).toBeGreaterThanOrEqual(viewport.y);
          expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
          await expect(link).toHaveCSS("outline-offset", "-2px");
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
  }
}

for (const route of [routes[0], routes[3]]) {
  test(`${route.name} uses the same phone breakpoint and returns focus when it widens`, async ({ page }) => {
    await openRoute(page, route, 619);
    const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
    await trigger.focus();
    await page.setViewportSize({ width: 620, height: 900 });
    await expect(trigger).toBeHidden();
    const collapse = page.getByRole("button", { name: "Collapse primary navigation", exact: true });
    await expect(collapse).toBeFocused();
    await expect(page.locator("aside.sidebar")).toHaveCSS("width", "208px");
  });
}

test.describe("touch navigation", () => {
  test.use({ hasTouch: true });
  for (const route of [routes[0], routes[3]]) {
    test(`${route.name} keeps 44px touch rows and disclosure targets`, async ({ page }) => {
      await openRoute(page, route, 1280);
      const rail = page.locator("aside.sidebar");
      await expect(rail.locator(".nav-item").first()).toHaveCSS("height", "44px");
      await expect(rail.locator(".nav-destination-toggle").first()).toHaveCSS("width", "44px");
      await expect(rail.locator(".nav-destination-toggle").first()).toHaveCSS("height", "44px");
    });
  }
});

for (const destination of ["body", "outside shell"]) {
  test(`widening preserves focus after the phone trigger loses focus to ${destination}`, async ({ page }) => {
    await openRoute(page, routes[0], 619);
    const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
    await trigger.focus();
    if (destination === "body") {
      await trigger.evaluate(element => (element as HTMLElement).blur());
    } else {
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Outside shell";
        button.id = "outside-shell";
        document.body.append(button);
      });
      await page.locator("#outside-shell").focus();
    }
    await page.setViewportSize({ width: 620, height: 900 });
    await expect(trigger).toBeHidden();
    await expect(page.getByRole("button", { name: "Collapse primary navigation", exact: true })).not.toBeFocused();
    if (destination === "outside shell") await expect(page.locator("#outside-shell")).toBeFocused();
  });
}
