import { installProofFonts, expect, test } from "./fixtures";
import { openSpecimen } from "./capture";
const open = (page: Parameters<typeof openSpecimen>[0], kind: "page" | "post", width = 1440) => openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width, presentation: "icons" }, { normalizeGeneratedIds: false });

test("Home section counts stay together while adding and deleting draft sections", async ({ page }) => {
  await open(page, "page");
  const expectCount = async (count: number) => {
    await expect(page.locator(".editor-outline-caption")).toHaveText(`${count} sections · reading order`);
    await expect(page.getByText(`${count} sections · Select to inspect, pencil to edit`, { exact: true })).toBeVisible();
  };
  await expectCount(8);
  for (const count of [9, 10]) {
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Text", exact: true }).click();
    await expectCount(count);
  }
  for (const count of [9, 8]) {
    await page.locator(".block-card-prose").last().getByRole("button", { name: /actions$/ }).click();
    await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
    await expectCount(count);
  }
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
});

test("Home state, reading order and source technical controls use the real loaded fixture", async ({ page }) => {
  await open(page, "page");
  await expect(page.locator('.editor-document-state')).toContainText("Draft saved");
  await expect(page.locator('.editor-document-state')).toContainText("v50 live · Newer draft");
  await expect(page.locator('.workspace-feedback')).toBeHidden();
  await expect(page.locator('.editor-selection-path')).toHaveText("Page › NJ Spotlight News");
  await expect(page.locator('.editor-outline-caption')).toHaveText("8 sections · reading order");
  for (const text of ["Fixed position", "Copy + action · move together", "YouTube embed"]) await expect(page.locator('.content-outline').getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText("Published cards could not be loaded.", { exact: false })).toHaveCount(0);
  const pane = page.locator('#editor-details-selection-panel');
  await expect(pane.getByRole("combobox", { name: "Source", exact: true })).toBeDisabled();
  await expect(pane.getByRole("combobox", { name: "Maximum items", exact: true })).toHaveValue("8");
  const details = pane.locator('.editor-technical-details');
  await expect(details).not.toHaveAttribute('open'); await details.locator('summary').click();
  const fields = [pane.getByRole('combobox', { name: 'Layout', exact: true }), pane.getByRole('combobox', { name: 'Card selection', exact: true }), pane.getByRole('textbox', { name: 'More-link label', exact: true })];
  const tops = await Promise.all(fields.map(async field => (await field.boundingBox())!.y));
  expect(tops[0]).toBeLessThan(tops[1]); expect(tops[1]).toBeLessThan(tops[2]);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await fields[0].selectOption('grid'); await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
});

test("Post summaries reveal canonical image controls and preserve independent image roles", async ({ page }) => {
  await open(page, "post");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edit post');
  await expect(page.locator('.editor-document-state')).toContainText('Captured draft');
  await expect(page.locator('.editor-document-state')).toContainText('v29 live · Draft v30');
  await expect(page.locator('.editor-outline-writing')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.editor-outline-writing')).toHaveCSS('background-color', 'rgb(233, 237, 255)');
  expect(await page.locator('.block-outline-copy strong').allTextContents()).toEqual(['Headline & summary', 'Uploaded video', 'Row 1', 'Column 1', 'Story text', 'Column 2', 'Story image', 'Continued story']);
  const background = page.locator('#record-post-heroBackgroundImage'); const lead = page.getByRole('textbox', { name: 'Lead image', exact: true, includeHidden: true });
  const stored = [await background.inputValue(), await lead.inputValue()];
  await background.evaluate(element => { (window as any).__headerField = element; });
  await expect(background).toBeHidden(); await expect(page.getByRole('group', { name: 'Background crop position', exact: true })).toBeHidden();
  const header = page.locator('[data-image-role="heroBackgroundImage"]'); await header.locator('summary').click();
  await page.getByRole('group', { name: 'Background crop position', exact: true }).getByRole('button', { name: 'Top', exact: true }).click();
  expect([await background.inputValue(), await lead.inputValue()]).toEqual(stored);
  await header.locator('summary').click(); await header.locator('summary').click();
  expect(await background.evaluate(element => (window as any).__headerField === element)).toBe(true);
  await page.locator('[data-image-role="leadMedia"] > summary').click();
  await expect(page.getByRole('dialog', { name: /Choose.*image/i })).toBeVisible();
});

test("Arrange exposes the real cross-column mover without replacing TipTap or its history", async ({ page }) => {
  await open(page, 'post');
  await page.locator('.post-inline-writing [contenteditable=true]').first().evaluate(element => element.setAttribute('data-retained-probe', 'moving-prose'));
  const prose = page.locator('[data-retained-probe="moving-prose"]');
  await prose.evaluate(element => { (window as any).__movingProse = element; });
  await prose.focus(); await prose.press('Control+End'); await page.keyboard.type(' retained move');
  const edited = await prose.innerText();
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.locator('.workspace-editing-start').getByRole('button', { name: /^Move to/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Move text', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Destination', exact: true }).selectOption('');
  await dialog.getByRole('button', { name: 'Move content', exact: true }).click();
  await expect.poll(() => prose.evaluate(element => Boolean(element.closest('.content-row-column')))).toBe(false);
  await page.locator('.workspace-editing-start').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => prose.evaluate(element => Boolean(element.closest('.content-row-column')))).toBe(true);
  await page.getByRole('button', { name: 'Done arranging', exact: true }).click();
  expect(await prose.evaluate(element => (window as any).__movingProse === element)).toBe(true);
  await expect(prose).toHaveText(edited, { useInnerText: true });
  await prose.focus(); await page.locator('.workspace-editing-start').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(prose).not.toContainText('retained move');
});

test("command arrows skip unavailable actions and preserve a real rich-text selection", async ({ page }) => {
  await open(page, 'post');
  const commands = page.getByRole('toolbar', { name: 'Post editing commands', exact: true });
  const outline = commands.getByRole('button', { name: 'Outline', exact: true });
  await outline.focus(); await page.keyboard.press('ArrowRight'); await expect(commands.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); const picker = page.getByRole('dialog', { name: /Add content/i }); await expect(picker).toBeVisible();
  await page.keyboard.press('Escape'); await expect(commands.getByRole('button', { name: 'Add', exact: true })).toBeFocused();
  const prose = page.locator('.post-inline-writing [contenteditable=true]').first();
  await prose.focus(); await prose.press('Control+Home'); await prose.press('Control+Shift+ArrowRight');
  await expect.poll(() => prose.evaluate(element => { const editor = (element as any).editor; const { from, to } = editor.state.selection; return editor.state.doc.textBetween(from, to); })).toContain('NEWARK');
  await prose.press('Alt+F10');
  const formatting = page.locator('.workspace-formatting').getByRole('toolbar');
  await expect(formatting.getByRole('button', { name: 'Bold', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(formatting.getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
  await page.keyboard.press('Space'); await expect(prose.locator('em')).toContainText('NEWARK');
});


test("phone Presentation summary closes the modal and reaches its canonical selector without dirtying", async ({ page }) => {
  await open(page, 'post', 390);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Presentation Standard post', exact: true }).click();
  await expect(page.locator('#editor-details-pane')).not.toHaveAttribute('open');
  const presentation = page.getByRole('combobox', { name: 'Presentation', exact: true });
  await expect(presentation).toBeFocused();
  await expect(page.locator('.editor-document-save-state')).toHaveText('Captured draft');
  await presentation.selectOption('multimedia');
  await expect(page.locator('.editor-document-save-state')).toHaveText('Unsaved changes');
});


// #3695: 320 and 390 use the same two-row phone chrome and editing-bar rules
// (cms-workspace.css:1190,1434); keep the narrower case in both presentations.
for (const width of [320]) for (const presentation of ["icons", "text"] as const) {
  test(`phone commands retain labels, density and measured wrapping at ${width}px in ${presentation} mode`, async ({ page }) => {
    await openSpecimen(page, { id: "study-reference-post", title: "Post", width, presentation }, { normalizeGeneratedIds: false });
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    if (presentation === "text") await expect(page.locator('.editor-toolbar-add-label')).toBeVisible();
    await page.getByRole("button", { name: "More document actions", exact: true }).click();
    const density = page.getByRole("button", { name: /^Density:/ });
    await expect(density).toBeVisible();
    const oldDensity = await page.locator("html").getAttribute("data-density");
    await density.click();
    await expect(page.locator("html")).not.toHaveAttribute("data-density", oldDensity!);
    await expect(page.locator(".editor-document-save-state")).toHaveText("Captured draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const dimensions = await page.locator(".workspace-shell").evaluate(element => ({ measured: Number.parseFloat(getComputedStyle(element).getPropertyValue("--editor-chrome-height")), actual: element.querySelector(".workspace-chrome")!.getBoundingClientRect().height }));
    expect(dimensions.measured).toBeCloseTo(dimensions.actual, 0);
  });
}


for (const kind of ["page", "post"] as const) for (const coarse of [false, true]) {
  // The phone document bar puts the navigation menu and the title on one row
  // and the document actions on the next, because the menu does not fit beside the actions.
  test(`390px ${kind} keeps the menu with the title, the actions and the editing bar each on one row with ${coarse ? "coarse" : "fine"} targets and reachable overflow`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, hasTouch: coarse, reducedMotion: "reduce" });
    await installProofFonts(context);
    const page = await context.newPage();
    await open(page, kind, 390);
    const title = await page.getByRole('heading', { level: 1 }).boundingBox();
    const menuControl = await page.getByRole('button', { name: 'Open navigation', exact: true }).boundingBox();
    expect(Math.abs((menuControl!.y + menuControl!.height / 2) - (title!.y + title!.height / 2))).toBeLessThan(2);
    const more = await page.getByRole('button', { name: 'More document actions', exact: true }).boundingBox();
    expect(more!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
    for (const name of ['Preview', 'Save draft', 'Review & publish', 'More document actions']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(Math.abs((box!.y + box!.height / 2) - (more!.y + more!.height / 2))).toBeLessThan(2);
    }
    const outline = await page.getByRole('button', { name: 'Outline', exact: true }).boundingBox();
    for (const name of ['Undo', 'Redo', 'Add', 'Arrange', 'Details', ...(kind === 'post' ? ['Focus writing', 'Revision history'] : [])]) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(Math.abs((box!.y + box!.height / 2) - (outline!.y + outline!.height / 2))).toBeLessThan(2);
      expect(box!.height).toBeGreaterThanOrEqual(coarse ? 44 : 32);
    }
    await page.getByRole('button', { name: 'More document actions', exact: true }).click();
    const menu = page.locator('#workspace-more-panel');
    await expect(menu.getByRole('button', { name: /^Density:/ })).toBeVisible();
    await menu.getByRole('button', { name: 'Find a workspace', exact: true }).click();
    const finder = page.getByRole('dialog', { name: 'Find a workspace', exact: true });
    await expect(finder).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'More document actions', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'More document actions', exact: true }).click();
    if (kind === 'post') {
      await menu.getByRole('button', { name: 'Video checks', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toBeVisible();
    } else await expect(menu.getByRole('button', { name: 'Revision history', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await context.close();
  });
}


test("phone overflow search returns visible focus after pointer use and desktop resize", async ({ page }) => {
  await open(page, 'post', 390);
  const more = page.getByRole('button', { name: 'More document actions', exact: true });
  const menu = page.locator('#workspace-more-panel');
  const finder = page.getByRole('dialog', { name: 'Find a workspace', exact: true });
  await more.click(); await menu.getByRole('button', { name: 'Find a workspace', exact: true }).click();
  await finder.getByRole('searchbox', { name: 'Search workspaces', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(finder).toBeHidden(); await expect(more).toBeFocused();
  await more.click(); await menu.getByRole('button', { name: 'Find a workspace', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape'); await expect(finder).toBeHidden(); await expect(more).toBeFocused();
});
