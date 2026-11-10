import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "./fixtures";
import { openSpecimen } from "./capture";
const open = (page: Parameters<typeof openSpecimen>[0], kind: "page" | "post", width = 1440) => openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width, presentation: "icons" }, { normalizeGeneratedIds: false });
const activate = async (page: Page, control: Locator) => {
  await control.focus();
  await page.keyboard.press("Enter");
};
const openInteractivePost = async (page: Page, width: number) => {
  await page.route("https://njpbs.org/**", route => route.abort());
  await page.setViewportSize({ width, height: width >= 1024 ? 900 : 800 });
  await page.goto("/gallery.html?embed=study-reference-post&presentation=icons");
  await page.getByRole("heading", { name: "Edit post", exact: true }).waitFor();
};

test("headline wraps as one single-line value with independent URL and browser undo", async ({ page }) => {
  await open(page, "post");
  const headline = page.getByRole("textbox", { name: "Headline", exact: true });
  await expect(headline).toHaveCount(1);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  const initialSlug = await slug.inputValue();
  const initial = await headline.inputValue();
  await headline.focus(); await headline.press("Control+End"); await page.keyboard.type(" local change");
  await expect(headline).toHaveValue(`${initial} local change`);
  await expect(slug).toHaveValue(initialSlug);
  const undo = page.locator(".workspace-editing-start").getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeEnabled(); await undo.click();
  const undone = await headline.inputValue();
  expect(undone).not.toBe(`${initial} local change`);
  await page.locator(".workspace-editing-start").getByRole("button", { name: "Redo", exact: true }).click();
  await expect(headline).toHaveValue(`${initial} local change`);
  await headline.press("Control+z"); await expect(headline).toHaveValue(undone);
  await headline.fill(initial);
  await headline.press("Enter");
  await expect(page.locator(".success-notice")).toContainText("Draft saved.");
  await expect(headline).toHaveValue(initial);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(text => navigator.clipboard.writeText(text), `${initial}\nPasted continuation`);
  await headline.focus(); await headline.press("Control+a"); await headline.press("Control+v");
  await expect(headline).toHaveValue(`${initial} Pasted continuation`);
  await headline.press("Control+z"); await expect(headline).toHaveValue(initial);
  await headline.press("Control+y"); await expect(headline).toHaveValue(`${initial} Pasted continuation`);
  await undo.click(); await expect(headline).toHaveValue(initial);
  await page.locator(".workspace-editing-start").getByRole("button", { name: "Redo", exact: true }).click();
  await expect(headline).toHaveValue(`${initial} Pasted continuation`);
  await expect(slug).toHaveValue(initialSlug);
  const summary = page.getByRole("textbox", { name: "Summary", exact: true });
  const initialSummary = await summary.inputValue();
  await page.evaluate(() => navigator.clipboard.writeText("First line\r\nSecond line"));
  await summary.focus(); await summary.press("Control+a"); await summary.press("Control+v");
  await expect(summary).toHaveValue("First line Second line");
  await summary.press("Control+z"); await expect(summary).toHaveValue(initialSummary);
  await summary.press("Control+y"); await expect(summary).toHaveValue("First line Second line");
  await summary.press("Enter");
  await expect(page.locator(".editor-document-save-state")).toHaveText("Captured draft");
  expect(await headline.evaluate(element => element.clientHeight >= element.scrollHeight - 1)).toBe(true);
});

test("phone headline navigation closes Outline before focusing the canonical field", async ({ page }) => {
  await open(page, "post", 390);
  const headline = page.getByRole("textbox", { name: "Headline", exact: true });
  const draft = `${await headline.inputValue()} local draft`;
  await headline.fill(draft);
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  const pane = page.getByRole("dialog", { name: "On this post", exact: true });
  await expect.poll(() => pane.evaluate(element => element.matches(":modal"))).toBe(true);
  await pane.getByRole("button", { name: "Headline & summary", exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(headline).toBeFocused();
  await expect(headline).toHaveValue(draft);
});

test("native multiline text insertion preserves exact undo and redo in the headline", async ({ page }) => {
  await open(page, "post");
  const headline = page.getByRole("textbox", { name: "Headline", exact: true });
  const initial = await headline.inputValue();
  await headline.focus(); await headline.press("Control+a");
  await page.keyboard.insertText("First\nSecond");
  await expect(headline).toHaveValue("First Second");
  await headline.press("Control+z"); await expect(headline).toHaveValue(initial);
  await headline.press("Control+y"); await expect(headline).toHaveValue("First Second");
});

test("canonical TipTap host, selection and history survive panes, focus mode and arrangement", async ({ page }) => {
  await open(page, "post");
  const prose = page.locator(".post-inline-writing [contenteditable=true]").first();
  const initial = await prose.innerText();
  await prose.evaluate(element => { (window as any).__prose = element; });
  await prose.focus(); await prose.press("Control+End"); await page.keyboard.type(" retained text");
  const edited = await prose.innerText(); expect(edited).toContain("retained text");
  await expect(page.locator(".workspace-formatting").getByRole("toolbar")).toBeVisible();
  const undo = page.locator(".workspace-editing-start").getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeEnabled(); await undo.click(); await expect(prose).toHaveText(initial, { useInnerText: true });
  await page.locator(".workspace-editing-start").getByRole("button", { name: "Redo", exact: true }).click();
  await expect(prose).toHaveText(edited, { useInnerText: true });
  await page.getByRole("button", { name: "Focus writing", exact: true }).click();
  await expect(page.locator(".workspace-body")).toHaveAttribute("data-details-open", "false");
  await page.getByRole("button", { name: "Focus writing", exact: true }).click();
  await expect(page.locator(".workspace-body")).toHaveAttribute("data-details-open", "true");
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(prose).toBeHidden();
  await expect(undo).toBeDisabled();
  await expect(page.locator('.editor-bento-card[data-presentation="article-title"]')).toBeHidden();
  await expect(page.locator(".workspace-body")).toHaveAttribute("data-outline-open", "false");
  await page.getByRole("button", { name: "Done arranging", exact: true }).click();
  expect(await prose.evaluate(element => (window as any).__prose === element)).toBe(true);
  await expect(prose).toHaveText(edited, { useInnerText: true });
  await prose.focus(); await prose.press("Alt+F10");
  await expect(page.locator(".workspace-formatting").getByRole("button", { name: "Bold", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(prose).toBeFocused();
});

test("row pencil selects the row and retains every column operation", async ({ page }) => {
  await open(page, "post");
  const row = page.locator(".content-row-editor").first();
  await row.getByRole("button", { name: "Edit row 1", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Row 1", exact: true })).toBeVisible();
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row.locator(".content-row-column[data-selected]")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Three equal columns", exact: true }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Three equal columns", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Row 1", exact: true })).toBeHidden();
  await page.getByRole("tab", { name: "Block", exact: true }).click();
  await expect(page.locator(".editor-selection-details h3")).toHaveText("Row");
});

test("Details opens a visible row editor after leaving Arrange", async ({ page }) => {
  await openInteractivePost(page, 1440);
  const outlineRow = page.locator(".block-outline-jump").filter({ hasText: "Row 1" });
  await activate(page, outlineRow);
  const blockTab = page.getByRole("tab", { name: "Block", exact: true });
  await activate(page, blockTab);
  await expect(page.locator(".editor-selection-details h3")).toHaveText("Row");

  const arrange = page.getByRole("button", { name: "Arrange", exact: true });
  await activate(page, arrange);
  await expect(page.getByRole("heading", { name: "Arrange post content", exact: true })).toBeVisible();
  const editRow = page.locator(".editor-selection-details").getByRole("button", { name: "Edit row", exact: true });
  await activate(page, editRow);

  const dialog = page.getByRole("dialog", { name: "Row 1", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Arrange", exact: true })).toHaveAttribute("aria-pressed", "false");

  const done = dialog.getByRole("button", { name: "Done", exact: true });
  await activate(page, done);
  await expect(dialog).toBeHidden();
  const postTab = page.getByRole("tab", { name: "Post", exact: true });
  await activate(page, postTab);
  await expect(page.getByRole("textbox", { name: "Headline", exact: true })).toBeVisible();
});

test("phone Details opens a visible row editor after leaving Arrange", async ({ page }) => {
  await openInteractivePost(page, 390);

  const outline = page.getByRole("button", { name: "Outline", exact: true });
  await activate(page, outline);
  const outlinePane = page.getByRole("dialog", { name: "On this post", exact: true });
  await expect(outlinePane).toBeVisible();
  const outlineRow = outlinePane.locator(".block-outline-jump").filter({ hasText: "Row 1" });
  await activate(page, outlineRow);
  await expect(outlinePane).toBeHidden();

  const arrange = page.getByRole("button", { name: "Arrange", exact: true });
  await activate(page, arrange);
  const details = page.getByRole("button", { name: "Details", exact: true });
  await activate(page, details);
  const detailsPane = page.getByRole("dialog", { name: "Details", exact: true });
  await expect(detailsPane).toBeVisible();
  const blockTab = detailsPane.getByRole("tab", { name: "Block", exact: true });
  await activate(page, blockTab);
  const editRow = detailsPane.getByRole("button", { name: "Edit row", exact: true });
  await activate(page, editRow);

  const dialog = page.getByRole("dialog", { name: "Row 1", exact: true });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Arrange", exact: true })).toHaveAttribute("aria-pressed", "false");

  const done = dialog.getByRole("button", { name: "Done", exact: true });
  await activate(page, done);
  await expect(dialog).toBeHidden();
  await expect(detailsPane).toBeVisible();
  await expect(editRow).toBeFocused();
});

test("Home hero and Passport expose canonical fields with one grouped outline entry", async ({ page }) => {
  await open(page, "page");
  const passport = page.locator('[data-home-section="home-passport-copy"]');
  await expect(passport.locator(".block-card")).toHaveCount(2);
  await expect(passport.locator(".editor-frame-header:visible")).toHaveCount(1);
  await expect(page.locator(".block-outline-jump").filter({ hasText: "Stream more with PBS Passport" })).toHaveCount(1);
  await page.getByRole("button", { name: "Edit Home hero", exact: true }).click();
  await expect(page.locator("#home-hero-frame")).toHaveAttribute("data-selected", "true");
  await expect(page.locator(".editor-selection-details h3")).toHaveText("Home hero");
  const field = page.locator("#editor-details-selection-panel input").first();
  expect(await field.evaluate(element => Boolean((element as HTMLInputElement).form?.id))).toBe(true);
  await field.evaluate(element => { (window as any).__heroField = element; });
  await page.getByRole("tab", { name: "Page", exact: true }).click();
  await page.getByRole("tab", { name: "Section", exact: true }).click();
  expect(await field.evaluate(element => (window as any).__heroField === element)).toBe(true);
});

test("history and unknown video checks use real unavailable-service states", async ({ page }) => {
  await open(page, "post", 390);
  await expect(page.locator(".editor-resource-warning")).toContainText("could not be checked");
  await page.getByRole("button", { name: "Revision history", exact: true }).click();
  const pane = page.getByRole("dialog", { name: "Details", exact: true });
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("Revision history could not be loaded.");
  await expect(pane.getByRole("button", { name: "Back to details", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(pane).toBeHidden();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const rights = page.getByRole("dialog", { name: "Video rights", exact: true });
  await expect(rights).toBeVisible();
  await expect(rights).toContainText("Video rights are unavailable");
  await expect(rights).toContainText("Sign in to review this video's rights.");
  await expect(rights.getByRole("button", { name: "Save rights", exact: true })).toHaveCount(0);
  await rights.getByRole("button", { name: "Close video rights", exact: true }).click();
  await expect(rights).toHaveCount(0);
  await page.locator(".block-card-video").getByRole("button", { name: /^Edit uploaded video/ }).click();
  await expect(pane).toBeVisible();
  await expect(page.getByRole("tab", { name: "Block", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(pane.getByRole("textbox", { name: "Video title", exact: true })).toHaveCount(1);
});

test("header crop, lead image and byline retain independent canonical owners", async ({ page }) => {
  await open(page, "post");
  await page.locator('[data-image-role="heroBackgroundImage"] summary').click();
  const background = page.getByRole("textbox", { name: "Hero background image", exact: true });
  const lead = page.locator("#record-post-heroImage");
  const originalBackground = await background.inputValue(); const originalLead = await lead.inputValue();
  await page.getByRole("group", { name: "Background crop position", exact: true }).getByRole("button", { name: "Top", exact: true }).click();
  await expect(background).toHaveValue(originalBackground); await expect(lead).toHaveValue(originalLead);
  await expect(page.getByRole("button", { name: "Top", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Center", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.locator(".post-story-meta").getByRole("link", { name: "Sean P. Sullivan", exact: true }).click();
  await expect(page.locator(".editor-byline-details")).toHaveAttribute("open", "");
  await expect(page.getByRole("textbox", { name: "Add a custom credit", exact: true })).toBeVisible();
});

test("deferred Home editors and band artwork remain reachable in the retained inspector", async ({ page }, testInfo) => {
  await open(page, "page");
  const timings: Array<{ name: string; milliseconds: number; fallbackPainted: boolean }> = [];
  const pane = page.locator("#editor-details-selection-panel");
  for (const name of ["NJ Spotlight News", "Newscast", "Newsletter signup", "Passport"]) {
    await page.evaluate(() => {
      (window as any).__openingFallbackPainted = false;
      const sample = () => {
        if (Array.from(document.querySelectorAll('[role="status"]')).some(element => element.textContent?.includes("Opening content details") && element.getBoundingClientRect().height)) (window as any).__openingFallbackPainted = true;
        (window as any).__openingFrame = requestAnimationFrame(sample);
      };
      sample();
    });
    const started = await page.evaluate(() => performance.now());
    await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
    await expect(pane.locator('input:not([type="hidden"]), textarea, select').first()).toBeVisible();
    const measurement = await page.evaluate(start => { cancelAnimationFrame((window as any).__openingFrame); return { milliseconds: performance.now() - start, fallbackPainted: (window as any).__openingFallbackPainted }; }, started);
    timings.push({ name, ...measurement });
    if (["Newsletter signup", "Passport"].includes(name)) await expect(pane.getByRole("textbox", { name: "Background image", exact: true })).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Donor-advised giving", exact: true }).click();
  await page.getByRole("button", { name: /Edit Donor/i }).click();
  await expect(pane.getByRole("textbox", { name: "Background image", exact: true })).toHaveCount(1);
  await expect(pane.getByRole("textbox", { name: "Heading", exact: true })).toBeVisible();
  await testInfo.attach("deferred-editor-openings.json", { body: JSON.stringify(timings, null, 2), contentType: "application/json" });
});

test("long independent slugs wrap in Advanced and the new chrome honors text presentation", async ({ page }) => {
  await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
  for (const name of ["Revision history", "Focus writing"]) await expect(page.getByRole("button", { name, exact: true })).toHaveText(name);
  await page.getByRole("button", { name: "More document actions", exact: true }).click();
  await expect(page.getByRole("button", { name: "Video checks", exact: true })).toHaveText("Video checks");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  const slug = page.getByRole("textbox", { name: "URL slug", exact: true });
  await slug.fill("a-long-independent-slug-that-keeps-its-exact-stored-value-and-wraps-within-the-inspector");
  expect(await slug.evaluate(element => element.clientHeight >= element.scrollHeight - 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("a late PBS Sans load keeps the complete wrapped Summary visible", async ({ page }) => {
  let releaseFont!: () => void;
  const fontGate = new Promise<void>(resolve => { releaseFont = resolve; });
  await page.route("https://media.njpbs.org/cms-media/fonts/*/PBSSans.woff2", async route => {
    await fontGate;
    await route.fulfill({ contentType: "font/ttf", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../site/src/assets/pdf-fonts/PublicSans-Regular.ttf", import.meta.url)) });
  });
  const opening = openSpecimen(page, { id: "shell-restore-confirmation", title: "Restore Post", width: 320, presentation: "icons" }, { normalizeGeneratedIds: false });
  const summary = page.getByRole("textbox", { name: "Summary", exact: true });
  try {
    await expect(summary).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally {
    releaseFont();
  }
  await opening;
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family === "PBS Sans" && font.weight === "400" && font.status === "loaded"))).toBe(true);
  await expect(summary).toHaveValue("A newsroom update prepared for review.");
  await expect.poll(() => summary.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
});
