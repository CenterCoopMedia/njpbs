import { expect, test, type Locator, type Page } from "./fixtures";
import { fileURLToPath } from "node:url";

const route = "/settings-workspace.html";
const storageKey = "cms.inspector.settings.width";
const splitter = (page: Page) => page.getByRole("separator", { name: "Resize settings preview", exact: true });
test.beforeEach(async ({ page }) => {
  // Fulfill once from committed artwork, without a second request that can
  // outlive the preview frame during reload or route cleanup.
  await page.route("https://njpbs.org/brand/**", async route => {
    const source = new URL(route.request().url());
    await route.fulfill({ path: fileURLToPath(new URL(`../../../site/public${source.pathname}`, import.meta.url)) });
  });
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
async function bannerGeometry(page: Page) {
  const viewport = page.locator('.settings-section-host:not([hidden]) > .settings-public-panel .settings-banner-viewport').first();
  const frame = viewport.locator("iframe");
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) =>
    element.contentDocument?.querySelector(".nj-decides-band")?.getBoundingClientRect().width ?? 0)).toBe(1280);
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) =>
    element.contentDocument?.querySelector<HTMLImageElement>(".nj-decides__logo")?.naturalWidth ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const source = await frame.evaluate((element: HTMLIFrameElement) => {
    const band = element.contentDocument!.querySelector(".nj-decides-band")!;
    const rect = band.getBoundingClientRect();
    const identity = band.querySelector(".nj-decides-band__identity")!.getBoundingClientRect();
    const copy = band.querySelector(".nj-decides-band__copy")!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, layoutWidth: element.contentWindow!.innerWidth,
      horizontal: identity.right <= copy.left };
  });
  await expect.poll(async () => {
    const frameWidth = (await frame.boundingBox())!.width;
    return Math.abs(frameWidth - await viewport.evaluate(element => element.clientWidth));
  }).toBeLessThan(0.5);
  const box = (await viewport.boundingBox())!;
  const available = await viewport.evaluate(element => element.clientWidth);
  expect(source.layoutWidth).toBe(1280);
  expect(source.horizontal).toBe(true);
  expect(box.width).toBeCloseTo(available, 0);
  expect(box.width / source.width).toBeCloseTo(box.height / source.height, 2);
  await expect(viewport.locator(".settings-banner-layout")).toHaveAttribute("aria-hidden", "true");
  await expect(viewport.locator(".settings-banner-layout")).toHaveAttribute("inert", "");
  return { width: box.width, height: box.height, ratio: source.width / source.height };
}

for (const width of [1280, 1920]) {
  test(`settings preview supports drag, keyboard, bounds and saved width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(route);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(message).toBeVisible();
    await message.fill("Retain this unsaved draft");
    const handle = splitter(page);
    await expect(handle).toHaveAttribute("aria-valuenow", "19");
    const controlled = await handle.getAttribute("aria-controls");
    expect(await page.locator(`[id="${controlled}"]`).count()).toBe(1);
    await handle.press("Home");
    await handle.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "18");
    const narrow = await bannerGeometry(page);
    await handle.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "19");
    await handle.press("End");
    const maximum = await handle.getAttribute("aria-valuemax");
    await expect(handle).toHaveAttribute("aria-valuenow", maximum!);
    expect(Number(maximum)).toBeLessThanOrEqual(80);
    await handle.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", maximum!);
    const wide = await bannerGeometry(page);
    expect(wide.width).toBeGreaterThan(narrow.width);
    if (width === 1920) expect(wide.width).toBeGreaterThanOrEqual(800);
    for (const band of [narrow, wide]) expect(band.width / band.height).toBeCloseTo(band.ratio, 1);
    await handle.press("Home");
    // Both drag endpoints are located elements; no viewport-coordinate input.
    await handle.dragTo(page.getByRole("searchbox", { name: "Find a setting", exact: true }));
    await expect(handle).toHaveAttribute("aria-valuenow", maximum!);
    await expect(handle).toBeFocused();
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(maximum);
    await expect(message).toHaveValue("Retain this unsaved draft");
    if (width === 1920) {
      const dragged = await bannerGeometry(page);
      expect(dragged.width).toBeGreaterThanOrEqual(800);
      expect((await page.locator('.settings-section-host:not([hidden]) .settings-section-fields').boundingBox())!.width).toBeGreaterThanOrEqual(512);
    }
    await page.setViewportSize({ width, height: 450 });
    await expect.poll(() => handle.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(450);
    const fields = page.locator('.settings-section-host:not([hidden]) .settings-section-fields');
    const fieldsScroll = await fields.evaluate(element => element.scrollTop);
    const before = await handle.boundingBox();
    const content = page.locator('.settings-section-host:not([hidden]) .settings-section-inspector-content');
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await fields.evaluate(element => element.scrollTop)).toBe(fieldsScroll);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await handle.boundingBox()).toEqual(before);
    await page.reload();
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", maximum!);
    await bannerGeometry(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("saved settings width survives a constrained desktop and phone stacking", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(route);
  await splitter(page).press("End");
  const maximum = (await splitter(page).getAttribute("aria-valuenow"))!;
  expect(Number(maximum)).toBeGreaterThan(50);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => Number(await splitter(page).getAttribute("aria-valuenow"))).toBeLessThan(Number(maximum));
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(maximum);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(splitter(page)).toBeHidden();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Phone draft stays");
  const preview = page.getByRole("complementary", { name: "Preview and publication", exact: true });
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toBeInViewport();
  const band = await bannerGeometry(page);
  expect(band.width / band.height).toBeCloseTo(band.ratio, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", maximum);
  await expect(message).toHaveValue("Phone draft stays");
});

test("each retained settings inspector uses the shared saved width", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(route);
  await splitter(page).press("ArrowLeft");
  for (const name of ["NJ Decides brand", "Header newsletter", "Site navigation", "Coverage labels", "Homepage banner"]) {
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true }).click();
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "20");
    await expect(splitter(page)).toHaveCount(1);
  }
});

for (const width of [1280, 1920, 390]) {
  test(`full-size banner dialog fits, closes with Escape and restores focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(route);
    const button = page.getByRole("button", { name: "Open full-size preview", exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    await button.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Full-size banner preview", exact: true });
    await expect(dialog).toBeVisible();
    const frame = dialog.locator("iframe");
    await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => element.contentWindow?.innerWidth)).toBe(1280);
    await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThan(width === 1920 ? 1279 : width - 100);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expect(dialog.getByRole("button", { name: "Close full-size banner preview", exact: true })).toBeFocused();
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("history keeps a retained banner dialog out of the inactive settings section", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`${route}?section=nj-decides-brand`);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Homepage banner", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open full-size preview", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Open full-size preview", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Full-size banner preview", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "NJ Decides brand", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Full-size banner preview", exact: true })).toBeHidden();
  expect(await page.locator("dialog[open]").count()).toBe(0);
  await page.goForward();
  const banner = page.getByRole("region", { name: "Homepage banner", exact: true });
  await expect(banner).toBeFocused();
  expect(await page.locator("dialog[open]").count()).toBe(0);
  const button = page.getByRole("button", { name: "Open full-size preview", exact: true });
  await button.click();
  await page.getByRole("dialog", { name: "Full-size banner preview", exact: true }).press("Escape");
  await expect(button).toBeFocused();
});

test("the NJ Decides full-size action keeps room for its keyboard focus outline", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`${route}?section=nj-decides-brand`);
  const button = page.getByRole("button", { name: "Open full-size preview", exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  const clearance = await button.evaluate(element => {
    const parent = element.closest(".nj-decides-settings-preview-band")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: box.left - parent.left, bottom: parent.bottom - box.bottom,
      outline: Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset)) };
  });
  expect(clearance.left).toBeGreaterThan(clearance.outline);
  expect(clearance.bottom).toBeGreaterThan(clearance.outline);
});

async function choosePreviewSection(page: Page, id: string, label: string) {
  const selector = page.getByRole("combobox", { name: "Settings section", exact: true });
  if (await selector.isVisible()) await selector.selectOption(id);
  else await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: label, exact: true }).click();
}

async function expectPreviewWidth(frame: Locator, width: 1280 | 390) {
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => element.contentWindow?.innerWidth)).toBe(width);
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => {
    const band = element.contentDocument?.querySelector(".nj-decides-band");
    if (!band) return false;
    const identity = band.querySelector(".nj-decides-band__identity")!.getBoundingClientRect();
    const copy = band.querySelector(".nj-decides-band__copy")!.getBoundingClientRect();
    return element.contentWindow!.innerWidth === 390 ? identity.bottom <= copy.top : identity.right <= copy.left;
  })).toBe(true);
  // The public layout can reflow before ResizeObserver applies its fitting scale.
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => {
    const viewport = element.closest(".settings-banner-viewport")!;
    return Math.abs(element.getBoundingClientRect().width - viewport.clientWidth);
  })).toBeLessThan(0.5);
  const viewportWidth = await frame.evaluate(element => element.closest(".settings-banner-viewport")!.clientWidth);
  expect(viewportWidth).toBeLessThanOrEqual(width);
  await expect.poll(() => frame.evaluate((element: HTMLIFrameElement) => {
    const root = element.contentDocument!.getElementById("home-preview-root")!;
    const viewport = element.closest(".settings-banner-viewport")!;
    return Math.abs(viewport.getBoundingClientRect().height - root.getBoundingClientRect().height * viewport.clientWidth / element.contentWindow!.innerWidth);
  })).toBeLessThan(1);
  await expect(frame.locator("..").locator("..")).toHaveAttribute("aria-hidden", "true");
  await expect(frame.locator("..").locator("..")).toHaveAttribute("inert", "");
}

for (const width of [1280, 1920, 390]) {
  test(`settings width toggle composes both public layouts and retains the choice at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(route);
    const desktop = page.getByRole("button", { name: "Desktop preview", exact: true });
    const mobile = page.getByRole("button", { name: "Mobile preview", exact: true });
    const frame = page.locator('.settings-section-host:not([hidden]) .settings-banner-viewport iframe');
    await expect(desktop).toHaveAttribute("aria-pressed", "true");
    await expectPreviewWidth(frame, 1280);
    await mobile.scrollIntoViewIfNeeded();
    await mobile.focus();
    await mobile.press("Enter");
    await expect(mobile).toHaveAttribute("aria-pressed", "true");
    await expect(desktop).toHaveAttribute("aria-pressed", "false");
    await expect(mobile).toBeFocused();
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await expectPreviewWidth(frame, 390);
    const target = (await mobile.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Preview width keeps this draft");
    await choosePreviewSection(page, "nj-decides-brand", "NJ Decides brand");
    await expect(mobile).toHaveAttribute("aria-pressed", "true");
    await expectPreviewWidth(frame, 390);
    await desktop.click();
    await expectPreviewWidth(frame, 1280);
    await choosePreviewSection(page, "public-homepage-banner", "Homepage banner — Unsaved changes");
    await expect(desktop).toHaveAttribute("aria-pressed", "true");
    await expect(message).toHaveValue("Preview width keeps this draft");
    await expectPreviewWidth(frame, 1280);
    await mobile.click();
    await page.getByRole("button", { name: "Open full-size preview", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Full-size banner preview", exact: true });
    await expectPreviewWidth(dialog.locator("iframe"), 390);
    await dialog.getByRole("button", { name: "Desktop preview", exact: true }).click();
    await expectPreviewWidth(dialog.locator("iframe"), 1280);
    await dialog.getByRole("button", { name: "Close full-size banner preview", exact: true }).click();
    await expect(desktop).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Open full-size preview", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
