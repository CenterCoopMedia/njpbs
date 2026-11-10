import { expect, test, type Locator } from "./fixtures";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openSpecimen } from "./capture";

const image = { name: "auth-statehouse.jpg", mimeType: "image/jpeg",
  buffer: readFileSync(fileURLToPath(new URL("../../public/brand/auth-statehouse.jpg", import.meta.url))) };

async function expectFieldsFit(picker: Locator) {
  for (const selector of [".media-upload-panel", ".media-upload-fields", ".media-category-assignments > div"]) {
    const container = picker.locator(selector);
    const geometry = await container.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.scroll, `${selector} stays within its available width`).toBeLessThanOrEqual(geometry.width + 1);
  }
  const fields = picker.locator(".media-upload-fields");
  expect(await fields.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("input, select")].every(field => {
      const box = field.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    });
  })).toBe(true);
}

for (const [width, text] of [[1280, 100], [1920, 100], [390, 100], [320, 100], [390, 200], [320, 200]]) {
  test(`routed Post upload fields fit and preserve native save at ${width}px, ${text}% text`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-mobile-draft", title: "Draft Post", width, presentation: "text" }, { normalizeGeneratedIds: false });
    const headline = page.getByRole("textbox", { name: "Headline", exact: true });
    await headline.fill("Retained upload draft");
    const save = page.getByRole("button", { name: "Save draft", exact: true });
    await save.evaluate(button => {
      const form = (button as HTMLButtonElement).form!;
      form.dataset.uploadTestSubmissions = "0";
      form.addEventListener("submit", () => { form.dataset.uploadTestSubmissions = String(Number(form.dataset.uploadTestSubmissions) + 1); });
    });
    const submissions = () => save.evaluate(button => (button as HTMLButtonElement).form!.dataset.uploadTestSubmissions);
    await page.getByRole("button", { name: /^Edit image / }).click();
    await page.locator("#editor-details-selection-panel").getByRole("button", { name: "Change image", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
    await picker.getByRole("button", { name: "Upload image", exact: true }).click();
    await picker.locator('input[type="file"]').setInputFiles(image);
    await page.addStyleTag({ content: `html { font-size: ${text}%; }` });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
    await expectFieldsFit(picker);
    const license = picker.getByRole("textbox", { name: "Batch license default", exact: true });
    await license.focus();
    await expect(license).toBeFocused();
    await expect(license).toBeInViewport({ ratio: 1 });
    expect(await license.evaluate(element => (element as HTMLInputElement).form === null)).toBe(true);
    await license.fill("NJ PBS owned");
    await license.press("Enter");
    expect(await submissions()).toBe("0");
    await picker.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(picker).toBeHidden();
    expect(await submissions()).toBe("0");
    await expect(headline).toHaveValue("Retained upload draft");
    await expect(page.getByText("Draft saved.", { exact: true })).toHaveCount(0);
    if (width < 780) await page.getByRole("button", { name: "Close details", exact: true }).click();
    await save.click();
    expect(await submissions()).toBe("1");
    await expect(page.locator(".success-notice").getByText("Draft saved.", { exact: true })).toBeVisible();
  });
}

test("standalone picker upload fields fit at the reported 320px and 200% text boundary", async ({ page }) => {
  await openSpecimen(page, { id: "media-picker-upload", title: "Picker", width: 320, presentation: "icons" }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Choose image", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
  await picker.getByRole("button", { name: "Upload image", exact: true }).click();
  await picker.locator('input[type="file"]').setInputFiles(image);
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expectFieldsFit(picker);
});
