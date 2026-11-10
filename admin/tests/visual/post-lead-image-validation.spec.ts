import { expect, test } from "./fixtures";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const complete of [false, true]) for (const width of [390, 1280]) {
  test(`${complete ? "complete whitespace" : "draft"} decorative lead image errors explain the repair at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
      ? route.continue() : route.abort());
    await page.route("**/guide/landscape.webp", route => route.fulfill({
      path: fileURLToPath(new URL("../../public/brand/auth-newsroom-art.webp", import.meta.url)), contentType: "image/webp",
    }));
    await page.goto(complete ? "/lead-media.html?standalone=1&editable=1&decorative=1&whitespace=1" : "/lead-media.html?decorative=1");
    const imageGroup = page.getByRole("button", { name: "Hero image", exact: true });
    if (await imageGroup.getAttribute("aria-expanded") !== "true") await imageGroup.click();
    await page.getByRole("textbox", { name: "Lead image caption" }).fill("Updated photo credit");
    const save = page.getByRole("button", { name: complete ? "Save" : "Save draft", exact: true });
    await save.click();
    const type = page.getByLabel("Lead media type", { exact: true });
    const alt = page.getByRole("textbox", { name: "Lead image alt text", exact: true });
    await expect(alt).toBeFocused();
    await expect(alt).toHaveAttribute("aria-invalid", "true");
    const editor = page.locator(".post-lead-media-editor");
    const error = editor.getByRole("alert");
    await expect(error).toBeVisible();
    expect((await alt.getAttribute("aria-describedby"))?.split(" ")).toContain(await error.getAttribute("id"));
    const repair = page.getByRole("button", { name: "Lead image", exact: true });
    await repair.click();
    await expect(alt).toBeFocused();
    await page.evaluate(() => document.fonts.ready);
    await editor.locator("img").evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    if (process.env.LEAD_IMAGE_EVIDENCE) await editor.screenshot({ path: join(process.env.LEAD_IMAGE_EVIDENCE, `${complete ? "complete-whitespace" : "image-error"}-${width}.png`) });
    await expect(error).toHaveText(complete
      ? 'The alt text has only spaces. Clear it while "Mark lead image as decorative" is on.'
      : 'Clear the alt text or turn off "Mark lead image as decorative".');
    expect(await error.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await alt.fill("");
    await save.click();
    await expect(type).not.toHaveAttribute("aria-invalid", "true");
    await expect(alt).not.toHaveAttribute("aria-invalid", "true");
    await expect(error).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Lead image alt text" })).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: "Mark lead image as decorative" })).toBeChecked();
  });
}
