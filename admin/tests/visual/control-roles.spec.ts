import { installProofFonts, expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

test("disabled destructive confirmations retain their inverse label", async ({ page }) => {
  await openSpecimen(page, { id: "control-roles", title: "Controls", width: 390, presentation: "text" });
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const confirmation = page.getByRole("button", { name: "Deleting example…", exact: true });
  await expect(confirmation).toBeDisabled();
  await expect(confirmation).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(confirmation).toHaveCSS("background-color", "rgb(173, 37, 61)");
  await page.getByRole("button", { name: "Close example", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`shared controls retain names, target sizes and stable pending width at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "control-roles", title: "Controls", width, presentation: "icons" });
    const idle = page.getByRole("button", { name: "Settings: idle", exact: true });
    await expect(idle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(idle).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    const target = await idle.boundingBox();
    expect(target?.width).toBe(36);
    expect(target?.height).toBe(36);
    expect((await page.getByRole("button", { name: "Edit: compact control", exact: true }).boundingBox())?.height).toBe(32);
    expect((await page.getByRole("button", { name: "Preview: comfortable control", exact: true }).boundingBox())?.height).toBe(44);
    const help = page.getByRole("button", { name: "About Section title", exact: true });
    expect((await help.boundingBox())?.height).toBe(28);
    await idle.focus();
    await expect(idle).toBeFocused();
    await expect(idle).toHaveCSS("outline-style", "solid");
    await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText("Settings: idle");
    await page.keyboard.press("Escape");
    await expect(idle).toBeFocused();
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    const previewIcon = preview.locator(".async-action-icon-slot > svg");
    await expect(previewIcon).toBeVisible();
    expect((await previewIcon.boundingBox())?.width).toBe(18);
    const before = await preview.boundingBox();
    await preview.click();
    const pending = page.getByRole("button", { name: "Preview: Preparing a saved preview of this revision…", exact: true }).last();
    const after = await pending.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveAttribute("aria-disabled", "true");
    await pending.dispatchEvent("click");
    await expect(pending).toBeFocused();
    await expect(page.getByRole("status").last()).toHaveText("Preparing a saved preview of this revision…");
    const unavailable = page.getByRole("button", { name: "Unavailable", exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveCSS("color", "rgb(123, 135, 152)");
    await expect(unavailable).toHaveCSS("border-top-color", "rgb(182, 193, 206)");
    await expect(unavailable).toHaveCSS("opacity", "0.55");
    await expect(page.getByRole("button", { name: "Review & publish", exact: true }).locator("svg")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Save draft", exact: true }).locator("svg path")).toHaveCount(2);
    const remove = page.getByRole("button", { name: "Remove", exact: true });
    await expect(remove).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(remove).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(remove.locator("svg")).toHaveCount(1);
    await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test("coarse pointer controls retain 44px targets without enlarging glyphs or fields", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 390, height: 800 } });
  await installProofFonts(context);
  const page = await context.newPage();
  await openSpecimen(page, { id: "control-roles", title: "Controls", width: 390, presentation: "text" });
  expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
  const settings = page.getByRole("button", { name: "Settings: idle", exact: true });
  expect((await settings.boundingBox())?.height).toBe(44);
  await expect(settings).toHaveText("Settings");
  const help = page.getByRole("button", { name: "About Section title", exact: true });
  expect((await help.boundingBox())?.height).toBe(44);
  expect((await help.locator("svg").boundingBox())?.width).toBe(14);
  expect((await page.getByLabel("Section title", { exact: true }).boundingBox())?.height).toBe(44);
  await expect(page.getByLabel("Section title", { exact: true })).toHaveCSS("font-size", "16px");
  await help.tap();
  await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveText("Use the name readers will recognize.");
  await context.close();
});

test("phone text presentation keeps async words visible and pending names include them", async ({ page }) => {
  await openSpecimen(page, { id: "control-roles", title: "Controls", width: 390, presentation: "text" });
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  const label = preview.locator(".async-action-copy");
  expect((await label.boundingBox())!.width).toBeGreaterThan(30);
  const before = await preview.boundingBox();
  await preview.click();
  const pending = page.getByRole("button", { name: "Preview: Preparing a saved preview of this revision…", exact: true }).last();
  await expect(pending).toHaveAccessibleName("Preview: Preparing a saved preview of this revision…");
  expect((await pending.locator(".async-action-copy").boundingBox())!.width).toBeGreaterThan(30);
  expect((await pending.boundingBox())!.width).toBe(before!.width);
});

test("shared type follows the browser's default text size", async ({ page }) => {
  await openSpecimen(page, { id: "control-roles", title: "Controls", width: 390, presentation: "text" });
  for (const size of [20, 32]) {
    await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
    await expect(page.locator("body")).toHaveCSS("font-size", `${size * 0.875}px`);
    await expect(page.getByRole("heading", { name: "Control roles and states", exact: true })).toHaveCSS("font-size", `${size * 1.25}px`);
    await expect(page.locator('label[for="control-title"]')).toHaveCSS("font-size", `${size * 0.75}px`);
    await expect(page.getByRole("tab", { name: "Section", exact: true })).toHaveCSS("font-size", `${size * 0.75}px`);
    await expect(page.getByText("Draft saved", { exact: true })).toHaveCSS("font-size", `${size * 0.6875}px`);
    await expect(page.getByText("Needs attention", { exact: true })).toHaveCSS("font-size", `${size * 0.625}px`);
    for (const glyph of await page.locator(".async-action-icon-slot > svg").all()) {
      expect((await glyph.boundingBox())!.width).toBeLessThanOrEqual(18);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  }
});

test("the rail retains its target allocation and scrolls its last destination above the footer", async ({ page }) => {
  await openSpecimen(page, { id: "shell-editor", title: "Home", width: 1280, presentation: "icons" });
  const nav = page.getByRole("navigation", { name: "Primary", exact: true });
  const clipped = await nav.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll("a")].filter(link => {
      const target = link.getBoundingClientRect();
      return target.width > 0 && target.top >= box.top && target.top < box.bottom && target.bottom > box.bottom + 1;
    }).map(link => link.textContent);
  });
  expect(clipped).toEqual([]);
  const last = nav.getByRole("link", { name: "Open Around NJ in a new tab", exact: true });
  await last.scrollIntoViewIfNeeded();
  const navBox = await nav.boundingBox();
  const lastBox = await last.boundingBox();
  expect(lastBox!.y).toBeGreaterThanOrEqual(navBox!.y);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(navBox!.y + navBox!.height + 1);
  await expect(page.getByRole("button", { name: "View options", exact: true })).toBeVisible();
});

test("shared tabs change panels by keyboard and preserve the field draft", async ({ page }) => {
  await openSpecimen(page, { id: "control-roles", title: "Controls", width: 1280, presentation: "text" });
  const section = page.getByRole("tab", { name: "Section", exact: true });
  const field = page.getByLabel("Standard field", { exact: true });
  expect((await field.boundingBox())?.height).toBe(40);
  await field.fill("Retained local edit");
  await section.focus();
  await page.keyboard.press("ArrowRight");
  const document = page.getByRole("tab", { name: "Page", exact: true });
  await expect(document).toHaveAttribute("aria-selected", "true");
  await expect(document).toBeFocused();
  // 36px minimum; 13px × 1.4 line box plus 16px padding and 2px border.
  const compactHeight = (await page.getByLabel("Compact field", { exact: true }).boundingBox())!.height;
  expect(compactHeight).toBeGreaterThanOrEqual(36);
  expect(compactHeight).toBeLessThan(37);
  await expect(page.getByLabel("Read-only field", { exact: true })).not.toBeEditable();
  await expect(page.getByLabel("Read-only field", { exact: true })).toHaveValue("Retained stored value");
  await page.keyboard.press("Home");
  await expect(section).toBeFocused();
  await expect(field).toHaveValue("Retained local edit");
  await page.keyboard.press("End");
  await expect(document).toBeFocused();
});

test("unmigrated controls retain 44px targets and fields follow Loose density", async ({ page }) => {
  await openSpecimen(page, { id: "shell-record-saved", title: "Sponsor", width: 1280, presentation: "icons" });
  const action = page.getByRole("button", { name: "Save draft", exact: true });
  const field = page.locator('input.field-control:not([type="checkbox"]):visible').first();
  await expect(field).toBeVisible();
  for (const control of [action, field]) {
    expect((await control.boundingBox())?.height).toBe(44);
  }
  await page.getByRole("button", { name: "View options", exact: true }).click();
  await page.getByRole("radio", { name: "Loose", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-density", "loose");
  expect((await field.boundingBox())?.height).toBe(48);
  // The existing fine-pointer shell header has its own 44px allocation.
  expect((await action.boundingBox())?.height).toBe(44);
});
