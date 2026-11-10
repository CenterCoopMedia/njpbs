import { readFileSync } from "node:fs";
import { expect, test, type Locator } from "./fixtures";
import { openSpecimen } from "./capture";

test("shared bulk trigger feedback survives later owner styles", async ({ page }) => {
  await openSpecimen(page, { id: "media-inspector-bulk", title: "Media bulk inspector", width: 1280, presentation: "text" });
  // Route styles can arrive after the deferred workspace sheet during navigation.
  await page.addStyleTag({ content: readFileSync(new URL("../../src/components/media/MediaBulkInspector.css", import.meta.url), "utf8") });
  const trigger = page.getByRole("button", { name: "Description: Leave unchanged", exact: true });
  await expect(trigger).toHaveCSS("gap", "4px");
  await expect(trigger).toHaveCSS("color", "rgb(38, 56, 196)");
  await trigger.hover();
  await expect(trigger).toHaveCSS("background-color", "rgb(226, 231, 239)");
  await expect(trigger).toHaveCSS("color", "rgb(19, 34, 59)");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveCSS("background-color", "rgb(219, 226, 237)");
  await expect(trigger).toHaveCSS("color", "rgb(19, 34, 59)");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

async function expectRows(panel: Locator) {
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  const rows = panel.locator('button:visible, a[href]:visible');
  expect(await rows.count()).toBeGreaterThan(0);
  const geometry = await rows.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const labels = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement!;
      if (!node.textContent?.trim() || parent.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (rect.width && rect.height && style.clipPath === "none" && style.visibility === "visible") labels.push({ left: rect.left, right: rect.right, text: node.textContent.trim() });
    }
    const icon = element.querySelector('.icon')?.getBoundingClientRect();
    return { name: element.getAttribute('aria-label') ?? element.textContent, left: box.left, right: box.right, height: box.height,
      labels, icon: icon && { left: icon.left, right: icon.right }, viewport: innerWidth };
  }));
  const labelLeft = geometry[0].labels[0]?.left;
  for (const row of geometry) {
    expect(row.labels, String(row.name)).not.toHaveLength(0);
    expect(row.icon, String(row.name)).toBeTruthy();
    expect(row.left, String(row.name)).toBeGreaterThanOrEqual(0);
    expect(row.right, String(row.name)).toBeLessThanOrEqual(row.viewport);
    expect(row.height, String(row.name)).toBeGreaterThanOrEqual(44);
    expect(row.height, String(row.name)).toBeCloseTo(geometry[0].height, 0);
    expect(row.labels[0].left, String(row.name)).toBeCloseTo(labelLeft!, 0);
    expect(row.labels[0].left, String(row.name)).toBeGreaterThan(row.icon!.right);
    expect(row.labels.at(-1)!.right, String(row.name)).toBeLessThanOrEqual(row.right);
  }
}

for (const kind of ["page", "post"] as const) for (const width of [390, 1280]) {
  test(`${kind} header menus keep labeled icon rows at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {id: kind === "post" ? "shell-post-actions" : "study-reference-page", title: kind, width, presentation: "icons"}, {normalizeGeneratedIds: false});
    await page.locator('body').ariaSnapshot();
    await page.getByRole('button', {name: 'Review & publish', exact: true}).click();
    await expectRows(page.getByRole('group', {name: 'Review & publish', exact: true}));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', {name: 'Review & publish', exact: true})).toBeFocused();
    await page.locator('body').ariaSnapshot();
    const more = page.getByRole('button', {name: 'More document actions', exact: true});
    await more.click();
    await expectRows(page.locator('#workspace-more-panel'));
    await expect(page.getByRole('button', {name:'Report a problem', exact:true})).toContainText('Report a problem');
    const deletion = page.getByRole('button', {name:'Delete', exact:true});
    await deletion.click();
    await expect(page.getByRole('button', {name:'Move to recycle bin', exact:true})).toBeFocused();
    await page.getByRole('button', {name:'Cancel', exact:true}).click();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
  });
}

for (const id of ['study-reference-post', 'shell-post-mobile-published']) {
  test(`${id} phone overflow labels and destructive confirmation`, async ({ page }) => {
    await openSpecimen(page, {id, title: id, width:390, presentation:'text'}, {normalizeGeneratedIds:false});
    await page.locator('body').ariaSnapshot();
    await page.getByRole('button',{name:'More document actions',exact:true}).click();
    await expectRows(page.locator('#workspace-more-panel'));
    if (id === 'shell-post-mobile-published') {
      await page.getByRole('button',{name:'Unpublish',exact:true}).click();
      await expect(page.getByRole('button',{name:'Confirm unpublish',exact:true})).toBeFocused();
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
    }
  });
}


test("an unsaved Page does not begin More with an empty group separator", async ({ page }) => {
  await openSpecimen(page, {id:'shell-editor',title:'New Page',width:390,presentation:'icons'}, {normalizeGeneratedIds:false});
  await page.locator('body').ariaSnapshot();
  await page.getByRole('button',{name:'More document actions',exact:true}).click();
  await expect(page.locator('.workspace-secondary-actions .ui-menu-item')).toHaveCount(0);
  await expect(page.locator('.workspace-secondary-separator')).toBeHidden();
});


test("library-only header menus keep labeled danger rows and real disabled reasons at every width", async ({ page }) => {
  const reason = 'Lifecycle actions are not connected in this workspace.';
  await openSpecimen(page, {id:'shell-record-saved',title:'Stored sponsor',width:390,presentation:'icons'}, {normalizeGeneratedIds:false});
  for (const width of [390,1280,1920]) {
    await page.setViewportSize({width,height:width === 390 ? 844 : 900});
    const firstAction = page.locator('.workspace-actions').getByRole('button',{name:'Save draft',exact:true});
    // Measure both edges in the same frame after responsive portals settle.
    await expect.poll(() => firstAction.evaluate(action => {
      const title = document.querySelector('.workspace-title')!;
      return Math.abs(action.getBoundingClientRect().x - title.getBoundingClientRect().x);
    })).toBeLessThanOrEqual(1);
    const more = page.getByRole('button',{name:'More',exact:true});
    await expect(more).toBeVisible();
    await page.locator('body').ariaSnapshot();
    await more.click();
    const panel = page.locator('#workspace-more-panel');
    await expectRows(panel);
    await expect(page.locator('.workspace-actions').getByRole('button',{name:'Delete',exact:true})).toHaveCount(0);
    for (const name of ['Unpublish','Delete']) {
      const row = panel.getByRole('button',{name,exact:true});
      await expect(row).toBeDisabled();
      await expect(row).toHaveAttribute('aria-disabled','true');
      await expect(row).toHaveAccessibleDescription(reason);
      const state = await row.evaluate(element => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--cms-ink-muted)';
        element.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return {color:getComputedStyle(element).color,icon:getComputedStyle(element.querySelector('.icon')!).color,muted};
      });
      expect(state.color).toBe(state.muted);
      expect(state.icon).toBe(state.muted);
      await expect(row).toHaveCSS('cursor','not-allowed');
      await row.hover({force:true});
      await expect(row).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    }
    const reasons = panel.getByText(reason,{exact:true});
    await expect(reasons).toHaveCount(2);
    for (const explanation of await reasons.all()) await expect(explanation).toBeVisible();
    if (width === 390) {
      const help = panel.getByRole('button',{name:'Lifecycle help',exact:true});
      await expect(help).toHaveAccessibleDescription(/^Save your edits before publishing\./);
      await help.click();
      const tooltip = page.getByRole('tooltip',{includeHidden:true});
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText('Save your edits before publishing.');
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(more).toBeFocused();
  }
});
