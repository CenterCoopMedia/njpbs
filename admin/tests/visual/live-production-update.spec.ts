import { expect, test } from './fixtures';

for (const host of ['boardwalk', 'studio']) {
  test(`${host} Update live stays deliberate and reachable on phone and iPad`, async ({ page }) => {
    await page.route('**/src/lib/live-production-access.ts', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'import.meta.env.VITE_LIVE_PRODUCTION_ENABLED === "true"', 'true') });
    });
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/live-production.html?host=${host}&updateLive=1`);
      await page.getByLabel('Production session').selectOption('rehearsal');
      await page.getByRole('button', { name: /Headline · v1/ }).click();
      await page.getByRole('button', { name: 'Prepare', exact: true }).click();
      await page.getByRole('textbox', { name: 'Headline', exact: true }).fill('Updated saved headline');
      await expect(page.getByRole('button', { name: 'Take saved banner', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      const update = page.getByRole('button', { name: 'Update live', exact: true });
      await expect(update).toBeEnabled();
      for (const mode of ['Show', 'Prepare']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await expect(update).toBeInViewport();
        const clear = page.getByRole('button', { name: 'Clear Overlay 1', exact: true });
        await expect(clear).toBeInViewport();
        for (const button of [update, clear]) {
          const box = await button.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
          expect(box!.width).toBeGreaterThanOrEqual(44);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await update.click();
      await expect(page.getByText('Update live · saved version 2', { exact: true })).toBeVisible();
      await expect(update).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Clear Overlay 1', exact: true })).toBeEnabled();
    }
  });
}
