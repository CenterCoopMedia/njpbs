import { expect, test, type Locator, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

async function expectUsablePicker(root: Locator | Page, page: Page, width: number) {
  const picker = root.getByRole('dialog', { name: 'Choose an image', exact: true });
  await expect(picker).toBeVisible();
  const card = picker.locator('.media-picker-card').filter({ hasText: 'Story image' });
  await expect(card).toBeVisible();
  expect(await card.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  if (width === 1280) {
    const point = await page.getByRole('button', { name: 'Preview', exact: true }).evaluate(element => {
      const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    expect(await page.locator('.media-picker-overlay').evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)).toBe(true);
  }
  return { picker, card };
}

test('an open image picker retains search focus and DOM when Details changes modality', async ({ page }) => {
  await openSpecimen(page, { id: 'study-reference-post', title: 'Post', width: 390, presentation: 'icons' }, { normalizeGeneratedIds: false });
  const headline = page.getByRole('textbox', { name: 'Headline', exact: true });
  const draft = `${await headline.inputValue()} retained modal draft`;
  await headline.fill(draft);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const opener = page.locator('[data-image-role="leadMedia"] > summary');
  await opener.click();
  const picker = page.getByRole('dialog', { name: 'Choose an image', exact: true });
  const search = picker.getByRole('searchbox', { name: 'Search images', exact: true });
  await search.fill('Draft search');
  await search.evaluate(element => { (window as any).__pickerSearch = element; });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('Draft search');
    expect(await search.evaluate(element => (window as any).__pickerSearch === element)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab'); await expect(search).toBeFocused();
  }
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(headline).toHaveValue(draft);
});

for (const width of [390, 1280]) {
for (const role of ['heroImage', 'heroBackgroundImage']) {
  test(`${width}px Post ${role} picker uses its modal layer and preserves the other image role`, async ({ page }) => {
    await openSpecimen(page, { id: 'study-reference-post', title: 'Post', width, presentation: 'icons' }, { normalizeGeneratedIds: false });
    const headline = page.getByRole('textbox', { name: 'Headline', exact: true });
    const edited = `${await headline.inputValue()} unsaved picker draft`;
    await headline.fill(edited);
    if (width === 390) await page.getByRole('button', { name: 'Details', exact: true }).click();
    const pane = page.locator('#editor-details-pane');
    const root = width === 390 ? pane : page;
    const selected = page.getByRole('textbox', { name: role === 'heroImage' ? 'Lead image' : 'Hero background image', exact: true, includeHidden: true });
    const other = role === 'heroImage' ? page.locator('#record-post-heroBackgroundImage') : page.getByRole('textbox', { name: 'Lead image', exact: true, includeHidden: true });
    const otherValue = await other.inputValue();
    const details = pane.locator(`[data-image-role="${role === 'heroImage' ? 'leadMedia' : role}"]`);
    let opener = details.locator('summary');
    await opener.click();
    if (role === 'heroBackgroundImage') {
      opener = details.getByRole('button', { name: /Change.*background image/i });
      await opener.click();
    }
    const { picker, card } = await expectUsablePicker(root, page, width);
    await picker.getByRole('searchbox', { name: /Search/ }).fill('image');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(pane).toHaveAttribute('open');
    await expect(opener).toBeFocused();
    await details.getByRole('button', { name: /(?:Choose|Change).*image/i }).click();
    await expectUsablePicker(root, page, width);
    await card.click();
    await expect(picker).toHaveCount(0);
    await expect(selected).toHaveValue('Story image');
    await expect(other).toHaveValue(otherValue);
    await details.getByRole('button', { name: /Change.*image/i }).click();
    await expect((await expectUsablePicker(root, page, width)).card).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await expect(headline).toHaveValue(edited);
  });
}

test(`${width}px Home hero artwork picker uses its modal layer with the same canonical field`, async ({ page }) => {
  await openSpecimen(page, { id: 'study-reference-page', title: 'Page', width, presentation: 'icons' }, { normalizeGeneratedIds: false });
  await page.getByRole('button', { name: 'Edit Home hero', exact: true }).click();
  const pane = page.locator('#editor-details-pane');
  await pane.getByRole('combobox', { name: 'Selection', exact: true }).selectOption('manual');
  await pane.getByRole('button', { name: 'Add a story with a URL', exact: true }).click();
  const image = pane.getByRole('textbox', { name: 'Story image', exact: true });
  await image.evaluate(element => { (window as any).__heroImageField = element; });
  await pane.getByRole('button', { name: /Choose story image/i }).click();
  const { card } = await expectUsablePicker(width === 390 ? pane : page, page, width);
  await card.click();
  await expect(image).toHaveValue('Story image');
  expect(await image.evaluate(element => (window as any).__heroImageField === element)).toBe(true);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Home hero', exact: true }).click();
  await expect(image).toHaveValue('Story image');
  expect(await image.evaluate(element => (window as any).__heroImageField === element)).toBe(true);
});
}
