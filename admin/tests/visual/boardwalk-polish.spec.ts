import { expect, test, type Page } from "./fixtures";
import { visualSpecimenUrl, type VisualSpecimenPair } from "../../src/lib/visual-specimens";

// These are interaction/geometry regressions, not frozen-clock snapshot baselines.
async function openSpecimen(page: Page, pair: VisualSpecimenPair) {
  await page.setViewportSize({ width: pair.width, height: pair.width >= 1024 ? 900 : 844 });
  await page.goto(visualSpecimenUrl("/gallery.html", pair));
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}
test.beforeEach(async ({ page }) => {
  // Serve fixture assets through Playwright so the sandboxed browser needs no local-network access.
  await page.route("http://127.0.0.1:*/**", async route => {
    // Cold Vite asset connections can reset (#3691). Retry only fixture GET resets,
    // once inside the proxy; HTTP errors and non-idempotent requests still fail.
    const response = await route.fetch({ maxRetries: route.request().method() === "GET" ? 1 : 0 });
    await route.fulfill({ response });
  });
  await page.route("https://**/*", route => route.abort());
});

for (const width of [1280, 390]) {
  test(`editor return navigation stays reachable at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "study-reference-page", title: "Home", width, presentation: "icons" });
    // The current shared chrome replaces the old overlapping Back link with Pages.
    if (width === 390) {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const home = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Home", exact: true });
      await expect(home).toBeVisible();
      await home.click({ trial: true });
      await page.getByRole("button", { name: "Close menu", exact: true }).click();
    } else {
      const pages = page.locator(".workspace-document-bar").getByRole("link", { name: "Back to pages", exact: true });
      await expect(pages).toBeVisible();
      await expect(pages).toHaveAttribute("href", "/content");
      await pages.click({ trial: true });
    }
    await expect(page.locator(".editor-back")).toHaveCount(0);
    await expect(page.locator(".workspace-chrome")).toHaveJSProperty("offsetTop", 0);
  });
}

for (const width of [1280, 390]) {
  test(`Page settings show the full Social image value and version at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "study-reference-page", title: "Home", width, presentation: "icons" });
    if (width === 390) await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByRole("tab", { name: "Page", exact: true }).click();
    const social = page.getByRole("textbox", { name: "Social image", exact: true });
    await social.scrollIntoViewIfNeeded();
    await expect(social).toHaveValue("No image selected");
    const size = await social.evaluate((element: HTMLInputElement) => {
      const style = getComputedStyle(element), canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = style.font;
      return { text: context.measureText(element.value).width,
        available: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) };
    });
    expect(size.available).toBeGreaterThan(size.text);
    const version = page.locator(".lifecycle-version-label");
    await version.scrollIntoViewIfNeeded();
    await expect(version).toHaveText("Version 51");
    const lines = await version.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => rect.top)).size;
    });
    expect(lines).toBe(1);
  });

  test(`milestone count stays together in a minimum-width dashboard module at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "newsroom-home", title: "Newsroom", width, presentation: "text" });
    await page.getByText("Build and publication details", { exact: true }).click();
    const milestone = page.getByRole("region", { name: "Milestone status", exact: true });
    // Exercise the existing 14rem minimum module width, even on a wide viewport.
    await milestone.locator("..").evaluate((element: HTMLElement) => { element.style.flex = "0 0 14rem"; element.style.maxWidth = "14rem"; });
    const count = milestone.getByText("226 of 330 closed", { exact: true });
    await count.scrollIntoViewIfNeeded();
    const lines = await count.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => rect.top)).size;
    });
    expect(lines).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });

  test(`Newsletter phone preview names its hidden state and retains the empty standard band at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "home-v2-arrangement", title: "Home", width, presentation: "text" });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Newsletter signup", exact: true }).click();
    await page.getByRole("button", { name: "Edit Newsletter signup", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Newsletter signup", exact: true });
    const panel = dialog.getByRole("complementary", { name: "Component phone preview" });
    if (width === 390) await panel.getByRole("button", { name: "Expand component preview", exact: true }).click();
    await expect(panel.locator("iframe").contentFrame().getByRole("heading", { name: "Get the NJ PBS email newsletter", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /^Remove section from page/ }).click();
    await expect(panel.getByRole("status")).toHaveText("Newsletter signup is hidden from the page.");
    await expect(panel.locator("iframe")).toHaveCount(0);
    await dialog.getByRole("button", { name: /^Add section to page/ }).click();
    await expect(panel.locator("iframe").contentFrame().getByRole("heading", { name: "Get the NJ PBS email newsletter", exact: true })).toBeVisible();
  });
}
