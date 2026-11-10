import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const retryFails of [true, false]) {
  test(`a failed outline chunk keeps the draft when retry ${retryFails ? "fails" : "recovers"} without reloading`, async ({ page }) => {
    await openSpecimen(page, { id: "study-reference-post", title: "Post", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
    const title = page.locator('#record-post-title');
    const edited = `${await title.inputValue()} unsaved outline retry`;
    await title.fill(edited); await title.evaluate(element => { (window as any).__outlineDraft = element; });
    await page.route('**/src/components/PageOutline.tsx*', route => route.abort('failed'));
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Your document is still open');
    await expect(title).toHaveValue(edited);
    expect(await title.evaluate(element => (window as any).__outlineDraft === element)).toBe(true);
    // Keep the network failure active when testing failed recovery. Browsers can
    // fetch a previously rejected import again once the network is available.
    if (!retryFails) await page.unroute('**/src/components/PageOutline.tsx*');
    await page.getByRole('button', { name: 'Retry outline', exact: true }).click();
    if (retryFails) await expect(page.getByRole('alert')).toContainText('Save your changes before reloading');
    else {
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'On this post', exact: true })
        .getByRole('button', { name: 'Headline & summary', exact: true })).toBeVisible();
    }
    await expect(title).toHaveValue(edited);
    expect(await title.evaluate(element => (window as any).__outlineDraft === element)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(title).toBeVisible(); await expect(title).toHaveValue(edited);
    expect(await title.evaluate(element => (window as any).__outlineDraft === element)).toBe(true);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.locator('.success-notice')).toContainText('Draft saved.');
  });


  test(`a failed Home editor chunk keeps other section changes available to save when retry ${retryFails ? "fails" : "recovers"}`, async ({ page }) => {
    await page.route('**/src/components/HomeDonorEditor.tsx*', route => route.abort('failed'));
    await openSpecimen(page, { id: "home-editor-recovery", title: "Page recovery", width: 1440, presentation: "icons" }, { normalizeGeneratedIds: false });
    await page.getByRole('button', { name: 'Edit NJ Spotlight News', exact: true }).click();
    const heading = page.locator('.home-source-selection input').first();
    await heading.fill('Unsaved source heading');
    await heading.evaluate(element => { element.setAttribute('data-source-draft-probe', 'retained'); (window as any).__sourceDraft = element; });
    const retained = page.locator('[data-source-draft-probe="retained"]');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Donor-advised giving', exact: true }).click();
    await page.getByRole('button', { name: /Edit Donor/i }).click();
    await expect(page.getByRole('alert')).toContainText('Your document is still open');
    await expect(retained).toHaveValue('Unsaved source heading');
    expect(await retained.evaluate(element => (window as any).__sourceDraft === element)).toBe(true);
    if (!retryFails) await page.unroute('**/src/components/HomeDonorEditor.tsx*');
    await page.getByRole('button', { name: 'Retry content details', exact: true }).click();
    if (retryFails) await expect(page.getByRole('alert')).toContainText('Save your changes before reloading');
    else {
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Donor-advised giving', exact: true })
        .getByRole('textbox', { name: 'Heading', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.locator('.success-notice')).toContainText('Draft saved.');
    await expect(retained).toHaveValue('Unsaved source heading');
    expect(await retained.evaluate(element => (window as any).__sourceDraft === element)).toBe(true);
  });
}
