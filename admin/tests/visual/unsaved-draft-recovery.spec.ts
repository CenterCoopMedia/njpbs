import { expect, test } from "./fixtures";
import { openSpecimen, waitForFonts } from "./capture";

for (const width of [390, 1280]) {
  test(`a reloaded Post offers restore and discard at ${width}px`, async ({ page }) => {
    const headline = page.getByRole("textbox", { name: "Headline", exact: true });
    await openSpecimen(page, {
      id: "study-reference-post", title: "Post", width, presentation: "icons",
    }, { normalizeGeneratedIds: false, readyLocator: headline });
    const savedHeadline = await headline.inputValue();
    const unsavedHeadline = "Local draft headline";
    await headline.fill(unsavedHeadline);
    await page.reload();

    const restore = page.getByRole("button", { name: "Restore unsaved changes" });
    const discard = page.getByRole("button", { name: "Discard unsaved changes" });
    await expect(restore).toBeInViewport();
    await expect(discard).toBeInViewport();
    await expect(headline).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await waitForFonts(page);
    await test.info().attach(`recovery-offer-${width}.png`, {
      body: await page.screenshot(), contentType: "image/png",
    });

    await restore.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Edit post", exact: true })).toBeFocused();
    await expect(headline).toHaveValue(unsavedHeadline);
    await page.reload();
    await discard.focus();
    await page.keyboard.press("Enter");
    await expect(headline).toHaveValue(savedHeadline);
    await page.reload();
    await expect(headline).toHaveValue(savedHeadline);
    await expect(restore).toHaveCount(0);
  });
}
