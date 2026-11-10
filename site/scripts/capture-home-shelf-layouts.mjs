import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const root = process.cwd();
const require = createRequire(root + '/package.json');
const { chromium } = require('playwright');
const [phase, gallery, publicOrigin, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", chromiumSandbox: true });
try {
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce', deviceScaleFactor: 1 });
await context.route('https://**/*', async route => {
 const url = new URL(route.request().url());
 if (['njpbs.org', 'dev-public.example.org'].includes(url.hostname)) {
  const response = await route.fetch({ url: publicOrigin + url.pathname });
  return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
 }
 return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const snap = async (locator, name) => {
 await locator.scrollIntoViewIfNeeded();
 await page.evaluate(() => document.fonts.ready);
 await locator.screenshot({ path: `${output}/${phase}-${name}.png`, animations: 'disabled', caret: 'hide' });
};
for (const width of [1280, 390]) {
 await page.setViewportSize({ width, height: 1000 });
 for (const layout of ['two_features', 'list']) for (const state of (layout === 'list' ? ['filled', 'one', 'empty', 'withdrawn', 'many'] : ['filled', 'one', 'empty', 'withdrawn'])) {
  console.log(JSON.stringify({ phase, layout, state, width }));
  await page.goto(`${gallery}/gallery.html?embed=home-shelf-layouts&layout=${layout}&state=${state}`);
  const sectionName = layout === 'list' ? 'home-posts' : 'home-spotlight';
  await page.locator(`[data-home-section="${sectionName}"]`).getByRole('button', { name: /^Edit / }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Published generation 21.').waitFor();
  const control = dialog.getByRole('combobox', { name: 'Layout', exact: true });
  if (phase === 'after') {
   await control.selectOption('rail');
   await control.focus();
   for (let step = 0; step < (layout === 'list' ? 3 : 2); step++) await control.press('ArrowDown');
   await control.press('Tab');
   if (await control.inputValue() !== layout) throw new Error('Keyboard layout choice failed');
   if ((await control.boundingBox()).height < 44) throw new Error('Layout target is too small');
  }
  await control.focus();
  await snap(dialog, `${layout}-${state}-editor-${width}`);
  const expand = dialog.getByRole('button', { name: 'Expand component preview', exact: true });
  if (await expand.isVisible()) { await expand.focus(); await expand.press('Enter'); }
  const iframe = dialog.locator('iframe.home-preview-frame');
  await iframe.waitFor();
  await iframe.scrollIntoViewIfNeeded();
  const frame = iframe.contentFrame();
  const expected = state === 'many' ? 6 : state === 'empty' ? 0 : layout === 'list' && state === 'filled' ? 3 : state === 'one' ? 1 : layout === 'list' && state === 'withdrawn' ? 2 : state === 'withdrawn' ? 1 : 2;
  await frame.locator('[data-home-card-id]').first().waitFor({ state: expected ? 'attached' : 'detached' });
  const count = await frame.locator('[data-home-card-id]').count();
  if (count !== expected) throw new Error(`Wrong card count ${layout}/${state}: ${count}`);
  if (phase === 'after' && layout === 'list' && await frame.locator('img').count()) throw new Error('List has an image');
  await frame.locator('body').evaluate(async body => {
   await body.ownerDocument.fonts.ready;
   await Promise.all([...body.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
   if ([...body.querySelectorAll('img')].some(img => img.naturalWidth === 0)) throw new Error('Preview fixture artwork failed to load');
  });
  await snap(dialog.locator('.component-phone-viewport'), `${layout}-${state}-phone-preview-${width}`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Editor overflow at ${width}`);
  if (phase === 'after') {
   await dialog.getByRole('button', { name: 'Done', exact: true }).click();
   await page.getByRole('button', { name: 'Save page', exact: true }).click();
   const saved = JSON.parse(await page.locator('[data-home-shelf-saved]').getAttribute('data-home-shelf-saved'));
   const shelf = saved.find(block => block.section === sectionName);
   if (shelf.data.presentation !== layout) throw new Error('Layout did not survive save');
   await page.getByRole('button', { name: 'Reopen saved Home', exact: true }).click();
   await page.locator(`[data-home-section="${sectionName}"]`).getByRole('button', { name: /^Edit / }).click();
   const reopened = page.getByRole('dialog');
   if (await reopened.getByRole('combobox', { name: 'Layout', exact: true }).inputValue() !== layout) throw new Error('Layout did not survive reopen');
  }
  if (layout === 'list' && state === 'many' && width === 390) await page.setViewportSize({ width, height: 1600 });
  await page.goto(`${publicOrigin}/${layout}-${state}.html`);
  const section = page.locator(`section[data-home-section="${sectionName}"]`);
  if (expected) {
   await section.waitFor();
   await section.scrollIntoViewIfNeeded();
   await section.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode().catch(() => {}))));
   await snap(section, `${layout}-${state}-public-${width}`);
   if (phase === 'after') {
    const cols = await section.locator('ul').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    if (cols !== (width === 390 ? 1 : layout === 'list' ? 3 : 2)) throw new Error(`Wrong columns ${layout}/${width}: ${cols}`);
    if (layout === 'list' && state === 'many' && width === 1280) {
     const links = section.locator('.home-shelf__card');
     const first = await links.nth(0).boundingBox();
     const fourth = await links.nth(3).boundingBox();
     if (Math.abs(first.x - fourth.x) > 1) throw new Error('Later List row starts at a different inset');
    }
   }
  } else {
   if (await section.count()) throw new Error('Empty shelf rendered');
   await snap(page.locator('main').first(), `${layout}-${state}-public-${width}`);
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Public overflow at ${width}`);
  await page.setViewportSize({ width, height: 1000 });
 }
 for (const state of ['defaults', 'override']) {
  await page.goto(`${publicOrigin}/hero-${state}.html`);
  await snap(page.locator('.home-editorial'), `hero-${state}-public-${width}`);
 }
 await page.goto(`${gallery}/gallery.html?embed=home-shelf-layouts&surface=hero`);
 await page.getByRole('button', { name: 'Edit Home hero', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Home hero', exact: true });
 await dialog.getByRole('complementary', { name: 'Hero preview' }).waitFor();
 for (const kind of ['article', 'video', 'override']) {
  if (kind === 'video') await dialog.getByRole('button', { name: /New Jersey report fixture.*Supporting/ }).click();
  if (kind === 'override') await dialog.getByRole('button', { name: /Station update fixture.*More stories/ }).click();
  if (phase === 'after') {
   const text = dialog.getByRole('textbox', { name: 'Story button text', exact: true });
   if (kind === 'override') await text.fill('Read the full update');
   if (kind === 'override') await dialog.locator('#home-hero-action-help-override-fixture').scrollIntoViewIfNeeded();
   await text.focus();
   if ((await text.boundingBox()).height < 44) throw new Error('Story button input is too small');
  } else if (kind === 'override') await dialog.getByRole('textbox', { name: 'Destination URL', exact: true }).scrollIntoViewIfNeeded();
  await snap(dialog, `hero-${kind}-editor-${width}`);
 }
 const expand = dialog.getByRole('button', { name: 'Expand component preview', exact: true });
 if (await expand.isVisible()) { await expand.focus(); await expand.press('Enter'); }
 const iframe = dialog.locator('iframe.home-preview-frame');
 await iframe.contentFrame().locator('.home-editorial').waitFor();
 await snap(dialog.locator('.component-phone-viewport'), `hero-override-phone-preview-${width}`);
 await iframe.contentFrame().locator('.home-editorial__overflow').scrollIntoViewIfNeeded();
 await snap(dialog.locator('.component-phone-viewport'), `hero-actions-phone-preview-${width}`);
}
} finally { await browser.close(); }
console.log(JSON.stringify({ event: 'screenshots-complete', phase, output }));
