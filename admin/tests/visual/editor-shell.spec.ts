import { installProofFonts, expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

// Keep phone sheets, mutually exclusive panes and simultaneous Outline + Details.
// Page needs 1440px to fit both columns; Post reaches that state at 1280px.
for (const kind of ["page", "post"] as const) {
  for (const width of kind === "page" ? [320, 1280, 1440] : [320, 1024, 1280]) {
    test(`${kind} shared chrome and pane budget at ${width}px`, async ({ page }) => {
      await openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width, presentation: "icons" }, { normalizeGeneratedIds: false });
      const chrome = page.locator(".workspace-chrome");
      const body = page.locator(".workspace-body");
      await expect(page.getByRole("navigation", { name: "Document sections" })).toHaveCount(0);
      await expect(page.locator(".editor-back")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "More document actions", exact: true })).toHaveCount(1);
      const dimensions = await page.locator(".workspace-shell").evaluate(element => ({
        width: element.getBoundingClientRect().width,
        measured: Number.parseFloat(getComputedStyle(element).getPropertyValue("--editor-chrome-height")),
        actual: element.querySelector(".workspace-chrome")!.getBoundingClientRect().height,
        viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      }));
      expect(dimensions.scroll).toBe(dimensions.viewport);
      expect(dimensions.measured).toBeCloseTo(dimensions.actual, 0);
      if (width >= 1024) {
        expect((await page.locator(".workspace-document-bar").boundingBox())!.height).toBe(58);
        expect((await page.locator(".workspace-editing-bar").boundingBox())!.height).toBe(46);
        const feedbackHeight = await page.locator(".workspace-feedback").evaluate(element => element.getBoundingClientRect().height);
        expect(dimensions.actual - feedbackHeight).toBe(104);
      }
      const bothFit = dimensions.width >= (kind === "post" ? 1220 : 1240);
      await expect(body).toHaveAttribute("data-outline-open", bothFit ? "true" : "false");
      await expect(body).toHaveAttribute("data-details-open", dimensions.width >= 720 ? "true" : "false");
      await page.locator(".content-area").evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect((await chrome.boundingBox())!.y).toBeGreaterThanOrEqual(-1);
      expect((await chrome.boundingBox())!.y).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "Outline", exact: true }).click();
      if (!bothFit) {
        if (dimensions.width < 720) {
          const sheet = page.getByRole("dialog", { name: kind === "post" ? "On this post" : "On this page", exact: true });
          await expect(sheet).toBeVisible();
          await expect.poll(() => sheet.evaluate(element => element.matches(":modal"))).toBe(true);
          await page.keyboard.press("Escape");
          await expect(sheet).toBeHidden();
          await expect(page.getByRole("button", { name: "Outline", exact: true })).toBeFocused();
        } else {
          await expect(body).toHaveAttribute("data-outline-open", "true");
          await expect(body).toHaveAttribute("data-details-open", "false");
          await page.getByRole("button", { name: "Details", exact: true }).click();
          await expect(body).toHaveAttribute("data-outline-open", "false");
          await expect(body).toHaveAttribute("data-details-open", "true");
        }
      }
    });
  }
}

test("Post inspector keeps form ownership, values and DOM through tabs, panes and arrangement", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 1440, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  await slug.evaluate(element => { (window as any).__retainedSlug = element; });
  const initial = await slug.inputValue();
  await slug.fill(`${initial}-local`);
  expect(await slug.evaluate(element => (element as HTMLInputElement).form?.id)).toBeTruthy();
  const title = page.getByRole("textbox", { name: "Headline", exact: true });
  expect(await title.evaluate(element => (element as HTMLInputElement).form?.id)).toBe(await slug.evaluate(element => (element as HTMLInputElement).form?.id));
  await page.getByRole("tab", { name: "Block", exact: true }).click();
  await expect(slug).toBeHidden();
  await page.getByRole("tab", { name: "Post", exact: true }).click();
  await expect(slug).toHaveValue(`${initial}-local`);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  expect(await slug.evaluate(element => (window as any).__retainedSlug === element)).toBe(true);
  const row = page.locator(".block-outline-jump").filter({ hasText: "Row 1" });
  await row.click();
  await page.getByRole("tab", { name: "Block", exact: true }).click();
  await expect(page.locator(".editor-selection-details h3")).toHaveText("Row");
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Arrange post content", exact: true })).toBeVisible();
  await expect(page.locator(".editor-writing-canvas")).toBeHidden();
  await expect(page.locator(".content-outline-shell")).toHaveCount(1);
  await page.getByRole("button", { name: "Done arranging", exact: true }).click();
  await page.getByRole("tab", { name: "Post", exact: true }).click();
  expect(await slug.evaluate(element => (window as any).__retainedSlug === element)).toBe(true);
  await expect(slug).toHaveValue(`${initial}-local`);
});

test("phone Details traps focus, preserves native form ownership and restores its trigger", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  await trigger.click();
  const pane = page.getByRole("dialog", { name: "Details", exact: true });
  await expect.poll(() => pane.evaluate(element => element.matches(":modal"))).toBe(true);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = pane.getByRole("textbox", { name: "URL slug", exact: true });
  expect(await slug.evaluate(element => (element as HTMLInputElement).form?.id)).toBeTruthy();
  await slug.focus();
  for (let index = 0; index < 20; index++) await page.keyboard.press("Tab");
  expect(await pane.evaluate(element => element.contains(document.activeElement))).toBe(true);
  // The tab cycle may end on a help trigger; Escape there dismisses its tooltip first.
  await slug.focus();
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("desktop presentation panes do not block finder or publishing-menu Escape", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 1440, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.locator("h1").click();
  await page.keyboard.press("Control+k");
  const finder = page.getByRole("dialog", { name: "Find a workspace", exact: true });
  await expect(finder).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Review & publish", exact: true }).click();
  await expect(page.getByRole("group", { name: "Review & publish", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Review & publish", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Review & publish", exact: true })).toBeFocused();
});

test("preferences preserve the clean page and account for expanded navigation and text size", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-page", title: "Page", width: 1440, presentation: "text" }, { normalizeGeneratedIds: false });
  const save = page.getByRole("button", { name: "Save draft", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Expand primary navigation", exact: true }).click();
  await expect(page.locator(".workspace-shell")).toHaveJSProperty("clientWidth", 1232);
  await expect(page.locator(".workspace-body")).toHaveAttribute("data-outline-open", "false");
  await page.getByRole("button", { name: /^Density: / }).click();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "More document actions", exact: true }).click();
  await page.getByRole("button", { name: "Workspace preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Workspace preferences", exact: true });
  await expect(preferences).toBeVisible();
  await preferences.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "More document actions", exact: true })).toBeFocused();
  await expect(save).toBeDisabled();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.setViewportSize({ width: 1024, height: 480 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.locator(".workspace-chrome").evaluate(element => {
    const measured = Number.parseFloat(getComputedStyle(element.parentElement!).getPropertyValue("--editor-chrome-height"));
    return Math.abs(measured - element.getBoundingClientRect().height);
  })).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
});

test("phone finder shortcut opens the visible search, and pane help stays in the modal layer", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.locator("h1").click();
  await page.keyboard.press("Control+k");
  const finder = page.getByRole("dialog", { name: "Find a workspace", exact: true });
  await expect(finder).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  const pane = page.getByRole("dialog", { name: "Details", exact: true });
  await pane.getByRole("button", { name: "Advanced", exact: true }).click();
  await pane.getByRole("button", { name: "About URL slug", exact: true }).click();
  await expect(pane.getByRole("tooltip", { includeHidden: true })).toContainText("URL");
  await pane.getByRole("textbox", { name: "URL slug", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
});

test("Enter in a retained Post inspector submits the original save owner", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 1440, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  await slug.fill(`${await slug.inputValue()}-saved-locally`);
  await slug.press("Enter");
  await expect(page.locator(".success-notice").getByText("Draft saved.", { exact: true })).toBeVisible();
  await expect(slug).toHaveValue(/-saved-locally$/);
});

test("save validation reveals and focuses the canonical field in a closed inspector", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  await slug.fill("invalid slug");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(slug).toBeHidden();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(slug).toBeVisible();
  await expect(slug).toBeFocused();
  await expect(slug).toHaveAttribute("aria-invalid", "true");
  await expect(slug).toHaveValue("invalid slug");
});

test("coarse targets and forced-color focus remain usable in the shared editor", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, reducedMotion: "reduce", forcedColors: "active" });
  await installProofFonts(context);
  const page = await context.newPage();
  for (const width of [1280, 390]) {
    await openSpecimen(page, { id: "study-reference-post", title: "Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    for (const name of ["Outline", "Add", "Arrange", "Details", "Preview", "Save draft", "Review & publish"]) {
      const control = page.getByRole("button", { name, exact: true });
      const box = await control.boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
    const outline = page.getByRole("button", { name: "Outline", exact: true });
    await outline.focus();
    expect(await outline.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    if (await outline.getAttribute("aria-expanded") !== "true") await outline.click();
    const pane = page.locator(".editor-workspace-pane-outline");
    const disclosures = pane.locator(".content-outline-node > .button[aria-expanded]:visible");
    await expect(disclosures.first()).toBeVisible();
    if (await disclosures.first().getAttribute("aria-expanded") !== "true") await disclosures.first().click();
    await expect.poll(() => disclosures.count()).toBeGreaterThanOrEqual(3);
    for (const disclosure of await disclosures.all()) {
      const box = await disclosure.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await context.close();
});

test("an inspector field retains DOM, caret and focus when its phone sheet becomes a desktop pane", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  await slug.focus();
  await slug.evaluate((element: HTMLInputElement) => { element.setSelectionRange(3, 8); (window as any).__resizeField = element; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(slug).toBeFocused();
  await expect.poll(() => slug.evaluate((element: HTMLInputElement) => ({ same: (window as any).__resizeField === element, start: element.selectionStart, end: element.selectionEnd }))).toEqual({ same: true, start: 3, end: 8 });
});

for (const presentation of ["text", "icons"] as const) test(`document overflow respects ${presentation} presentation and Escape`, async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation }, { normalizeGeneratedIds: false });
  const trigger = page.getByRole("button", { name: "More document actions", exact: true });
  if (presentation === "text") await expect(trigger).toHaveText("More");
  await trigger.click();
  await expect(page.getByRole("button", { name: "Workspace preferences", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
