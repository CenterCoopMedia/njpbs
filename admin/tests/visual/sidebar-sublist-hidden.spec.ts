import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const width of [768, 390]) {
  test(`sidebar sections close and reopen at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "false"));
    await openSpecimen(page, {id:'shell-home',title:'Home',width,presentation:'text'}, {normalizeGeneratedIds:false});
    await page.locator('body').ariaSnapshot();
    const nav = page.getByRole('navigation', {name:'Primary',exact:true});
    if (!await nav.isVisible()) await page.getByRole('button', {name:'Open navigation',exact:true}).click();
    for (const name of ['Pages','Posts','All content']) {
      const group = nav.locator('.nav-destination-group').filter({has: page.locator(`button[aria-label$="${name} actions"]`)});
      const toggle = group.locator('.nav-destination-toggle');
      const sublist = group.locator('.nav-sublist');
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded','false');
      await expect(sublist).toBeHidden();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded','true');
      await expect(sublist).toBeVisible();
      await toggle.click();
      await expect(sublist).toBeHidden();
    }
  });
}
